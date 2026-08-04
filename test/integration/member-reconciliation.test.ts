import assert from 'node:assert/strict';
import test from 'node:test';

import { ROLE_NAMES } from '../../src/constants.js';
import { runMigrations } from '../../src/migrations/runner.js';
import { reconcileExistingMembers } from '../../src/provision/members.js';
import { normalizePlan } from '../../src/provision/plan.js';
import {
  assertDisposableTestDatabaseUrl,
  createDisposableTestDatabase,
} from '../helpers/disposable-postgres.js';

const databaseUrl = assertDisposableTestDatabaseUrl(process.env.TEST_DATABASE_URL);
const database = createDisposableTestDatabase(databaseUrl);

function provisionMember(id, roleNames) {
  const cache = new Map(roleNames.map((name, index) => [`${id}-${index}`, { id: `${id}-${index}`, name }]));
  cache.map = (callback) => [...cache.values()].map(callback);
  let roleAddCount = 0;
  return {
    id,
    user: { bot: false },
    roles: {
      cache,
      async add(role) {
        roleAddCount += 1;
        cache.set(role.id, role);
      },
      async remove(role) {
        cache.delete(role.id);
      },
    },
    roleAddCount() {
      return roleAddCount;
    },
  };
}

test.after(async () => {
  await database.resetPublicSchema();
  await database.close();
});

test('reconciles a batch of recognized existing members in PostgreSQL', async () => {
  await database.resetPublicSchema();
  await runMigrations({ databaseUrl });
  const university = await database.query(
    `INSERT INTO universities (name, slug, discord_role_id)
     VALUES ('Bocconi', 'bocconi', 'bocconi-role') RETURNING id, slug`,
  );
  const projects = await database.query(
    `INSERT INTO divisions (university_id, name, slug, member_role_id)
     VALUES ($1, 'Projects', 'projects', 'projects-role') RETURNING id, slug`,
    [university.rows[0].id],
  );
  const analysis = await database.query(
    `INSERT INTO divisions (university_id, name, slug, member_role_id)
     VALUES ($1, 'Analysis', 'analysis', 'analysis-role') RETURNING id, slug`,
    [university.rows[0].id],
  );
  const researcher = { id: 'researcher', name: ROLE_NAMES.RESEARCHER };
  const alumni = { id: 'alumni', name: ROLE_NAMES.ALUMNI };
  const first = provisionMember('10', [
    'Bocconi | Member',
    'Bocconi | Projects',
    'Bocconi | Analysis',
    'Bocconi | President',
  ]);
  const second = provisionMember('20', [
    'Bocconi | Member',
    'Bocconi | Projects',
    'Bocconi | Vice-President',
    'Global Admin',
  ]);

  const result = await reconcileExistingMembers({
    guild: { members: { async fetch() { return new Map([[second.id, second], [first.id, first]]); } } },
    rolesByName: new Map([[ROLE_NAMES.RESEARCHER, researcher], [ROLE_NAMES.ALUMNI, alumni]]),
    plan: normalizePlan({ universities: [{ name: 'Bocconi', divisions: ['Projects', 'Analysis'] }] }),
    db: database,
    resources: {
      universities: [{
        ...university.rows[0],
        divisions: [projects.rows[0], analysis.rows[0]],
      }],
    },
  });

  assert.deepEqual(result.members.map((member) => member.discordUserId), ['10', '20']);
  assert.equal((await database.query('SELECT count(*)::int AS count FROM members')).rows[0].count, 2);
  assert.equal((await database.query('SELECT count(*)::int AS count FROM member_divisions')).rows[0].count, 0);
  assert.equal((await database.query('SELECT count(*)::int AS count FROM board_assignments WHERE active')).rows[0].count, 3);
});

test('rolls back a failed reconciliation batch and exposes retryable Discord completion', async () => {
  await database.resetPublicSchema();
  await runMigrations({ databaseUrl });
  const university = await database.query(
    `INSERT INTO universities (name, slug, discord_role_id)
     VALUES ('Bocconi', 'bocconi', 'bocconi-role') RETURNING id, slug`,
  );
  const projects = await database.query(
    `INSERT INTO divisions (university_id, name, slug, member_role_id)
     VALUES ($1, 'Projects', 'projects', 'projects-role') RETURNING id, slug`,
    [university.rows[0].id],
  );
  const analysis = await database.query(
    `INSERT INTO divisions (university_id, name, slug, member_role_id)
     VALUES ($1, 'Analysis', 'analysis', 'analysis-role') RETURNING id, slug`,
    [university.rows[0].id],
  );
  const first = provisionMember('10', ['Bocconi | Member', 'Bocconi | Projects', 'Bocconi | President']);
  const second = provisionMember('20', ['Bocconi | Member', 'Bocconi | Analysis', 'Bocconi | Vice-President']);
  const input = {
    guild: { members: { async fetch() { return new Map([[second.id, second], [first.id, first]]); } } },
    rolesByName: new Map([
      [ROLE_NAMES.RESEARCHER, { id: 'researcher', name: ROLE_NAMES.RESEARCHER }],
      [ROLE_NAMES.ALUMNI, { id: 'alumni', name: ROLE_NAMES.ALUMNI }],
    ]),
    plan: normalizePlan({ universities: [{ name: 'Bocconi', divisions: ['Projects', 'Analysis'] }] }),
    resources: {
      universities: [{
        ...university.rows[0],
        divisions: [projects.rows[0], analysis.rows[0]],
      }],
    },
  };
  const injected = new Error('Injected batch cleanup failure');
  let memberInsertCompleted = false;
  const failingDatabase = {
    transaction(work) {
      return database.transaction((client) => work({
        async query(sql, values = []) {
          if (memberInsertCompleted && sql.startsWith('DELETE FROM member_divisions')) throw injected;
          const result = await client.query(sql, values);
          if (sql.startsWith('INSERT INTO members')) memberInsertCompleted = true;
          return result;
        },
      }));
    },
  };

  let error;
  try {
    await reconcileExistingMembers({ ...input, db: failingDatabase });
  } catch (caught) {
    error = caught;
  }

  assert.ok(error instanceof AggregateError);
  assert.equal(error.reconciliation.databaseError, injected);
  assert.deepEqual(error.reconciliation.members.map((member) => member.discordUserId), ['10', '20']);
  assert.deepEqual(
    error.reconciliation.roleResults.map(({ discordUserId, status }) => ({ discordUserId, status })),
    [
      { discordUserId: '10', status: 'applied' },
      { discordUserId: '20', status: 'applied' },
    ],
  );
  assert.equal(first.roleAddCount(), 1);
  assert.equal(second.roleAddCount(), 1);
  assert.equal((await database.query('SELECT count(*)::int AS count FROM members')).rows[0].count, 0);
  assert.equal((await database.query('SELECT count(*)::int AS count FROM member_divisions')).rows[0].count, 0);
  assert.equal((await database.query('SELECT count(*)::int AS count FROM board_assignments')).rows[0].count, 0);

  const retry = await reconcileExistingMembers({ ...input, db: database });

  assert.deepEqual(retry.members.map((member) => member.discordUserId), ['10', '20']);
  assert.equal((await database.query('SELECT count(*)::int AS count FROM members')).rows[0].count, 2);
  assert.equal((await database.query('SELECT count(*)::int AS count FROM member_divisions')).rows[0].count, 0);
  assert.equal((await database.query('SELECT count(*)::int AS count FROM board_assignments WHERE active')).rows[0].count, 2);
});
