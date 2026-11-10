import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Collection } from 'discord.js';

import { PROJECT_PERSON_ROLES } from '../src/constants.js';
import {
  createSlurmHook, ensureSlurmWebhook, slurmHookMessage, slurmSnippet, SLURM_WEBHOOK_NAME,
} from '../src/services/projects/slurm-hook.js';

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

test('reset also removes a bot webhook that was renamed in Discord', async () => {
  const renamed = hook('1', 'bot', { name: 'renamed' });
  const channel = fakeChannel([renamed]);
  await ensureSlurmWebhook(channel, 'bot', { reset: true });
  assert.equal(renamed.deleted, true);
});

function hookInput(status, { reset = false, memberId = 'sup' } = {}) {
  const existing = hook('1', 'bot');
  const channel = fakeChannel([existing]);
  // Typed loosely on purpose: the fake only answers the two queries createSlurmHook makes.
  const db = {
    query: async (sql) => (sql.includes('project_people')
      ? { rowCount: 1, rows: [{ discord_user_id: 'sup', role: PROJECT_PERSON_ROLES.SUPERVISOR }] }
      : { rowCount: 1, rows: [{ id: '7', name: 'Proj', status, discord_channel_id: 'c1', university_name: 'Bocconi', division_name: 'Research' }] }),
    transaction: async () => assert.fail('unexpected transaction'),
  } as never;
  const interaction = {
    member: { id: memberId, roles: { cache: new Collection() } },
    channel: null,
    client: { user: { id: 'bot' } },
    guild: { channels: { fetch: async () => channel } },
  };
  return { channel, existing, db, input: { interaction, project: '7', pingUserId: null, reset } };
}

test('createSlurmHook refuses non-supervisors and closed projects without reset', async () => {
  const outsider = hookInput('active', { memberId: 'other' });
  await assert.rejects(createSlurmHook(outsider.input, { db: outsider.db }), /supervisors/);
  const closed = hookInput('completed');
  await assert.rejects(createSlurmHook(closed.input, { db: closed.db }), /cannot be changed/);
});

test('reset on a closed project only revokes the webhook', async () => {
  const { channel, existing, db, input } = hookInput('archived', { reset: true });
  const reply = JSON.stringify(await createSlurmHook(input, { db }));
  assert.match(reply, /Slurm webhook removed/);
  assert.equal(channel.created.length, 0);
  assert.equal(existing.deleted, true);
});

test('the snippet posts valid, truncated JSON with hostile job names', { skip: process.platform === 'win32' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'slurm-hook-'));
  writeFileSync(join(dir, 'curl'), '#!/bin/bash\nwhile [ $# -gt 0 ]; do [ "$1" = -d ] && printf %s "$2" > "$OUT"; shift; done\n');
  chmodSync(join(dir, 'curl'), 0o755);
  writeFileSync(join(dir, 'job.sh'), `${slurmSnippet('https://hook/x', '42')}\nexit 3\n`);
  const env = { ...process.env, PATH: `${dir}:${process.env.PATH}`, OUT: join(dir, 'out.json'),
    SLURM_JOB_NAME: `a"b\\c $(touch ${dir}/pwned) ${'x'.repeat(300)}` };
  assert.throws(() => execFileSync('bash', [join(dir, 'job.sh')], { env }));
  const body = JSON.parse(readFileSync(join(dir, 'out.json'), 'utf8'));
  assert.equal(body.content, '<@42>');
  assert.match(body.embeds[0].title, /^❌ FAILED \(exit 3\): a"b\\c \$\(touch /);
  assert.ok(body.embeds[0].title.length <= 256);
  assert.throws(() => readFileSync(join(dir, 'pwned')));
});
