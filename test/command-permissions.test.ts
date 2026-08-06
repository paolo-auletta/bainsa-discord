import assert from 'node:assert/strict';
import test from 'node:test';

import { ApplicationCommandPermissionType } from 'discord.js';

import {
  COMMAND_VISIBILITY,
  buildCommandPermissionOverwrites,
  canDiscoverCommand,
  syncCommandPermissions,
  visibleRoleIds,
} from '../src/runtime/command-permissions.js';

const roles = [
  { id: 'global', name: 'Global President' },
  { id: 'bocconi-president', name: 'Bocconi - President' },
  { id: 'bocconi-vp', name: 'Bocconi - Vice President' },
  { id: 'bocconi-head', name: 'Bocconi - Head of Projects' },
  { id: 'member', name: 'Researcher' },
];

test('every registered command has a deliberate board-visibility policy', () => {
  assert.deepEqual(Object.keys(COMMAND_VISIBILITY).sort(), [
    'board-assign',
    'board-info',
    'board-remove',
    'division-add-member',
    'division-create',
    'division-remove-member',
    'division-update',
    'guide',
    'member-add',
    'member-info',
    'member-remove',
    'member-update',
    'project-add-member',
    'project-close',
    'project-create',
    'project-info',
    'project-remove-member',
    'project-update',
  ]);
});

test('role visibility tiers expose only the intended board levels', () => {
  assert.deepEqual(visibleRoleIds('president', roles), ['global', 'bocconi-president']);
  assert.deepEqual(visibleRoleIds('executive', roles), ['global', 'bocconi-president', 'bocconi-vp']);
  assert.deepEqual(visibleRoleIds('board', roles), ['global', 'bocconi-president', 'bocconi-vp', 'bocconi-head']);
});

test('board role commands are visible to university Vice Presidents', () => {
  const scope = { kind: 'university', universityName: 'Bocconi' };
  const vicePresident = memberWithRoles(['Bocconi - Vice President']);

  assert.equal(canDiscoverCommand({ commandName: 'board-assign', member: vicePresident, channelScope: scope }), true);
  assert.equal(canDiscoverCommand({ commandName: 'board-remove', member: vicePresident, channelScope: scope }), true);
});

test('command overwrites deny everyone and explicitly allow only the selected roles', () => {
  assert.deepEqual(
    buildCommandPermissionOverwrites({ commandName: 'division-create', guildId: 'guild', roles }),
    [
      { id: 'guild', type: ApplicationCommandPermissionType.Role, permission: false },
      { id: 'global', type: ApplicationCommandPermissionType.Role, permission: true },
      { id: 'bocconi-president', type: ApplicationCommandPermissionType.Role, permission: true },
    ],
  );
});

test('visibility synchronization fails without a client secret unless explicitly allowed for local work', async () => {
  await assert.rejects(
    syncCommandPermissions({
      clientId: 'client',
      clientSecret: null,
      botToken: 'bot',
      guildId: 'guild',
      commands: [],
    }),
    /DISCORD_CLIENT_SECRET is required/,
  );

  assert.deepEqual(
    await syncCommandPermissions({
      clientId: 'client',
      clientSecret: null,
      botToken: 'bot',
      guildId: 'guild',
      commands: [],
      allowUnsynced: true,
    }),
    {
      applied: 0,
      skipped: 'Command visibility sync explicitly disabled for local development or tests.',
    },
  );
});

function memberWithRoles(names) {
  return {
    roles: {
      cache: names.map((name) => ({ name })),
    },
  };
}

test('autocomplete visibility applies board tier and university command-channel scope', () => {
  const scope = { kind: 'university', universityName: 'Bocconi' };
  const globalPresident = memberWithRoles(['Global President']);
  const president = memberWithRoles(['Bocconi - President']);
  const vicePresident = memberWithRoles(['Bocconi - Vice President']);
  const head = memberWithRoles(['Bocconi - Head of Projects']);
  const ordinaryMember = memberWithRoles(['Researcher']);

  assert.equal(canDiscoverCommand({ commandName: 'division-create', member: globalPresident, channelScope: scope }), true);
  assert.equal(canDiscoverCommand({ commandName: 'division-create', member: president, channelScope: scope }), true);
  assert.equal(canDiscoverCommand({ commandName: 'division-create', member: vicePresident, channelScope: scope }), false);
  assert.equal(canDiscoverCommand({ commandName: 'division-create', member: head, channelScope: scope }), false);
  assert.equal(canDiscoverCommand({ commandName: 'member-add', member: vicePresident, channelScope: scope }), true);
  assert.equal(canDiscoverCommand({ commandName: 'member-add', member: head, channelScope: scope }), false);
  assert.equal(canDiscoverCommand({ commandName: 'project-create', member: head, channelScope: scope }), true);
  assert.equal(canDiscoverCommand({ commandName: 'project-create', member: ordinaryMember, channelScope: scope }), false);
  assert.equal(canDiscoverCommand({ commandName: 'guide', member: head, channelScope: scope }), true);
  assert.equal(canDiscoverCommand({ commandName: 'guide', member: ordinaryMember, channelScope: scope }), false);
  assert.equal(
    canDiscoverCommand({
      commandName: 'project-create',
      member: president,
      channelScope: { kind: 'university', universityName: 'Sapienza' },
    }),
    false,
  );
  assert.equal(
    canDiscoverCommand({ commandName: 'project-create', member: president, channelScope: { kind: 'global' } }),
    false,
  );
});

test('permission sync errors preserve Discord response details', async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, options) => {
    requests.push({ url, options });
    if (requests.length === 1) {
      return new Response(JSON.stringify({ access_token: 'oauth-token' }), { status: 200 });
    }
    return new Response(JSON.stringify({ code: 20012, message: 'You are not authorized to perform this action' }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    });
  };

  try {
    await assert.rejects(
      syncCommandPermissions({
        clientId: 'client',
        clientSecret: 'secret',
        botToken: 'bot',
        guildId: 'guild',
        commands: [{ id: 'command', name: 'division-create' }],
      }),
      /Discord command permission request failed \(400\): You are not authorized to perform this action \[20012\]/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('permission sync retries transient unknown-role responses', async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, options) => {
    requests.push({ url, options });
    if (requests.length === 1) {
      return new Response(JSON.stringify({ access_token: 'oauth-token' }), { status: 200 });
    }
    if (requests.length === 2) {
      return new Response(JSON.stringify(roles), { status: 200 });
    }
    if (requests.length < 5) {
      return new Response(JSON.stringify({ code: 10011, message: 'Unknown Role' }), { status: 400 });
    }
    return new Response(JSON.stringify({}), { status: 200 });
  };

  try {
    const result = await syncCommandPermissions({
      clientId: 'client',
      clientSecret: 'secret',
      botToken: 'bot',
      guildId: 'guild',
      commands: [{ id: 'command', name: 'division-create' }],
    });

    assert.deepEqual(result, { applied: 1, skipped: null });
    assert.equal(requests.length, 5);
    assert.match(requests[2].url, /\/applications\/client\/guilds\/guild\/commands\/command\/permissions$/);
    assert.equal(requests[2].options.method, 'PUT');
    assert.deepEqual(JSON.parse(requests[2].options.body), {
      permissions: buildCommandPermissionOverwrites({ commandName: 'division-create', guildId: 'guild', roles }),
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
