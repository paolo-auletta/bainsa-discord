import assert from 'node:assert/strict';
import test from 'node:test';

import { ONBOARDING_ACTIONS, onboardingId } from '../../src/onboarding/custom-ids.mjs';
import { createOnboardingService } from '../../src/onboarding/service.mjs';
import { ROLE_NAMES } from '../../src/constants.mjs';
import { addMember, updateMember } from '../../src/services/governance/service.mjs';
import { createProject } from '../../src/services/projects/index.mjs';
import { runMigrations } from '../../src/migrations/runner.mjs';
import {
  assertDisposableTestDatabaseUrl,
  createDisposableTestDatabase,
  failTransactionQuery,
} from '../helpers/disposable-postgres.mjs';

const databaseUrl = assertDisposableTestDatabaseUrl(process.env.TEST_DATABASE_URL);
const database = createDisposableTestDatabase(databaseUrl);

function role(id, name) {
  return { id: String(id), name, editable: true, hexColor: '#000000' };
}

function roleCache(roles = []) {
  const values = new Map(roles.map((entry) => [String(entry.id), entry]));
  return {
    get: (id) => values.get(String(id)),
    has: (id) => values.has(String(id)),
    keys: () => values.keys(),
    find: (predicate) => [...values.values()].find(predicate),
    some: (predicate) => [...values.values()].some(predicate),
    set: (id, value) => values.set(String(id), value),
    delete: (id) => values.delete(String(id)),
  };
}

function managedMember(id, guild, initialRoles = []) {
  const cache = roleCache(initialRoles);
  let roleMutationCount = 0;
  return {
    id: String(id),
    user: { id: String(id) },
    guild,
    roles: {
      cache,
      async add(entries) {
        roleMutationCount += 1;
        for (const entry of entries) {
          const resolved = typeof entry === 'string' ? guild.roles.cache.get(entry) : entry;
          cache.set(resolved.id, resolved);
        }
      },
      async remove(entries) {
        roleMutationCount += 1;
        for (const entry of entries) cache.delete(typeof entry === 'string' ? entry : entry.id);
      },
    },
    roleMutationCount() {
      return roleMutationCount;
    },
  };
}

function globalPresident(id = 'reviewer') {
  return {
    id,
    roles: { cache: roleCache([role('global-president', ROLE_NAMES.GLOBAL_PRESIDENT)]) },
  };
}

async function resetAndMigrate() {
  await database.resetPublicSchema();
  await runMigrations({ databaseUrl });
}

async function seedUniversityAndDivision() {
  const university = await database.query(
    `INSERT INTO universities (name, discord_role_id)
     VALUES ('Bocconi', 'bocconi-role') RETURNING id`,
  );
  const division = await database.query(
    `INSERT INTO divisions (university_id, name, member_role_id)
     VALUES ($1, 'Analysis', 'analysis-role') RETURNING id`,
    [university.rows[0].id],
  );
  return { universityId: university.rows[0].id, divisionId: division.rows[0].id };
}

test.after(async () => {
  await database.resetPublicSchema();
  await database.close();
});

test('onboarding approval rolls back its PostgreSQL transaction and Discord role changes when auditing fails', async () => {
  await resetAndMigrate();
  const { universityId, divisionId } = await seedUniversityAndDivision();
  const request = await database.query(
    `INSERT INTO onboarding_requests
      (discord_user_id, member_type, university_id, division_ids, status, full_name, full_name_required)
     VALUES ($1, 'researcher', $2, ARRAY[$3]::bigint[], 'pending', 'Ada Lovelace', true)
     RETURNING id`,
    ['onboarding-user', universityId, divisionId],
  );

  const guild = { id: 'guild' };
  guild.roles = {
    cache: roleCache([
      role('guild', '@everyone'),
      role('researcher-role', ROLE_NAMES.RESEARCHER),
      role('bocconi-role', 'Bocconi'),
      role('analysis-role', 'Bocconi - Analysis'),
      role('global-president', ROLE_NAMES.GLOBAL_PRESIDENT),
    ]),
  };
  const target = managedMember('onboarding-user', guild, [role('guild', '@everyone')]);
  const reviewer = globalPresident();
  guild.members = {
    async fetch(id) {
      if (String(id) === target.id) return target;
      if (String(id) === reviewer.id) return reviewer;
      throw new Error('Unknown mock member');
    },
  };

  const service = createOnboardingService({
    db: database,
    runTransaction: failTransactionQuery(database, (text) => text.includes('INSERT INTO audit_log')).transaction,
  });
  const interaction = {
    customId: onboardingId(ONBOARDING_ACTIONS.APPROVE, request.rows[0].id),
    user: { id: reviewer.id },
    guild,
    member: reviewer,
    async deferReply() {},
  };

  await assert.rejects(service.handleButton(interaction), /Controlled integration transaction failure/);
  assert.equal(target.roles.cache.has('researcher-role'), false);
  assert.equal(target.roles.cache.has('bocconi-role'), false);
  assert.equal(target.roles.cache.has('analysis-role'), false);
  assert.equal((await database.query('SELECT count(*)::int AS count FROM members')).rows[0].count, 0);
  assert.equal(
    (await database.query('SELECT status FROM onboarding_requests WHERE id = $1', [request.rows[0].id])).rows[0].status,
    'pending',
  );
});

test('governance membership restores mocked Discord roles when its PostgreSQL transaction fails', async () => {
  await resetAndMigrate();
  await seedUniversityAndDivision();

  const guild = { id: 'guild' };
  guild.roles = {
    cache: roleCache([
      role('researcher-role', ROLE_NAMES.RESEARCHER),
      role('bocconi-role', 'Bocconi'),
      role('analysis-role', 'Bocconi - Analysis'),
      role('global-president', ROLE_NAMES.GLOBAL_PRESIDENT),
    ]),
  };
  const target = managedMember('governance-user', guild);
  const actor = globalPresident('actor');
  guild.members = { async fetch(id) { return String(id) === target.id ? target : null; } };
  const failingDatabase = failTransactionQuery(database, (text) => text.includes('INSERT INTO audit_log'));

  await assert.rejects(
    addMember(
      { guild, user: { id: actor.id }, member: actor },
      { user: { id: target.id }, university: 'Bocconi', memberType: 'researcher', divisionsText: 'Analysis' },
      { db: failingDatabase },
    ),
    /Discord roles were restored because the database update failed/i,
  );
  assert.equal(target.roles.cache.has('researcher-role'), false);
  assert.equal(target.roles.cache.has('bocconi-role'), false);
  assert.equal(target.roles.cache.has('analysis-role'), false);
  assert.equal((await database.query('SELECT count(*)::int AS count FROM members')).rows[0].count, 0);
});

test('member-update rejects an ineligible active PostgreSQL project assignment before Discord or transaction side effects', async () => {
  await resetAndMigrate();
  const { universityId, divisionId } = await seedUniversityAndDivision();
  await database.query(
    `INSERT INTO members (discord_user_id, university_id, member_type, status)
     VALUES ($1, $2, 'researcher', 'active')`,
    ['project-member', universityId],
  );
  await database.query(
    'INSERT INTO member_divisions (discord_user_id, division_id) VALUES ($1, $2)',
    ['project-member', divisionId],
  );
  const project = await database.query(
    `INSERT INTO projects (name, university_id, division_id, start_date, expected_end, status)
     VALUES ('Signals', $1, $2, '2026-07-01', '2026-08-01', 'active')
     RETURNING id`,
    [universityId, divisionId],
  );
  await database.query(
    `INSERT INTO project_people (project_id, discord_user_id, role)
     VALUES ($1, $2, 'member')`,
    [project.rows[0].id, 'project-member'],
  );

  const guild = { id: 'guild' };
  guild.roles = {
    cache: roleCache([
      role('researcher-role', ROLE_NAMES.RESEARCHER),
      role('alumni-role', ROLE_NAMES.ALUMNI),
      role('bocconi-role', 'Bocconi'),
      role('analysis-role', 'Bocconi - Analysis'),
      role('global-president', ROLE_NAMES.GLOBAL_PRESIDENT),
    ]),
  };
  const target = managedMember('project-member', guild, [
    role('researcher-role', ROLE_NAMES.RESEARCHER),
    role('bocconi-role', 'Bocconi'),
    role('analysis-role', 'Bocconi - Analysis'),
  ]);
  const actor = globalPresident('actor');
  guild.members = { async fetch(id) { return String(id) === target.id ? target : null; } };
  let transactionCalls = 0;
  const trackedDatabase = {
    query: database.query.bind(database),
    async transaction(work) {
      transactionCalls += 1;
      return database.transaction(work);
    },
  };

  await assert.rejects(
    updateMember(
      { guild, user: { id: actor.id }, member: actor },
      { user: { id: target.id }, memberType: 'alumni' },
      { db: trackedDatabase },
    ),
    new RegExp(`#${project.rows[0].id} Signals.*Remove or reassign their project participation first`, 'i'),
  );
  assert.equal(target.roleMutationCount(), 0);
  assert.equal(transactionCalls, 0);
  const member = await database.query(
    'SELECT member_type FROM members WHERE discord_user_id = $1',
    ['project-member'],
  );
  assert.equal(member.rows[0].member_type, 'researcher');
});

test('project creation archives its committed record when the mocked Discord channel create fails', async () => {
  await resetAndMigrate();
  const { universityId, divisionId } = await seedUniversityAndDivision();
  await database.query(
    `INSERT INTO members (discord_user_id, university_id, member_type, status)
     VALUES ($1, $2, 'researcher', 'active'), ($3, $2, 'alumni', 'active')`,
    ['111111111111111111', universityId, '222222222222222222'],
  );
  await database.query(
    'INSERT INTO member_divisions (discord_user_id, division_id) VALUES ($1, $2)',
    ['111111111111111111', divisionId],
  );

  const guild = { id: 'guild' };
  guild.roles = { cache: roleCache([role('head-role', 'Bocconi - Head of Analysis')]) };
  const actor = {
    id: 'actor',
    roles: { cache: roleCache([role('head-role', 'Bocconi - Head of Analysis')]) },
  };
  const member = managedMember('111111111111111111', guild);
  const supervisor = managedMember('222222222222222222', guild);
  guild.members = {
    async fetch(id) {
      if (String(id) === member.id) return member;
      if (String(id) === supervisor.id) return supervisor;
      throw new Error('Unknown mock member');
    },
  };
  guild.channels = {
    cache: { has: () => false, find: () => null },
    async create() {
      throw new Error('Controlled Discord channel failure');
    },
  };

  await assert.rejects(
    createProject({
      interaction: { guild, member: actor, user: { id: actor.id } },
      name: 'Signals',
      university: 'Bocconi',
      division: 'Analysis',
      startDate: '2026-07-01',
      expectedEnd: '2026-08-01',
      notes: null,
      members: member.id,
      supervisors: supervisor.id,
    }, { db: database }),
    /Discord provisioning failed and it was archived for review/i,
  );
  const project = await database.query('SELECT status, notes FROM projects');
  assert.equal(project.rows[0].status, 'archived');
  assert.match(project.rows[0].notes, /Controlled Discord channel failure/);
  const audit = await database.query("SELECT action FROM audit_log WHERE action = 'project.create_failed'");
  assert.equal(audit.rowCount, 1);
});
