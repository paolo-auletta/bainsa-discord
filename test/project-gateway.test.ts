import assert from 'node:assert/strict';
import test from 'node:test';

import { ChannelType } from 'discord.js';

import {
  createShowcaseThread,
  updateProjectChannel,
  updateShowcaseThread,
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
  notes: '@here private update',
  showcase_channel_id: 'showcase',
  showcase_thread_id: 'showcase-thread',
  discord_channel_id: 'project-channel',
};
const people = [{ discord_user_id: 'member', role: 'supervisor' }];

test('project history messages disable implicit Discord mentions', async () => {
  let createPayload;
  let showcasePayload;
  let channelPayload;
  const forum = {
    type: ChannelType.GuildForum,
    availableTags: [{ id: 'analysis', name: 'Analysis' }],
    threads: { async create(payload) { createPayload = payload; return { id: 'created-thread' }; } },
  };
  const showcaseThread = {
    async setName() {},
    async send(payload) { showcasePayload = payload; },
  };
  const projectChannel = { async send(payload) { channelPayload = payload; } };
  const guild = {
    channels: {
      async fetch(id) {
        return {
          showcase: forum,
          'showcase-thread': showcaseThread,
          'project-channel': projectChannel,
        }[id] ?? null;
      },
    },
  };

  await createShowcaseThread(guild, project, people);
  await updateShowcaseThread(guild, project, people, '@everyone status');
  await updateProjectChannel(guild, project, people, '@here status');

  assert.deepEqual(createPayload.message.allowedMentions, { parse: [] });
  assert.deepEqual(showcasePayload.allowedMentions, { parse: [] });
  assert.deepEqual(channelPayload.allowedMentions, { parse: [] });
});
