import test from 'node:test';
import assert from 'node:assert/strict';

import { ChannelType } from 'discord.js';

import { MAX_PROJECT_PARTICIPANTS, PROJECT_MEMBER_FETCH_CONCURRENCY, PROJECT_STATUSES } from '../src/constants.js';
import {
  addProjectMember,
  assertGuildMembers,
  assertActiveProjectMembers,
  assertActiveUniversityMembers,
  canViewProject,
  closeProject,
  createProject,
  findProjectParentId,
  findProjectDivisions,
  findProjectPeople,
  findProjectUniversities,
  removeProjectMember,
  searchVisibleProjects,
  updateProject,
  warmProjectAutocompleteCache,
} from '../src/services/projects/index.js';
import { UserFacingError } from '../src/errors.js';
import {
  assertMemberProjectAssignmentEligibility,
  assertProjectPeopleEligibility,
  sortedDiscordUserIds,
} from '../src/services/projects/eligibility.js';
import { formatProjectIntro, formatShowcasePost, projectInfoMessage } from '../src/services/projects/formatters.js';

function memberWithRoles(id, roleNames) {
  return {
    id,
    roles: {
      cache: {
        some(callback) {
          return roleNames.some((name) => callback({ name }));
        },
      },
    },
  };
}

function guildWithCategories(categories) {
  return {
    channels: {
      cache: {
        has(id) {
          return categories.some((category) => category.id === id);
        },
        find(callback) {
          return categories.find(callback);
        },
      },
    },
  };
}

test('project channels use persisted university category with university-name fallback', () => {
  const guild = guildWithCategories([
    { id: 'persisted', name: 'Anything', type: ChannelType.GuildCategory },
    { id: 'fallback', name: 'BAINSA BOCCONI', type: ChannelType.GuildCategory },
  ]);

  assert.equal(
    findProjectParentId(guild, { category_id: 'persisted', university_name: 'Bocconi' }),
    'persisted',
  );
  assert.equal(
    findProjectParentId(guild, { category_id: 'missing', university_name: 'Bocconi' }),
    'fallback',
  );
});

test('project view policy includes project people and scoped board roles only', () => {
  const project = { university_name: 'Bocconi', division_name: 'Projects' };

  assert.equal(canViewProject(memberWithRoles('person', []), project, [{ discord_user_id: 'person' }]), true);
  assert.equal(canViewProject(memberWithRoles('head', ['Bocconi - Head of Projects']), project), true);
  assert.equal(canViewProject(memberWithRoles('head', ['Bocconi - Head of Analysis']), project), false);
  assert.equal(canViewProject(memberWithRoles('vp', ['Bocconi - Vice President']), project), true);
  assert.equal(canViewProject(memberWithRoles('global', ['Global President']), project), true);
  assert.equal(canViewProject(memberWithRoles('other', ['Sapienza - President']), project), false);
});

test('autocomplete only returns projects visible to the caller', async () => {
  const rows = [
    {
      id: 1,
      name: 'Own Assignment',
      status: 'active',
      university_name: 'Bocconi',
      division_name: 'Analysis',
      actor_is_project_person: true,
    },
    {
      id: 2,
      name: 'Own Division',
      status: 'active',
      university_name: 'Bocconi',
      division_name: 'Projects',
      actor_is_project_person: false,
    },
    {
      id: 3,
      name: 'Other Division',
      status: 'active',
      university_name: 'Bocconi',
      division_name: 'Culture',
      actor_is_project_person: false,
    },
  ];
  let sql;
  const db = {
    query: async (text) => {
      sql = text;
      return { rows };
    },
  };
  const choices = await searchVisibleProjects(
    {
      interaction: {
        user: { id: 'caller' },
        member: memberWithRoles('caller', ['Bocconi - Head of Projects']),
      },
      query: '',
    },
    { db },
  );

  assert.deepEqual(
    choices.map((choice) => choice.value),
    ['1', '2'],
  );
  assert.doesNotMatch(sql, /LIMIT 100/);
});

test('project setup autocomplete scopes universities, divisions, and people correctly', async () => {
  const calls = [];
  const db = {
    async query(text, values) {
      calls.push({ text, values });
      return { rows: [{ name: 'Bocconi', discord_user_id: '111111111111111111', full_name: 'Ada Lovelace' }] };
    },
  };

  await findProjectUniversities('b', { db });
  await findProjectDivisions('Bocconi', 'p', { db });
  await findProjectPeople({
    universityName: 'Bocconi',
    divisionName: 'Projects',
    role: 'member',
    term: 'ada',
  }, { db });
  await findProjectPeople({
    universityName: 'Bocconi',
    divisionName: 'Projects',
    role: 'supervisor',
    term: 'ada',
  }, { db });

  assert.match(calls[0].text, /FROM universities/);
  assert.match(calls[1].text, /JOIN universities/);
  assert.match(calls[2].text, /member_divisions/);
  assert.deepEqual(calls[2].values.slice(0, 3), ['Bocconi', 'Projects', 'researcher']);
  assert.equal(calls[3].values[1], null);
  assert.equal(calls[3].values[2], null);
});

test('cached project people scope members to a division and supervisors to a university', async () => {
  await warmProjectAutocompleteCache({
    db: {
      async query(text) {
        if (text.includes('FROM universities')) return { rows: [] };
        if (text.includes('FROM divisions')) return { rows: [] };
        return {
          rows: [
            { discord_user_id: '1', full_name: 'Ada', member_type: 'researcher', university_name: 'Bocconi', division_name: 'Projects', is_university_board_member: false },
            { discord_user_id: '2', full_name: 'Beatrice', member_type: 'alumni', university_name: 'Bocconi', division_name: 'Projects', is_university_board_member: false },
            { discord_user_id: '3', full_name: 'Carlo', member_type: 'researcher', university_name: 'Bocconi', division_name: 'Analysis', is_university_board_member: true },
            { discord_user_id: '4', full_name: 'Daria', member_type: 'researcher', university_name: 'Sapienza', division_name: 'Projects', is_university_board_member: true },
            { discord_user_id: '5', full_name: 'Elena', member_type: 'researcher', university_name: 'Bocconi', division_name: null, is_university_board_member: true },
          ],
        };
      },
    },
  });

  const scoped = { universityName: 'Bocconi', divisionName: 'Projects', term: '' };
  assert.deepEqual(
    await findProjectPeople({ ...scoped, role: 'member' }),
    [
      { discord_user_id: '1', full_name: 'Ada' },
      { discord_user_id: '3', full_name: 'Carlo' },
      { discord_user_id: '5', full_name: 'Elena' },
    ],
  );
  assert.deepEqual(
    await findProjectPeople({ ...scoped, role: 'supervisor' }),
    [
      { discord_user_id: '1', full_name: 'Ada' },
      { discord_user_id: '2', full_name: 'Beatrice' },
      { discord_user_id: '3', full_name: 'Carlo' },
      { discord_user_id: '5', full_name: 'Elena' },
    ],
  );
  assert.deepEqual(
    await findProjectPeople({ universityName: 'Bocconi', role: 'supervisor', term: '' }),
    [
      { discord_user_id: '1', full_name: 'Ada' },
      { discord_user_id: '2', full_name: 'Beatrice' },
      { discord_user_id: '3', full_name: 'Carlo' },
      { discord_user_id: '5', full_name: 'Elena' },
    ],
  );
});

test('project member lookup accepts division researchers and same-university board members', async () => {
  const calls = [];
  const db = {
    async query(text, values) {
      calls.push({ text, values });
      return { rows: [{ discord_user_id: '111111111111111111' }] };
    },
  };

  await assertActiveProjectMembers(db, 10, 20, ['111111111111111111'], 'members');
  assert.match(calls[0].text, /FROM member_divisions/);
  assert.match(calls[0].text, /FROM board_assignments/);
  assert.deepEqual(calls[0].values, [10, 20, ['111111111111111111'], 'researcher']);
});

test('project eligibility accepts local board members as members without a division', async () => {
  const project = { university_id: 10, division_id: 20 };
  const person = { discord_user_id: 'board-member', role: 'member' };
  const db = {
    async query() {
      return {
        rows: [{
          discord_user_id: 'board-member',
          member_type: 'researcher',
          university_id: 10,
          status: 'active',
          division_id: null,
          is_university_board_member: true,
        }],
      };
    },
  };

  await assertProjectPeopleEligibility(db, project, [person]);
});

test('executive promotion preserves same-university project member eligibility', async () => {
  const db = {
    async query() {
      return {
        rows: [{
          id: 42,
          name: 'Signals',
          university_id: 10,
          division_id: 20,
          role: 'member',
          is_university_board_member: false,
        }],
      };
    },
  };

  await assertMemberProjectAssignmentEligibility(db, {
    userId: 'future-president',
    memberType: 'researcher',
    universityId: 10,
    divisionIds: [],
    additionalBoardUniversityIds: [10],
  });
});

test('supervisor eligibility is university-scoped and accepts active alumni', async () => {
  const calls = [];
  const db = {
    async query(text, values) {
      calls.push({ text, values });
      return { rows: [{ discord_user_id: '222222222222222222' }] };
    },
  };

  await assertActiveUniversityMembers(db, 10, ['222222222222222222'], 'supervisors');
  assert.doesNotMatch(calls[0].text, /member_type/);
  assert.deepEqual(calls[0].values, [10, ['222222222222222222']]);
});

test('participant eligibility locks use one deterministic Discord user ID order', () => {
  assert.deepEqual(
    sortedDiscordUserIds(['333333333333333333', '111111111111111111', '333333333333333333', '222222222222222222']),
    ['111111111111111111', '222222222222222222', '333333333333333333'],
  );
});

test('project creation rejects capacity-incompatible participants before database or Discord work', async () => {
  const participantIds = Array.from(
    { length: MAX_PROJECT_PARTICIPANTS + 1 },
    (_, index) => String(100000000000000 + index),
  );
  let databaseQueries = 0;
  let memberFetches = 0;
  const guild = {
    members: {
      async fetch() {
        memberFetches += 1;
        return null;
      },
    },
  };
  const db = {
    async query() {
      databaseQueries += 1;
      throw new Error('capacity validation should run first');
    },
  };

  await assert.rejects(
    () => createProject({
      interaction: { guild, member: {}, user: { id: 'actor' } },
      name: 'Signals',
      university: 'Bocconi',
      division: 'Analysis',
      startDate: '2026-07-01',
      expectedEnd: '2026-08-01',
      members: participantIds.join(','),
      supervisors: '999999999999999',
    }, { db }),
    new RegExp(`at most ${MAX_PROJECT_PARTICIPANTS} unique participants`),
  );
  assert.equal(databaseQueries, 0);
  assert.equal(memberFetches, 0);
});

test('project member fetches are bounded and surface transient fetch failures', async () => {
  const ids = Array.from({ length: PROJECT_MEMBER_FETCH_CONCURRENCY * 3 }, (_, index) => String(index + 1));
  let inFlight = 0;
  let maxInFlight = 0;
  const guild = {
    members: {
      async fetch(id) {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setImmediate(resolve));
        inFlight -= 1;
        if (id === ids.at(-1)) throw new Error('controlled fetch failure');
        return { id };
      },
    },
  };

  await assert.rejects(
    () => assertGuildMembers(guild, ids),
    /controlled fetch failure/,
  );
  assert.ok(maxInFlight <= PROJECT_MEMBER_FETCH_CONCURRENCY);
  assert.equal(maxInFlight, PROJECT_MEMBER_FETCH_CONCURRENCY);
});

test('project member fetches report only confirmed unknown members as absent', async () => {
  const guild = {
    members: {
      async fetch() {
        throw { code: 10_007 };
      },
    },
  };

  await assert.rejects(
    () => assertGuildMembers(guild, ['123456789012345']),
    /These users are not in the server: <@123456789012345>/,
  );
});

test('project formatters cap participant lists and full messages at Discord\'s content limit', () => {
  const people = Array.from({ length: MAX_PROJECT_PARTICIPANTS }, (_, index) => ({
    discord_user_id: String(100000000000000 + index),
    role: index % 3 === 0 ? 'member' : index % 3 === 1 ? 'supervisor' : 'board_liaison',
  }));
  const project = {
    id: 42,
    name: 'Signals',
    university_name: 'Bocconi',
    division_name: 'Projects',
    division_color: 'blue',
    status: 'active',
    start_date: '2026-07-01',
    expected_end: '2026-08-01',
    discord_channel_id: 'channel',
    notes: 'x'.repeat(4_000),
  };

  for (const message of [
    formatProjectIntro(project, people, 'y'.repeat(4_000)),
    formatShowcasePost(project, people, 'y'.repeat(4_000)),
    projectInfoMessage(project, people),
  ]) {
    assert.ok(message.length <= 2_000);
    assert.match(message, /\(\+\d+ more\)/);
    assert.doesNotMatch(message, /<@\d{0,14}(?:$|[^\d>])/);
  }
});

test('project-close completes the project and moves the channel to history', async () => {
  const queries = [];
  const project = {
    id: 42,
    name: 'Signals',
    university_id: 10,
    division_id: 20,
    university_name: 'Bocconi',
    division_name: 'Projects',
    start_date: '2026-07-01',
    expected_end: '2026-08-01',
    notes: null,
    status: PROJECT_STATUSES.ACTIVE,
    discord_channel_id: 'project-channel',
    category_id: 'university-category',
    showcase_thread_id: null,
    division_head_role_id: null,
  };
  const closedProject = { ...project, status: PROJECT_STATUSES.COMPLETED };
  const people = [{ discord_user_id: 'member', role: 'member' }];
  let projectSelects = 0;
  function reconciliationQuery(text) {
    if (text.includes('INSERT INTO project_reconciliation') || text.includes("SET status = 'succeeded'")) {
      return { rowCount: 1, rows: [{ desired_generation: 1 }] };
    }
    if (text.includes('SELECT desired_generation')) return { rowCount: 1, rows: [{ desired_generation: 1 }] };
    return null;
  }
  const db = {
    async query(text, values) {
      queries.push({ text, values });
      const reconciliation = reconciliationQuery(text);
      if (reconciliation) return reconciliation;
      if (text.includes('FROM projects p')) {
        projectSelects += 1;
        return { rowCount: 1, rows: [projectSelects === 1 ? project : closedProject] };
      }
      if (text.includes('FROM project_people')) return { rows: people };
      return { rows: [] };
    },
    async transaction(work) {
      return work({
        async query(text, values) {
          queries.push({ text, values });
          const reconciliation = reconciliationQuery(text);
          if (reconciliation) return reconciliation;
          if (text.includes('FROM projects p')) {
            projectSelects += 1;
            return { rowCount: 1, rows: [closedProject] };
          }
          if (text.includes('FROM project_people')) return { rows: people };
          return { rows: [] };
        },
      });
    },
  };
  const channel = {
    name: 'project-42-signals',
    parentId: null,
    permissionOverwrites: {
      async set(overwrites, reason) {
        channel.overwrites = overwrites;
        channel.overwriteReason = reason;
      },
    },
    async setParent(parentId, options) {
      channel.parentId = parentId;
      channel.parentOptions = options;
    },
    async setName(name) {
      channel.name = name;
    },
    async send(message) {
      channel.message = message;
    },
  };
  const guild = {
    id: 'guild',
    roles: {
      cache: {
        find(callback) {
          return [
            { id: 'head-role', name: 'Bocconi - Head of Projects' },
            { id: 'global-role', name: 'Global President' },
            { id: 'bot-role', name: 'Bot' },
          ].find(callback);
        },
      },
    },
    channels: {
      cache: {
        has(id) {
          return id === 'archive-category';
        },
        find(callback) {
          return [{ id: 'archive-category', name: 'ARCHIVE / HISTORY', type: ChannelType.GuildCategory }].find(callback);
        },
      },
      async fetch(id) {
        assert.equal(id, 'project-channel');
        return channel;
      },
    },
  };

  const result = await closeProject(
    {
      interaction: {
        guild,
        user: { id: 'actor' },
        member: memberWithRoles('actor', ['Bocconi - Head of Projects']),
      },
      project: '42',
      outcome: 'Completed successfully',
      finalNotes: 'Ready for handover',
    },
    { db },
  );

  assert.equal(result.project.status, PROJECT_STATUSES.COMPLETED);
  assert.equal(channel.parentId, 'archive-category');
  assert.deepEqual(channel.parentOptions, { lockPermissions: false });
  assert.equal(channel.overwriteReason, 'Reconcile project 42 access');
  assert.match(channel.message.content, /\*\*Outcome:\*\* Completed successfully/);
  assert.ok(queries.some((call) => call.text.includes('SET status = $1') && call.values[0] === PROJECT_STATUSES.COMPLETED));
  assert.equal(queries.some((call) => call.values?.[0] === PROJECT_STATUSES.ARCHIVED), false);
});

test('completed and archived projects reject all mutating project commands before writing', async () => {
  const immutableProject = {
    id: 42,
    name: 'Signals',
    university_id: 10,
    division_id: 20,
    university_name: 'Bocconi',
    division_name: 'Projects',
    status: PROJECT_STATUSES.COMPLETED,
  };
  let writes = 0;
  const db = {
    async query(text) {
      if (text.includes('FROM projects p')) return { rowCount: 1, rows: [immutableProject] };
      throw new Error(`Unexpected query: ${text}`);
    },
    async transaction() {
      writes += 1;
    },
  };
  const interaction = {
    user: { id: 'actor' },
    member: memberWithRoles('actor', ['Bocconi - Head of Projects']),
  };

  await assert.rejects(
    () => addProjectMember({ interaction, project: '42', user: { id: 'member' }, role: 'member' }, { db }),
    /cannot be changed/,
  );
  await assert.rejects(
    () => removeProjectMember({ interaction, project: '42', user: { id: 'member' } }, { db }),
    /cannot be changed/,
  );
  await assert.rejects(
    () => updateProject({ interaction, project: '42', name: 'Renamed' }, { db }),
    /cannot be changed/,
  );
  await assert.rejects(
    () => closeProject({ interaction, project: '42', outcome: 'Done', finalNotes: 'Handover' }, { db }),
    /cannot be changed/,
  );
  assert.equal(writes, 0);
});

test('eligibility reports missing active members clearly', async () => {
  const db = { query: async () => ({ rows: [] }) };
  await assert.rejects(
    () => assertActiveProjectMembers(db, 10, 20, ['333333333333333333'], 'members'),
    UserFacingError,
  );
});
