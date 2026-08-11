import assert from 'node:assert/strict';
import test from 'node:test';

import { ChannelType } from 'discord.js';

import {
  syncProjectHome,
  syncProjectWorkspaceGuide,
  syncShowcaseThread,
} from '../src/services/projects/gateway.js';

const project = {
  id: 42,
  name: '@everyone project',
  university_name: 'Bocconi',
  division_name: 'Analysis',
  division_color: 'orange',
  status: 'active',
  start_date: '2026-07-01',
  expected_end: '2026-08-01',
  summary: 'Public project summary',
  notes: '@here private update',
  outcome: null,
  final_notes: null,
  showcase_channel_id: 'showcase',
  showcase_thread_id: null,
  discord_channel_id: 'project-channel',
  home_message_id: null,
  workspace_guide_message_id: null,
};
const people = [{ discord_user_id: 'member', role: 'supervisor' }];

test('showcase creation applies division and active lifecycle tags without pinging authored text', async () => {
  let createPayload;
  const createdThread = {
    id: 'created-thread',
    async fetchStarterMessage() { return { id: 'created-thread' }; },
  };
  const forum = {
    type: ChannelType.GuildForum,
    availableTags: [
      { id: 'analysis', name: 'Analysis' },
      { id: 'active', name: 'Active' },
      { id: 'paused', name: 'Paused' },
      { id: 'completed', name: 'Completed' },
    ],
    threads: {
      async create(payload) {
        createPayload = payload;
        return createdThread;
      },
    },
  };
  const guild = { channels: { async fetch(id) { return id === 'showcase' ? forum : null; } } };

  const thread = await syncShowcaseThread(guild, project, people);

  assert.equal(thread, createdThread);
  assert.deepEqual(createPayload.appliedTags, ['analysis', 'active']);
  assert.deepEqual(createPayload.message.allowedMentions, { parse: [] });
  assert.match(createPayload.message.content, /^## @everyone project/);
  assert.match(createPayload.message.content, /\*\*Summary\*\*\nPublic project summary/);
  assert.equal(JSON.stringify(createPayload.message).includes('@here private update'), false);
  assert.doesNotMatch(createPayload.message.content, /handover/i);
});

test('a missing or invalid configured showcase forum keeps reconciliation retryable', async () => {
  const guild = { channels: { async fetch() { return null; } } };
  await assert.rejects(
    () => syncShowcaseThread(guild, { ...project, showcase_channel_id: null }, people),
    /no configured university showcase forum/,
  );
  await assert.rejects(
    () => syncShowcaseThread(guild, project, people),
    /showcase forum is missing/,
  );
  await assert.rejects(
    () => syncShowcaseThread(
      { channels: { async fetch() { return { type: ChannelType.GuildText }; } } },
      project,
      people,
    ),
    /showcase channel is not a forum/,
  );
});

test('showcase reconciliation edits the starter and lifecycle tags instead of appending snapshots', async () => {
  let editedPayload;
  let appliedTags;
  let sent = false;
  const starter = { async edit(payload) { editedPayload = payload; } };
  const thread = {
    id: 'showcase-thread',
    name: '@everyone project',
    archived: false,
    locked: false,
    async fetchStarterMessage() { return starter; },
    async setAppliedTags(tags) { appliedTags = tags; },
    async send() { sent = true; },
  };
  const forum = {
    type: ChannelType.GuildForum,
    availableTags: [
      { id: 'analysis', name: 'Analysis' },
      { id: 'active', name: 'Active' },
      { id: 'paused', name: 'Paused' },
      { id: 'completed', name: 'Completed' },
    ],
  };
  const completed = {
    ...project,
    status: 'completed',
    outcome: 'Published the final report.',
    final_notes: 'PRIVATE HANDOVER',
    showcase_thread_id: 'showcase-thread',
  };
  const guild = {
    channels: {
      async fetch(id) {
        return { showcase: forum, 'showcase-thread': thread }[id] ?? null;
      },
    },
  };

  await syncShowcaseThread(guild, completed, people);

  assert.deepEqual(appliedTags, ['analysis', 'completed']);
  assert.equal(sent, false);
  assert.deepEqual(editedPayload.allowedMentions, { parse: [] });
  assert.match(editedPayload.content, /\*\*Conclusion\*\*\nPublished the final report\./);
  assert.equal(editedPayload.content.includes('PRIVATE HANDOVER'), false);
});

test('project home reconciliation edits and pins one canonical overview', async () => {
  let editedPayload;
  let pinReason;
  let sent = false;
  const message = {
    id: 'home',
    pinned: false,
    async edit(payload) { editedPayload = payload; },
    async pin(reason) { pinReason = reason; },
  };
  const channel = {
    messages: {
      async fetch(id) {
        assert.equal(id, 'home');
        return message;
      },
    },
    async send() { sent = true; },
  };
  const guild = {
    channels: {
      async fetch(id) { return id === 'project-channel' ? channel : null; },
    },
  };

  const result = await syncProjectHome(guild, { ...project, home_message_id: 'home' }, people);

  assert.equal(result, message);
  assert.equal(sent, false);
  assert.match(pinReason, /canonical project 42 overview/);
  assert.deepEqual(editedPayload.allowedMentions, { parse: [] });
  assert.equal(editedPayload.embeds, undefined);
  assert.match(editedPayload.content, /^## @everyone project/);
  assert.match(editedPayload.content, /\*\*Division:\*\* 🟧 Analysis/);
  assert.match(editedPayload.content, /Pinned project record · Updates automatically$/);
});

test('project workspace guide is a separate pinned normal message', async () => {
  let editedPayload;
  let pinReason;
  let sent = false;
  const message = {
    id: 'workspace-guide',
    pinned: false,
    async edit(payload) { editedPayload = payload; },
    async pin(reason) { pinReason = reason; },
  };
  const channel = {
    messages: {
      async fetch(id) {
        assert.equal(id, 'workspace-guide');
        return message;
      },
    },
    async send() { sent = true; },
  };
  const guild = {
    channels: {
      async fetch(id) { return id === 'project-channel' ? channel : null; },
    },
  };

  const result = await syncProjectWorkspaceGuide(
    guild,
    { ...project, workspace_guide_message_id: 'workspace-guide' },
  );

  assert.equal(result, message);
  assert.equal(sent, false);
  assert.match(pinReason, /project 42 workspace guide/);
  assert.deepEqual(editedPayload.allowedMentions, { parse: [] });
  assert.match(editedPayload.content, /^## How to use this space/);
  assert.match(editedPayload.content, /`\/project-info`/);
  assert.match(editedPayload.content, /Pinned workspace guide$/);
});

test('canonical record fetches retry transient Discord failures instead of creating duplicates', async () => {
  const transient = Object.assign(new Error('Discord unavailable'), { code: 50_000 });
  const forumGuild = {
    channels: {
      async fetch() { throw transient; },
    },
  };
  await assert.rejects(() => syncShowcaseThread(forumGuild, project, people), transient);

  let sends = 0;
  const homeGuild = {
    channels: {
      async fetch() {
        return {
          messages: { async fetch() { throw transient; } },
          async send() { sends += 1; },
        };
      },
    },
  };
  await assert.rejects(
    () => syncProjectHome(homeGuild, { ...project, home_message_id: 'home' }, people),
    transient,
  );
  assert.equal(sends, 0);
});

test('deleted canonical messages are repaired without treating them as transient failures', async () => {
  const missing = Object.assign(new Error('Unknown Message'), { code: 10_008 });
  const replacement = { id: 'replacement', pinned: true };
  let sends = 0;
  const guild = {
    channels: {
      async fetch() {
        return {
          messages: {
            async fetch(input) {
              if (typeof input === 'string') throw missing;
              return new Map();
            },
            async fetchPins() { return { items: [] }; },
          },
          async send() {
            sends += 1;
            return replacement;
          },
        };
      },
    },
  };

  assert.equal(await syncProjectHome(guild, { ...project, home_message_id: 'deleted' }, people), replacement);
  assert.equal(sends, 1);
});

test('a project home is adopted after a pin failure instead of being duplicated', async () => {
  const transient = new Error('Pin failed');
  let sends = 0;
  let pinAttempts = 0;
  let sentMessage = null;
  const channel = {
    client: { user: { id: 'bot' } },
    messages: {
      async fetch() { return new Map(sentMessage ? [[sentMessage.id, sentMessage]] : []); },
      async fetchPins() { return { items: [] }; },
    },
    async send(payload) {
      sends += 1;
      sentMessage = {
        id: 'home',
        author: { id: 'bot' },
        content: payload.content,
        pinned: false,
        async edit() {},
        async pin() {
          pinAttempts += 1;
          if (pinAttempts === 1) throw transient;
          this.pinned = true;
        },
      };
      return sentMessage;
    },
  };
  const guild = { channels: { async fetch() { return channel; } } };

  await assert.rejects(() => syncProjectHome(guild, project, people), transient);
  assert.equal(await syncProjectHome(guild, project, people), sentMessage);
  assert.equal(sends, 1);
  assert.equal(pinAttempts, 2);
  assert.equal(sentMessage.pinned, true);
});
