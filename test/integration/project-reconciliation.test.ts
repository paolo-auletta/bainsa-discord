import assert from 'node:assert/strict';
import test from 'node:test';

import { ChannelType } from 'discord.js';

import { runMigrations } from '../../src/migrations/runner.js';
import {
  enqueueProjectReconciliation,
  reconcileProject,
  retryProjectReconciliations,
} from '../../src/services/projects/reconciliation.js';
import { assertDisposableTestDatabaseUrl, createDisposableTestDatabase } from '../helpers/disposable-postgres.js';

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

function guildWithChannels(channels, create = async () => { throw new Error('Unexpected channel create'); }) {
  const values = new Map(channels.map((channel) => [channel.id, channel]));
  let showcaseThreadIndex = 0;
  values.set('showcase', {
    id: 'showcase',
    type: ChannelType.GuildForum,
    availableTags: [
      { id: 'analysis', name: 'Analysis' },
      { id: 'active', name: 'Active' },
      { id: 'paused', name: 'Paused' },
      { id: 'completed', name: 'Completed' },
    ],
    threads: {
      async create() {
        showcaseThreadIndex += 1;
        const starter = { async edit() {} };
        const thread = {
          id: `showcase-thread-${showcaseThreadIndex}`,
          archived: false,
          locked: false,
          async fetchStarterMessage() { return starter; },
          async setAppliedTags() {},
        };
        values.set(thread.id, thread);
        return thread;
      },
    },
  });
  return {
    id: 'guild',
    roles: { cache: roleCache() },
    channels: {
      cache: {
        has: (id) => values.has(id),
        find: (predicate) => [...values.values()].find(predicate),
      },
      async fetch(id) { return id == null ? values : values.get(id) ?? null; },
      async create(options) {
        const channel = await create(options);
        if (channel) values.set(channel.id, channel);
        return channel;
      },
    },
  };
}

async function seedProject(status = 'pending', channelId = 'channel-1') {
  await database.resetPublicSchema();
  await runMigrations({ databaseUrl });
  const university = await database.query(
    "INSERT INTO universities (name, showcase_channel_id) VALUES ('Bocconi', 'showcase') RETURNING id",
  );
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
  if (channelId == null) await database.query('UPDATE projects SET channel_id = NULL WHERE id = $1', [project.rows[0].id]);
  return project.rows[0].id;
}

function reconciledChannel(set, options = {}) {
  const messages = new Map();
  const channel = {
    id: options.id ?? 'channel-1',
    name: options.name ?? 'project-1-signals',
    topic: options.topic ?? 'Bocconi / Analysis project 1',
    type: options.type ?? 0,
    parentId: options.parentId ?? null,
    permissionOverwrites: { set },
    messages: {
      async fetch(input) { return typeof input === 'string' ? messages.get(input) ?? null : messages; },
      async fetchPins() {
        return { items: [...messages.values()].filter((message) => message.pinned).map((message) => ({ message })) };
      },
    },
    async send(payload) {
      const message = {
        id: `home-${messages.size + 1}`,
        content: payload.content,
        pinned: false,
        async edit() {},
        async pin() { this.pinned = true; },
      };
      messages.set(message.id, message);
      return message;
    },
    async setName(name) { this.name = name; },
    async setTopic(topic) { this.topic = topic; },
    async setParent() {},
  };
  return channel;
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
  let canonicalWrites = 0;
  const sendCanonicalHome = channel.send.bind(channel);
  channel.send = async (payload) => {
    canonicalWrites += 1;
    return sendCanonicalHome(payload);
  };
  const guild = guildWithChannels([channel]);

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
  assert.equal(canonicalWrites, 2, 'durable retries create one canonical project record and workspace guide without replaying history');
});

test('serializes two workers and leaves a newer desired generation pending after an older completion', async () => {
  const projectId = await seedProject();
  const entered = deferred();
  const release = deferred();
  let calls = 0;
  const guild = guildWithChannels([reconciledChannel(async () => {
    calls += 1;
    entered.resolve();
    await release.promise;
  })]);

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

test('adopts one deterministic channel after a stored channel is deleted, but rejects ambiguity', async () => {
  const projectId = await seedProject();
  let creates = 0;
  const adopted = reconciledChannel(async () => {}, { id: 'adopted' });
  const guild = guildWithChannels([adopted], async () => { creates += 1; });
  assert.equal((await reconcileProject({ projectId, guild, db: database })).status, 'succeeded');
  assert.equal((await database.query('SELECT channel_id FROM projects WHERE id = $1', [projectId])).rows[0].channel_id, 'adopted');
  assert.equal(creates, 0);

  const ambiguousProject = await seedProject();
  const first = reconciledChannel(async () => {}, { id: 'first' });
  const second = reconciledChannel(async () => {}, { id: 'second' });
  const ambiguous = await reconcileProject({ projectId: ambiguousProject, guild: guildWithChannels([first, second]), db: database });
  assert.equal(ambiguous.status, 'failed');
  const state = await database.query('SELECT status, last_error FROM project_reconciliation WHERE project_id = $1', [ambiguousProject]);
  assert.equal(state.rows[0].status, 'failed');
  assert.match(state.rows[0].last_error, /Multiple Discord channels/);
});

test('persists replacement channels before retryable boundaries and retries every durable Discord boundary', async () => {
  const projectId = await seedProject('pending', null);
  let creates = 0;
  let overwriteCalls = 0;
  const replacement = reconciledChannel(async () => {
    overwriteCalls += 1;
    if (overwriteCalls === 1) throw new Error('overwrite boundary');
  }, { id: 'replacement' });
  const guild = guildWithChannels([], async () => {
    creates += 1;
    return replacement;
  });
  const failed = await reconcileProject({ projectId, guild, db: database });
  assert.equal(failed.status, 'failed');
  assert.equal((await database.query('SELECT channel_id FROM projects WHERE id = $1', [projectId])).rows[0].channel_id, 'replacement');
  assert.equal((await retryProjectReconciliations({ guild, db: database }))[0].status, 'succeeded');
  assert.equal(creates, 1);

  for (const boundary of ['setName', 'setParent']) {
    const boundaryProject = await seedProject();
    let calls = 0;
    const channel = reconciledChannel(async () => {}, {
      name: boundary === 'setName' ? 'old-name' : 'project-1-signals',
      parentId: boundary === 'setParent' ? 'wrong-parent' : null,
    });
    channel[boundary] = async () => {
      calls += 1;
      if (calls === 1) throw new Error(`${boundary} boundary`);
    };
    const categories = boundary === 'setParent' ? [{ id: 'category', name: 'BAINSA BOCCONI', type: 4 }] : [];
    const boundaryGuild = guildWithChannels([channel, ...categories]);
    const first = await reconcileProject({ projectId: boundaryProject, guild: boundaryGuild, db: database });
    assert.equal(first.status, 'failed');
    const failedState = await database.query('SELECT last_error FROM project_reconciliation WHERE project_id = $1', [boundaryProject]);
    assert.match(failedState.rows[0].last_error, new RegExp(`${boundary} boundary`));
    assert.equal((await retryProjectReconciliations({ guild: boundaryGuild, db: database }))[0].status, 'succeeded');
  }
});
