import assert from 'node:assert/strict';
import test from 'node:test';

import { runMigrations } from '../../src/migrations/runner.mjs';
import {
  enqueueProjectReconciliation,
  reconcileProject,
  retryProjectReconciliations,
} from '../../src/services/projects/reconciliation.mjs';
import { assertDisposableTestDatabaseUrl, createDisposableTestDatabase } from '../helpers/disposable-postgres.mjs';

const databaseUrl = assertDisposableTestDatabaseUrl(process.env.TEST_DATABASE_URL);
const database = createDisposableTestDatabase(databaseUrl);

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function roleCache() {
  return { has: () => false, find: () => null };
}

function guildWithChannel(channel) {
  return {
    id: 'guild',
    roles: { cache: roleCache() },
    channels: {
      cache: { has: () => false, find: () => null },
      async fetch() { return channel; },
    },
  };
}

async function seedProject(status = 'pending') {
  await database.resetPublicSchema();
  await runMigrations({ databaseUrl });
  const university = await database.query("INSERT INTO universities (name) VALUES ('Bocconi') RETURNING id");
  const division = await database.query(
    "INSERT INTO divisions (university_id, name) VALUES ($1, 'Analysis') RETURNING id",
    [university.rows[0].id],
  );
  const project = await database.query(
    `INSERT INTO projects (name, university_id, division_id, start_date, expected_end, status, channel_id)
     VALUES ('Signals', $1, $2, '2026-07-01', '2026-08-01', 'active', 'channel-1') RETURNING id`,
    [university.rows[0].id, division.rows[0].id],
  );
  await database.query(
    'INSERT INTO project_reconciliation (project_id, desired_generation, status) VALUES ($1, 1, $2)',
    [project.rows[0].id, status],
  );
  return project.rows[0].id;
}

function reconciledChannel(set) {
  return {
    name: 'project-1-signals',
    parentId: null,
    permissionOverwrites: { set },
    async setName() {},
    async setParent() {},
  };
}

test.after(async () => {
  await database.resetPublicSchema();
  await database.close();
});

test('records post-commit Discord failures, repairs them, and does not replay a succeeded generation', async () => {
  const projectId = await seedProject();
  let calls = 0;
  const channel = reconciledChannel(async () => {
    calls += 1;
    if (calls === 1) throw new Error('injected overwrite failure');
  });
  const guild = guildWithChannel(channel);

  const failed = await reconcileProject({ projectId, guild, db: database });
  assert.equal(failed.status, 'failed');
  const failedState = await database.query('SELECT status, attempts, last_error FROM project_reconciliation WHERE project_id = $1', [projectId]);
  assert.deepEqual(failedState.rows[0].status, 'failed');
  assert.equal(failedState.rows[0].attempts, 1);
  assert.match(failedState.rows[0].last_error, /injected overwrite failure/);

  const repaired = await retryProjectReconciliations({ guild, db: database, limit: 1 });
  assert.equal(repaired[0].status, 'succeeded');
  assert.equal((await database.query('SELECT status FROM project_reconciliation WHERE project_id = $1', [projectId])).rows[0].status, 'succeeded');
  const callsAfterSuccess = calls;
  assert.deepEqual(await retryProjectReconciliations({ guild, db: database, limit: 1 }), []);
  assert.equal(calls, callsAfterSuccess);
});

test('serializes two workers and leaves a newer desired generation pending after an older completion', async () => {
  const projectId = await seedProject();
  const entered = deferred();
  const release = deferred();
  let calls = 0;
  const guild = guildWithChannel(reconciledChannel(async () => {
    calls += 1;
    entered.resolve();
    await release.promise;
  }));

  const first = reconcileProject({ projectId, guild, db: database });
  await entered.promise;
  const second = await reconcileProject({ projectId, guild, db: database });
  assert.equal(second.status, 'skipped');

  const newerMutation = database.transaction((client) => enqueueProjectReconciliation(client, projectId));
  release.resolve();
  assert.equal((await first).status, 'succeeded');
  assert.equal(await newerMutation, '2');
  const state = await database.query('SELECT desired_generation, status FROM project_reconciliation WHERE project_id = $1', [projectId]);
  assert.deepEqual(state.rows[0], { desired_generation: '2', status: 'pending' });
  assert.equal(calls, 1);
});
