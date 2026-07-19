import test from 'node:test';
import assert from 'node:assert/strict';

import { ChannelType } from 'discord.js';

import { PROJECT_STATUSES } from '../src/constants.mjs';
import {
  addProjectMember,
  assertActiveDivisionResearchers,
  assertActiveUniversityMembers,
  canViewProject,
  closeProject,
  findProjectParentId,
  findProjectDivisions,
  findProjectPeople,
  findProjectUniversities,
  removeProjectMember,
  searchVisibleProjects,
  updateProject,
} from '../src/services/projects/index.mjs';
import { UserFacingError } from '../src/errors.mjs';
import { sortedDiscordUserIds } from '../src/services/projects/eligibility.mjs';

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
  const db = { query: async () => ({ rows }) };
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

test('member eligibility is division-scoped for project members', async () => {
  const calls = [];
  const db = {
    async query(text, values) {
      calls.push({ text, values });
      return { rows: [{ discord_user_id: '111111111111111111' }] };
    },
  };

  await assertActiveDivisionResearchers(db, 10, 20, ['111111111111111111'], 'members');
  assert.match(calls[0].text, /JOIN member_divisions/);
  assert.deepEqual(calls[0].values, [10, 20, ['111111111111111111'], 'researcher']);
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
    () => assertActiveDivisionResearchers(db, 10, 20, ['333333333333333333'], 'members'),
    UserFacingError,
  );
});
