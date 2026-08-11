import assert from 'node:assert/strict';
import test from 'node:test';

import { ChannelType, PermissionFlagsBits, type APIEmbed } from 'discord.js';

import {
  divisionAutocompleteChoice,
  governanceCommands,
} from '../src/commands/governance/index.js';
import { BOARD_ROLES, divisionColorDetails, MEMBER_TYPES, ROLE_NAMES } from '../src/constants.js';
import { UserFacingError } from '../src/errors.js';
import {
  assertBoardAssignDivisionShape,
  assertBoardRemoveDivisionShape,
  assertCanAssignBoardRole,
  assertHeadAssignmentCompatible,
  assertCanManageMember,
  assertCanRemoveBoardRole,
  assertCanRemoveMember,
  parseDivisionList,
} from '../src/services/governance/policy.js';
import {
  addDivisionMember,
  assignBoardRole,
  divisionChannelName,
  divisionChannelOverwrites,
  createDivision,
  findDivisions,
  findUniversities,
  formatBoardInfo,
  formatMemberInfo,
  memberRemovalCleanupPlan,
  projectChannelCleanupTargets,
  roleNamesForDivisionHead,
  resolveDivisionTextForMemberUpdate,
  updateDivision,
  updateBoardRoster,
  warmGovernanceAutocompleteCache,
} from '../src/services/governance/service.js';
import { createDivisionChannel, renameChannelById } from '../src/services/governance/gateway.js';

function fakeMember(roleNames) {
  return {
    roles: {
      cache: {
        find: (predicate) => roleNames.map((name) => ({ name })).find(predicate),
        some: (predicate) => roleNames.some((name) => predicate({ name })),
      },
    },
  };
}

function cacheFrom(items = []) {
  const map = new Map(items.map((item) => [String(item.id), item]));
  return {
    find: (predicate) => [...map.values()].find(predicate),
    get: (id) => map.get(String(id)),
    has: (id) => map.has(String(id)),
    set: (id, item) => map.set(String(id), item),
    delete: (id) => map.delete(String(id)),
    some: (predicate) => [...map.values()].some(predicate),
    values: () => map.values(),
  };
}

type TestRole = {
  id: string;
  name: string;
  hexColor: string;
  editable: boolean;
  lastSetNameReason?: string;
  lastEdit?: unknown;
  deletedReason?: string;
  createSpec?: unknown;
  setName(name: string, reason: string): Promise<TestRole>;
  edit(update: { colors?: { primaryColor?: string } }): Promise<TestRole>;
  delete(reason: string): Promise<void>;
};

type TestChannel = {
  id: string;
  name: string;
  type: ChannelType;
  parentId: string | null;
  lastSetNameReason?: string;
  deletedReason?: string;
  createSpec?: unknown;
  overwrites?: Array<{ id: string }>;
  overwriteReason?: string;
  permissionOverwrites?: {
    set(overwrites: Array<{ id: string }>, reason: string): Promise<void>;
  };
  setName(name: string, reason: string): Promise<TestChannel>;
  delete(reason: string): Promise<void>;
};

function testRole(id: string, name: string, hexColor = '#000000'): TestRole {
  return {
    id,
    name,
    hexColor,
    editable: true,
    async setName(name, reason) {
      this.name = name;
      this.lastSetNameReason = reason;
      return this;
    },
    async edit(update) {
      this.lastEdit = update;
      if (update.colors?.primaryColor) this.hexColor = update.colors.primaryColor;
      return this;
    },
    async delete(reason) {
      this.deletedReason = reason;
    },
  };
}

function testChannel(id: string, name: string, type: ChannelType, parentId: string | null = null): TestChannel {
  return {
    id,
    name,
    type,
    parentId,
    async setName(name, reason) {
      this.name = name;
      this.lastSetNameReason = reason;
      return this;
    },
    async delete(reason) {
      this.deletedReason = reason;
    },
  };
}

function embedJson(embed: APIEmbed | { toJSON(): APIEmbed }): APIEmbed {
  return typeof embed.toJSON === 'function' ? embed.toJSON() : embed;
}

function memberWithRoles(initialRoles = []) {
  const cache = cacheFrom(initialRoles);
  return {
    id: 'head-user',
    user: { id: 'head-user' },
    roles: {
      cache,
      async add(roles) {
        for (const role of roles) cache.set(role.id, role);
      },
      async remove(roles) {
        for (const role of roles) cache.delete?.(role.id);
      },
    },
  };
}

test('parseDivisionList normalizes, deduplicates, and ignores empty parts', () => {
  assert.deepEqual(parseDivisionList(' Projects, analysis, Projects ,, Culture  Lab '), [
    'Projects',
    'analysis',
    'Culture Lab',
  ]);
  assert.deepEqual(parseDivisionList('   '), []);
});

test('governanceCommands exposes only the approved v1 governance commands', () => {
  const names = governanceCommands.map((entry) => entry.data.name).sort();
  assert.deepEqual(names, [
    'board-info',
    'board-update',
    'division-add-member',
    'division-create',
    'division-remove-member',
    'division-update',
    'member-info',
    'member-remove',
    'member-update',
  ]);
});

test('division-create opens a zero-argument private panel flow', () => {
  const divisionCreate = governanceCommands.find((entry) => entry.data.name === 'division-create');
  const json = divisionCreate.data.toJSON();
  assert.deepEqual(json.options, []);
  assert.match(json.description, /private guided division setup/i);
});

test('division colors accept both slash-command values and displayed choice labels', () => {
  assert.equal(divisionColorDetails('green').key, 'green');
  assert.equal(divisionColorDetails('Green 🟩').key, 'green');
  assert.equal(divisionColorDetails('🟩 Green').key, 'green');
});

test('single-division autocomplete displays the color while submitting the plain division name', () => {
  assert.deepEqual(
    divisionAutocompleteChoice({ id: 1, name: 'Projects', color: 'blue' }),
    {
      id: 1,
      name: '🟦 Projects',
      color: 'blue',
      value: 'Projects',
    },
  );
});

test('division Heads receive both the ordinary division role and the scoped Head role', () => {
  assert.deepEqual(
    roleNamesForDivisionHead('Bocconi', 'Projects'),
    ['Bocconi', 'Bocconi - Projects', 'Bocconi - Head of Projects'],
  );
});

test('division-update opens a zero-argument private panel flow', () => {
  const divisionUpdate = governanceCommands.find((entry) => entry.data.name === 'division-update');
  const json = divisionUpdate.data.toJSON();
  assert.deepEqual(json.options, []);
  assert.match(json.description, /private guided division update panel/i);
});

test('division-update reconciles case-only renames and recolors across roles, channels, and persisted state', async () => {
  const accessRole = testRole('access-role', 'Bocconi - Projects', divisionColorDetails('blue').hex);
  const headRole = testRole('head-role', 'Bocconi - Head of Projects', divisionColorDetails('blue').hex);
  const textChannel = testChannel('text-channel', '🟦-projects', ChannelType.GuildText);
  const voiceChannel = testChannel('voice-channel', '🟦-projects-room', ChannelType.GuildVoice);
  const roleCache = cacheFrom([accessRole, headRole]);
  const channelCache = cacheFrom([textChannel, voiceChannel]);
  const transactionQueries = [];
  const db = {
    async query(text) {
      if (text.includes('FROM universities')) {
        return { rows: [{ id: 2, name: 'Bocconi', category_id: 'bocconi-category' }], rowCount: 1 };
      }
      if (text.includes('AND id <>')) return { rows: [], rowCount: 0 };
      if (text.includes('FROM divisions')) {
        return {
          rows: [{
            id: 7,
            university_id: 2,
            name: 'Projects',
            color: 'blue',
            access_role_id: accessRole.id,
            head_role_id: headRole.id,
            text_channel_id: textChannel.id,
            voice_channel_id: voiceChannel.id,
          }],
          rowCount: 1,
        };
      }
      throw new Error(`Unexpected query: ${text}`);
    },
    async transaction(callback) {
      return callback({
        async query(text, values) {
          transactionQueries.push({ text, values });
          return { rows: [], rowCount: 1 };
        },
      });
    },
  };

  const result = await updateDivision(
    {
      guild: {
        roles: { cache: roleCache },
        channels: {
          async fetch(id) {
            return channelCache.get(id) ?? null;
          },
        },
      },
      user: { id: 'actor-user' },
      member: fakeMember([ROLE_NAMES.GLOBAL_PRESIDENT]),
    },
    {
      university: 'Bocconi',
      currentName: 'Projects',
      newName: 'PROJECTS',
      color: 'green',
    },
    { db: db as never },
  );

  assert.deepEqual(result, {
    university: { id: 2, name: 'Bocconi', category_id: 'bocconi-category' },
    oldName: 'Projects',
    newName: 'PROJECTS',
    oldColor: 'blue',
    newColor: 'green',
  });
  assert.equal(accessRole.name, 'Bocconi - PROJECTS');
  assert.equal(headRole.name, 'Bocconi - Head of PROJECTS');
  assert.equal(accessRole.hexColor, divisionColorDetails('green').hex);
  assert.equal(headRole.hexColor, divisionColorDetails('green').hex);
  assert.equal(textChannel.name, '🟩-projects');
  assert.equal(voiceChannel.name, '🟩-projects-room');

  const update = transactionQueries.find((query) => query.text.includes('UPDATE divisions'));
  assert.deepEqual(update.values, ['PROJECTS', 'projects', 'green', accessRole.id, headRole.id, 7]);
  const audit = transactionQueries.find((query) => query.text.includes('INSERT INTO audit_log'));
  assert.equal(audit.values[1], 'division.update');
  assert.equal(audit.values[5], JSON.stringify({ name: 'Projects', color: 'blue' }));
  assert.equal(audit.values[6], JSON.stringify({ name: 'PROJECTS', color: 'green' }));
});

test('division-update restores an already-renamed channel when a later channel rename fails', async () => {
  const accessRole = testRole('access-role', 'Bocconi - Projects', divisionColorDetails('blue').hex);
  const headRole = testRole('head-role', 'Bocconi - Head of Projects', divisionColorDetails('blue').hex);
  const textChannel = testChannel('text-channel', 'manually-named-projects', ChannelType.GuildText);
  const voiceChannel = testChannel('voice-channel', '🟦-projects-room', ChannelType.GuildVoice);
  voiceChannel.setName = async () => {
    throw new Error('Controlled voice rename failure');
  };
  const roleCache = cacheFrom([accessRole, headRole]);
  const channelCache = cacheFrom([textChannel, voiceChannel]);
  let transactionCalls = 0;
  const db = {
    async query(text) {
      if (text.includes('FROM universities')) {
        return { rows: [{ id: 2, name: 'Bocconi', category_id: 'bocconi-category' }], rowCount: 1 };
      }
      if (text.includes('AND id <>')) return { rows: [], rowCount: 0 };
      if (text.includes('FROM divisions')) {
        return {
          rows: [{
            id: 7,
            university_id: 2,
            name: 'Projects',
            color: 'blue',
            access_role_id: accessRole.id,
            head_role_id: headRole.id,
            text_channel_id: textChannel.id,
            voice_channel_id: voiceChannel.id,
          }],
          rowCount: 1,
        };
      }
      throw new Error(`Unexpected query: ${text}`);
    },
    async transaction() {
      transactionCalls += 1;
      assert.fail('database transaction must not run after a Discord rename failure');
    },
  };

  await assert.rejects(
    () => updateDivision(
      {
        guild: {
          roles: { cache: roleCache },
          channels: { fetch: async (id) => channelCache.get(id) ?? null },
        },
        user: { id: 'actor-user' },
        member: fakeMember([ROLE_NAMES.GLOBAL_PRESIDENT]),
      },
      { university: 'Bocconi', currentName: 'Projects', newName: 'Innovation', color: 'green' },
      { db },
    ),
    /Division update failed\. Discord roles and channels were restored where possible; try again\./,
  );

  assert.equal(transactionCalls, 0);
  assert.equal(accessRole.name, 'Bocconi - Projects');
  assert.equal(headRole.name, 'Bocconi - Head of Projects');
  assert.equal(accessRole.hexColor, divisionColorDetails('blue').hex);
  assert.equal(headRole.hexColor, divisionColorDetails('blue').hex);
  assert.equal(textChannel.name, 'manually-named-projects');
  assert.equal(voiceChannel.name, '🟦-projects-room');
});

test('board update opens a zero-argument private roster editor', () => {
  const boardUpdate = governanceCommands.find((entry) => entry.data.name === 'board-update').data.toJSON();

  assert.deepEqual(boardUpdate.options, []);
  assert.match(boardUpdate.description, /private university board roster editor/i);
});

test('board roster update removes only a Head title and preserves ordinary division membership', async () => {
  const researcherRole = testRole('researcher-role', ROLE_NAMES.RESEARCHER);
  const universityRole = testRole('bocconi-role', 'Bocconi');
  const projectsRole = testRole('projects-role', 'Bocconi - Projects');
  const projectsHeadRole = testRole('projects-head-role', 'Bocconi - Head of Projects');
  const roles = cacheFrom([researcherRole, universityRole, projectsRole, projectsHeadRole]);
  const target = memberWithRoles([researcherRole, universityRole, projectsRole, projectsHeadRole]);
  target.id = 'target-user';
  target.user.id = 'target-user';
  const currentAssignments = [
    { discord_user_id: 'president-user', university_id: 2, role: BOARD_ROLES.PRESIDENT, division_id: null, division_name: null },
    { discord_user_id: 'target-user', university_id: 2, role: BOARD_ROLES.HEAD, division_id: 7, division_name: 'Projects' },
  ];
  const transactionQueries = [];
  const memberRecord = {
    discord_user_id: 'target-user',
    university_id: 2,
    university_name: 'Bocconi',
    member_type: MEMBER_TYPES.RESEARCHER,
    status: 'active',
  };
  const memberDivisions = [{ id: 7, university_id: 2, university_name: 'Bocconi', name: 'Projects' }];
  const queryResult = async (text) => {
    if (text.includes('FROM universities')) return { rows: [{ id: 2, name: 'Bocconi' }], rowCount: 1 };
    if (text.includes("role IN ('president', 'vice_president')")) {
      return { rows: [{ role: BOARD_ROLES.PRESIDENT }], rowCount: 1 };
    }
    if (text.includes('SELECT id, university_id, name, color, member_role_id')) {
      return { rows: [{ id: 7, university_id: 2, name: 'Projects', member_role_id: projectsRole.id, head_role_id: projectsHeadRole.id }], rowCount: 1 };
    }
    if (text.includes('SELECT br.discord_user_id')) return { rows: currentAssignments, rowCount: currentAssignments.length };
    if (text.includes('SELECT id, member_role_id, head_role_id')) {
      return { rows: [{ id: 7, member_role_id: projectsRole.id, head_role_id: projectsHeadRole.id }], rowCount: 1 };
    }
    if (text.includes('FROM members m')) return { rows: [memberRecord], rowCount: 1 };
    if (text.includes('FROM member_divisions')) return { rows: memberDivisions, rowCount: 1 };
    if (text.includes('FROM project_people pp')) return { rows: [], rowCount: 0 };
    return { rows: [], rowCount: 0 };
  };
  const db = {
    query: queryResult,
    async transaction(callback) {
      return callback({
        async query(text, values) {
          transactionQueries.push({ text, values });
          return queryResult(text);
        },
      });
    },
  };

  const result = await updateBoardRoster(
    {
      guild: {
        roles: { cache: roles },
        members: { async fetch() { return target; } },
      },
      user: { id: 'actor-user' },
      member: fakeMember([]),
    },
    {
      university: 'Bocconi',
      expectedAssignments: currentAssignments.map((assignment) => ({
        userId: assignment.discord_user_id,
        role: assignment.role,
        divisionId: assignment.division_id,
      })),
      assignments: [{ userId: 'president-user', role: BOARD_ROLES.PRESIDENT, divisionId: null }],
    },
    { db },
  );

  assert.deepEqual(
    [...target.roles.cache.values()].map((role) => role.name).sort(),
    [ROLE_NAMES.RESEARCHER, 'Bocconi', 'Bocconi - Projects'].sort(),
  );
  assert.equal(transactionQueries.some((query) => query.text.includes('DELETE FROM member_divisions')), false);
  assert.deepEqual(result.memberChanges[0].before, ['Head of Projects']);
  assert.deepEqual(result.memberChanges[0].after, []);
});

test('member-remove policy protects President and Bot roles', () => {
  const vp = fakeMember(['Bocconi - Vice President']);
  const president = fakeMember(['Bocconi - President']);
  const global = fakeMember([ROLE_NAMES.GLOBAL_PRESIDENT]);
  const bot = fakeMember([ROLE_NAMES.BOT]);

  assert.throws(() => assertCanRemoveMember(vp, 'Bocconi', president), UserFacingError);
  assert.throws(() => assertCanRemoveMember(global, 'Bocconi', bot), UserFacingError);
  assert.doesNotThrow(() => assertCanRemoveMember(president, 'Bocconi', vp));
});

test('member management policy blocks a VP from changing their President', () => {
  const vp = fakeMember(['Bocconi - Vice President']);
  const president = fakeMember(['Bocconi - President']);

  assert.throws(() => assertCanManageMember(vp, 'Bocconi', president), UserFacingError);
});

test('member management policy reports the actor university when the selected university is out of scope', () => {
  const bocconiVicePresident = fakeMember(['Bocconi - Vice President']);
  const sapienzaMember = fakeMember(['Sapienza']);

  assert.throws(
    () => assertCanManageMember(bocconiVicePresident, 'Sapienza', sapienzaMember),
    (error) => error instanceof UserFacingError && error.message === 'You can only manage members in Bocconi.',
  );
});

test('board role policy scopes VP and President authority for board roles', () => {
  const vp = fakeMember(['Bocconi - Vice President']);
  const president = fakeMember(['Bocconi - President']);

  for (const role of [BOARD_ROLES.HEAD, BOARD_ROLES.VICE_PRESIDENT]) {
    assert.doesNotThrow(() => assertCanAssignBoardRole(vp, 'Bocconi', role));
    assert.doesNotThrow(() => assertCanRemoveBoardRole(vp, 'Bocconi', role));
  }
  assert.doesNotThrow(() => assertCanAssignBoardRole(president, 'Bocconi', BOARD_ROLES.PRESIDENT));
  assert.doesNotThrow(() => assertCanRemoveBoardRole(president, 'Bocconi', BOARD_ROLES.PRESIDENT));
  assert.throws(() => assertCanAssignBoardRole(vp, 'Bocconi', BOARD_ROLES.PRESIDENT), UserFacingError);
  assert.throws(() => assertCanRemoveBoardRole(vp, 'Bocconi', BOARD_ROLES.PRESIDENT), UserFacingError);
  assert.throws(() => assertCanAssignBoardRole(president, 'Sapienza', BOARD_ROLES.PRESIDENT), UserFacingError);
  assert.throws(() => assertCanRemoveBoardRole(president, 'Sapienza', BOARD_ROLES.PRESIDENT), UserFacingError);
  assert.throws(() => assertCanAssignBoardRole(vp, 'Sapienza', BOARD_ROLES.VICE_PRESIDENT), UserFacingError);
  assert.throws(() => assertCanRemoveBoardRole(vp, 'Sapienza', BOARD_ROLES.HEAD), UserFacingError);
});

test('board Head division rules differ for assign and remove', () => {
  assert.throws(() => assertBoardAssignDivisionShape('head', null), UserFacingError);
  assert.doesNotThrow(() => assertBoardAssignDivisionShape('head', 'Projects'));
  assert.doesNotThrow(() => assertBoardRemoveDivisionShape('head', null));
  assert.throws(() => assertBoardRemoveDivisionShape('president', 'Projects'), UserFacingError);
});

test('active university executives cannot also be assigned as division Heads', () => {
  const president = [{ role: BOARD_ROLES.PRESIDENT, university_name: 'Bocconi' }];
  const vicePresident = [{ role: BOARD_ROLES.VICE_PRESIDENT, university_name: 'Bocconi' }];

  for (const [roles, label] of [[president, 'President'], [vicePresident, 'Vice President']]) {
    assert.throws(
      () => assertHeadAssignmentCompatible(roles, 'Bocconi'),
      (error) =>
        error instanceof UserFacingError
        && error.message === `This member is already an active ${label} of Bocconi and cannot also be assigned as a division Head. Remove the ${label} role first or choose another member.`,
    );
  }
  assert.doesNotThrow(() => assertHeadAssignmentCompatible(president, 'Sapienza'));
  assert.doesNotThrow(() => assertHeadAssignmentCompatible(
    [{ role: BOARD_ROLES.HEAD, university_name: 'Bocconi' }],
    'Bocconi',
  ));
});

test('Researcher to Alumni update clears divisions when divisions are omitted', () => {
  const previousDivisions = [{ name: 'Projects' }, { name: 'Analysis' }];

  assert.equal(resolveDivisionTextForMemberUpdate(MEMBER_TYPES.ALUMNI, previousDivisions, undefined), '');
  assert.equal(
    resolveDivisionTextForMemberUpdate(MEMBER_TYPES.RESEARCHER, previousDivisions, undefined),
    'Projects, Analysis',
  );
  assert.equal(resolveDivisionTextForMemberUpdate(MEMBER_TYPES.ALUMNI, previousDivisions, 'Culture'), 'Culture');
});

test('division channel names and overwrites match provisioner policy', () => {
  const guild = { roles: { everyone: { id: 'everyone' } } };
  const roles = {
    accessRole: { id: 'division' },
    headRole: { id: 'head' },
    presidentRole: { id: 'president' },
    vicePresidentRole: { id: 'vp' },
    globalPresidentRole: { id: 'global' },
    botRole: { id: 'bot' },
  };

  assert.equal(divisionChannelName('Robotics Lab', ChannelType.GuildText), '🟦-robotics-lab');
  assert.equal(divisionChannelName('Robotics Lab', ChannelType.GuildVoice), '🟦-robotics-lab-room');
  assert.equal(divisionChannelName('Robotics Lab', ChannelType.GuildText, 'orange'), '🟧-robotics-lab');
  assert.equal(divisionChannelName('Robotics Lab', ChannelType.GuildText, 'green'), '🟩-robotics-lab');
  assert.equal(divisionChannelName('Robotics Lab', ChannelType.GuildVoice, 'green'), '🟩-robotics-lab-room');
  assert.equal(divisionChannelName('Culture', ChannelType.GuildText), '🟪-culture');

  const overwrites = divisionChannelOverwrites(guild, roles, ChannelType.GuildText);
  assert.deepEqual(
    overwrites.map((overwrite) => overwrite.id),
    ['everyone', 'division', 'head', 'president', 'vp', 'global', 'bot'],
  );

  const humanAllows = overwrites
    .filter((overwrite) => !['everyone', 'bot'].includes(overwrite.id))
    .flatMap((overwrite) => overwrite.allow ?? []);
  assert.equal(humanAllows.includes(PermissionFlagsBits.ManageChannels), false);
  assert.equal(humanAllows.includes(PermissionFlagsBits.ManageMessages), false);
  assert.equal(humanAllows.includes(PermissionFlagsBits.AttachFiles), true);
  assert.equal(humanAllows.includes(PermissionFlagsBits.EmbedLinks), true);
  assert.equal(humanAllows.includes(PermissionFlagsBits.SendMessagesInThreads), true);
});

test('reused division channels have their access overwrites repaired', async () => {
  const existing = testChannel('existing', '🟦-projects', ChannelType.GuildText, 'category');
  existing.permissionOverwrites = {
    async set(overwrites, reason) {
      existing.overwrites = overwrites;
      existing.overwriteReason = reason;
    },
  };
  const roles = {
    accessRole: { id: 'division' },
    headRole: { id: 'head' },
    presidentRole: { id: 'president' },
    vicePresidentRole: { id: 'vp' },
    globalPresidentRole: { id: 'global' },
    botRole: { id: 'bot' },
  };
  const guild = {
    roles: { everyone: { id: 'everyone' } },
    channels: {
      cache: cacheFrom([existing]),
      async create() {
        throw new Error('existing channel should be reused');
      },
    },
  };

  const result = await createDivisionChannel(
    guild,
    'Projects',
    'blue',
    ChannelType.GuildText,
    { id: 'category' },
    roles,
    'Create division',
  );

  assert.equal(result.channel, existing);
  assert.equal(result.created, false);
  assert.deepEqual(existing.overwrites.map((overwrite) => overwrite.id), ['everyone', 'division', 'head', 'president', 'vp', 'global', 'bot']);
  assert.match(existing.overwriteReason, /repair existing channel access/);
});

test('division channel renames ignore confirmed absence but surface operational failures', async () => {
  const guild = {
    channels: {
      async fetch() {
        throw { code: 10_003 };
      },
    },
  };
  assert.equal(await renameChannelById(guild, 'missing', 'new-name', 'Rename division'), null);

  guild.channels.fetch = async () => {
    throw new Error('Discord API is unavailable');
  };
  await assert.rejects(
    () => renameChannelById(guild, 'channel', 'new-name', 'Rename division'),
    /Discord API is unavailable/,
  );
});

test('division-create creates same-named text and voice channels in a different university category', async () => {
  const everyoneRole = testRole('everyone', '@everyone');
  const roleCache = cacheFrom([
    everyoneRole,
    testRole('bot-role', ROLE_NAMES.BOT),
    testRole('researcher-role', ROLE_NAMES.RESEARCHER),
    testRole('global-president-role', ROLE_NAMES.GLOBAL_PRESIDENT),
    testRole('sapienza-role', 'Sapienza'),
    testRole('sapienza-president-role', 'Sapienza - President'),
    testRole('sapienza-vp-role', 'Sapienza - Vice President'),
  ]);
  let createdRoleCount = 0;

  const bocconiText = testChannel('bocconi-text', '🟩-robotics', ChannelType.GuildText, 'bocconi-category');
  const bocconiVoice = testChannel('bocconi-voice', '🟩-robotics-room', ChannelType.GuildVoice, 'bocconi-category');
  const sapienzaCategory = testChannel('sapienza-category', 'BAINSA SAPIENZA', ChannelType.GuildCategory);
  const channelCache = cacheFrom([
    testChannel('bocconi-category', 'BAINSA BOCCONI', ChannelType.GuildCategory),
    sapienzaCategory,
    bocconiText,
    bocconiVoice,
  ]);
  const createdChannels = [];

  const head = memberWithRoles();
  const guild = {
    id: 'guild',
    roles: {
      everyone: everyoneRole,
      cache: roleCache,
      async create(spec) {
        const role = testRole(`created-role-${++createdRoleCount}`, spec.name);
        role.createSpec = spec;
        if (spec.colors?.primaryColor) role.hexColor = spec.colors.primaryColor;
        roleCache.set(role.id, role);
        return role;
      },
    },
    channels: {
      cache: channelCache,
      async fetch(id) {
        return channelCache.get(id) ?? null;
      },
      async create(spec) {
        const channel = testChannel(
          `created-channel-${createdChannels.length + 1}`,
          spec.name,
          spec.type,
          spec.parent,
        );
        channel.createSpec = spec;
        channelCache.set(channel.id, channel);
        createdChannels.push(channel);
        return channel;
      },
    },
    members: {
      me: { id: 'bot-user' },
      async fetch(id) {
        assert.equal(id, 'head-user');
        return head;
      },
    },
  };

  const transactionQueries = [];
  const db = {
    async query(text) {
      if (text.includes('FROM universities')) {
        return { rows: [{ id: 2, name: 'Sapienza', category_id: 'sapienza-category' }], rowCount: 1 };
      }
      if (text.includes('SELECT id FROM divisions')) return { rows: [], rowCount: 0 };
      if (text.includes('FROM members m')) return { rows: [], rowCount: 0 };
      throw new Error(`Unexpected query: ${text}`);
    },
    async transaction(callback) {
      return callback({
        async query(text, values) {
          transactionQueries.push({ text, values });
          if (text.includes('INSERT INTO divisions')) return { rows: [{ id: 77 }], rowCount: 1 };
          return { rows: [], rowCount: 0 };
        },
      });
    },
  };

  const result = await createDivision(
    {
      guild,
      user: { id: 'actor-user' },
      member: fakeMember([ROLE_NAMES.GLOBAL_PRESIDENT]),
    },
    {
      university: 'Sapienza',
      divisionName: 'Robotics',
      color: 'green',
      head: { id: 'head-user' },
      createTextChannel: true,
      createVoiceChannel: true,
    },
    { db },
  );

  assert.equal(createdChannels.length, 2);
  assert.deepEqual(
    createdChannels.map((channel) => [channel.name, channel.type, channel.parentId]),
    [
      ['🟩-robotics', ChannelType.GuildText, 'sapienza-category'],
      ['🟩-robotics-room', ChannelType.GuildVoice, 'sapienza-category'],
    ],
  );
  assert.notEqual(result.textChannel.id, bocconiText.id);
  assert.notEqual(result.voiceChannel.id, bocconiVoice.id);

  const insertDivision = transactionQueries.find((query) => query.text.includes('INSERT INTO divisions'));
  assert.equal(insertDivision.values[6], result.textChannel.id);
  assert.equal(insertDivision.values[7], result.voiceChannel.id);
});

test('division-create keeps the requested color on the Head role after assignment', async () => {
  const everyoneRole = testRole('everyone', '@everyone');
  const roleCache = cacheFrom([
    everyoneRole,
    testRole('bot-role', ROLE_NAMES.BOT),
    testRole('researcher-role', ROLE_NAMES.RESEARCHER),
    testRole('global-president-role', ROLE_NAMES.GLOBAL_PRESIDENT),
    testRole('sapienza-role', 'Sapienza'),
    testRole('sapienza-president-role', 'Sapienza - President'),
    testRole('sapienza-vp-role', 'Sapienza - Vice President'),
  ]);
  let createdRoleCount = 0;
  const head = memberWithRoles();
  const guild = {
    id: 'guild',
    roles: {
      everyone: everyoneRole,
      cache: roleCache,
      async create(spec) {
        const role = testRole(`created-role-${++createdRoleCount}`, spec.name, spec.colors?.primaryColor);
        role.createSpec = spec;
        roleCache.set(role.id, role);
        return role;
      },
    },
    channels: {
      cache: cacheFrom([testChannel('sapienza-category', 'BAINSA SAPIENZA', ChannelType.GuildCategory)]),
      async fetch(id) {
        return this.cache.get(id) ?? null;
      },
    },
    members: {
      me: { id: 'bot-user' },
      async fetch(id) {
        assert.equal(id, 'head-user');
        return head;
      },
    },
  };
  const db = {
    async query(text) {
      if (text.includes('FROM universities')) {
        return { rows: [{ id: 2, name: 'Sapienza', category_id: 'sapienza-category' }], rowCount: 1 };
      }
      if (text.includes('SELECT id FROM divisions')) return { rows: [], rowCount: 0 };
      if (text.includes('FROM members m')) return { rows: [], rowCount: 0 };
      throw new Error(`Unexpected query: ${text}`);
    },
    async transaction(callback) {
      return callback({
        async query(text) {
          if (text.includes('INSERT INTO divisions')) return { rows: [{ id: 77 }], rowCount: 1 };
          return { rows: [], rowCount: 0 };
        },
      });
    },
  };

  await createDivision(
    {
      guild,
      user: { id: 'actor-user' },
      member: fakeMember([ROLE_NAMES.GLOBAL_PRESIDENT]),
    },
    {
      university: 'Sapienza',
      divisionName: 'Robotics',
      color: 'green',
      head: { id: 'head-user' },
      createTextChannel: false,
      createVoiceChannel: false,
    },
    { db },
  );

  const accessRole = roleCache.find((role) => role.name === 'Sapienza - Robotics');
  const headRole = roleCache.find((role) => role.name === 'Sapienza - Head of Robotics');
  assert.equal(accessRole.hexColor, divisionColorDetails('green').hex);
  assert.equal(headRole.hexColor, divisionColorDetails('green').hex);
  assert.equal(headRole.lastEdit, undefined);
  assert.equal(head.roles.cache.has(headRole.id), true);
  assert.equal(head.roles.cache.has(accessRole.id), true);
});

test('board Head assignment moves the member to the Head division in Discord and the database', async () => {
  const analysisRole = testRole('bocconi-analysis', 'Bocconi - Analysis', divisionColorDetails('green').hex);
  const analysisHeadRole = testRole(
    'bocconi-head-analysis',
    'Bocconi - Head of Analysis',
    divisionColorDetails('green').hex,
  );
  const projectsRole = testRole('bocconi-projects', 'Bocconi - Projects', divisionColorDetails('blue').hex);
  const projectsHeadRole = testRole(
    'bocconi-head-projects',
    'Bocconi - Head of Projects',
    divisionColorDetails('blue').hex,
  );
  const roleCache = cacheFrom([
    testRole('researcher-role', ROLE_NAMES.RESEARCHER),
    testRole('bocconi-role', 'Bocconi'),
    projectsRole,
    projectsHeadRole,
    analysisRole,
    analysisHeadRole,
    testRole('unrelated-role', 'Community Volunteer'),
  ]);
  const target = memberWithRoles([
    roleCache.get('researcher-role'),
    roleCache.get('bocconi-role'),
    projectsRole,
    projectsHeadRole,
    roleCache.get('unrelated-role'),
  ]);
  const guild = {
    roles: {
      cache: roleCache,
      async create(spec) {
        const role = testRole(`created-${spec.name}`, spec.name, spec.colors?.primaryColor);
        roleCache.set(role.id, role);
        return role;
      },
    },
    members: {
      async fetch(id) {
        assert.equal(id, 'target-user');
        return target;
      },
    },
  };
  const transactionQueries = [];
  const db = {
    async query(text) {
      if (text.includes('FROM universities')) return { rows: [{ id: 2, name: 'Bocconi' }], rowCount: 1 };
      if (text.includes('FROM members m')) {
        return {
          rows: [{
            university_id: 2,
            university_name: 'Bocconi',
            member_type: MEMBER_TYPES.RESEARCHER,
            status: 'active',
          }],
          rowCount: 1,
        };
      }
      if (text.includes('SELECT br.role')) {
        return {
          rows: [{
            role: BOARD_ROLES.HEAD,
            division_id: 87,
            university_name: 'Bocconi',
          }],
          rowCount: 1,
        };
      }
      if (text.includes('SELECT discord_user_id') && text.includes('FROM board_assignments')) {
        return { rows: [], rowCount: 0 };
      }
      if (text.includes('SELECT id, member_role_id, head_role_id')) {
        return {
          rows: [
            { id: 87, member_role_id: projectsRole.id, head_role_id: projectsHeadRole.id },
            { id: 88, member_role_id: analysisRole.id, head_role_id: analysisHeadRole.id },
          ],
          rowCount: 2,
        };
      }
      if (text.includes('FROM divisions')) {
        return {
          rows: [{
            id: 88,
            university_id: 2,
            name: 'Analysis',
            color: 'green',
            access_role_id: analysisRole.id,
            head_role_id: analysisHeadRole.id,
          }],
          rowCount: 1,
        };
      }
      throw new Error(`Unexpected query: ${text}`);
    },
    async transaction(callback) {
      return callback({
        async query(text, values) {
          transactionQueries.push({ text, values });
          if (text.includes('FROM members m')) {
            return {
              rows: [{
                university_id: 2,
                university_name: 'Bocconi',
                member_type: MEMBER_TYPES.RESEARCHER,
                status: 'active',
              }],
              rowCount: 1,
            };
          }
          if (text.includes('SELECT br.role')) {
            return {
              rows: [{
                role: BOARD_ROLES.HEAD,
                division_id: 87,
                university_name: 'Bocconi',
              }],
              rowCount: 1,
            };
          }
          if (text.includes('SELECT discord_user_id') && text.includes('FROM board_assignments')) {
            return { rows: [], rowCount: 0 };
          }
          if (text.includes('INSERT INTO board_assignments')) {
            return { rows: [{ id: 1 }], rowCount: 1 };
          }
          return { rows: [], rowCount: 0 };
        },
      });
    },
  };

  await assignBoardRole(
    {
      guild,
      user: { id: 'actor-user' },
      member: fakeMember([ROLE_NAMES.GLOBAL_PRESIDENT]),
    },
    {
      university: 'Bocconi',
      role: BOARD_ROLES.HEAD,
      division: 'Analysis',
      user: { id: 'target-user' },
    },
    { db },
  );

  assert.deepEqual(
    [...target.roles.cache.values()].map((role) => role.name).sort(),
    [
      ROLE_NAMES.RESEARCHER,
      'Bocconi',
      'Bocconi - Analysis',
      'Bocconi - Head of Analysis',
      'Community Volunteer',
    ].sort(),
  );
  assert.ok(transactionQueries.some((query) =>
    query.text.includes('DELETE FROM member_divisions') && query.values[0] === target.id,
  ));
  assert.ok(transactionQueries.some((query) =>
    query.text.includes('INSERT INTO member_divisions') && query.values[1] === 88,
  ));
  assert.ok(transactionQueries.some((query) =>
    query.text.includes('UPDATE board_assignments') &&
    query.values[2] === BOARD_ROLES.HEAD &&
    query.values[3] === 88,
  ));
});

test('board Head assignment rejects an active executive before touching Discord roles', async () => {
  const target = memberWithRoles();
  let transactionCalls = 0;
  const db = {
    async query(text) {
      if (text.includes('FROM universities')) return { rows: [{ id: 1, name: 'Bocconi' }], rowCount: 1 };
      if (text.includes('FROM members m')) {
        return {
          rows: [{
            university_id: 1,
            university_name: 'Bocconi',
            member_type: MEMBER_TYPES.RESEARCHER,
            status: 'active',
          }],
          rowCount: 1,
        };
      }
      if (text.includes('FROM divisions')) {
        return {
          rows: [{
            id: 6,
            university_id: 1,
            name: 'rsi',
            color: 'red',
            access_role_id: 'rsi-role',
            head_role_id: 'rsi-head-role',
          }],
          rowCount: 1,
        };
      }
      if (text.includes('FROM board_assignments br')) {
        return {
          rows: [{ role: BOARD_ROLES.PRESIDENT, division_id: null, university_name: 'Bocconi' }],
          rowCount: 1,
        };
      }
      throw new Error(`Unexpected query: ${text}`);
    },
    async transaction() {
      transactionCalls += 1;
      assert.fail('transaction must not start for an incompatible Head assignment');
    },
  };

  await assert.rejects(
    () => assignBoardRole(
      {
        guild: {
          roles: { cache: cacheFrom() },
          members: { async fetch() { return target; } },
        },
        user: { id: 'actor-user' },
        member: fakeMember([ROLE_NAMES.GLOBAL_PRESIDENT]),
      },
      {
        university: 'Bocconi',
        role: BOARD_ROLES.HEAD,
        division: 'rsi',
        user: { id: 'target-user' },
      },
      { db },
    ),
    /already an active President of Bocconi and cannot also be assigned as a division Head/,
  );

  assert.equal(transactionCalls, 0);
  assert.equal(target.roles.cache.values().next().done, true);
});

test('board VP assignment removes Discord division and Head roles even when assignments are stale', async () => {
  const researcherRole = testRole('researcher-role', ROLE_NAMES.RESEARCHER);
  const universityRole = testRole('bocconi-role', 'Bocconi');
  const analysisRole = testRole('analysis-role', 'Bocconi - Analysis');
  const projectsRole = testRole('projects-role', 'Bocconi - Projects');
  const analysisHeadRole = testRole('analysis-head-role', 'Bocconi - Head of Analysis');
  const projectsHeadRole = testRole('projects-head-role', 'Bocconi - Head of Projects');
  const vicePresidentRole = testRole('vice-president-role', 'Bocconi - Vice President');
  const roleCache = cacheFrom([
    researcherRole,
    universityRole,
    analysisRole,
    projectsRole,
    analysisHeadRole,
    projectsHeadRole,
    vicePresidentRole,
  ]);
  const target = memberWithRoles([
    researcherRole,
    universityRole,
    analysisRole,
    projectsRole,
    analysisHeadRole,
    projectsHeadRole,
  ]);
  const guild = {
    roles: { cache: roleCache },
    members: { async fetch() { return target; } },
  };
  const db = {
    async query(text) {
      if (text.includes('FROM universities')) return { rows: [{ id: 1, name: 'Bocconi' }], rowCount: 1 };
      if (text.includes('FROM members m')) {
        return {
          rows: [{
            university_id: 1,
            university_name: 'Bocconi',
            member_type: MEMBER_TYPES.RESEARCHER,
            status: 'active',
          }],
          rowCount: 1,
        };
      }
      if (text.includes('FROM member_divisions')) {
        return {
          rows: [
            { name: 'Analysis', university_name: 'Bocconi' },
            { name: 'Projects', university_name: 'Bocconi' },
          ],
          rowCount: 2,
        };
      }
      if (text.includes('FROM board_assignments br')) {
        return { rows: [], rowCount: 0 };
      }
      if (text.includes('SELECT discord_user_id') && text.includes('FROM board_assignments')) {
        return { rows: [], rowCount: 0 };
      }
      if (text.includes('SELECT id, member_role_id, head_role_id')) {
        return {
          rows: [
            { id: 10, member_role_id: analysisRole.id, head_role_id: analysisHeadRole.id },
            { id: 11, member_role_id: projectsRole.id, head_role_id: projectsHeadRole.id },
          ],
          rowCount: 2,
        };
      }
      if (text.includes('FROM project_people pp')) return { rows: [], rowCount: 0 };
      throw new Error(`Unexpected query: ${text}`);
    },
    async transaction(callback) {
      return callback({
        async query(text) {
          if (text.includes('FROM members m')) {
            return {
              rows: [{
                university_id: 1,
                university_name: 'Bocconi',
                member_type: MEMBER_TYPES.RESEARCHER,
                status: 'active',
              }],
              rowCount: 1,
            };
          }
          if (text.includes('SELECT discord_user_id') && text.includes('FROM board_assignments')) {
            return { rows: [], rowCount: 0 };
          }
          if (text.includes('INSERT INTO board_assignments')) {
            return { rows: [{ id: 1 }], rowCount: 1 };
          }
          return { rows: [], rowCount: 0 };
        },
      });
    },
  };

  await assignBoardRole(
    {
      guild,
      user: { id: 'actor-user' },
      member: fakeMember([ROLE_NAMES.GLOBAL_PRESIDENT]),
    },
    {
      university: 'Bocconi',
      role: BOARD_ROLES.VICE_PRESIDENT,
      user: { id: 'target-user' },
    },
    { db },
  );

  assert.deepEqual(
    [...target.roles.cache.values()].map((role) => role.name).sort(),
    [ROLE_NAMES.RESEARCHER, 'Bocconi', 'Bocconi - Vice President'].sort(),
  );
});

test('board VP assignment aborts and restores Discord roles when the appointment becomes occupied', async () => {
  const researcherRole = testRole('researcher-role', ROLE_NAMES.RESEARCHER);
  const universityRole = testRole('bocconi-role', 'Bocconi');
  const vicePresidentRole = testRole('vice-president-role', 'Bocconi - Vice President');
  const roleCache = cacheFrom([researcherRole, universityRole, vicePresidentRole]);
  const target = memberWithRoles([researcherRole, universityRole]);
  let occupancyChecks = 0;
  let inserts = 0;
  const activeMember = {
    university_id: 1,
    university_name: 'Bocconi',
    member_type: MEMBER_TYPES.RESEARCHER,
    status: 'active',
  };
  const db = {
    async query(text) {
      if (text.includes('FROM universities')) {
        return { rows: [{ id: 1, name: 'Bocconi' }], rowCount: 1 };
      }
      if (text.includes('FROM members m')) return { rows: [activeMember], rowCount: 1 };
      if (text.includes('FROM board_assignments br')) return { rows: [], rowCount: 0 };
      if (text.includes('SELECT discord_user_id') && text.includes('FROM board_assignments')) {
        occupancyChecks += 1;
        return { rows: [], rowCount: 0 };
      }
      if (text.includes('SELECT id, member_role_id, head_role_id')) {
        return { rows: [], rowCount: 0 };
      }
      if (text.includes('FROM project_people pp')) return { rows: [], rowCount: 0 };
      throw new Error(`Unexpected query: ${text}`);
    },
    async transaction(callback) {
      return callback({
        async query(text) {
          if (text.includes('FROM members m')) return { rows: [activeMember], rowCount: 1 };
          if (text.includes('FROM board_assignments br')) return { rows: [], rowCount: 0 };
          if (text.includes('SELECT discord_user_id') && text.includes('FROM board_assignments')) {
            occupancyChecks += 1;
            return {
              rows: [{ discord_user_id: 'another-member' }],
              rowCount: 1,
            };
          }
          if (text.includes('INSERT INTO board_assignments')) inserts += 1;
          return { rows: [], rowCount: 0 };
        },
      });
    },
  };

  await assert.rejects(
    assignBoardRole(
      {
        guild: {
          roles: { cache: roleCache },
          members: { async fetch() { return target; } },
        },
        user: { id: 'actor-user' },
        member: fakeMember([ROLE_NAMES.GLOBAL_PRESIDENT]),
      },
      {
        university: 'Bocconi',
        role: BOARD_ROLES.VICE_PRESIDENT,
        user: { id: 'target-user' },
      },
      { db },
    ),
    /Vice President at Bocconi is already assigned to another member/,
  );

  assert.equal(occupancyChecks, 2);
  assert.equal(inserts, 0);
  assert.deepEqual(
    [...target.roles.cache.values()].map((role) => role.name).sort(),
    [ROLE_NAMES.RESEARCHER, 'Bocconi'].sort(),
  );
});

test('board executive assignment removes division roles by persisted ID without touching a longer university name', async () => {
  const researcherRole = testRole('researcher-role', ROLE_NAMES.RESEARCHER);
  const universityRole = testRole('university-a-role', 'A');
  const divisionRole = testRole('a-division-role', 'A - Robotics');
  const headRole = testRole('a-head-role', 'A - Head of Robotics');
  const nestedDivisionRole = testRole('a-b-division-role', 'A - B - Robotics');
  const nestedHeadRole = testRole('a-b-head-role', 'A - B - Head of Robotics');
  const vicePresidentRole = testRole('a-vp-role', 'A - Vice President');
  const roleCache = cacheFrom([
    researcherRole,
    universityRole,
    divisionRole,
    headRole,
    nestedDivisionRole,
    nestedHeadRole,
    vicePresidentRole,
  ]);
  const target = memberWithRoles([
    researcherRole,
    universityRole,
    divisionRole,
    headRole,
    nestedDivisionRole,
    nestedHeadRole,
  ]);
  const guild = {
    roles: { cache: roleCache },
    members: { fetch: async () => target },
  };
  const db = {
    async query(text) {
      if (text.includes('FROM universities')) return { rows: [{ id: 1, name: 'A' }], rowCount: 1 };
      if (text.includes('FROM members m')) {
        return {
          rows: [{
            university_id: 1,
            university_name: 'A',
            member_type: MEMBER_TYPES.RESEARCHER,
            status: 'active',
          }],
          rowCount: 1,
        };
      }
      if (text.includes('FROM board_assignments br')) return { rows: [], rowCount: 0 };
      if (text.includes('SELECT discord_user_id') && text.includes('FROM board_assignments')) {
        return { rows: [], rowCount: 0 };
      }
      if (text.includes('SELECT id, member_role_id, head_role_id')) {
        return {
          rows: [{ id: 10, member_role_id: divisionRole.id, head_role_id: headRole.id }],
          rowCount: 1,
        };
      }
      if (text.includes('FROM project_people pp')) return { rows: [], rowCount: 0 };
      throw new Error(`Unexpected query: ${text}`);
    },
    async transaction(callback) {
      return callback({
        async query(text) {
          if (text.includes('FROM members m')) {
            return {
              rows: [{
                university_id: 1,
                university_name: 'A',
                member_type: MEMBER_TYPES.RESEARCHER,
                status: 'active',
              }],
              rowCount: 1,
            };
          }
          if (text.includes('SELECT discord_user_id') && text.includes('FROM board_assignments')) {
            return { rows: [], rowCount: 0 };
          }
          if (text.includes('INSERT INTO board_assignments')) {
            return { rows: [{ id: 1 }], rowCount: 1 };
          }
          return { rows: [], rowCount: 0 };
        },
      });
    },
  };

  await assignBoardRole(
    {
      guild,
      user: { id: 'actor-user' },
      member: fakeMember([ROLE_NAMES.GLOBAL_PRESIDENT]),
    },
    { university: 'A', role: BOARD_ROLES.VICE_PRESIDENT, user: { id: 'target-user' } },
    { db },
  );

  assert.deepEqual(
    [...target.roles.cache.values()].map((candidate) => candidate.id).sort(),
    [researcherRole.id, universityRole.id, nestedDivisionRole.id, nestedHeadRole.id, vicePresidentRole.id].sort(),
  );
});

test('board executive assignment preserves same-university project membership without a division', async () => {
  const researcherRole = testRole('researcher-role', ROLE_NAMES.RESEARCHER);
  const universityRole = testRole('bocconi-role', 'Bocconi');
  const analysisRole = testRole('analysis-role', 'Bocconi - Analysis');
  const vicePresidentRole = testRole('vice-president-role', 'Bocconi - Vice President');
  const roleCache = cacheFrom([researcherRole, universityRole, analysisRole, vicePresidentRole]);
  const target = memberWithRoles([researcherRole, universityRole, analysisRole]);
  const guild = {
    roles: { cache: roleCache },
    members: { async fetch() { return target; } },
  };
  const projectAssignment = {
    id: 42,
    name: 'Signals',
    university_id: 1,
    division_id: 10,
    role: 'member',
    is_university_board_member: false,
  };
  const db = {
    async query(text) {
      if (text.includes('FROM universities')) return { rows: [{ id: 1, name: 'Bocconi' }], rowCount: 1 };
      if (text.includes('FROM members m')) {
        return {
          rows: [{
            university_id: 1,
            university_name: 'Bocconi',
            member_type: MEMBER_TYPES.RESEARCHER,
            status: 'active',
          }],
          rowCount: 1,
        };
      }
      if (text.includes('FROM member_divisions')) {
        return { rows: [{ id: 10, name: 'Analysis', university_name: 'Bocconi' }], rowCount: 1 };
      }
      if (text.includes('FROM board_assignments br')) return { rows: [], rowCount: 0 };
      if (text.includes('SELECT discord_user_id') && text.includes('FROM board_assignments')) {
        return { rows: [], rowCount: 0 };
      }
      if (text.includes('SELECT id, member_role_id, head_role_id')) {
        return { rows: [{ id: 10, member_role_id: analysisRole.id, head_role_id: null }], rowCount: 1 };
      }
      if (text.includes('FROM project_people pp')) {
        return { rows: [projectAssignment], rowCount: 1 };
      }
      throw new Error(`Unexpected query: ${text}`);
    },
    async transaction(callback) {
      return callback({
        async query(text) {
          if (text.includes('FROM members m')) {
            return {
              rows: [{
                university_id: 1,
                university_name: 'Bocconi',
                member_type: MEMBER_TYPES.RESEARCHER,
                status: 'active',
              }],
              rowCount: 1,
            };
          }
          if (text.includes('FROM board_assignments br')) return { rows: [], rowCount: 0 };
          if (text.includes('SELECT discord_user_id') && text.includes('FROM board_assignments')) {
            return { rows: [], rowCount: 0 };
          }
          if (text.includes('FROM project_people pp')) {
            return { rows: [projectAssignment], rowCount: 1 };
          }
          if (text.includes('INSERT INTO board_assignments')) {
            return { rows: [{ id: 1 }], rowCount: 1 };
          }
          return { rows: [], rowCount: 0 };
        },
      });
    },
  };

  await assignBoardRole(
    {
      guild,
      user: { id: 'actor-user' },
      member: fakeMember([ROLE_NAMES.GLOBAL_PRESIDENT]),
    },
    {
      university: 'Bocconi',
      role: BOARD_ROLES.VICE_PRESIDENT,
      user: { id: 'target-user' },
    },
    { db },
  );
  assert.deepEqual(
    [...target.roles.cache.values()].map((role) => role.name).sort(),
    [ROLE_NAMES.RESEARCHER, 'Bocconi', 'Bocconi - Vice President'].sort(),
  );
});

test('division member assignment preserves an existing division member role color', async () => {
  const accessRole = testRole('sapienza-robotics-role', 'Sapienza - Robotics', divisionColorDetails('green').hex);
  const roleCache = cacheFrom([
    testRole('researcher-role', ROLE_NAMES.RESEARCHER),
    testRole('sapienza-role', 'Sapienza'),
    accessRole,
  ]);
  const target = memberWithRoles();
  const guild = {
    roles: {
      cache: roleCache,
      async create(spec) {
        const role = testRole(`created-${spec.name}`, spec.name, spec.colors?.primaryColor);
        roleCache.set(role.id, role);
        return role;
      },
    },
    members: {
      async fetch(id) {
        assert.equal(id, 'target-user');
        return target;
      },
    },
  };
  const db = {
    async query(text) {
      if (text.includes('FROM universities')) return { rows: [{ id: 2, name: 'Sapienza' }], rowCount: 1 };
      if (text.includes('FROM members m')) {
        return {
          rows: [{
            university_id: 2,
            university_name: 'Sapienza',
            member_type: MEMBER_TYPES.RESEARCHER,
            status: 'active',
          }],
          rowCount: 1,
        };
      }
      if (text.includes('FROM member_divisions')) return { rows: [], rowCount: 0 };
      if (text.includes('FROM board_assignments br')) return { rows: [], rowCount: 0 };
      if (text.includes('FROM divisions')) {
        return {
          rows: [{
            id: 88,
            university_id: 2,
            name: 'Robotics',
            color: 'green',
            access_role_id: accessRole.id,
            head_role_id: 'sapienza-head-robotics',
          }],
          rowCount: 1,
        };
      }
      throw new Error(`Unexpected query: ${text}`);
    },
    async transaction(callback) {
      return callback({
        async query(text) {
          if (text.includes('FROM members m')) {
            return {
              rows: [{
                university_id: 2,
                university_name: 'Sapienza',
                member_type: MEMBER_TYPES.RESEARCHER,
                status: 'active',
              }],
              rowCount: 1,
            };
          }
          return { rows: [], rowCount: 0 };
        },
      });
    },
  };

  await addDivisionMember(
    {
      guild,
      user: { id: 'actor-user' },
      member: fakeMember([ROLE_NAMES.GLOBAL_PRESIDENT]),
    },
    {
      university: 'Sapienza',
      division: 'Robotics',
      user: { id: 'target-user' },
    },
    { db },
  );

  assert.equal(accessRole.hexColor, divisionColorDetails('green').hex);
  assert.equal(accessRole.lastEdit, undefined);
  assert.equal(target.roles.cache.has(accessRole.id), true);
});

test('generic division assignment refuses to create a missing division role with fallback color', async () => {
  const roleCache = cacheFrom([
    testRole('researcher-role', ROLE_NAMES.RESEARCHER),
    testRole('sapienza-role', 'Sapienza'),
  ]);
  const target = memberWithRoles();
  const guild = {
    roles: {
      cache: roleCache,
      async create(spec) {
        const role = testRole(`created-${spec.name}`, spec.name, spec.colors?.primaryColor);
        roleCache.set(role.id, role);
        return role;
      },
    },
    members: {
      async fetch(id) {
        assert.equal(id, 'target-user');
        return target;
      },
    },
  };
  const db = {
    async query(text) {
      if (text.includes('FROM universities')) return { rows: [{ id: 2, name: 'Sapienza' }], rowCount: 1 };
      if (text.includes('FROM members m')) {
        return {
          rows: [{
            university_id: 2,
            university_name: 'Sapienza',
            member_type: MEMBER_TYPES.RESEARCHER,
            status: 'active',
          }],
          rowCount: 1,
        };
      }
      if (text.includes('FROM member_divisions')) return { rows: [], rowCount: 0 };
      if (text.includes('FROM board_assignments br')) return { rows: [], rowCount: 0 };
      if (text.includes('FROM divisions')) {
        return {
          rows: [{ id: 88, university_id: 2, name: 'Robotics', color: 'green' }],
          rowCount: 1,
        };
      }
      throw new Error(`Unexpected query: ${text}`);
    },
  };

  await assert.rejects(
    addDivisionMember(
      {
        guild,
        user: { id: 'actor-user' },
        member: fakeMember([ROLE_NAMES.GLOBAL_PRESIDENT]),
      },
      {
        university: 'Sapienza',
        division: 'Robotics',
        user: { id: 'target-user' },
      },
      { db },
    ),
    /Required division role is missing: Sapienza - Robotics/,
  );
  assert.equal(roleCache.find((role) => role.name === 'Sapienza - Robotics'), undefined);
});

test('autocomplete lookups target only active universities and divisions', async () => {
  const queries = [];
  const db = {
    async query(text, values) {
      queries.push({ text, values });
      if (text.includes('FROM universities')) return { rows: [{ id: 1, name: 'Bocconi' }] };
      return { rows: [{ id: 10, name: 'Projects' }] };
    },
  };

  await findUniversities('bo', { db });
  await findDivisions('Bocconi', 'pro', { db });

  assert.match(queries[0].text, /active = true/);
  assert.match(queries[1].text, /active = true/);
  assert.match(queries[2].text, /active = true/);
});

test('division autocomplete never falls back to all universities', async () => {
  let queried = false;
  const db = {
    async query() {
      queried = true;
      return { rows: [] };
    },
  };

  assert.deepEqual(await findDivisions('', 'pro', { db }), []);
  assert.equal(queried, false);
});

test('governance autocomplete cache loads only active universities and divisions', async () => {
  const queries = [];
  const db = {
    async query(text) {
      queries.push(text);
      if (text.includes('FROM divisions')) {
        return { rows: [{ university_name: 'Bocconi', name: 'Robotics', color: 'green' }] };
      }
      return { rows: [{ id: 1, name: 'Bocconi' }] };
    },
  };

  const snapshot = await warmGovernanceAutocompleteCache({ db });

  assert.equal(queries.length, 2);
  assert.match(queries[0], /FROM universities/);
  assert.match(queries[0], /active = true/);
  assert.match(queries[1], /FROM divisions/);
  assert.match(queries[1], /d\.active = true/);
  assert.deepEqual(snapshot.universities, [{ id: 1, name: 'Bocconi' }]);
  assert.deepEqual(snapshot.divisions, [{ university_name: 'Bocconi', name: 'Robotics', color: 'green' }]);
});

test('member-info renders a compact informational card from a direct Discord user', () => {
  const target = { id: '100', globalName: 'Ada on Discord', username: 'ada' };
  const payload = formatMemberInfo({
    target,
    member: { full_name: 'Ada Lovelace', member_type: MEMBER_TYPES.RESEARCHER, university_name: 'Bocconi' },
    divisions: [{ name: 'Robotics', color: 'yellow' }],
    boardRoles: [{ role: BOARD_ROLES.GLOBAL_PRESIDENT, university_name: null, division_name: null }],
    projects: [{ name: 'Research sprint', role: 'member', status: 'active' }],
  });

  assert.deepEqual(payload.allowedMentions, { parse: [] });
  assert.equal(payload.content, undefined);
  const embed = embedJson(payload.embeds[0]);
  assert.equal(embed.title, '🔵 Member information');
  assert.equal(embed.color, 0x5865f2);
  assert.equal(embed.description, 'Current canonical membership and active assignments');
  assert.deepEqual(embed.fields, [
    { name: 'Member', value: 'Ada Lovelace (<@100>)', inline: true },
    { name: 'Type', value: 'Researcher', inline: true },
    { name: 'University', value: 'Bocconi', inline: true },
    { name: 'Divisions', value: '🟨 Robotics', inline: true },
    { name: 'Board roles', value: 'Global President', inline: false },
    { name: 'Active projects', value: 'Research sprint — Member · Active', inline: false },
  ]);
  assert.equal(embed.footer.text, 'Member record · Current database state');
});

test('member-info keeps empty assignments compact and readable', () => {
  const payload = formatMemberInfo({
    target: { id: '100', displayName: 'Greek', user: { tag: 'Greek#0001' } },
    member: { full_name: null, member_type: MEMBER_TYPES.ALUMNI, university_name: null },
    divisions: [],
    boardRoles: [],
    projects: [],
  });
  const fields = embedJson(payload.embeds[0]).fields;
  assert.equal(fields.find((field) => field.name === 'Member').value, 'Greek (<@100>)');
  assert.equal(fields.find((field) => field.name === 'Type').value, 'Alumni');
  assert.equal(fields.find((field) => field.name === 'University').value, 'Not assigned');
  assert.equal(fields.find((field) => field.name === 'Divisions').value, 'Not applicable to Alumni');
  assert.equal(fields.find((field) => field.name === 'Board roles').value, 'No active board roles');
  assert.equal(fields.find((field) => field.name === 'Active projects').value, 'No active project assignments');
});

test('board-info keeps leadership and divisions in one compact roster', () => {
  const payload = formatBoardInfo({
    university: { name: 'Bocconi' },
    divisions: [
      { id: 10, name: 'Analysis', color: 'orange' },
      { id: 11, name: 'Robotics', color: 'yellow' },
    ],
    rows: [
      { discord_user_id: 'president', role: BOARD_ROLES.PRESIDENT, division_id: null, missingRoles: [] },
      { discord_user_id: 'co-president', role: BOARD_ROLES.PRESIDENT, division_id: null, missingRoles: [] },
      { discord_user_id: 'vice', role: BOARD_ROLES.VICE_PRESIDENT, division_id: null, missingRoles: [] },
      {
        discord_user_id: 'head', role: BOARD_ROLES.HEAD, division_id: 10,
        division_name: 'Analysis', division_color: 'orange', missingRoles: [],
      },
    ],
  });
  assert.equal(payload.embeds.length, 1);
  const roster = embedJson(payload.embeds[0]);
  assert.equal(roster.title, '🔵 Bocconi board');
  assert.equal(roster.description, '2 Presidents · 1 Vice President · 1 of 2 divisions headed');
  assert.equal(roster.fields[0].value, '<@president>, <@co-president>');
  assert.deepEqual(roster.fields.map((field) => field.name), [
    'Presidents', 'Vice Presidents', 'Division Heads',
  ]);
  assert.equal(roster.fields[2].value, '**🟧 Analysis** · <@head>\n**🟨 Robotics** · *No active Head*');
  assert.equal((roster.fields[2].value.match(/━/g) ?? []).length, 0);
  assert.equal(roster.footer, undefined);
  assert.deepEqual(payload.allowedMentions, { parse: [] });
});

test('board-info reports Discord consistency issues separately from the canonical roster', () => {
  const payload = formatBoardInfo({
    university: { name: 'Bocconi' },
    divisions: [{ id: 10, name: 'Analysis', color: 'orange' }],
    rows: [{
      discord_user_id: 'president', role: BOARD_ROLES.PRESIDENT, division_id: null,
      missingRoles: ['Bocconi President'],
    }],
  });
  const health = embedJson(payload.embeds[1]);
  assert.equal(health.title, '🟡 Discord consistency · 1 issue');
  assert.match(health.description, /canonical board assignments are valid/);
  assert.match(health.fields[0].value, /Missing Bocconi President/);
  assert.match(health.fields[0].value, /`\/board-update`/);
});

test('board-info identifies stale managed Discord roles as health drift', () => {
  const payload = formatBoardInfo({
    university: { name: 'Bocconi' },
    divisions: [],
    rows: [{
      discord_user_id: 'president', role: BOARD_ROLES.PRESIDENT, division_id: null,
      missingRoles: [], unexpectedRoles: ['Bocconi Vice President'],
    }],
  });
  const health = embedJson(payload.embeds[1]);
  assert.equal(health.title, '🟡 Discord consistency · 1 issue');
  assert.match(health.fields[0].value, /Unexpected Bocconi Vice President/);
  assert.match(health.fields[0].value, /`\/board-update`/);
});

test('board-info keeps an empty board and every unheaded division explicit', () => {
  const payload = formatBoardInfo({
    university: { name: 'Sciences Po' },
    divisions: [
      { id: 10, name: 'Research', color: 'blue' },
      { id: 11, name: 'Partnerships', color: 'purple' },
    ],
    rows: [],
  });
  assert.equal(payload.embeds.length, 1);
  const roster = embedJson(payload.embeds[0]);
  assert.equal(roster.title, '🟡 Sciences Po board');
  assert.equal(roster.description, 'No active leadership assignments are recorded');
  assert.equal(roster.fields[0].value, 'No active President');
  assert.equal(roster.fields[1].value, 'No active Vice Presidents');
  assert.match(roster.fields[2].value, /\*\*🟦 Research\*\* · \*No active Head\*/);
  assert.match(roster.fields[2].value, /\*\*[^\n]+ Partnerships\*\* · \*No active Head\*/);
});

test('board-info retains a database name when the Discord member is unresolved', () => {
  const payload = formatBoardInfo({
    university: { name: 'Bocconi' },
    divisions: [],
    rows: [{
      discord_user_id: 'missing-member', full_name: 'Grace Hopper', role: BOARD_ROLES.PRESIDENT,
      division_id: null, missingRoles: ['member not in server'],
    }],
  });
  const roster = embedJson(payload.embeds[0]);
  const health = embedJson(payload.embeds[1]);
  assert.equal(roster.fields[0].value, 'Grace Hopper (<@missing-member>)');
  assert.match(health.fields[0].value, /Grace Hopper \(<@missing-member>\)/);
  assert.match(health.fields[0].value, /Member is no longer in Discord/);
});

test('board-info keeps a large roster inside Discord limits without losing university context', () => {
  const divisions = Array.from({ length: 100 }, (_, index) => ({
    id: index + 1,
    name: `Division ${index + 1}`,
    color: 'blue',
  }));
  const payload = formatBoardInfo({
    university: { name: 'A Very Long University Name' },
    divisions,
    rows: divisions.map((division, index) => ({
      discord_user_id: `head-${index}`,
      role: BOARD_ROLES.HEAD,
      division_id: division.id,
      division_name: division.name,
      division_color: division.color,
      missingRoles: [],
    })),
  });
  const roster = embedJson(payload.embeds[0]);
  const characterCount = roster.title.length
    + roster.description.length
    + roster.fields.reduce((total, field) => total + field.name.length + field.value.length, 0);
  assert.ok(characterCount <= 6_000);
  assert.ok(roster.fields.every((field) => field.value.length <= 1_024));
  assert.match(roster.fields.find((field) => field.name === 'Division Heads').value, /more/);
  assert.match(roster.title, /A Very Long University Name board/);
  assert.equal(roster.footer, undefined);
});

test('member-info uses a readable fallback when the Discord user cannot be resolved', () => {
  const payload = formatMemberInfo({
    target: { displayName: 'Grace Hopper' },
    member: { full_name: null, member_type: MEMBER_TYPES.ALUMNI, university_name: 'Bocconi' },
    divisions: [],
    boardRoles: [],
    projects: [],
  });
  const member = embedJson(payload.embeds[0]).fields.find((field) => field.name === 'Member').value;
  assert.equal(member, 'Grace Hopper');
  assert.doesNotMatch(JSON.stringify(payload), /\[object Object\]/);
});

test('member-info keeps the complete compact card within Discord limits', () => {
  const payload = formatMemberInfo({
    target: { id: '100', user: { tag: 'Greek#0001' } },
    member: { full_name: 'Greek', member_type: MEMBER_TYPES.RESEARCHER, university_name: 'Bocconi' },
    divisions: Array.from({ length: 30 }, (_, index) => ({ name: `Division ${index}`, color: 'blue' })),
    boardRoles: Array.from({ length: 10 }, (_, index) => ({
      role: BOARD_ROLES.HEAD,
      division_name: `Division ${index}`,
    })),
    projects: Array.from({ length: 100 }, (_, index) => ({
      name: `Project ${index}`,
      role: 'member',
      status: 'active',
    })),
  });
  const embed = embedJson(payload.embeds[0]);
  const characterCount = embed.title.length
    + embed.footer.text.length
    + embed.fields.reduce((total, field) => total + field.name.length + field.value.length, 0);
  assert.ok(characterCount <= 6_000);
  assert.ok(embed.fields.every((field) => field.value.length <= 1_024));
  assert.match(JSON.stringify(embed.fields), /more/);
});

test('member removal cleanup targets project channel overwrites once', () => {
  assert.deepEqual(
    projectChannelCleanupTargets([
      { channel_id: '123' },
      { channel_id: null },
      { channel_id: '456' },
      { channel_id: '123' },
    ]),
    ['123', '456'],
  );
});

test('member removal cleanup plan captures board, division, project, and overwrite scopes', () => {
  assert.deepEqual(
    memberRemovalCleanupPlan({
      divisions: [{ id: 10, name: 'Projects' }],
      boardRoles: [
        { role: BOARD_ROLES.HEAD, university_name: 'Bocconi', division_name: 'Projects' },
        { role: BOARD_ROLES.GLOBAL_PRESIDENT, university_name: null, division_name: null },
      ],
      projects: [
        { id: 100, role: 'member', channel_id: 'abc' },
        { id: 101, role: 'supervisor', channel_id: 'abc' },
        { id: 102, role: 'member', channel_id: null },
      ],
    }),
    {
      divisionIds: ['10'],
      boardAssignments: [
        { role: BOARD_ROLES.HEAD, university: 'Bocconi', division: 'Projects' },
        { role: BOARD_ROLES.GLOBAL_PRESIDENT, university: null, division: null },
      ],
      projectAssignments: [
        { id: '100', role: 'member', channelId: 'abc' },
        { id: '101', role: 'supervisor', channelId: 'abc' },
        { id: '102', role: 'member', channelId: null },
      ],
      projectChannelIds: ['abc'],
    },
  );
});
