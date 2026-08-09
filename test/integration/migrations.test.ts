import assert from 'node:assert/strict';
import { copyFile, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { runMigrations } from '../../src/migrations/runner.js';
import { projectPath } from '../../src/project-paths.js';
import {
  assertDisposableTestDatabaseUrl,
  createDisposableTestDatabase,
} from '../helpers/disposable-postgres.js';

const databaseUrl = assertDisposableTestDatabaseUrl(process.env.TEST_DATABASE_URL);
const database = createDisposableTestDatabase(databaseUrl);
const migrationsDir = projectPath('db', 'migrations');

async function migrate(options = {}) {
  return runMigrations({ databaseUrl, ...options });
}

async function resetAndMigrate() {
  await database.resetPublicSchema();
  return migrate();
}

async function insertUniversity(name) {
  const result = await database.query(
    'INSERT INTO universities (name) VALUES ($1) RETURNING id',
    [name],
  );
  return result.rows[0].id;
}

function deferred() {
  let resolve;
  const promise = new Promise((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

test.after(async () => {
  await database.resetPublicSchema();
  await database.close();
});

test('runs every migration against a fresh database and keeps the final contract idempotent', async () => {
  const first = await resetAndMigrate();
  assert.equal(first.pending, 0);
  assert.equal(first.appliedNow.length, 17);
  assert.deepEqual(first.status.map((row) => row.status), [
    'applied', 'applied', 'applied', 'applied', 'applied', 'applied', 'applied', 'applied', 'applied', 'applied',
    'applied', 'applied', 'applied', 'applied', 'applied', 'applied', 'applied',
  ]);

  const tables = await database.query(`
    SELECT table_name
      FROM information_schema.tables
     WHERE table_schema = 'public'
     ORDER BY table_name
  `);
  for (const table of [
    'audit_log',
    'board_assignments',
    'divisions',
    'member_divisions',
    'member_profile_reconciliation',
    'member_profiles',
    'members',
    'onboarding_requests',
    'projects',
    'project_people',
    'project_reconciliation',
    'provisioned_messages',
    'schema_migrations',
    'universities',
  ]) {
    assert.ok(tables.rows.some((row) => row.table_name === table), `missing ${table}`);
  }

  const indexes = await database.query(`
    SELECT indexname
      FROM pg_indexes
     WHERE schemaname = 'public'
       AND indexname IN (
         'universities_name_ci_unique',
         'divisions_university_name_ci_unique',
         'onboarding_requests_one_open_per_user_unique',
         'board_assignments_active_head_per_division_unique'
       )
  `);
  assert.equal(indexes.rowCount, 4);

  const reapplicationColumn = await database.query(`
    SELECT data_type, is_nullable, column_default
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'onboarding_requests'
       AND column_name = 'previously_removed'
  `);
  assert.deepEqual(reapplicationColumn.rows[0], {
    data_type: 'boolean',
    is_nullable: 'NO',
    column_default: 'false',
  });

  const projectUxColumns = await database.query(`
    SELECT column_name, data_type
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'projects'
       AND column_name IN ('summary', 'home_message_id', 'workspace_guide_message_id')
     ORDER BY column_name
  `);
  assert.deepEqual(projectUxColumns.rows, [
    { column_name: 'home_message_id', data_type: 'text' },
    { column_name: 'summary', data_type: 'text' },
    { column_name: 'workspace_guide_message_id', data_type: 'text' },
  ]);

  const universityId = await insertUniversity('Bocconi');
  const otherUniversityId = await insertUniversity('Sapienza');
  await database.query(
    'INSERT INTO divisions (university_id, name, color) VALUES ($1, $2, $3) RETURNING id',
    [universityId, 'Analysis', 'orange'],
  );
  const otherDivision = await database.query(
    'INSERT INTO divisions (university_id, name, color) VALUES ($1, $2, $3) RETURNING id',
    [otherUniversityId, 'Projects', 'blue'],
  );
  await database.query(
    `INSERT INTO members (discord_user_id, university_id, member_type)
     VALUES ($1, $2, $3), ($4, $2, $3), ($5, $2, $3)`,
    ['member-1', universityId, 'researcher', 'president-1', 'president-2'],
  );
  await database.query(
    `INSERT INTO board_assignments (discord_user_id, university_id, role)
     VALUES ($1, $2, 'president'), ($3, $2, 'president')`,
    ['president-1', universityId, 'president-2'],
  );

  await assert.rejects(
    database.query('INSERT INTO universities (name) VALUES ($1)', ['bocconi']),
    /duplicate key/i,
  );
  await assert.rejects(
    database.query(
      'INSERT INTO member_divisions (discord_user_id, division_id) VALUES ($1, $2)',
      ['member-1', otherDivision.rows[0].id],
    ),
    /member division must belong to the member university/i,
  );
  await assert.rejects(
    database.query(
      `INSERT INTO onboarding_requests (discord_user_id, member_type, university_id, division_ids, status)
       VALUES ($1, $2, $3, $4::bigint[], $5)`,
      ['onboarding-1', 'researcher', universityId, [otherDivision.rows[0].id], 'pending'],
    ),
    /onboarding division_ids must belong to the selected university/i,
  );
  await assert.rejects(
    database.query(
      'INSERT INTO divisions (university_id, name, color) VALUES ($1, $2, $3)',
      [universityId, 'Invalid colour', 'purple'],
    ),
    /divisions_color_check/i,
  );

  const second = await migrate();
  assert.deepEqual(second.appliedNow, []);
  assert.equal(second.applied, 16);
  assert.equal(second.pending, 0);

  const status = await migrate({ statusOnly: true });
  assert.equal(status.applied, 16);
  assert.equal(status.pending, 0);
});

test('university tag upgrade queues existing published profiles exactly once', async () => {
  await database.resetPublicSchema();
  const temporaryDir = await mkdtemp(path.join(os.tmpdir(), 'bainsa-migrations-before-017-'));

  try {
    for (const filename of await readdir(migrationsDir)) {
      if (!filename.endsWith('.sql') || filename === '017_replace_profile_identity_tags_with_university_tags.sql') continue;
      await copyFile(path.join(migrationsDir, filename), path.join(temporaryDir, filename));
    }
    await migrate({ migrationsDir: temporaryDir });
    const universityId = await insertUniversity('Profile Layout University');
    await database.query(
      `INSERT INTO members (discord_user_id, university_id, member_type)
       VALUES ('layout-profile', $1, 'researcher')`,
      [universityId],
    );
    await database.query(
      `INSERT INTO member_profiles (
         discord_user_id, headline, about, "current_role", goals, selected_tags
       ) VALUES (
         'layout-profile', 'Applied AI researcher',
         'I enjoy machine learning and collaborative research projects.',
         'MSc student', 'Explore research and internship collaborations.', ARRAY['ai_data']
       )`,
    );
    await database.query(
      `INSERT INTO member_profile_reconciliation (
         discord_user_id, desired_generation, status, attempts, succeeded_at
       ) VALUES ('layout-profile', 4, 'succeeded', 3, now())`,
    );

    const migrated = await migrate();
    assert.deepEqual(
      migrated.appliedNow.map((migration) => migration.filename),
      ['017_replace_profile_identity_tags_with_university_tags.sql'],
    );
    const queued = await database.query(
      `SELECT desired_generation, status, attempts, started_at, succeeded_at, failed_at, last_error
         FROM member_profile_reconciliation
        WHERE discord_user_id = 'layout-profile'`,
    );
    assert.deepEqual(queued.rows[0], {
      desired_generation: '5',
      status: 'pending',
      attempts: 0,
      started_at: null,
      succeeded_at: null,
      failed_at: null,
      last_error: null,
    });

    const second = await migrate();
    assert.equal(second.appliedNow.length, 0);
  } finally {
    await rm(temporaryDir, { recursive: true, force: true });
  }
});

test('executive exclusivity handles head promotion and multi-row division assignments', async () => {
  await resetAndMigrate();
  const universityId = await insertUniversity('Bocconi');
  const divisions = await database.query(
    `INSERT INTO divisions (university_id, name, color)
     VALUES ($1, 'Analysis', 'orange'), ($1, 'Projects', 'blue')
     RETURNING id, name`,
    [universityId],
  );
  const analysisId = divisions.rows.find((division) => division.name === 'Analysis').id;
  const projectsId = divisions.rows.find((division) => division.name === 'Projects').id;
  await database.query(
    `INSERT INTO members (discord_user_id, university_id, member_type)
     VALUES ('promoted-head', $1, 'researcher'), ('multi-row', $1, 'researcher')`,
    [universityId],
  );
  await database.query(
    `INSERT INTO member_divisions (discord_user_id, division_id)
     VALUES ('promoted-head', $1), ('multi-row', $2)`,
    [analysisId, projectsId],
  );
  const head = await database.query(
    `INSERT INTO board_assignments (discord_user_id, university_id, division_id, role)
     VALUES ('promoted-head', $1, $2, 'head') RETURNING id`,
    [universityId, analysisId],
  );

  await database.transaction(async (q) => {
    await q.query(
      `UPDATE board_assignments
          SET role = 'president',
              division_id = NULL
        WHERE id = $1`,
      [head.rows[0].id],
    );
    await q.query(
      `INSERT INTO board_assignments (discord_user_id, university_id, division_id, role)
       VALUES
         ('multi-row', $1, NULL, 'vice_president'),
         ('multi-row', $1, $2, 'head')`,
      [universityId, projectsId],
    );
  });

  const memberships = await database.query(
    `SELECT discord_user_id FROM member_divisions
      WHERE discord_user_id IN ('promoted-head', 'multi-row')`,
  );
  assert.equal(memberships.rowCount, 0);
  const activeAssignments = await database.query(
    `SELECT discord_user_id, role
       FROM board_assignments
      WHERE discord_user_id IN ('promoted-head', 'multi-row')
        AND active = true
      ORDER BY discord_user_id, role`,
  );
  assert.deepEqual(activeAssignments.rows, [
    { discord_user_id: 'multi-row', role: 'vice_president' },
    { discord_user_id: 'promoted-head', role: 'president' },
  ]);
});

test('executive exclusivity removes a Head assignment committed after an overlapping promotion', async () => {
  await resetAndMigrate();
  const universityId = await insertUniversity('Bocconi');
  const division = await database.query(
    `INSERT INTO divisions (university_id, name, color)
     VALUES ($1, 'Analysis', 'orange') RETURNING id`,
    [universityId],
  );
  await database.query(
    `INSERT INTO members (discord_user_id, university_id, member_type)
     VALUES ('concurrent-member', $1, 'researcher')`,
    [universityId],
  );

  const headInserted = deferred();
  const releaseHead = deferred();
  const headAssignment = database.transaction(async (q) => {
    await q.query(
      `INSERT INTO board_assignments (discord_user_id, university_id, division_id, role)
       VALUES ('concurrent-member', $1, $2, 'head')`,
      [universityId, division.rows[0].id],
    );
    headInserted.resolve();
    await releaseHead.promise;
  });

  await headInserted.promise;
  await database.transaction((q) => q.query(
    `INSERT INTO board_assignments (discord_user_id, university_id, role)
     VALUES ('concurrent-member', $1, 'vice_president')`,
    [universityId],
  ));
  releaseHead.resolve();
  await headAssignment;

  const activeAssignments = await database.query(
    `SELECT role FROM board_assignments
      WHERE discord_user_id = 'concurrent-member'
        AND active = true
      ORDER BY role`,
  );
  assert.deepEqual(activeAssignments.rows, [{ role: 'vice_president' }]);
});

test('executive appointments clear division memberships and Head assignments in the same university', async () => {
  await resetAndMigrate();
  const bocconiId = await insertUniversity('Bocconi');
  const sapienzaId = await insertUniversity('Sapienza');
  const divisions = await database.query(
    `INSERT INTO divisions (university_id, name, color)
     VALUES
       ($1, 'Analysis', 'orange'),
       ($1, 'Projects', 'blue'),
       ($2, 'Culture', 'pink'),
       ($2, 'Research', 'green')
     RETURNING id, university_id`,
    [bocconiId, sapienzaId],
  );
  const [bocconiAnalysis, bocconiProjects, sapienzaCulture, sapienzaResearch] = divisions.rows;
  await database.query(
    `INSERT INTO members (discord_user_id, university_id, member_type)
     VALUES ('vice-president', $1, 'researcher'), ('president', $2, 'researcher')`,
    [bocconiId, sapienzaId],
  );
  await database.query(
    `INSERT INTO member_divisions (discord_user_id, division_id)
     VALUES
       ('vice-president', $1),
       ('vice-president', $2),
       ('president', $3),
       ('president', $4)`,
    [bocconiAnalysis.id, bocconiProjects.id, sapienzaCulture.id, sapienzaResearch.id],
  );
  await database.query(
    `INSERT INTO board_assignments (discord_user_id, university_id, division_id, role)
     VALUES
       ('vice-president', $1, $2, 'head'),
       ('president', $3, $4, 'head')`,
    [bocconiId, bocconiAnalysis.id, sapienzaId, sapienzaCulture.id],
  );

  await database.query(
    `INSERT INTO board_assignments (discord_user_id, university_id, role)
     VALUES
       ('vice-president', $1, 'vice_president'),
       ('president', $2, 'president')`,
    [bocconiId, sapienzaId],
  );

  const memberships = await database.query(
    `SELECT discord_user_id FROM member_divisions
      WHERE discord_user_id IN ('vice-president', 'president')`,
  );
  assert.equal(memberships.rowCount, 0);

  const assignments = await database.query(
    `SELECT discord_user_id, role, active
       FROM board_assignments
      WHERE discord_user_id IN ('vice-president', 'president')
      ORDER BY discord_user_id, role`,
  );
  assert.deepEqual(assignments.rows, [
    { discord_user_id: 'president', role: 'head', active: false },
    { discord_user_id: 'president', role: 'president', active: true },
    { discord_user_id: 'vice-president', role: 'head', active: false },
    { discord_user_id: 'vice-president', role: 'vice_president', active: true },
  ]);
});

test('executive exclusivity backfills legacy member divisions and Head assignments', async () => {
  await database.resetPublicSchema();
  const temporaryDir = await mkdtemp(path.join(os.tmpdir(), 'bainsa-migrations-before-010-'));

  try {
    for (const filename of await readdir(migrationsDir)) {
      if (!filename.endsWith('.sql') || ['010_enforce_executive_division_exclusivity.sql', '014_repair_executive_exclusivity.sql'].includes(filename)) continue;
      await copyFile(path.join(migrationsDir, filename), path.join(temporaryDir, filename));
    }
    await migrate({ migrationsDir: temporaryDir });

    const universityId = await insertUniversity('Bocconi');
    const division = await database.query(
      `INSERT INTO divisions (university_id, name, color)
       VALUES ($1, 'Analysis', 'orange') RETURNING id`,
      [universityId],
    );
    await database.query(
      `INSERT INTO members (discord_user_id, university_id, member_type)
       VALUES ('legacy-executive', $1, 'researcher')`,
      [universityId],
    );
    await database.query('ALTER TABLE board_assignments DISABLE TRIGGER USER');
    try {
      await database.query(
        `INSERT INTO member_divisions (discord_user_id, division_id)
         VALUES ('legacy-executive', $1)`,
        [division.rows[0].id],
      );
      await database.query(
        `INSERT INTO board_assignments (discord_user_id, university_id, division_id, role)
         VALUES
           ('legacy-executive', $1, $2, 'head'),
           ('legacy-executive', $1, NULL, 'vice_president')`,
        [universityId, division.rows[0].id],
      );
    } finally {
      await database.query('ALTER TABLE board_assignments ENABLE TRIGGER USER');
    }

    const migrated = await migrate();
    assert.deepEqual(
      migrated.appliedNow.map((migration) => migration.filename),
      ['010_enforce_executive_division_exclusivity.sql', '014_repair_executive_exclusivity.sql'],
    );
    assert.equal(
      (await database.query(
        "SELECT count(*)::int AS count FROM member_divisions WHERE discord_user_id = 'legacy-executive'",
      )).rows[0].count,
      0,
    );
    const assignments = await database.query(
      `SELECT role, active
         FROM board_assignments
        WHERE discord_user_id = 'legacy-executive'
        ORDER BY role`,
    );
    assert.deepEqual(assignments.rows, [
      { role: 'head', active: false },
      { role: 'vice_president', active: true },
    ]);
  } finally {
    await rm(temporaryDir, { recursive: true, force: true });
  }
});

test('executive exclusivity fails closed above READ COMMITTED isolation', async () => {
  await resetAndMigrate();
  const universityId = await insertUniversity('Bocconi');
  const division = await database.query(
    `INSERT INTO divisions (university_id, name, color)
     VALUES ($1, 'Analysis', 'orange') RETURNING id`,
    [universityId],
  );
  await database.query(
    `INSERT INTO members (discord_user_id, university_id, member_type)
     VALUES ('repeatable-read-member', $1, 'researcher')`,
    [universityId],
  );

  await assert.rejects(
    database.transaction(async (q) => {
      await q.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
      await q.query(
        `INSERT INTO board_assignments (discord_user_id, university_id, role)
         VALUES ('repeatable-read-member', $1, 'vice_president')`,
        [universityId],
      );
    }),
    /requires READ COMMITTED/i,
  );

  await database.query(
    `INSERT INTO board_assignments (discord_user_id, university_id, role)
     VALUES ('repeatable-read-member', $1, 'vice_president')`,
    [universityId],
  );
  await assert.rejects(
    database.transaction(async (q) => {
      await q.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
      await q.query(
        `INSERT INTO member_divisions (discord_user_id, division_id)
         VALUES ('repeatable-read-member', $1)`,
        [division.rows[0].id],
      );
    }),
    /requires READ COMMITTED/i,
  );
});

test('division university ownership is immutable', async () => {
  await resetAndMigrate();
  const bocconiId = await insertUniversity('Bocconi');
  const sapienzaId = await insertUniversity('Sapienza');
  const division = await database.query(
    `INSERT INTO divisions (university_id, name, color)
     VALUES ($1, 'Analysis', 'orange') RETURNING id`,
    [bocconiId],
  );

  await assert.rejects(
    database.query(
      'UPDATE divisions SET university_id = $1 WHERE id = $2',
      [sapienzaId, division.rows[0].id],
    ),
    /division university_id is immutable/i,
  );
  await database.query(
    'UPDATE divisions SET university_id = $1 WHERE id = $2',
    [bocconiId, division.rows[0].id],
  );
  assert.equal(
    (await database.query('SELECT university_id FROM divisions WHERE id = $1', [division.rows[0].id])).rows[0]
      .university_id,
    bocconiId,
  );
});

test('refuses checksum drift after migrations have been applied', async () => {
  await resetAndMigrate();
  const temporaryDir = await mkdtemp(path.join(os.tmpdir(), 'bainsa-migrations-test-'));

  try {
    for (const filename of await readdir(migrationsDir)) {
      if (!filename.endsWith('.sql')) continue;
      await copyFile(path.join(migrationsDir, filename), path.join(temporaryDir, filename));
    }
    const changedFile = path.join(temporaryDir, '006_expand_division_colors.sql');
    await writeFile(changedFile, `${await readFile(changedFile, 'utf8')}\n-- controlled integration checksum drift\n`);

    await assert.rejects(
      migrate({ migrationsDir: temporaryDir, statusOnly: true }),
      /Applied migration has been modified: 006_expand_division_colors\.sql/,
    );
  } finally {
    await rm(temporaryDir, { recursive: true, force: true });
  }
});

test('upgrades the tracked legacy university and division shape in place', async () => {
  await database.resetPublicSchema();
  await database.query(`
    CREATE TABLE schema_migrations (
      filename text PRIMARY KEY,
      checksum char(64) NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now(),
      execution_ms integer NOT NULL
    );
    CREATE TABLE universities (
      id bigint PRIMARY KEY,
      name text NOT NULL,
      discord_category_id text,
      discord_board_channel_id text,
      is_cross_university boolean
    );
    CREATE TABLE divisions (
      id bigint PRIMARY KEY,
      university_id bigint NOT NULL,
      name text NOT NULL,
      discord_general_channel_id text,
      discord_voice_channel_id text
    );
  `);
  await database.query(
    `INSERT INTO schema_migrations (filename, checksum, execution_ms)
     VALUES ($1, $2, $3)`,
    ['001_legacy_schema.sql', '0'.repeat(64), 1],
  );
  await database.query(
    `INSERT INTO universities
      (id, name, discord_category_id, discord_board_channel_id, is_cross_university)
     VALUES ($1, $2, $3, $4, $5)`,
    [41, 'Legacy University', 'legacy-category', 'legacy-board', true],
  );
  await database.query(
    `INSERT INTO divisions
      (id, university_id, name, discord_general_channel_id, discord_voice_channel_id)
     VALUES ($1, $2, $3, $4, $5)`,
    [71, 41, 'Legacy Division', 'legacy-text', 'legacy-voice'],
  );

  const result = await migrate();
  assert.equal(result.applied, 15);
  assert.equal(result.recordedNotLocal, 1);

  const university = await database.query(
    `SELECT id, name, category_id, board_channel_id, active
       FROM universities WHERE id = $1`,
    [41],
  );
  assert.deepEqual(university.rows[0], {
    id: '41',
    name: 'Legacy University',
    category_id: 'legacy-category',
    board_channel_id: 'legacy-board',
    active: false,
  });
  const division = await database.query(
    `SELECT id, university_id, name, text_channel_id, voice_channel_id
       FROM divisions WHERE id = $1`,
    [71],
  );
  assert.deepEqual(division.rows[0], {
    id: '71',
    university_id: '41',
    name: 'Legacy Division',
    text_channel_id: 'legacy-text',
    voice_channel_id: 'legacy-voice',
  });
});
