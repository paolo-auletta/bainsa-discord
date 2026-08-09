import assert from 'node:assert/strict';
import test from 'node:test';

import { ChannelType } from 'discord.js';

import { runMigrations } from '../../src/migrations/runner.js';
import {
  hideProfileAndEnqueue,
  requestProfileReconciliation,
} from '../../src/profiles/repository.js';
import {
  reconcileProfile,
  retryProfileReconciliations,
} from '../../src/profiles/reconciliation.js';
import { hideDepartedMemberProfile } from '../../src/services/governance/service.js';
import {
  assertDisposableTestDatabaseUrl,
  createDisposableTestDatabase,
} from '../helpers/disposable-postgres.js';

const databaseUrl = assertDisposableTestDatabaseUrl(process.env.TEST_DATABASE_URL);
const database = createDisposableTestDatabase(databaseUrl);

async function resetAndMigrate() {
  await database.resetPublicSchema();
  await runMigrations({ databaseUrl });
}

async function seedMember(discordUserId, universityName = `University ${discordUserId}`) {
  const university = await database.query(
    `INSERT INTO universities (name)
     VALUES ($1)
     RETURNING id`,
    [universityName],
  );
  await database.query(
    `INSERT INTO members (discord_user_id, university_id, member_type)
     VALUES ($1, $2, 'researcher')`,
    [discordUserId, university.rows[0].id],
  );
}

function directoryGuild({ failCreates = 0 } = {}) {
  const threads = new Map();
  const forum = {
    id: 'directory-forum',
    name: 'people-directory',
    type: ChannelType.GuildForum,
    availableTags: [
      { id: 'bocconi', name: 'Bocconi' },
      { id: 'ai-data', name: 'AI & Data' },
    ],
    threads: {
      async fetchActive() { return { threads }; },
      async fetchArchived() { return { threads: new Map(), hasMore: false }; },
      async create(payload) {
        if (failCreates > 0) {
          failCreates -= 1;
          throw new Error('injected directory create failure');
        }
        const id = `directory-thread-${threads.size + 1}`;
        const starter = {
          id,
          author: { id: 'bot' },
          content: '',
          components: payload.message.components,
          async edit() {},
        };
        const thread = {
          id,
          parentId: forum.id,
          archived: false,
          name: payload.name,
          appliedTags: payload.appliedTags,
          async fetchStarterMessage() { return starter; },
          async delete() { threads.delete(id); },
        };
        threads.set(id, thread);
        return thread;
      },
    },
  };
  const channels = new Map([[forum.id, forum]]);
  return {
    client: { user: { id: 'bot' } },
    channels: {
      cache: { find: (predicate) => [...channels.values()].find(predicate) },
      async fetch(id) { return id == null ? channels : channels.get(id) ?? null; },
    },
    directoryThreadCount: () => threads.size,
  };
}

function validProfile(discordUserId, overrides = {}) {
  return {
    discordUserId,
    headline: 'Applied AI researcher',
    about: 'I enjoy machine learning and collaborative research projects.',
    currentRole: 'MSc student',
    goals: 'Explore research and internship collaborations.',
    selectedTags: ['ai_data'],
    forumThreadId: null,
    forumMessageId: null,
    ...overrides,
  };
}

async function insertProfile(profile) {
  return database.query(
    `INSERT INTO member_profiles (
       discord_user_id,
       headline,
       about,
       "current_role",
       goals,
       selected_tags,
       forum_thread_id,
       forum_message_id
     ) VALUES ($1, $2, $3, $4, $5, $6::text[], $7, $8)`,
    [
      profile.discordUserId,
      profile.headline,
      profile.about,
      profile.currentRole,
      profile.goals,
      profile.selectedTags,
      profile.forumThreadId,
      profile.forumMessageId,
    ],
  );
}

test.after(async () => {
  await database.resetPublicSchema();
  await database.close();
});

test('member profiles reject incomplete, invalid, and orphaned published data', async () => {
  await resetAndMigrate();
  await seedMember('profile-owner');

  await assert.rejects(
    database.query(
      `INSERT INTO member_profiles (discord_user_id, headline, about, "current_role", selected_tags)
       VALUES ($1, $2, $3, $4, $5::text[])`,
      [
        'profile-owner',
        'Applied AI researcher',
        'I enjoy machine learning and collaborative research projects.',
        'MSc student',
        ['ai_data'],
      ],
    ),
    /null value in column "goals"/i,
  );
  await assert.rejects(
    insertProfile(validProfile('profile-owner', { selectedTags: [] })),
    /member_profiles_selected_tags_check/i,
  );
  await assert.rejects(
    insertProfile(validProfile('profile-owner', {
      selectedTags: ['ai_data', 'biology', 'academia', 'industry', 'entrepreneurship'],
    })),
    /member_profiles_selected_tags_check/i,
  );
  await assert.rejects(
    insertProfile(validProfile('missing-member')),
    /member_profiles_discord_user_id_fkey/i,
  );
});

test('profile lifecycle state protects Discord identities and reconciliation generations', async () => {
  await resetAndMigrate();
  await seedMember('profile-owner');
  await seedMember('second-profile-owner');

  await insertProfile(validProfile('profile-owner', {
    forumThreadId: 'directory-thread-1',
    forumMessageId: 'directory-message-1',
  }));
  await assert.rejects(
    insertProfile(validProfile('second-profile-owner', {
      forumThreadId: 'directory-thread-1',
      forumMessageId: 'directory-message-2',
    })),
    /member_profiles_forum_thread_id_key/i,
  );

  await database.query(
    `INSERT INTO member_profile_reconciliation (discord_user_id, desired_generation, status)
     VALUES ($1, $2, $3)`,
    ['profile-owner', 1, 'pending'],
  );
  await assert.rejects(
    database.query(
      'UPDATE member_profile_reconciliation SET desired_generation = -1 WHERE discord_user_id = $1',
      ['profile-owner'],
    ),
    /member_profile_reconciliation_desired_generation_check/i,
  );
  await assert.rejects(
    database.query(
      "UPDATE member_profile_reconciliation SET status = 'unknown' WHERE discord_user_id = $1",
      ['profile-owner'],
    ),
    /member_profile_reconciliation_status_check/i,
  );
  await assert.rejects(
    database.query(
      'UPDATE member_profile_reconciliation SET attempts = -1 WHERE discord_user_id = $1',
      ['profile-owner'],
    ),
    /member_profile_reconciliation_attempts_check/i,
  );
  await database.query(
    `UPDATE member_profile_reconciliation
        SET desired_generation = 2,
            status = 'processing',
            updated_at = '2000-01-01T00:00:00Z'
      WHERE discord_user_id = $1`,
    ['profile-owner'],
  );
  const reconciliation = await database.query(
    `SELECT desired_generation, status, updated_at > '2020-01-01T00:00:00Z' AS updated
       FROM member_profile_reconciliation
      WHERE discord_user_id = $1`,
    ['profile-owner'],
  );
  assert.deepEqual(reconciliation.rows[0], {
    desired_generation: '2',
    status: 'processing',
    updated: true,
  });

  await database.query(
    `UPDATE member_profiles
        SET visibility = 'hidden',
            updated_at = '2000-01-01T00:00:00Z'
      WHERE discord_user_id = $1`,
    ['profile-owner'],
  );
  const hiddenProfile = await database.query(
    `SELECT visibility, forum_thread_id, forum_message_id, updated_at > '2020-01-01T00:00:00Z' AS updated
       FROM member_profiles
      WHERE discord_user_id = $1`,
    ['profile-owner'],
  );
  assert.deepEqual(hiddenProfile.rows[0], {
    visibility: 'hidden',
    forum_thread_id: 'directory-thread-1',
    forum_message_id: 'directory-message-1',
    updated: true,
  });

  await database.query('DELETE FROM members WHERE discord_user_id = $1', ['profile-owner']);
  assert.equal(
    (await database.query(
      "SELECT count(*)::int AS count FROM member_profiles WHERE discord_user_id = 'profile-owner'",
    )).rows[0].count,
    0,
  );
  assert.equal(
    (await database.query(
      "SELECT count(*)::int AS count FROM member_profile_reconciliation WHERE discord_user_id = 'profile-owner'",
    )).rows[0].count,
    0,
  );
});

test('repeated guild departures hide and enqueue a profile without changing membership or audits', async () => {
  await resetAndMigrate();
  await seedMember('departed-profile-owner');
  await insertProfile(validProfile('departed-profile-owner', {
    forumThreadId: 'directory-thread-departure',
    forumMessageId: 'directory-message-departure',
  }));

  await hideDepartedMemberProfile({ id: 'departed-profile-owner' }, { db: database });
  await hideDepartedMemberProfile({ id: 'departed-profile-owner' }, { db: database });

  const profile = await database.query(
    `SELECT visibility, forum_thread_id, forum_message_id
       FROM member_profiles WHERE discord_user_id = $1`,
    ['departed-profile-owner'],
  );
  const reconciliation = await database.query(
    `SELECT desired_generation, status
       FROM member_profile_reconciliation WHERE discord_user_id = $1`,
    ['departed-profile-owner'],
  );
  const member = await database.query(
    'SELECT status FROM members WHERE discord_user_id = $1',
    ['departed-profile-owner'],
  );
  const audits = await database.query(
    "SELECT count(*)::int AS count FROM audit_log WHERE action = 'member.remove'",
  );

  assert.deepEqual(profile.rows[0], {
    visibility: 'hidden',
    forum_thread_id: 'directory-thread-departure',
    forum_message_id: 'directory-message-departure',
  });
  assert.deepEqual(reconciliation.rows[0], { desired_generation: '1', status: 'pending' });
  assert.equal(member.rows[0].status, 'active');
  assert.equal(audits.rows[0].count, 0);
});

test('profile reconciliation records failures, retries successfully, and clears hidden posts', async () => {
  await resetAndMigrate();
  await seedMember('profile-reconciliation-owner', 'Bocconi');
  await insertProfile(validProfile('profile-reconciliation-owner'));
  await database.transaction((client) => requestProfileReconciliation(client, 'profile-reconciliation-owner'));

  const guild = directoryGuild({ failCreates: 1 });
  const failed = await reconcileProfile({
    discordUserId: 'profile-reconciliation-owner',
    guild,
    db: database,
  });
  assert.equal(failed.status, 'failed');
  assert.deepEqual(
    (await database.query(
      'SELECT status, attempts FROM member_profile_reconciliation WHERE discord_user_id = $1',
      ['profile-reconciliation-owner'],
    )).rows[0],
    { status: 'failed', attempts: 1 },
  );

  const retried = await retryProfileReconciliations({ guild, db: database, limit: 1 });
  assert.equal(retried[0].status, 'succeeded');
  const published = (await database.query(
    `SELECT visibility, forum_thread_id, forum_message_id
       FROM member_profiles WHERE discord_user_id = $1`,
    ['profile-reconciliation-owner'],
  )) as unknown as {
    rows: Array<{ visibility: string; forum_thread_id: string | null; forum_message_id: string | null }>;
  };
  assert.equal(published.rows[0].visibility, 'published');
  assert.ok(published.rows[0].forum_thread_id);
  assert.ok(published.rows[0].forum_message_id);
  assert.equal(guild.directoryThreadCount(), 1);

  await database.transaction((client) => hideProfileAndEnqueue(client, 'profile-reconciliation-owner'));
  const hidden = await reconcileProfile({
    discordUserId: 'profile-reconciliation-owner',
    guild,
    db: database,
  });
  assert.equal(hidden.status, 'succeeded');
  assert.deepEqual(
    (await database.query(
      `SELECT visibility, forum_thread_id, forum_message_id
         FROM member_profiles WHERE discord_user_id = $1`,
      ['profile-reconciliation-owner'],
    )).rows[0],
    { visibility: 'hidden', forum_thread_id: null, forum_message_id: null },
  );
  assert.equal(guild.directoryThreadCount(), 0);
});
