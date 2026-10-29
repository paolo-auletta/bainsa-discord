import test from 'node:test';
import assert from 'node:assert/strict';
import { Collection } from 'discord.js';

import { ensureSlurmWebhook, slurmHookMessage, SLURM_WEBHOOK_NAME } from '../src/services/projects/slurm-hook.js';

function fakeChannel(webhooks) {
  const created = [];
  return {
    created,
    fetchWebhooks: async () => new Collection(webhooks.map((webhook) => [webhook.id, webhook])),
    createWebhook: async ({ name }) => {
      const webhook = { id: `new-${created.length}`, name, token: 't', url: 'https://discord.com/api/webhooks/new' };
      created.push(webhook);
      return webhook;
    },
  };
}

function hook(id, ownerId, extra = {}) {
  return { id, name: SLURM_WEBHOOK_NAME, owner: { id: ownerId }, token: 't', url: `https://hook/${id}`, deleted: false,
    async delete() { this.deleted = true; }, ...extra };
}

test('reuses the bot-owned Slurm webhook so the URL stays stable', async () => {
  const mine = hook('1', 'bot');
  const channel = fakeChannel([hook('2', 'someone-else'), mine]);
  assert.equal(await ensureSlurmWebhook(channel, 'bot'), mine);
  assert.equal(channel.created.length, 0);
});

test('creates a webhook when none exists', async () => {
  const channel = fakeChannel([hook('2', 'someone-else')]);
  const webhook = await ensureSlurmWebhook(channel, 'bot');
  assert.equal(webhook.name, SLURM_WEBHOOK_NAME);
  assert.equal(channel.created.length, 1);
});

test('reset deletes the old bot webhook and creates a new one', async () => {
  const mine = hook('1', 'bot');
  const foreign = hook('2', 'someone-else');
  const channel = fakeChannel([mine, foreign]);
  await ensureSlurmWebhook(channel, 'bot', { reset: true });
  assert.equal(mine.deleted, true);
  assert.equal(foreign.deleted, false);
  assert.equal(channel.created.length, 1);
});

test('the private reply contains the URL, ping, and paste instructions', () => {
  const json = JSON.stringify(slurmHookMessage({ discord_channel_id: 'c1' }, 'https://hook/abc', '42', false));
  assert.match(json, /https:\/\/hook\/abc/);
  assert.match(json, /BAINSA_PING='<@42>'/);
  assert.match(json, /after the `#SBATCH` lines/);
  assert.match(json, /trap bainsa_notify EXIT/);
});
