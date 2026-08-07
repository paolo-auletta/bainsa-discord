import assert from 'node:assert/strict';
import test from 'node:test';

import { MessageFlags } from 'discord.js';

import { commands } from '../src/commands/index.js';
import { buildGuideAccess, guideScopeLabel } from '../src/guide/access.js';
import { GUIDE_CATALOG, GUIDE_COMMAND_NAMES } from '../src/guide/catalog.js';
import {
  guideInteractions,
  homePayload,
  parseCustomId,
  showGuide,
  topicPayload,
} from '../src/guide/service.js';

function memberWithRoles(names) {
  return {
    roles: {
      cache: names.map((name) => ({ name })),
    },
  };
}

function universityScope(name = 'BOCCONI') {
  return { kind: 'university', universityName: name };
}

test('guide catalogue deliberately covers every operational command', () => {
  const registered = commands.map((command) => command.data.name).filter((name) => name !== 'guide').sort();
  assert.deepEqual([...GUIDE_COMMAND_NAMES].sort(), registered);
  assert.equal(new Set(GUIDE_COMMAND_NAMES).size, GUIDE_CATALOG.length);
});

test('a division Head sees only Head commands in the owned division scope', () => {
  const access = buildGuideAccess({
    member: memberWithRoles(['Bocconi - Head of Culture']),
    channelScope: universityScope(),
  });

  assert.deepEqual(access.roleLabels, ['Head of Culture · Bocconi']);
  assert.deepEqual(access.divisions, ['Culture']);
  assert.deepEqual(
    [...access.availableCommands].sort(),
    [
      'board-info',
      'division-add-member',
      'division-remove-member',
      'member-info',
      'project-add-member',
      'project-close',
      'project-create',
      'project-info',
      'project-remove-member',
      'project-update',
    ],
  );
  assert.equal(guideScopeLabel(access, { scopeKind: 'division' }), 'Bocconi › Culture');
  assert.equal(access.availableCommands.has('board-assign'), false);
});

test('multiple board roles combine their current effective access', () => {
  const access = buildGuideAccess({
    member: memberWithRoles([
      'Bocconi - Vice President',
      'Bocconi - Head of Culture',
      'Sapienza - President',
    ]),
    channelScope: universityScope(),
  });

  assert.equal(access.vicePresident, true);
  assert.deepEqual(access.divisions, ['Culture']);
  assert.equal(access.availableCommands.has('division-create'), false);
  assert.equal(access.availableCommands.has('board-assign'), true);
  assert.equal(access.availableCommands.has('board-remove'), true);
  assert.equal(guideScopeLabel(access, { scopeKind: 'division' }), 'Bocconi › all divisions');
});

test('President and Global President guides expose the intended wider tiers', () => {
  const president = buildGuideAccess({
    member: memberWithRoles(['Bocconi - President']),
    channelScope: universityScope(),
  });
  assert.equal(president.availableCommands.size, GUIDE_CATALOG.length);
  assert.equal(guideScopeLabel(president), 'Bocconi');

  const global = buildGuideAccess({
    member: memberWithRoles(['Global President']),
    channelScope: { kind: 'global' },
  });
  assert.equal(global.availableCommands.size, GUIDE_CATALOG.length);
  assert.equal(guideScopeLabel(global), 'All universities');

  const members = topicPayload({ user: { id: '42' } }, global, 'members');
  assert.equal(members.embeds[0].toJSON().title, 'Members and divisions');
  assert.match(members.embeds[0].toJSON().description, /\/division-create/);
});

test('guide access denies ordinary members and cross-university board roles', () => {
  assert.equal(
    buildGuideAccess({
      member: memberWithRoles(['Researcher']),
      channelScope: universityScope(),
    }),
    null,
  );
  assert.equal(
    buildGuideAccess({
      member: memberWithRoles(['Sapienza - President']),
      channelScope: universityScope(),
    }),
    null,
  );
});

test('guide home and topics render one private navigable message payload', () => {
  const interaction = {
    user: { id: '42' },
  };
  const access = buildGuideAccess({
    member: memberWithRoles(['Bocconi - Head of Culture']),
    channelScope: universityScope(),
  });

  const home = homePayload(interaction, access);
  const homeJson = home.embeds[0].toJSON();
  assert.equal(homeJson.title, 'BAINSA Bot Guide');
  assert.equal(
    homeJson.fields.find((field) => field.name === 'Working scope').value,
    'Bocconi › Culture',
  );
  assert.equal(home.components[0].components[0].data.label, 'Manage Culture members');
  assert.ok(home.components[0].components.length >= 4);

  const projects = topicPayload(interaction, access, 'projects');
  const projectJson = projects.embeds[0].toJSON();
  assert.equal(projectJson.title, 'Manage Culture projects');
  assert.match(projectJson.description, /\/project-create/);
  assert.equal(projects.components.length, 2);
});

test('/guide defers an ephemeral response and never sends to the channel', async () => {
  let deferred;
  let edited;
  const interaction = {
    user: { id: '42' },
    member: memberWithRoles(['Bocconi - Head of Culture']),
    channel: {
      name: 'bot-log',
      parent: { name: 'BAINSA BOCCONI' },
      send: async () => assert.fail('/guide must not send a channel message'),
    },
    async deferReply(options) {
      deferred = options;
    },
    async editReply(payload) {
      edited = payload;
    },
  };

  await showGuide(interaction);

  assert.deepEqual(deferred, { flags: MessageFlags.Ephemeral });
  assert.equal(edited.embeds[0].toJSON().title, 'BAINSA Bot Guide');
});

test('/guide accepts scoped board roles under provisioned uppercase university categories', async () => {
  for (const roleName of ['Bocconi - Vice President', 'Bocconi - Head of Projects']) {
    let edited;
    await showGuide({
      user: { id: '42' },
      member: memberWithRoles([roleName]),
      channel: { name: 'bot-log', parent: { name: 'BAINSA BOCCONI' } },
      async deferReply() {},
      async editReply(payload) {
        edited = payload;
      },
    });

    assert.equal(edited.embeds[0].toJSON().title, 'BAINSA Bot Guide');
  }
});

test('guide component ids are bound to the initiating member and update in place', async () => {
  const interaction = {
    customId: 'guide:v1:42:topic:projects',
    user: { id: '42' },
    member: memberWithRoles(['Bocconi - Head of Culture']),
    channel: { name: 'bot-log', parent: { name: 'BAINSA BOCCONI' } },
    async update(payload) {
      this.updated = payload;
    },
  };

  assert.deepEqual(parseCustomId(interaction.customId), {
    userId: '42',
    kind: 'topic',
    value: 'projects',
  });
  await guideInteractions.handleComponent(interaction);
  assert.equal(interaction.updated.embeds[0].toJSON().title, 'Manage Culture projects');
});

test('guide component navigation rechecks roles and rejects stale access', async () => {
  const interaction = {
    customId: 'guide:v1:42:topic:projects',
    user: { id: '42' },
    member: memberWithRoles(['Researcher']),
    channel: { name: 'bot-log', parent: { name: 'BAINSA Bocconi' } },
    update: async () => assert.fail('stale guide must not update'),
  };

  await assert.rejects(
    guideInteractions.handleComponent(interaction),
    /No board command guide is available/,
  );
});
