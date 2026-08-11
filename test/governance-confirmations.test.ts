import assert from 'node:assert/strict';
import test from 'node:test';

import { ComponentType, MessageFlags } from 'discord.js';

import {
  createBoardRoleRemovalConfirmationService,
  parseBoardRemovalConfirmationId,
} from '../src/services/governance/confirmations.js';

function components(payload) {
  const queue = [...payload.components.map((component) => component.toJSON?.() ?? component)];
  const values = [];
  while (queue.length > 0) {
    const component = queue.shift();
    values.push(component);
    if (component.components) queue.push(...component.components);
  }
  return values;
}

function panelText(payload) {
  return components(payload)
    .filter((component) => component.type === ComponentType.TextDisplay)
    .map((component) => component.content)
    .join('\n');
}

function actionId(payload, suffix) {
  return components(payload).find((component) => component.custom_id?.endsWith(`:${suffix}`))?.custom_id;
}

function input() {
  return {
    user: { id: 'target', username: 'Target' },
    university: 'Bocconi',
    role: 'vice_president',
    division: null,
    reason: 'Term completed',
  };
}

test('board role removal confirmation is private, actor-bound, and performs the mutation once', async () => {
  let removed = 0;
  let handoff;
  const service = createBoardRoleRemovalConfirmationService({
    id: () => 'session',
    removeRole: async () => {
      removed += 1;
      return {
        target: {
          id: 'target',
          displayName: 'Target',
          async send(payload) { handoff = payload; },
        },
        university: { name: 'Bocconi' },
        role: 'vice_president',
        division: null,
      };
    },
    formatActivity: () => ({ embeds: [{ title: 'activity' }] }),
    postActivity: async () => ({ status: 'posted', channel: { id: 'bot-log' } }),
  });

  let initial;
  await service.start({
    guildId: 'guild',
    user: { id: 'actor' },
    async reply(payload) { initial = payload; },
  }, input());

  assert.equal(initial.flags, MessageFlags.Ephemeral | MessageFlags.IsComponentsV2);
  assert.match(panelText(initial), /^\*\*Remove board role\?\*\*/);
  const confirmId = actionId(initial, 'confirm');
  assert.deepEqual(parseBoardRemovalConfirmationId(confirmId), { sessionId: 'session', action: 'confirm' });

  let waiting;
  let final;
  await service.handleButton({
    customId: confirmId,
    guildId: 'guild',
    user: { id: 'actor' },
    channel: { id: 'bot-log' },
    async update(payload) { waiting = payload; },
    async editReply(payload) { final = payload; },
  });

  assert.equal(removed, 1);
  assert.match(panelText(waiting), /^\*\*Removing board role\*\*/);
  assert.match(panelText(final), /^\*\*Board role removed\*\*/);
  assert.match(handoff.content, /Term completed/);
  assert.equal(service.activeSessionCount(), 0);
  await assert.rejects(
    () => service.handleButton({
      customId: confirmId,
      guildId: 'guild',
      user: { id: 'actor' },
    }),
    /expired/,
  );
  assert.equal(removed, 1);
});

test('board role removal can be cancelled and cannot be confirmed by another actor', async () => {
  let removed = 0;
  const service = createBoardRoleRemovalConfirmationService({
    id: () => 'session',
    removeRole: async () => {
      removed += 1;
      return {
        target: { id: 'target', async send() {} },
        university: { name: 'Bocconi' },
        role: 'vice_president',
        division: null,
      };
    },
  });
  let initial;
  await service.start({
    guildId: 'guild',
    user: { id: 'actor' },
    async reply(payload) { initial = payload; },
  }, input());

  const confirmId = actionId(initial, 'confirm');
  await assert.rejects(
    () => service.handleButton({ customId: confirmId, guildId: 'guild', user: { id: 'intruder' } }),
    /another member/,
  );

  let cancelled;
  await service.handleButton({
    customId: actionId(initial, 'cancel'),
    guildId: 'guild',
    user: { id: 'actor' },
    async update(payload) { cancelled = payload; },
  });
  assert.match(panelText(cancelled), /^\*\*Board role kept\*\*/);
  assert.equal(removed, 0);
  assert.equal(service.activeSessionCount(), 0);
});

test('a committed removal reports delivery failures without offering an unsafe retry', async () => {
  const service = createBoardRoleRemovalConfirmationService({
    id: () => 'session',
    removeRole: async () => ({
      target: {
        id: 'target',
        async send() { throw new Error('DM disabled'); },
      },
      university: { name: 'Bocconi' },
      role: 'vice_president',
      division: null,
    }),
    formatActivity: () => ({ embeds: [{ title: 'activity' }] }),
    postActivity: async () => ({ status: 'failed', channel: null }),
  });
  let initial;
  await service.start({
    guildId: 'guild',
    user: { id: 'actor' },
    async reply(payload) { initial = payload; },
  }, input());
  let final;
  await service.handleButton({
    customId: actionId(initial, 'confirm'),
    guildId: 'guild',
    user: { id: 'actor' },
    async update() {},
    async editReply(payload) { final = payload; },
  });

  assert.match(panelText(final), /role change was saved/i);
  assert.match(panelText(final), /activity card could not be posted/i);
  assert.match(panelText(final), /could not be reached by DM/i);
  assert.equal(components(final).some((component) => component.custom_id), false);
});
