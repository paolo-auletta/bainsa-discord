import assert from 'node:assert/strict';
import test from 'node:test';

import { ChannelType, PermissionFlagsBits } from 'discord.js';

import { BOARD_ROLES, ROLE_COLORS, ROLE_NAMES } from '../src/constants.js';
import {
  DiscordProvisioner,
  UNIVERSITY_CHANNELS,
  divisionVoiceOverwrites,
  globalBotLogOverwrites,
  globalGeneralOverwrites,
  globalAnnouncementOverwrites,
  globalReadOnlyOverwrites,
  legacyDivisionTextAliases,
  mergePersistedDivisionsIntoPlan,
  normalizeComparableName,
  normalizePlan,
  recognizeMemberFromRoles,
  roleSpecs,
  showcaseForumOverwrites,
  startHereOverwrites,
  stripDangerousHumanPermissions,
  universityExecutiveOverwrites,
  universityForumTags,
  universityBotLogOverwrites,
} from '../src/provision/index.js';

const samplePlan = {
  universities: [
    {
      name: 'Bocconi',
      divisions: ['Projects', 'Analysis', 'Culture', 'Projects'],
    },
  ],
};

test('normalizePlan deduplicates and derives university and division names', () => {
  const plan = normalizePlan(samplePlan);
  assert.equal(plan.universities.length, 1);
  assert.equal(plan.universities[0].slug, 'bocconi');
  assert.equal(plan.universities[0].categoryName, 'BAINSA BOCCONI');
  assert.deepEqual(
    plan.universities[0].divisions.map((division) => division.slug),
    ['projects', 'analysis', 'culture'],
  );
  assert.deepEqual(
    plan.universities[0].divisions.map((division) => [division.name, division.color, division.icon]),
    [['Projects', 'blue', '🟦'], ['Analysis', 'orange', '🟧'], ['Culture', 'pink', '🟪']],
  );
});

test('mergePersistedDivisionsIntoPlan adds active DB-only divisions under each university', () => {
  const merged = mergePersistedDivisionsIntoPlan(
    {
      universities: [
        { name: 'Bocconi', divisions: [{ name: 'Projects', color: 'blue' }] },
        { name: 'Sapienza', divisions: [{ name: 'Projects', color: 'blue' }] },
      ],
    },
    [
      {
        university_name: 'Bocconi',
        division_name: 'Robotics',
        division_color: 'green',
        university_active: true,
        division_active: true,
      },
      {
        university_name: 'Sapienza',
        division_name: 'Robotics',
        division_color: 'pink',
        university_active: true,
        division_active: true,
      },
      {
        university_name: 'Sapienza',
        division_name: 'Test',
        division_color: 'pink',
        university_active: true,
        division_active: true,
      },
    ],
  );

  const byUniversity = new Map(merged.plan.universities.map((university) => [university.name, university]));
  assert.deepEqual(
    byUniversity.get('Bocconi').divisions.map((division) => [division.name, division.color, division.icon]),
    [['Projects', 'blue', '🟦'], ['Robotics', 'green', '🟩']],
  );
  assert.deepEqual(
    byUniversity.get('Sapienza').divisions.map((division) => [division.name, division.color, division.icon]),
    [['Projects', 'blue', '🟦'], ['Robotics', 'pink', '🟪'], ['Test', 'pink', '🟪']],
  );
  assert.equal(merged.added, 3);
});

test('mergePersistedDivisionsIntoPlan preserves static divisions and skips inactive or unknown rows', () => {
  const merged = mergePersistedDivisionsIntoPlan(
    {
      universities: [
        { name: 'Sapienza', divisions: [{ name: 'Projects', color: 'blue' }] },
      ],
    },
    [
      {
        university_name: 'Sapienza',
        division_name: 'Projects',
        division_color: 'green',
        university_active: true,
        division_active: true,
      },
      {
        university_name: 'Sapienza',
        division_name: 'Projects!',
        division_color: 'orange',
        university_active: true,
        division_active: true,
      },
      {
        university_name: 'Sapienza',
        division_name: 'Dormant',
        division_color: 'orange',
        university_active: true,
        division_active: false,
      },
      {
        university_name: 'Unknown',
        division_name: 'Robotics',
        division_color: 'green',
        university_active: true,
        division_active: true,
      },
    ],
  );

  assert.deepEqual(
    merged.plan.universities[0].divisions.map((division) => [division.name, division.color]),
    [['Projects', 'blue']],
  );
  assert.equal(merged.added, 0);
  assert.deepEqual(merged.skippedUnknownUniversities, ['Unknown']);
});

test('roleSpecs include member, board, division and legacy aliases without dangerous human permissions', () => {
  const specs = roleSpecs(samplePlan);
  const names = specs.map((spec) => spec.name);
  assert.ok(names.includes(ROLE_NAMES.RESEARCHER));
  assert.ok(names.includes(ROLE_NAMES.ALUMNI));
  assert.ok(names.includes('Bocconi'));
  assert.ok(names.includes('Bocconi - Head of Projects'));
  assert.ok(names.includes('Bocconi - Vice President'));
  assert.ok(names.includes('Bocconi - President'));

  const universityRole = specs.find((spec) => spec.name === 'Bocconi');
  assert.ok(universityRole.legacyAliases.includes('Bocconi | Member'));
  assert.equal(universityRole.permissions, 0n);

  const globalPresident = specs.find((spec) => spec.name === ROLE_NAMES.GLOBAL_PRESIDENT);
  const president = specs.find((spec) => spec.name === 'Bocconi - President');
  const vicePresident = specs.find((spec) => spec.name === 'Bocconi - Vice President');
  assert.equal(BigInt(globalPresident.permissions) & PermissionFlagsBits.CreateEvents, PermissionFlagsBits.CreateEvents);
  assert.equal(BigInt(president.permissions) & PermissionFlagsBits.CreateEvents, PermissionFlagsBits.CreateEvents);
  assert.equal(vicePresident.permissions, 0n);

  const humanSpecs = specs.filter((spec) => spec.human);
  for (const spec of humanSpecs) {
    const stripped = stripDangerousHumanPermissions(
      BigInt(spec.permissions) |
        PermissionFlagsBits.Administrator |
        PermissionFlagsBits.ManageRoles |
        PermissionFlagsBits.KickMembers,
    );
    assert.equal(stripped & PermissionFlagsBits.Administrator, 0n);
    assert.equal(stripped & PermissionFlagsBits.ManageRoles, 0n);
    assert.equal(stripped & PermissionFlagsBits.KickMembers, 0n);
  }
});

test('roleSpecs apply stable colors to membership, university, and board roles', () => {
  const specs = roleSpecs({
    universities: [
      { name: 'Bocconi', divisions: ['Analysis'] },
      { name: 'Sapienza', divisions: ['Robotics'] },
      { name: 'Polimi', divisions: ['Projects'] },
    ],
  });
  const byName = new Map(specs.map((spec) => [spec.name, spec]));
  assert.equal(byName.get(ROLE_NAMES.RESEARCHER).color, ROLE_COLORS.RESEARCHER);
  assert.equal(byName.get(ROLE_NAMES.ALUMNI).color, ROLE_COLORS.ALUMNI);
  assert.equal(byName.get(ROLE_NAMES.GLOBAL_PRESIDENT).color, ROLE_COLORS.GLOBAL_PRESIDENT);
  assert.equal(byName.get('Bocconi - Head of Analysis').color, '#F2994A');
  assert.equal(byName.get('Sapienza - Robotics').color, '#2F80ED');
  assert.equal(byName.get('Sapienza - Head of Robotics').color, '#2F80ED');
  assert.equal(byName.get('Polimi - Projects').color, '#2F80ED');
  assert.equal(byName.get('Polimi - Head of Projects').color, '#2F80ED');
});

test('approved channel constants do not include a separate university projects category', () => {
  assert.equal('PROJECTS_CATEGORY' in UNIVERSITY_CHANNELS, false);
  assert.equal(UNIVERSITY_CHANNELS.BOT_LOG, 'bot-log');
});

test('text and start permissions match v1 Discord policy', () => {
  const roleIds = {
    everyone: 'everyone',
    bot: 'bot',
    researcher: 'researcher',
    alumni: 'alumni',
    globalPresident: 'global',
    universityPresidents: ['president'],
    roles: new Map(),
  };
  const startEveryone = startHereOverwrites(roleIds).find((entry) => entry.id === 'everyone');
  assert.ok(startEveryone.deny.includes(PermissionFlagsBits.SendMessages));
  assert.ok(startEveryone.deny.includes(PermissionFlagsBits.CreatePublicThreads));
  assert.ok(startEveryone.deny.includes(PermissionFlagsBits.CreatePrivateThreads));
  assert.ok(startEveryone.deny.includes(PermissionFlagsBits.SendMessagesInThreads));

  const researcher = globalGeneralOverwrites(roleIds).find((entry) => entry.id === 'researcher');
  assert.ok(researcher.allow.includes(PermissionFlagsBits.AttachFiles));
  assert.ok(researcher.allow.includes(PermissionFlagsBits.EmbedLinks));
  assert.ok(researcher.allow.includes(PermissionFlagsBits.AddReactions));
  assert.equal(researcher.allow.includes(PermissionFlagsBits.UseApplicationCommands), false);
  assert.ok(researcher.allow.includes(PermissionFlagsBits.CreatePublicThreads));
  assert.ok(researcher.allow.includes(PermissionFlagsBits.SendMessagesInThreads));
});

test('application commands are permitted only in global or university bot logs', () => {
  const roleIds = {
    everyone: 'everyone',
    bot: 'bot',
    researcher: 'researcher',
    alumni: 'alumni',
    globalPresident: 'global',
    universityPresidents: ['president'],
    universityHeadRoleIds: new Map([['Bocconi', ['head']]]),
    roles: new Map([
      ['Bocconi', 'university'],
      ['Bocconi - President', 'president'],
      ['Bocconi - Vice President', 'vp'],
      ['Bocconi - Head of Projects', 'head'],
    ]),
  };
  const university = normalizePlan(samplePlan).universities[0];
  const globalLog = globalBotLogOverwrites(roleIds);
  const universityLog = universityBotLogOverwrites(roleIds, university);

  assert.ok(globalLog.find((entry) => entry.id === 'global').allow.includes(PermissionFlagsBits.UseApplicationCommands));
  for (const id of ['president', 'vp', 'head']) {
    assert.ok(
      universityLog.find((entry) => entry.id === id).allow.includes(PermissionFlagsBits.UseApplicationCommands),
      id,
    );
  }
  assert.equal(
    globalGeneralOverwrites(roleIds).find((entry) => entry.id === 'researcher').allow.includes(PermissionFlagsBits.UseApplicationCommands),
    false,
  );
});

test('anonymous feedback is read-only for normal member roles', () => {
  const overwrites = globalReadOnlyOverwrites({
    everyone: 'everyone',
    bot: 'bot',
    researcher: 'researcher',
    alumni: 'alumni',
    globalPresident: 'global',
    universityPresidents: ['president'],
  });
  for (const id of ['researcher', 'alumni']) {
    const entry = overwrites.find((overwrite) => overwrite.id === id);
    assert.ok(entry.allow.includes(PermissionFlagsBits.ViewChannel));
    assert.ok(entry.deny.includes(PermissionFlagsBits.SendMessages));
    assert.ok(entry.deny.includes(PermissionFlagsBits.CreatePublicThreads));
    assert.ok(entry.deny.includes(PermissionFlagsBits.SendMessagesInThreads));
  }
});

test('onboarding review is visible to every university board role', () => {
  const [university] = normalizePlan(samplePlan).universities;
  const overwrites = universityExecutiveOverwrites(
    {
      everyone: 'everyone',
      bot: 'bot',
      globalPresident: 'global',
      roles: new Map([
        ['Bocconi - Head of Projects', 'head'],
        ['Bocconi - President', 'president'],
        ['Bocconi - Vice President', 'vp'],
      ]),
    },
    university,
  );
  assert.ok(overwrites.some((overwrite) => overwrite.id === 'head'));
  assert.ok(overwrites.some((overwrite) => overwrite.id === 'president'));
  assert.ok(overwrites.some((overwrite) => overwrite.id === 'vp'));
  assert.ok(overwrites.some((overwrite) => overwrite.id === 'global'));
});

test('showcase forums are read-only to humans and postable only by the bot overwrite', () => {
  const overwrites = showcaseForumOverwrites(
    {
      everyone: 'everyone',
      bot: 'bot',
      globalPresident: 'global',
      universityPresidents: ['president'],
    },
    ['researcher', 'president', 'global'],
  );
  for (const id of ['researcher', 'president', 'global']) {
    const entry = overwrites.find((overwrite) => overwrite.id === id);
    assert.ok(entry.allow.includes(PermissionFlagsBits.ViewChannel));
    assert.ok(entry.deny.includes(PermissionFlagsBits.CreatePublicThreads));
    assert.ok(entry.deny.includes(PermissionFlagsBits.SendMessagesInThreads));
  }
  const bot = overwrites.find((overwrite) => overwrite.id === 'bot');
  assert.ok(bot.allow.includes(PermissionFlagsBits.CreatePublicThreads));
  assert.ok(bot.allow.includes(PermissionFlagsBits.SendMessagesInThreads));
});

test('division voice channels grant event creation only to scoped board roles', () => {
  const [university] = normalizePlan(samplePlan).universities;
  const [division] = university.divisions;
  const roleIds = {
    everyone: 'everyone',
    bot: 'bot',
    globalPresident: 'global',
    roles: new Map([
      ['Bocconi - Projects', 'division-member'],
      ['Bocconi - Head of Projects', 'head'],
      ['Bocconi - President', 'president'],
      ['Bocconi - Vice President', 'vp'],
    ]),
  };
  const overwrites = divisionVoiceOverwrites(roleIds, university, division);
  assert.equal(
    overwrites.find((entry) => entry.id === 'division-member').allow.includes(PermissionFlagsBits.CreateEvents),
    false,
  );
  for (const id of ['head', 'vp', 'president', 'global']) {
    assert.ok(overwrites.find((entry) => entry.id === id).allow.includes(PermissionFlagsBits.CreateEvents));
  }
  for (const entry of overwrites) {
    assert.equal(entry.allow.includes(PermissionFlagsBits.ManageEvents), false);
  }
});

test('legacy name normalization adopts pipe and emoji-prefixed resources', () => {
  assert.equal(normalizeComparableName('📊 Bocconi | Analysis Head'), 'bocconi analysis head');
  assert.equal(normalizeComparableName('🔬 analysis-general'), 'analysis general');
});

test('legacy division aliases cover old university-prefixed and registry channels', () => {
  const [university] = normalizePlan(samplePlan).universities;
  const [division] = university.divisions;
  const aliases = legacyDivisionTextAliases(university, division);
  assert.ok(aliases.includes('projects'));
  assert.ok(aliases.includes('bocconi-projects-general'));
  assert.ok(aliases.includes('Projects Registry'));
});

test('plain division channels are adopted into icon-prefixed names', async () => {
  const existing = {
    id: 'plain-projects',
    name: 'projects',
    type: ChannelType.GuildText,
    parentId: 'bocconi-category',
  };
  const guild = {
    channels: {
      cache: {
        find(predicate) {
          return [existing].find(predicate);
        },
      },
    },
  };
  const provisioner = new DiscordProvisioner({
    client: {},
    config: {},
    db: null,
    dryRun: true,
    plan: samplePlan,
    logger: {},
  });

  const channel = await provisioner.ensureTextChannel(guild, '🟦-projects', {
    parent: { id: 'bocconi-category' },
    aliases: ['projects'],
  });

  assert.equal(channel.id, existing.id);
  assert.equal(provisioner.summary.channels.adopted, 1);
  assert.equal(provisioner.summary.channels.updated, 1);
});

test('seed messages adopt an untracked matching bot message instead of sending a duplicate', async () => {
  const seedContent = '# Bocconi General\n\nUse this channel for member coordination.';
  const existingMessage = {
    id: 'existing-seed',
    content: seedContent,
    author: { id: 'bot' },
    components: [],
    createdTimestamp: 1,
    async edit() {
      throw new Error('An unchanged seed should not be edited.');
    },
  };
  const trackedMessages = [];
  const channel = {
    id: 'general',
    messages: {
      async fetch(query) {
        if (typeof query === 'string') return null;
        return new Map([[existingMessage.id, existingMessage]]);
      },
    },
    async send() {
      throw new Error('An existing seed must not be sent again.');
    },
  };
  const db = {
    async query(sql, values) {
      if (sql.includes('SELECT message_id')) return { rows: [] };
      if (sql.includes('INSERT INTO provisioned_messages')) {
        trackedMessages.push(values);
        return { rows: [] };
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
  };
  const provisioner = new DiscordProvisioner({
    client: { user: { id: 'bot' } },
    config: {},
    db,
    dryRun: false,
    plan: samplePlan,
    logger: {},
  });
  provisioner.guildId = 'guild';

  const message = await provisioner.seedMessage(channel, 'university:Bocconi:general', seedContent);

  assert.equal(message, existingMessage);
  assert.equal(provisioner.summary.seeds.unchanged, 1);
  assert.deepEqual(trackedMessages, [['guild', 'general', 'university:Bocconi:general', 'existing-seed']]);
});

test('seed messages adopt legacy bot messages with the same heading and update their content', async () => {
  const seedContent = '# Bocconi General\n\nUse this channel for member coordination.';
  const edited = [];
  const existingMessage = {
    id: 'legacy-seed',
    content: '# Bocconi General\n\nOld guidance.',
    author: { id: 'bot' },
    components: [],
    createdTimestamp: 1,
    async edit(payload) {
      edited.push(payload);
      this.content = payload.content;
      return this;
    },
  };
  const channel = {
    id: 'general',
    messages: {
      async fetch(query) {
        if (typeof query === 'string') return null;
        return new Map([[existingMessage.id, existingMessage]]);
      },
    },
    async send() {
      throw new Error('A legacy seed must be updated in place.');
    },
  };
  const db = {
    async query(sql) {
      if (sql.includes('SELECT message_id')) return { rows: [] };
      if (sql.includes('INSERT INTO provisioned_messages')) return { rows: [] };
      throw new Error(`Unexpected query: ${sql}`);
    },
  };
  const provisioner = new DiscordProvisioner({
    client: { user: { id: 'bot' } },
    config: {},
    db,
    dryRun: false,
    plan: samplePlan,
    logger: {},
  });
  provisioner.guildId = 'guild';

  await provisioner.seedMessage(channel, 'university:Bocconi:general', seedContent);

  assert.equal(provisioner.summary.seeds.updated, 1);
  assert.deepEqual(edited, [{ content: seedContent, components: [] }]);
});

test('bot-log guide seeds are pinned when provisioning requests it', async () => {
  let pins = 0;
  const provisioner = new DiscordProvisioner({
    client: { user: { id: 'bot' } },
    config: {},
    db: null,
    dryRun: false,
    plan: samplePlan,
    logger: {},
  });
  const message = {
    pinned: false,
    async pin() {
      pins += 1;
      this.pinned = true;
    },
  };

  await provisioner.pinSeedMessage(message, 'university:Bocconi:bot-log', true);
  await provisioner.pinSeedMessage(message, 'university:Bocconi:bot-log', true);

  assert.equal(pins, 1);
  assert.equal(message.pinned, true);
});

test('retiring Start Here guidance only deletes the consolidated legacy channels', async () => {
  const deleted = [];
  const retiredRules = {
    id: 'rules',
    name: 'rules',
    type: ChannelType.GuildText,
    parentId: 'start-here',
    delete: async (reason) => deleted.push(['rules', reason]),
  };
  const retiredStructure = {
    id: 'structure',
    name: 'discord-structure',
    type: ChannelType.GuildText,
    parentId: 'start-here',
    delete: async (reason) => deleted.push(['discord-structure', reason]),
  };
  const keepOnboarding = {
    id: 'onboarding',
    name: 'onboarding',
    type: ChannelType.GuildText,
    parentId: 'start-here',
    delete: async () => deleted.push(['onboarding']),
  };
  const sameNameElsewhere = {
    id: 'other-rules',
    name: 'rules',
    type: ChannelType.GuildText,
    parentId: 'other-category',
    delete: async () => deleted.push(['other-rules']),
  };
  const guild = {
    channels: {
      cache: new Map([
        [retiredRules.id, retiredRules],
        [retiredStructure.id, retiredStructure],
        [keepOnboarding.id, keepOnboarding],
        [sameNameElsewhere.id, sameNameElsewhere],
      ]),
    },
  };
  const provisioner = new DiscordProvisioner({
    client: {},
    config: {},
    db: null,
    dryRun: false,
    plan: samplePlan,
    logger: {},
  });

  await provisioner.retireStartHereChannels(guild, { id: 'start-here' });

  assert.deepEqual(deleted, [
    ['rules', 'BAINSA member guidance was consolidated into #welcome'],
    ['discord-structure', 'BAINSA member guidance was consolidated into #welcome'],
  ]);
  assert.equal(provisioner.summary.channels.deleted, 2);
});

test('role alias adoption prefers university Member alias before Alumni alias', async () => {
  const spec = roleSpecs(samplePlan).find((role) => role.name === 'Bocconi');
  const alumniRole = fakeRole('1', 'Bocconi | Alumni');
  const memberRole = fakeRole('2', 'Bocconi | Member');
  const guild = {
    roles: {
      cache: {
        find(predicate) {
          return [alumniRole, memberRole].find(predicate);
        },
      },
    },
  };
  const provisioner = new DiscordProvisioner({
    client: {},
    config: {},
    db: null,
    dryRun: true,
    plan: samplePlan,
    logger: {},
  });
  const adopted = await provisioner.ensureRole(guild, spec);
  assert.equal(adopted.id, '2');
});

test('persisted division color sync updates matching head roles by stored id', async () => {
  const memberRole = fakeRole('member-role', 'Bocconi - Robotics');
  memberRole.hexColor = '#27AE60';
  const headRole = fakeRole('head-role', 'Legacy Head Label');
  headRole.hexColor = '#D7263D';
  headRole.edit = async (edits) => {
    headRole.hexColor = edits.colors.primaryColor;
  };
  const guild = {
    roles: {
      cache: {
        get(id) {
          return [memberRole, headRole].find((role) => role.id === id);
        },
        find(predicate) {
          return [memberRole, headRole].find(predicate);
        },
      },
    },
  };
  const db = {
    async query() {
      return {
        rows: [
          {
            university_name: 'Bocconi',
            division_name: 'Robotics',
            division_color: 'green',
            member_role_id: memberRole.id,
            head_role_id: headRole.id,
          },
        ],
      };
    },
  };
  const provisioner = new DiscordProvisioner({
    client: {},
    config: {},
    db,
    dryRun: false,
    plan: samplePlan,
    logger: {},
  });

  await provisioner.syncPersistedRoleColors(guild);

  assert.equal(headRole.hexColor, '#27AE60');
  assert.equal(provisioner.summary.roles.updated, 1);
});

test('provisioner loads active persisted divisions into the plan before provisioning resources', async () => {
  const statements = [];
  const db = {
    async query(sql) {
      statements.push(sql);
      return {
        rows: [
          {
            university_name: 'Sapienza',
            university_active: true,
            division_name: 'Robotics',
            division_color: 'green',
            division_active: true,
          },
          {
            university_name: 'Bocconi',
            university_active: true,
            division_name: 'Robotics',
            division_color: 'pink',
            division_active: true,
          },
          {
            university_name: 'Unknown',
            university_active: true,
            division_name: 'Labs',
            division_color: 'orange',
            division_active: true,
          },
        ],
      };
    },
  };
  const provisioner = new DiscordProvisioner({
    client: {},
    config: {},
    db,
    dryRun: true,
    plan: {
      universities: [
        { name: 'Bocconi', divisions: [{ name: 'Projects', color: 'blue' }] },
        { name: 'Sapienza', divisions: [{ name: 'Projects', color: 'blue' }] },
      ],
    },
    logger: {},
  });

  await provisioner.loadPersistedDivisionsIntoPlan();

  const specs = roleSpecs(provisioner.plan);
  const names = specs.map((spec) => spec.name);
  assert.ok(names.includes('Bocconi - Robotics'));
  assert.ok(names.includes('Bocconi - Head of Robotics'));
  assert.ok(names.includes('Sapienza - Robotics'));
  assert.ok(names.includes('Sapienza - Head of Robotics'));
  assert.equal(specs.find((spec) => spec.name === 'Sapienza - Robotics').color, '#27AE60');
  assert.equal(specs.find((spec) => spec.name === 'Bocconi - Robotics').color, '#E76F9A');
  assert.match(statements[0], /WHERE u\.active = true/);
  assert.match(statements[0], /d\.active = true/);
  assert.deepEqual(
    provisioner.summary.warnings,
    [{
      type: 'persisted_division_university_skipped',
      university: 'Unknown',
      reason: 'University is not present in the provisioning plan.',
    }],
  );
});

test('existing Bot role compares array permissions as one bitfield on reruns', async () => {
  const spec = roleSpecs(samplePlan).find((role) => role.name === ROLE_NAMES.BOT);
  const bitfield = spec.permissions.reduce((bits, permission) => bits | permission, 0n);
  const botRole = {
    ...fakeRole('bot-role', ROLE_NAMES.BOT),
    permissions: { bitfield },
    hoist: spec.hoist,
    mentionable: spec.mentionable,
  };
  const guild = {
    roles: {
      cache: {
        find(predicate) {
          return [botRole].find(predicate);
        },
      },
    },
  };
  const provisioner = new DiscordProvisioner({
    client: {},
    config: {},
    db: null,
    dryRun: true,
    plan: samplePlan,
    logger: {},
  });

  const existing = await provisioner.ensureRole(guild, spec);

  assert.equal(existing.id, botRole.id);
  assert.equal(provisioner.summary.roles.unchanged, 1);
});

test('child channel aliases never adopt a same-named channel from another university', async () => {
  const existing = {
    id: 'bocconi-room',
    name: 'Projects Room',
    type: ChannelType.GuildVoice,
    parentId: 'bocconi-category',
  };
  const guild = {
    channels: {
      cache: {
        find(predicate) {
          return [existing].find(predicate);
        },
      },
    },
  };
  const provisioner = new DiscordProvisioner({
    client: {},
    config: {},
    db: null,
    dryRun: true,
    plan: samplePlan,
    logger: {},
  });

  const channel = await provisioner.ensureVoiceChannel(guild, 'Projects Room', {
    parent: { id: 'sapienza-category' },
    aliases: ['Projects Room', 'projects-room'],
  });

  assert.notEqual(channel.id, existing.id);
  assert.equal(provisioner.summary.channels.created, 1);
  assert.equal(provisioner.summary.channels.adopted, 0);
});

test('existing member role recognition preserves university, division, and board assignments', () => {
  const plan = normalizePlan(samplePlan);
  const member = fakeMember('42', [
    'Bocconi | Member',
    'Bocconi | Analysis',
    'Global Admin',
    'Bocconi | Vice-President',
  ]);
  const recognition = recognizeMemberFromRoles(member, plan);
  assert.equal(recognition.alumni, false);
  assert.equal(recognition.universities[0].name, 'Bocconi');
  assert.deepEqual(recognition.divisions.map(({ division }) => division.name), ['Analysis']);
  assert.deepEqual(
    recognition.boardAssignments.map((assignment) => assignment.role).sort(),
    [BOARD_ROLES.GLOBAL_PRESIDENT, BOARD_ROLES.VICE_PRESIDENT].sort(),
  );

  const alumni = recognizeMemberFromRoles(fakeMember('43', ['Bocconi | Alumni']), plan);
  assert.equal(alumni.alumni, true);
});

test('university forum tags include divisions and status tags', () => {
  const [university] = normalizePlan(samplePlan).universities;
  assert.deepEqual(
    universityForumTags(university).map((tag) => tag.name),
    ['Projects', 'Analysis', 'Culture', 'Active', 'Completed'],
  );
});

test('global announcements allow presidents to post but keep everyone else hidden by default', () => {
  const overwrites = globalAnnouncementOverwrites({
    everyone: 'everyone',
    researcher: 'researcher',
    alumni: 'alumni',
    globalPresident: 'global',
    universityPresidents: ['president'],
  });
  assert.deepEqual(overwrites[0], {
    id: 'everyone',
    allow: [],
    deny: [PermissionFlagsBits.ViewChannel],
  });
  assert.ok(overwrites.some((entry) => entry.id === 'president' && entry.allow.includes(PermissionFlagsBits.SendMessages)));
  assert.ok(overwrites.some((entry) => entry.id === 'global' && entry.allow.includes(PermissionFlagsBits.SendMessages)));
});

function fakeRole(id, name) {
  return {
    id,
    name,
    editable: true,
    permissions: { bitfield: 0n },
    hoist: false,
    mentionable: false,
  };
}

function fakeMember(id, roleNames) {
  const roles = roleNames.map((name, index) => ({ id: String(index + 1), name }));
  return {
    id,
    user: { bot: false },
    roles: {
      cache: {
        map(callback) {
          return roles.map(callback);
        },
        has(roleId) {
          return roles.some((role) => role.id === roleId);
        },
      },
    },
  };
}
