import assert from 'node:assert/strict';
import test from 'node:test';

import { ChannelType, ComponentType, MessageFlags } from 'discord.js';

import { deleteProfileForumPosts, upsertProfileForumPost } from '../src/profiles/gateway.js';

const post = Object.freeze({
  threadName: 'Ada Lovelace — Researcher building practical AI systems',
  sections: [
    '## Ada Lovelace\n**Discord** · <@owner>',
    '### Current focus\nMSc student',
    '### Looking to explore\nApplied AI',
  ],
  content: '## Ada Lovelace\n**Discord** · <@owner>\n\n### Current focus\nMSc student\n\n### Looking to explore\nApplied AI',
  appliedTagLabels: ['Bocconi', 'AI & Data'],
  allowedMentions: { parse: [] },
});

function forumWith(threads = {}) {
  const forum = {
    id: 'forum',
    name: 'people-database',
    type: ChannelType.GuildForum,
    availableTags: [{ id: 'bocconi', name: 'Bocconi' }, { id: 'ai', name: 'AI & Data' }],
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
  const thread = {
    id: 'thread-1', parentId: 'forum', archived: false,
    async send() { throw new Error('a profile must contain only the starter message'); },
    async fetchStarterMessage() { return starter; },
  };
  const guild = forumWith({
    async create(payload) { createPayload = payload; guild.add(thread); return thread; },
    async fetchActive() { return { threads: new Map() }; },
    async fetchArchived() { return { threads: new Map() }; },
  });

  const identity = await upsertProfileForumPost({ guild, ownerId: 'owner', post });
  assert.deepEqual(identity, { forumThreadId: 'thread-1', forumMessageId: 'thread-1', created: true });
  assert.equal(createPayload.autoArchiveDuration, 10_080);
  assert.deepEqual(createPayload.appliedTags, ['bocconi', 'ai']);
  assert.deepEqual(createPayload.message.allowedMentions, { parse: [] });
  assert.equal(createPayload.message.content, undefined);
  assert.equal(createPayload.message.flags, MessageFlags.IsComponentsV2);
  assert.equal(createPayload.message.components.length, 1);
  const card = createPayload.message.components[0].toJSON();
  assert.equal(card.accent_color, 0x5865f2);
  assert.deepEqual(card.components.filter((component) => component.type === ComponentType.TextDisplay).map((component) => component.content), post.sections);
  assert.equal(card.components.filter((component) => component.type === ComponentType.Separator).length, 2);
  assert.ok(card.components.length < 30);
});

test('updates the existing starter in place after unarchiving and changing tags', async () => {
  let unarchived = 0;
  let edited = 0;
  let tags;
  let name;
  const starterEdits = [];
  const deletedSections = [];
  const starter = { id: 'thread-1', author: { id: 'bot' }, content: post.content, embeds: [{ title: 'Legacy contact' }], async edit(payload) { edited += 1; starterEdits.push(payload); } };
  const sections = [
    { id: 'section-1', author: { id: 'bot' }, content: '## 🔭 What I’d like to explore next\nOld', async delete() { deletedSections.push(this.id); } },
    { id: 'section-2', author: { id: 'bot' }, content: '## 🧭 Discover & connect\nOld', async delete() { deletedSections.push(this.id); } },
  ];
  const thread = {
    id: 'thread-1', parentId: 'forum', archived: true, name: 'old', appliedTags: ['old'],
    messages: { async fetch() { return new Map([[starter.id, starter], ...sections.map((message) => [message.id, message])]); } },
    async fetchStarterMessage() { return starter; },
    async setArchived(value) { assert.equal(value, false); unarchived += 1; },
    async setName(value) { name = value; },
    async setAppliedTags(value) { tags = value; },
  };
  const guild = forumWith({ async fetchActive() { return { threads: new Map() }; }, async fetchArchived() { return { threads: new Map() }; } });
  guild.add(thread);
  const updatedPost = {
    ...post,
    sections: [post.sections[0], '### Current focus\nUpdated role', post.sections[2]],
    content: post.content.replace('MSc student', 'Updated role'),
  };
  const identity = await upsertProfileForumPost({ guild, ownerId: 'owner', post: updatedPost, forumThreadId: 'thread-1', forumMessageId: 'old-message' });
  assert.equal(identity.created, false);
  assert.equal(unarchived, 1);
  assert.equal(edited, 2);
  assert.equal(name, updatedPost.threadName);
  assert.deepEqual(tags, ['bocconi', 'ai']);
  assert.deepEqual(starterEdits[0], { content: null, embeds: [], components: [] });
  assert.equal(starterEdits[1].flags, MessageFlags.IsComponentsV2);
  const updatedText = starterEdits[1].components[0].toJSON().components
    .filter((component) => component.type === ComponentType.TextDisplay)
    .map((component) => component.content);
  assert.deepEqual(updatedText, updatedPost.sections);
  assert.deepEqual(deletedSections, ['section-1', 'section-2']);
});

test('single-message reconciliation removes every legacy managed section and preserves unrelated messages', async () => {
  const deleted = [];
  const starter = {
    id: 'thread-1', author: { id: 'bot' }, content: post.content,
    async edit() {},
  };
  const legacy = [
    ['exploring-1', '## 🔭 What I’d like to explore next'],
    ['exploring-2', '## 🔭 What I’d like to explore next'],
    ['connect', '## 🧭 Discover & connect'],
  ].map(([id, heading]) => ({
    id,
    author: { id: 'bot' },
    content: `${heading}\nOld`,
    async delete() { deleted.push(this.id); },
  }));
  const unrelated = { id: 'unrelated', author: { id: 'bot' }, content: 'An unrelated bot message', async delete() { deleted.push(this.id); } };
  const messages = [starter, ...legacy, unrelated];
  const thread = {
    id: 'thread-1', parentId: 'forum', archived: false, name: post.threadName, appliedTags: ['bocconi', 'ai'],
    messages: { async fetch() { return new Map(messages.map((message) => [message.id, message])); } },
    async fetchStarterMessage() { return starter; },
  };
  const guild = forumWith({ async fetchActive() { return { threads: new Map() }; }, async fetchArchived() { return { threads: new Map() }; } });
  guild.add(thread);

  await upsertProfileForumPost({ guild, ownerId: 'owner', post, forumThreadId: thread.id });

  assert.deepEqual(deleted.sort(), ['connect', 'exploring-1', 'exploring-2']);
});

test('adopts the oldest natural owner post and removes confirmed duplicates', async () => {
  const calls = [];
  const candidate = (id, createdTimestamp) => ({
    id, parentId: 'forum', createdTimestamp, archived: false, name: post.threadName, appliedTags: ['bocconi', 'ai'],
    messages: { async fetch() { return new Map(); } },
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
  assert.deepEqual(calls, ['delete:duplicate', 'edit:oldest', 'edit:oldest']);

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

test('recovery scans subsequent archived pages before deciding to create', async () => {
  let archivedCalls = 0;
  let creates = 0;
  const recovered = {
    id: 'recovered', parentId: 'forum', createdTimestamp: 1, archived: true,
    name: post.threadName, appliedTags: ['bocconi', 'ai'],
    messages: { async fetch() { return new Map(); } },
    async setArchived() {},
    async fetchStarterMessage() {
      return {
        id: 'recovered', author: { id: 'bot' }, content: '',
        components: [{ toJSON: () => ({ content: post.content }) }],
        flags: { has: (flag) => flag === MessageFlags.IsComponentsV2 },
        async edit() {},
      };
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

test('recovery stops at the archived-page ceiling without creating a possible duplicate', async () => {
  let archivedCalls = 0;
  let creates = 0;
  const guild = forumWith({
    async fetchActive() { return { threads: new Map() }; },
    async fetchArchived() {
      archivedCalls += 1;
      return {
        threads: new Map([[`unrelated-${archivedCalls}`, {
          id: `unrelated-${archivedCalls}`,
          async fetchStarterMessage() { return { author: { id: 'bot' }, content: 'another member' }; },
        }]]),
        hasMore: true,
      };
    },
    async create() { creates += 1; },
  });

  await assert.rejects(
    () => upsertProfileForumPost({ guild, ownerId: 'owner', post }),
    /archived-thread scan limit/,
  );
  assert.equal(archivedCalls, 10);
  assert.equal(creates, 0);
});

test('duplicate deletion is concurrency-bounded during unpublish cleanup', async () => {
  let deleting = 0;
  let maxDeleting = 0;
  const deleted = [];
  const threads = Array.from({ length: 12 }, (_, index) => {
    const id = `duplicate-${index}`;
    return {
      id,
      async fetchStarterMessage() { return { id, author: { id: 'bot' }, content: post.content }; },
      async delete() {
        deleting += 1;
        maxDeleting = Math.max(maxDeleting, deleting);
        await new Promise((resolve) => setTimeout(resolve, 5));
        deleted.push(id);
        deleting -= 1;
      },
    };
  });
  const guild = forumWith({
    async fetchActive() { return { threads: new Map(threads.map((thread) => [thread.id, thread])) }; },
    async fetchArchived() { return { threads: new Map(), hasMore: false }; },
  });

  const result = await deleteProfileForumPosts({ guild, ownerId: 'owner' });
  assert.equal(maxDeleting, 5);
  assert.deepEqual(result.deletedThreadIds.sort(), threads.map(({ id }) => id).sort());
  assert.equal(deleted.length, threads.length);
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

test('stored owner-matched posts are deleted but cleanup stays retryable when the forum is unavailable', async () => {
  let deleted = 0;
  const stored = {
    id: 'stored-profile',
    parentId: 'renamed-forum',
    async fetchStarterMessage() {
      return { id: 'stored-profile', author: { id: 'bot' }, content: post.content };
    },
    async delete() { deleted += 1; },
  };
  const guild = {
    client: { user: { id: 'bot' } },
    channels: {
      cache: { find: () => null },
      async fetch(id) { return id === stored.id ? stored : new Map(); },
    },
  };

  await assert.rejects(
    () => deleteProfileForumPosts({ guild, ownerId: 'owner', forumThreadId: stored.id }),
    /people-database forum is unavailable/,
  );
  assert.equal(deleted, 1);
});
