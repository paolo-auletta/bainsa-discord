import assert from 'node:assert/strict';
import test from 'node:test';

import { ChannelType, PermissionFlagsBits } from 'discord.js';

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
  formatMemberInfo,
  memberRemovalCleanupPlan,
  projectChannelCleanupTargets,
  roleNamesForDivisionHead,
  resolveDivisionTextForMemberUpdate,
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

function option(commandJson, name) {
  return commandJson.options.find((entry) => entry.name === name);
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

function testRole(id, name, hexColor = '#000000') {
  return {
    id,
    name,
    hexColor,
    editable: true,
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

function testChannel(id, name, type, parentId = null) {
  return {
    id,
    name,
    type,
    parentId,
    async delete(reason) {
      this.deletedReason = reason;
    },
  };
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
    'board-assign',
    'board-info',
    'board-remove',
    'division-add-member',
    'division-create',
    'division-remove-member',
    'division-rename',
    'member-add',
    'member-info',
    'member-remove',
    'member-update',
  ]);
});

test('division-create requires a head and both channel booleans', () => {
  const divisionCreate = governanceCommands.find((entry) => entry.data.name === 'division-create');
  const json = divisionCreate.data.toJSON();

  assert.equal(option(json, 'head').required, true);
  assert.equal(option(json, 'create_text_channel').required, true);
  assert.equal(option(json, 'create_voice_channel').required, true);
  assert.deepEqual(option(json, 'color').choices.map((choice) => choice.value), [
    'red', 'orange', 'yellow', 'green', 'blue', 'pink', 'brown', 'black',
  ]);
  assert.equal(option(json, 'color').choices.find((choice) => choice.value === 'pink').name, 'Pink 🟪');
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

test('division Heads receive only the scoped Head role, not the ordinary division role', () => {
  assert.deepEqual(
    roleNamesForDivisionHead('Bocconi', 'Projects'),
    ['Bocconi', 'Bocconi - Head of Projects'],
  );
});

test('division-rename uses current_name, not old_name', () => {
  const divisionRename = governanceCommands.find((entry) => entry.data.name === 'division-rename');
  const json = divisionRename.data.toJSON();

  assert.ok(option(json, 'current_name'));
  assert.equal(option(json, 'old_name'), undefined);
});

test('board command option shape matches the approved policy', () => {
  const boardAssign = governanceCommands.find((entry) => entry.data.name === 'board-assign').data.toJSON();
  const boardRemove = governanceCommands.find((entry) => entry.data.name === 'board-remove').data.toJSON();

  assert.equal(option(boardAssign, 'division').required, false);
  assert.equal(option(boardRemove, 'division').required, false);
  assert.equal(option(boardRemove, 'reason').required, false);
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
  assert.equal(head.roles.cache.has(accessRole.id), false);
});

test('board Head assignment preserves an existing division Head role color', async () => {
  const headRole = testRole('sapienza-head-robotics', 'Sapienza - Head of Robotics', divisionColorDetails('green').hex);
  const roleCache = cacheFrom([
    testRole('researcher-role', ROLE_NAMES.RESEARCHER),
    testRole('sapienza-role', 'Sapienza'),
    testRole('sapienza-robotics-role', 'Sapienza - Robotics', divisionColorDetails('green').hex),
    headRole,
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
      if (text.includes('FROM members m')) return { rows: [], rowCount: 0 };
      if (text.includes('FROM divisions')) {
        return {
          rows: [{
            id: 88,
            university_id: 2,
            name: 'Robotics',
            color: 'green',
            access_role_id: 'sapienza-robotics-role',
            head_role_id: headRole.id,
          }],
          rowCount: 1,
        };
      }
      throw new Error(`Unexpected query: ${text}`);
    },
    async transaction(callback) {
      return callback({ async query() { return { rows: [], rowCount: 0 }; } });
    },
  };

  await assignBoardRole(
    {
      guild,
      user: { id: 'actor-user' },
      member: fakeMember([ROLE_NAMES.GLOBAL_PRESIDENT]),
    },
    {
      university: 'Sapienza',
      role: BOARD_ROLES.HEAD,
      division: 'Robotics',
      user: { id: 'target-user' },
    },
    { db },
  );

  assert.equal(headRole.hexColor, divisionColorDetails('green').hex);
  assert.equal(headRole.lastEdit, undefined);
  assert.equal(target.roles.cache.has(headRole.id), true);
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
      if (text.includes('FROM members m')) return { rows: [], rowCount: 0 };
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
      return callback({ async query() { return { rows: [], rowCount: 0 }; } });
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
      if (text.includes('FROM members m')) return { rows: [], rowCount: 0 };
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

test('member-info formats nullable global president board rows', () => {
  const output = formatMemberInfo({
    target: { user: { tag: 'Global#0001' } },
    member: { member_type: MEMBER_TYPES.RESEARCHER, university_name: 'Bocconi' },
    divisions: [],
    boardRoles: [{ role: BOARD_ROLES.GLOBAL_PRESIDENT, university_name: null, division_name: null }],
    projects: [],
  });

  assert.match(output, /Board roles: Global President/);
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
