import assert from 'node:assert/strict';
import test from 'node:test';

import { ChannelType, ForumLayoutType, PermissionFlagsBits } from 'discord.js';

import { BOARD_ROLES, ROLE_COLORS, ROLE_NAMES } from '../src/constants.js';
import { globalSeeds } from '../src/content/seeds.js';
import { PROFILE_TAGS } from '../src/profiles/state.js';
import { PROFILE_CUSTOM_IDS } from '../src/profiles/custom-ids.js';
import {
  DiscordProvisioner,
  GLOBAL_CHANNELS,
  UNIVERSITY_CHANNELS,
  divisionVoiceOverwrites,
  globalBotLogOverwrites,
  globalGeneralOverwrites,
  globalVoiceOverwrites,
  globalAnnouncementOverwrites,
  globalReadOnlyOverwrites,
  peopleDirectoryForumOverwrites,
  peopleDirectoryForumTags,
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
  universityAnnouncementOverwrites,
  universityForumTags,
  universityBotLogOverwrites,
  universityVoiceOverwrites,
  universityBoardOverwrites,
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

test('global channel proposals use clear plural naming in the channel and guide', () => {
  const seeds = globalSeeds();

  assert.equal(GLOBAL_CHANNELS.CHANNEL_PROPOSALS, 'channel-proposals');
  assert.equal('TOPIC_PROPOSALS' in GLOBAL_CHANNELS, false);
  assert.equal('topicProposals' in seeds, false);
  assert.match(seeds.channelProposals, /^# Channel Proposals\n/);
  assert.match(seeds.channelProposals, /Suggest a new shared channel/);
});

test('people directory has exactly the managed profile taxonomy and no legacy availability tags', () => {
  assert.equal(GLOBAL_CHANNELS.PEOPLE_DIRECTORY, 'people-directory');
  assert.deepEqual(
    peopleDirectoryForumTags().map((tag) => tag.name),
    [
      'Bocconi',
      'Sapienza',
      'PoliMi',
      'AI & Data',
      'Econ & Finance',
      'Neuroscience',
      'Biology',
      'Eng & Robotics',
      'Life & Health Sci',
      'Social Sciences',
      'Math & Physics',
      'Humanities & Design',
      'Academia',
      'Industry',
      'Entrepreneurship',
    ],
  );
  assert.equal(PROFILE_TAGS.length, 15);
  assert.equal(new Set(PROFILE_TAGS.map((tag) => tag.label)).size, 15);
  assert.ok(PROFILE_TAGS.every((tag) => tag.label.length <= 20));
  assert.equal(PROFILE_TAGS.some((tag) => /climate|policy|availability/i.test(tag.key)), false);
});

test('legacy topic proposals forum is renamed in place', async () => {
  const edits = [];
  const legacyForum = {
    id: 'legacy-forum',
    name: 'topic-proposals',
    type: ChannelType.GuildForum,
    parentId: 'global-category',
    availableTags: [],
    async edit(payload) {
      edits.push(payload);
      if (payload.name) this.name = payload.name;
      if (payload.parent) this.parentId = payload.parent;
      return this;
    },
  };
  const guild = {
    channels: {
      cache: {
        find(predicate) {
          return [legacyForum].find(predicate);
        },
      },
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

  const channel = await provisioner.ensureForumChannel(guild, GLOBAL_CHANNELS.CHANNEL_PROPOSALS, {
    parent: { id: 'global-category' },
    aliases: ['topic-proposals'],
  });

  assert.equal(channel.id, legacyForum.id);
  assert.equal(channel.name, 'channel-proposals');
  assert.equal(provisioner.summary.channels.adopted, 1);
  assert.equal(provisioner.summary.channels.updated, 1);
  assert.deepEqual(edits, [{ name: 'channel-proposals', reason: 'BAINSA v1 provisioning' }]);
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

test('university board channels are private to that university board', () => {
  const [university] = normalizePlan(samplePlan).universities;
  const overwrites = universityBoardOverwrites(
    {
      everyone: 'everyone',
      bot: 'bot',
      globalPresident: 'global',
      universityHeadRoleIds: new Map([['Bocconi', ['head']]]),
      roles: new Map([
        ['Bocconi - Head of Projects', 'head'],
        ['Bocconi - President', 'president'],
        ['Bocconi - Vice President', 'vp'],
      ]),
    },
    university,
  );

  assert.equal(overwrites.some((overwrite) => overwrite.id === 'global'), false);
  for (const id of ['head', 'president', 'vp']) {
    const entry = overwrites.find((overwrite) => overwrite.id === id);
    assert.ok(entry, `missing local board overwrite for ${id}`);
    assert.ok(entry.allow.includes(PermissionFlagsBits.ViewChannel), id);
    assert.ok(entry.allow.includes(PermissionFlagsBits.SendMessages), id);
  }
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

test('people directory grants approved identities read-only forum access and bot forum management', () => {
  const overwrites = peopleDirectoryForumOverwrites({
    everyone: 'everyone',
    bot: 'bot',
    researcher: 'researcher',
    alumni: 'alumni',
    globalPresident: 'global',
    universityPresidents: ['president'],
  });
  for (const id of ['researcher', 'alumni', 'global', 'president']) {
    const entry = overwrites.find((candidate) => candidate.id === id);
    assert.ok(entry.allow.includes(PermissionFlagsBits.ViewChannel), id);
    assert.ok(entry.allow.includes(PermissionFlagsBits.ReadMessageHistory), id);
    assert.ok(entry.deny.includes(PermissionFlagsBits.CreatePublicThreads), id);
    assert.ok(entry.deny.includes(PermissionFlagsBits.SendMessagesInThreads), id);
  }
  const bot = overwrites.find((candidate) => candidate.id === 'bot');
  assert.ok(bot.allow.includes(PermissionFlagsBits.CreatePublicThreads));
  assert.ok(bot.allow.includes(PermissionFlagsBits.ManageThreads));
  assert.ok(bot.allow.includes(PermissionFlagsBits.ManageMessages));
});

test('directory-only forum options replace managed tags and configure list layout plus one-week archive', async () => {
  const edits = [];
  const forum = {
    id: 'directory',
    name: 'people-directory',
    type: ChannelType.GuildForum,
    parentId: 'global-category',
    availableTags: [{ id: 'university', name: 'Bocconi' }, { id: 'obsolete', name: 'Obsolete' }],
    defaultForumLayout: ForumLayoutType.GalleryView,
    defaultAutoArchiveDuration: 1440,
    permissionOverwrites: { cache: new Map() },
    async edit(payload) {
      edits.push(payload);
      return this;
    },
  };
  const guild = { channels: { cache: { find: (predicate) => [forum].find(predicate) } } };
  const provisioner = new DiscordProvisioner({ client: {}, config: {}, db: null, dryRun: false, plan: samplePlan, logger: {} });

  await provisioner.ensureForumChannel(guild, 'people-directory', {
    parent: { id: 'global-category' },
    tags: peopleDirectoryForumTags(),
    exactTags: true,
    defaultForumLayout: ForumLayoutType.ListView,
    defaultAutoArchiveDuration: 10080,
  });

  assert.equal(edits.length, 1);
  assert.equal(edits[0].defaultForumLayout, ForumLayoutType.ListView);
  assert.equal(edits[0].defaultAutoArchiveDuration, 10080);
  assert.deepEqual(edits[0].availableTags.map((tag) => tag.name), peopleDirectoryForumTags().map((tag) => tag.name));
  assert.equal(edits[0].availableTags[0].id, 'university');
});

test('new directory forum receives the list layout and one-week archive defaults on creation', async () => {
  const created = [];
  const guild = {
    channels: {
      cache: { find: () => null },
      create: async (payload) => {
        created.push(payload);
        return { id: 'directory', ...payload };
      },
    },
  };
  const provisioner = new DiscordProvisioner({ client: {}, config: {}, db: null, dryRun: false, plan: samplePlan, logger: {} });

  await provisioner.ensureForumChannel(guild, 'people-directory', {
    parent: { id: 'global-category' },
    tags: peopleDirectoryForumTags(),
    exactTags: true,
    defaultForumLayout: ForumLayoutType.ListView,
    defaultAutoArchiveDuration: 10080,
  });

  assert.equal(created.length, 1);
  assert.equal(created[0].defaultForumLayout, ForumLayoutType.ListView);
  assert.equal(created[0].defaultAutoArchiveDuration, 10080);
  assert.deepEqual(created[0].availableTags.map((tag) => tag.name), peopleDirectoryForumTags().map((tag) => tag.name));
});

test('directory provisioning attaches the profile guide buttons from the profile custom-ID contract', async () => {
  const guideCalls = [];
  const provisioner = new DiscordProvisioner({ client: {}, config: {}, db: null, dryRun: true, plan: samplePlan, logger: {} });
  provisioner.seedForumGuide = async (...args) => guideCalls.push(args);
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
      ['Bocconi - Projects', 'projects'],
      ['Bocconi - Head of Projects', 'head'],
    ]),
  };
  await provisioner.ensureStructure({ channels: { cache: { find: () => null, values: () => [] } } }, roleIds);

  const [, key, , options] = guideCalls.find(([, candidate]) => candidate === 'global:people-directory');
  assert.equal(key, 'global:people-directory');
  const componentIds = options.components[0].toJSON().components.map((component) => component.custom_id);
  assert.deepEqual(componentIds, [PROFILE_CUSTOM_IDS.START, PROFILE_CUSTOM_IDS.UNPUBLISH]);
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

test('global voice channel is available to members and event creation is limited to board roles', () => {
  const overwrites = globalVoiceOverwrites({
    everyone: 'everyone',
    bot: 'bot',
    researcher: 'researcher',
    alumni: 'alumni',
    globalPresident: 'global',
    universityPresidents: ['president'],
  });

  assert.ok(overwrites.find((entry) => entry.id === 'researcher').allow.includes(PermissionFlagsBits.Connect));
  assert.ok(overwrites.find((entry) => entry.id === 'alumni').allow.includes(PermissionFlagsBits.Speak));
  for (const id of ['global', 'president']) {
    const entry = overwrites.find((candidate) => candidate.id === id);
    assert.ok(entry.allow.includes(PermissionFlagsBits.Connect));
    assert.ok(entry.allow.includes(PermissionFlagsBits.CreateEvents));
  }
  for (const id of ['researcher', 'alumni']) {
    assert.equal(
      overwrites.find((entry) => entry.id === id).allow.includes(PermissionFlagsBits.CreateEvents),
      false,
    );
  }
});

test('university voice channel is available to all university members and its board', () => {
  const [university] = normalizePlan(samplePlan).universities;
  const overwrites = universityVoiceOverwrites(
    {
      everyone: 'everyone',
      bot: 'bot',
      globalPresident: 'global',
      universityHeadRoleIds: new Map([['Bocconi', ['head']]]),
      roles: new Map([
        ['Bocconi', 'university'],
        ['Bocconi - President', 'president'],
        ['Bocconi - Vice President', 'vp'],
        ['Bocconi - Head of Projects', 'projects-head'],
      ]),
    },
    university,
  );

  const member = overwrites.find((entry) => entry.id === 'university');
  assert.ok(member.allow.includes(PermissionFlagsBits.Connect));
  assert.ok(member.allow.includes(PermissionFlagsBits.Speak));
  assert.equal(member.allow.includes(PermissionFlagsBits.CreateEvents), false);
  for (const id of ['head', 'projects-head', 'president', 'vp', 'global']) {
    const entry = overwrites.find((candidate) => candidate.id === id);
    assert.ok(entry.allow.includes(PermissionFlagsBits.Connect), id);
    assert.ok(entry.allow.includes(PermissionFlagsBits.Speak), id);
    assert.ok(entry.allow.includes(PermissionFlagsBits.CreateEvents), id);
  }
});

test('provisioning creates one global and one university voice room in their scoped categories', async () => {
  const plan = normalizePlan({
    universities: [{ name: 'Bocconi', divisions: ['Projects'] }],
  });
  const provisioner = new DiscordProvisioner({
    client: {},
    config: {},
    db: null,
    dryRun: true,
    plan,
    logger: {},
  });
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
      ['Bocconi - Projects', 'projects'],
      ['Bocconi - Head of Projects', 'head'],
    ]),
  };
  const guild = {
    channels: { cache: { find: () => null, values: () => [] } },
  };

  await provisioner.ensureStructure(guild, roleIds);

  const createdChannels = provisioner.summary.actions
    .filter(({ action }) => action === 'channels.created')
    .map(({ label }) => label);
  assert.ok(createdChannels.includes('channel:bainsa-general-room'));
  assert.ok(createdChannels.includes('channel:general-room'));
  assert.ok(createdChannels.includes('channel:people-directory'));
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

test('provisioning writes a durable topic and reconciles a text channel position', async () => {
  const edits = [];
  const existing = {
    id: 'bocconi-general',
    name: 'general',
    type: ChannelType.GuildText,
    parentId: 'bocconi-category',
    position: 7,
    topic: 'Old guidance',
    async edit(payload) {
      edits.push(payload);
      Object.assign(this, payload);
      return this;
    },
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
    dryRun: false,
    plan: samplePlan,
    logger: {},
  });

  await provisioner.ensureTextChannel(guild, 'general', {
    parent: { id: 'bocconi-category' },
    topic: 'BAINSA BOCCONI · Local coordination.',
    position: 0,
  });

  assert.deepEqual(edits, [{
    topic: 'BAINSA BOCCONI · Local coordination.',
    position: 0,
    reason: 'BAINSA v1 provisioning',
  }]);
  assert.equal(provisioner.summary.channels.updated, 1);
});

test('welcome guidance provisions a persistent personal-space action', async () => {
  const seedCalls = [];
  const provisioner = new DiscordProvisioner({
    client: {},
    config: {},
    db: null,
    dryRun: true,
    plan: samplePlan,
    logger: {},
  });
  provisioner.seedMessage = async (...args) => seedCalls.push(args);
  provisioner.seedForumGuide = async () => {};
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
      ['Bocconi - Projects', 'projects'],
      ['Bocconi - Head of Projects', 'head'],
    ]),
  };

  await provisioner.ensureStructure({ channels: { cache: { find: () => null, values: () => [] } } }, roleIds);

  const [, , , options] = seedCalls.find(([, key]) => key === 'start:welcome');
  const component = options.components[0].toJSON().components[0];
  assert.equal(component.custom_id, 'onboarding:status');
  assert.equal(component.label, 'Find my spaces');
  assert.equal(options.pin, true);
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

test('channel proposal guide migrates its tracked seed without creating a duplicate', async () => {
  const seedContent = globalSeeds().channelProposals;
  const edited = [];
  const queries = [];
  const existingMessage = {
    id: 'legacy-guide',
    content: '# Topic Proposals\n\nOld guidance.',
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
    id: 'channel-proposals',
    messages: {
      async fetch(query) {
        if (query === 'legacy-guide') return existingMessage;
        return new Map([[existingMessage.id, existingMessage]]);
      },
    },
    async send() {
      throw new Error('The legacy guide must be updated in place.');
    },
  };
  const db = {
    async query(sql, values) {
      queries.push({ sql, values });
      if (sql.includes('SELECT message_id')) {
        return { rows: values[2] === 'global:topic-proposals' ? [{ message_id: 'legacy-guide' }] : [] };
      }
      if (sql.includes('INSERT INTO provisioned_messages')) return { rows: [] };
      if (sql.includes('DELETE FROM provisioned_messages')) return { rows: [] };
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

  const message = await provisioner.seedMessage(channel, 'global:channel-proposals', seedContent, {
    legacyKeys: ['global:topic-proposals'],
    legacyHeadings: ['# Topic Proposals'],
  });

  assert.equal(message, existingMessage);
  assert.equal(provisioner.summary.seeds.updated, 1);
  assert.deepEqual(edited, [{ content: seedContent, components: [] }]);
  assert.deepEqual(
    queries.filter(({ sql }) => sql.includes('INSERT INTO provisioned_messages')).map(({ values }) => values),
    [['guild', 'channel-proposals', 'global:channel-proposals', 'legacy-guide']],
  );
  assert.deepEqual(
    queries.filter(({ sql }) => sql.includes('DELETE FROM provisioned_messages')).map(({ values }) => values),
    [['guild', 'channel-proposals', 'global:topic-proposals']],
  );
});

test('forum guide forwards persistent components when it is created for the first time', async () => {
  const created = [];
  const provisioner = new DiscordProvisioner({
    client: { user: { id: 'bot' } },
    config: {},
    db: null,
    dryRun: false,
    plan: samplePlan,
    logger: {},
  });
  const forum = {
    threads: {
      fetchActive: async () => ({ threads: new Map() }),
      fetchArchived: async () => ({ threads: new Map() }),
      create: async (payload) => {
        created.push(payload);
        return { id: 'guide-thread', fetchStarterMessage: async () => null };
      },
    },
  };
  const components = [{ type: 1, components: [{ type: 2, custom_id: 'pf:start' }] }];

  await provisioner.seedForumGuide(forum, 'global:people-directory', globalSeeds().peopleDirectory, { components });

  assert.equal(created.length, 1);
  assert.equal(created[0].name, 'Start here');
  assert.equal(created[0].message.content, globalSeeds().peopleDirectory);
  assert.equal(created[0].message.components, components);
});

test('forum guide repairs persistent components on an existing guide thread', async () => {
  const edits = [];
  const content = globalSeeds().peopleDirectory;
  const message = {
    id: 'guide-message',
    content,
    author: { id: 'bot' },
    components: [],
    createdTimestamp: 1,
    async edit(payload) {
      edits.push(payload);
      this.components = payload.components;
      return this;
    },
  };
  const guide = {
    id: 'guide-thread',
    name: 'Start here',
    messages: { fetch: async () => new Map([[message.id, message]]) },
  };
  const provisioner = new DiscordProvisioner({
    client: { user: { id: 'bot' } },
    config: {},
    db: null,
    dryRun: false,
    plan: samplePlan,
    logger: {},
  });
  const forum = {
    threads: {
      fetchActive: async () => ({ threads: new Map([[guide.id, guide]]) }),
      create: async () => { throw new Error('An existing guide must be updated in place.'); },
    },
  };
  const components = [{ type: 1, components: [{ type: 2, custom_id: 'pf:start' }] }];

  await provisioner.seedForumGuide(forum, 'global:people-directory', content, { components });

  assert.deepEqual(edits, [{ content, components }]);
});

test('forum guide adopts the archived Start here thread, unarchives it, and does not duplicate it', async () => {
  let unarchived = 0;
  let created = 0;
  const content = globalSeeds().peopleDirectory;
  const guideMessage = {
    id: 'guide-message',
    content,
    author: { id: 'bot' },
    components: [],
    createdTimestamp: 1,
    async edit(payload) {
      this.content = payload.content;
      this.components = payload.components;
      return this;
    },
  };
  const archivedGuide = {
    id: 'guide-thread',
    name: 'Start here',
    archived: true,
    messages: { fetch: async () => new Map([[guideMessage.id, guideMessage]]) },
    async setArchived(value) {
      assert.equal(value, false);
      unarchived += 1;
      this.archived = false;
    },
  };
  const provisioner = new DiscordProvisioner({
    client: { user: { id: 'bot' } },
    config: {},
    db: null,
    dryRun: false,
    plan: samplePlan,
    logger: {},
  });
  const forum = {
    threads: {
      fetchActive: async () => ({ threads: new Map() }),
      fetchArchived: async () => ({ threads: new Map([[archivedGuide.id, archivedGuide]]) }),
      create: async () => { created += 1; },
    },
  };

  const result = await provisioner.seedForumGuide(forum, 'global:people-directory', content);

  assert.equal(result, archivedGuide);
  assert.equal(unarchived, 1);
  assert.equal(created, 0);
});

test('forum guide prefers its tracked archived thread before scanning or creating another guide', async () => {
  let unarchived = 0;
  const content = globalSeeds().peopleDirectory;
  const message = {
    id: 'guide-message',
    content,
    author: { id: 'bot' },
    components: [],
    createdTimestamp: 1,
  };
  const guide = {
    id: 'tracked-guide',
    name: 'Start here',
    parentId: 'directory',
    archived: true,
    messages: { fetch: async (id) => id === 'guide-message' ? message : new Map() },
    async setArchived(value) {
      assert.equal(value, false);
      unarchived += 1;
      this.archived = false;
    },
  };
  const db = {
    async query(sql) {
      if (sql.includes('SELECT channel_id')) return { rows: [{ channel_id: guide.id }] };
      if (sql.includes('SELECT message_id')) return { rows: [{ message_id: message.id }] };
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
  const forum = {
    id: 'directory',
    guild: { channels: { fetch: async (id) => id === guide.id ? guide : null } },
    threads: {
      fetchActive: async () => { throw new Error('Tracked guide should be checked before scanning active threads.'); },
      create: async () => { throw new Error('Tracked guide must not be duplicated.'); },
    },
  };

  const result = await provisioner.seedForumGuide(forum, 'global:people-directory', content);

  assert.equal(result, guide);
  assert.equal(unarchived, 1);
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

test('university announcements allow every local board role but keep Heads out of global announcements', () => {
  const university = normalizePlan(samplePlan).universities[0];
  const roleIds = {
    everyone: 'everyone',
    bot: 'bot',
    globalPresident: 'global',
    universityPresidents: ['president'],
    universityHeadRoleIds: new Map([['Bocconi', ['head']]]),
    roles: new Map([
      ['Bocconi', 'university'],
      ['Bocconi - President', 'president'],
      ['Bocconi - Vice President', 'vice-president'],
      ['Bocconi - Head of Projects', 'head'],
    ]),
  };

  const local = universityAnnouncementOverwrites(roleIds, university);
  for (const id of ['head', 'vice-president', 'president', 'global']) {
    const overwrite = local.find((entry) => entry.id === id);
    assert.ok(overwrite, `missing university announcement overwrite for ${id}`);
    assert.ok(overwrite.allow.includes(PermissionFlagsBits.SendMessages), id);
  }

  const universityMember = local.find((entry) => entry.id === 'university');
  assert.ok(universityMember.deny.includes(PermissionFlagsBits.SendMessages));

  const global = globalAnnouncementOverwrites(roleIds);
  assert.equal(global.some((entry) => entry.id === 'head'), false);
  assert.equal(global.some((entry) => entry.id === 'vice-president'), false);
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
