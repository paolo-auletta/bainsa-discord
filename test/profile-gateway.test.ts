import assert from 'node:assert/strict';
import test from 'node:test';

import { ChannelType } from 'discord.js';

import { deleteProfileForumPosts, upsertProfileForumPost } from '../src/profiles/gateway.js';

const post = Object.freeze({
  threadName: 'Ada Lovelace — MSc student',
  content: '**Discord:** <@owner>',
  contactEmbed: null,
  appliedTagLabels: ['Researcher', 'AI & Data'],
  allowedMentions: { parse: [] },
});

function forumWith(threads = {}) {
  const forum = {
    id: 'forum',
    name: 'people-directory',
    type: ChannelType.GuildForum,
    availableTags: [{ id: 'researcher', name: 'Researcher' }, { id: 'ai', name: 'AI & Data' }],
    threads,
  };
  const channels = new Map([['forum', forum]]);
  return {
    client: { user: { id: 'bot' } },
    channels: {
      cache: { find: (predicate) => [...channels.values()].find(predicate) },
      async fetch(id) { return id == null ? channels : channels.get(id) ?? null; },
    },
    add(channel) { channels.set(channel.id, channel); },
    forum,
  };
}

test('creates one no-ping forum starter post and persists both current API identities', async () => {
  let createPayload;
  const starter = { id: 'thread-1', author: { id: 'bot' }, content: post.content, async edit() { throw new Error('not an update'); } };
  const thread = { id: 'thread-1', parentId: 'forum', archived: false, async fetchStarterMessage() { return starter; } };
  const guild = forumWith({
    async create(payload) { createPayload = payload; guild.add(thread); return thread; },
    async fetchActive() { return { threads: new Map() }; },
    async fetchArchived() { return { threads: new Map() }; },
  });

  const identity = await upsertProfileForumPost({ guild, ownerId: 'owner', post });
  assert.deepEqual(identity, { forumThreadId: 'thread-1', forumMessageId: 'thread-1', created: true });
  assert.equal(createPayload.autoArchiveDuration, 10_080);
  assert.deepEqual(createPayload.appliedTags, ['researcher', 'ai']);
  assert.deepEqual(createPayload.message.allowedMentions, { parse: [] });
  assert.equal(createPayload.message.content, post.content);
});

test('updates the existing starter in place after unarchiving and changing tags', async () => {
  let unarchived = 0;
  let edited = 0;
  let tags;
  let name;
  const starter = { id: 'thread-1', author: { id: 'bot' }, content: post.content, async edit(payload) { edited += 1; assert.equal(payload.content, post.content); } };
  const thread = {
    id: 'thread-1', parentId: 'forum', archived: true, name: 'old', appliedTags: ['old'],
    async fetchStarterMessage() { return starter; },
    async setArchived(value) { assert.equal(value, false); unarchived += 1; },
    async setName(value) { name = value; },
    async setAppliedTags(value) { tags = value; },
    async send() { throw new Error('profile synchronization must not append messages'); },
  };
  const guild = forumWith({ async fetchActive() { return { threads: new Map() }; }, async fetchArchived() { return { threads: new Map() }; } });
  guild.add(thread);
  const identity = await upsertProfileForumPost({ guild, ownerId: 'owner', post, forumThreadId: 'thread-1', forumMessageId: 'old-message' });
  assert.equal(identity.created, false);
  assert.equal(unarchived, 1);
  assert.equal(edited, 1);
  assert.equal(name, post.threadName);
  assert.deepEqual(tags, ['researcher', 'ai']);
});

test('adopts the oldest natural owner post and removes confirmed duplicates', async () => {
  const calls = [];
  const candidate = (id, createdTimestamp) => ({
    id, parentId: 'forum', createdTimestamp, archived: false, name: post.threadName, appliedTags: ['researcher', 'ai'],
    async fetchStarterMessage() { return { id, author: { id: 'bot' }, content: post.content, async edit() { calls.push(`edit:${id}`); } }; },
    async delete() { calls.push(`delete:${id}`); },
  });
  const oldest = candidate('oldest', 1);
  const duplicate = candidate('duplicate', 2);
  const guild = forumWith({
    async fetchActive() { return { threads: new Map([[oldest.id, oldest], [duplicate.id, duplicate]]) }; },
    async fetchArchived() { return { threads: new Map() }; },
    async create() { throw new Error('recovery should avoid a duplicate create'); },
  });
  const identity = await upsertProfileForumPost({ guild, ownerId: 'owner', post });
  assert.equal(identity.forumThreadId, 'oldest');
  assert.deepEqual(calls, ['delete:duplicate', 'edit:oldest']);

  calls.length = 0;
  await deleteProfileForumPosts({ guild, ownerId: 'owner', forumThreadId: 'missing' });
  assert.deepEqual(calls.sort(), ['delete:duplicate', 'delete:oldest']);
});

test('transient Discord fetch failures stay retryable and never create a duplicate post', async () => {
  let creates = 0;
  const guild = forumWith({
    async fetchActive() { throw Object.assign(new Error('temporary outage'), { code: 50_013 }); },
    async fetchArchived() { return { threads: new Map(), hasMore: false }; },
    async create() { creates += 1; },
  });
  await assert.rejects(
    () => upsertProfileForumPost({ guild, ownerId: 'owner', post }),
    /temporary outage/,
  );
  assert.equal(creates, 0);

  const originalFetch = guild.channels.fetch;
  guild.channels.fetch = async (id) => {
    if (id === 'stored') throw Object.assign(new Error('gateway timeout'), { code: 50_013 });
    return originalFetch(id);
  };
  await assert.rejects(
    () => upsertProfileForumPost({ guild, ownerId: 'owner', post, forumThreadId: 'stored' }),
    /gateway timeout/,
  );
  assert.equal(creates, 0);
});

test('recovery scans every archived page before deciding to create', async () => {
  let archivedCalls = 0;
  let creates = 0;
  const recovered = {
    id: 'recovered', parentId: 'forum', createdTimestamp: 1, archived: true,
    name: post.threadName, appliedTags: ['researcher', 'ai'],
    async setArchived() {},
    async fetchStarterMessage() {
      return { id: 'recovered', author: { id: 'bot' }, content: post.content, async edit() {} };
    },
  };
  const guild = forumWith({
    async fetchActive() { return { threads: new Map() }; },
    async fetchArchived({ before } = {}) {
      archivedCalls += 1;
      if (!before) return { threads: new Map([['unrelated', {
        id: 'unrelated', parentId: 'forum', archived: true,
        async fetchStarterMessage() { return { author: { id: 'bot' }, content: 'another member' }; },
      }]]), hasMore: true };
      return { threads: new Map([[recovered.id, recovered]]), hasMore: false };
    },
    async create() { creates += 1; },
  });
  const identity = await upsertProfileForumPost({ guild, ownerId: 'owner', post });
  assert.equal(identity.forumThreadId, 'recovered');
  assert.equal(archivedCalls, 2);
  assert.equal(creates, 0);
});

test('unpublishing never deletes a stored thread that is not confidently owner-matched', async () => {
  let deleted = 0;
  const wrongOwner = {
    id: 'wrong-owner', parentId: 'forum',
    async fetchStarterMessage() {
      return { id: 'wrong-owner', author: { id: 'bot' }, content: '**Discord:** <@somebody-else>' };
    },
    async delete() { deleted += 1; },
  };
  const guild = forumWith({
    async fetchActive() { return { threads: new Map() }; },
    async fetchArchived() { return { threads: new Map(), hasMore: false }; },
  });
  guild.add(wrongOwner);
  const result = await deleteProfileForumPosts({
    guild,
    ownerId: 'owner',
    forumThreadId: wrongOwner.id,
  });
  assert.deepEqual(result.deletedThreadIds, []);
  assert.equal(deleted, 0);
});
