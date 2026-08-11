import assert from 'node:assert/strict';
import test from 'node:test';

import { ComponentType, MessageFlags } from 'discord.js';

import { createBoardInfoPanelService } from '../src/services/governance/board-info-panel.js';

function components(payload) {
  const queue = [...(payload.components ?? []).map((component) => component.toJSON?.() ?? component)];
  const result = [];
  while (queue.length) {
    const component = queue.shift();
    result.push(component);
    if (component.components) queue.push(...component.components);
  }
  return result;
}

function action(payload, suffix) {
  const component = components(payload).find((candidate) => candidate.custom_id?.endsWith(`:${suffix}`));
  assert.ok(component, `Missing board-info action ${suffix}`);
  return component;
}

function panelText(payload) {
  return components(payload)
    .filter((component) => component.type === ComponentType.TextDisplay)
    .map((component) => component.content)
    .join('\n');
}

test('board-info keeps the completed roster in Components V2 after choosing a university', async () => {
  const panel = createBoardInfoPanelService({
    loadUniversities: async () => [{ id: 'bocconi', name: 'Bocconi' }],
    loadBoardInfo: async () => ({
      university: { name: 'Bocconi' },
      divisions: [{ id: 'analysis', name: 'Analysis', color: 'blue' }],
      rows: [{
        discord_user_id: 'president',
        role: 'president',
        division_id: null,
        missingRoles: [],
      }],
    }),
  });
  const channel = { name: 'bot-log', parent: { name: 'LOGS' } };
  const member = { roles: { cache: [{ name: 'Global President' }] } };
  let payload;
  await panel.start({
    guildId: 'guild',
    user: { id: 'actor' },
    member,
    channel,
    async reply(next) { payload = next; },
  });

  await panel.handleStringSelect({
    guildId: 'guild',
    user: { id: 'actor' },
    member,
    channel,
    customId: action(payload, 'u').custom_id,
    values: ['bocconi'],
    async update(next) { payload = next; },
  });

  let loading;
  let completed;
  await panel.handleButton({
    guildId: 'guild',
    user: { id: 'actor' },
    member,
    channel,
    customId: action(payload, 'c').custom_id,
    isButton: () => true,
    async update(next) { loading = next; },
    async editReply(next) { completed = next; },
  });

  assert.match(panelText(loading), /Loading the Bocconi board/);
  assert.equal(completed.embeds, undefined);
  assert.equal(completed.flags, MessageFlags.IsComponentsV2);
  assert.match(panelText(completed), /Bocconi board/);
  assert.match(panelText(completed), /Discord roles match the recorded board roster/);
});
