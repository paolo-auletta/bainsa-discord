import assert from 'node:assert/strict';
import { copyFile, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { runMigrations } from '../../src/migrations/runner.mjs';
import {
  assertDisposableTestDatabaseUrl,
  createDisposableTestDatabase,
} from '../helpers/disposable-postgres.mjs';

const databaseUrl = assertDisposableTestDatabaseUrl(process.env.TEST_DATABASE_URL);
const database = createDisposableTestDatabase(databaseUrl);
const migrationsDir = new URL('../../db/migrations/', import.meta.url);

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

test.after(async () => {
  await database.resetPublicSchema();
  await database.close();
});

test('runs every migration against a fresh database and keeps the final contract idempotent', async () => {
  const first = await resetAndMigrate();
  assert.equal(first.pending, 0);
  assert.equal(first.appliedNow.length, 5);
  assert.deepEqual(first.status.map((row) => row.status), ['applied', 'applied', 'applied', 'applied', 'applied']);

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

  const universityId = await insertUniversity('Bocconi');
  const otherUniversityId = await insertUniversity('Sapienza');
  const division = await database.query(
    'INSERT INTO divisions (university_id, name, color) VALUES ($1, $2, $3) RETURNING id',
    [universityId, 'Analysis', 'orange'],
  );
  const otherDivision = await database.query(
    'INSERT INTO divisions (university_id, name, color) VALUES ($1, $2, $3) RETURNING id',
    [otherUniversityId, 'Projects', 'blue'],
  );
  await database.query(
    'INSERT INTO members (discord_user_id, university_id, member_type) VALUES ($1, $2, $3)',
    ['member-1', universityId, 'researcher'],
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
  assert.equal(second.applied, 5);
  assert.equal(second.pending, 0);

  const status = await migrate({ statusOnly: true });
  assert.equal(status.applied, 5);
  assert.equal(status.pending, 0);
});

test('refuses checksum drift after migrations have been applied', async () => {
  await resetAndMigrate();
  const temporaryDir = await mkdtemp(path.join(os.tmpdir(), 'bainsa-migrations-test-'));

  try {
    for (const filename of await readdir(migrationsDir)) {
      if (!filename.endsWith('.sql')) continue;
      await copyFile(new URL(filename, migrationsDir), path.join(temporaryDir, filename));
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
  assert.equal(result.applied, 5);
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
