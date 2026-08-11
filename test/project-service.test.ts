import test from 'node:test';
import assert from 'node:assert/strict';

import { ChannelType } from 'discord.js';

import {
  MAX_PROJECT_PARTICIPANTS,
  OPEN_PROJECT_STATUSES,
  PROJECT_MEMBER_FETCH_CONCURRENCY,
  PROJECT_PERSON_ROLES,
  PROJECT_STATUSES,
} from '../src/constants.js';
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
  findProjectUniversities,
  removeProjectMember,
  searchVisibleProjects,
  updateProject,
  warmProjectAutocompleteCache,
} from '../src/services/projects/index.js';
import { UserFacingError } from '../src/errors.js';
import { canManageProject } from '../src/services/projects/policy.js';
import {
  assertMemberProjectAssignmentEligibility,
  assertProjectPeopleEligibility,
  sortedDiscordUserIds,
} from '../src/services/projects/eligibility.js';
import {
  projectAutocompleteName,
  projectAssignmentMessage,
  projectHomePayload,
  projectInfoMessage,
  projectWorkspaceGuidePayload,
  showcasePostPayload,
} from '../src/services/projects/formatters.js';

function memberWithRoles(id, roleNames) {
  return {
    id,
    roles: {
      cache: {
        some(callback) {
          return roleNames.some((name) => callback({ name }));
        },
        *values() {
          for (const name of roleNames) yield { name };
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

test('project management policy includes supervisors and scoped board, but not ordinary members', () => {
  const project = { university_name: 'Bocconi', division_name: 'Projects' };
  const supervisor = memberWithRoles('supervisor', []);
  const member = memberWithRoles('member', []);

  assert.equal(
    canManageProject(supervisor, project, [{ discord_user_id: 'supervisor', role: 'supervisor' }]),
    true,
  );
  assert.equal(
    canManageProject(member, project, [{ discord_user_id: 'member', role: 'member' }]),
    false,
  );
  assert.equal(canManageProject(memberWithRoles('head', ['Bocconi - Head of Projects']), project), true);
  assert.equal(canManageProject(memberWithRoles('other', ['Bocconi - Head of Analysis']), project), false);
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
  assert.match(sql, /LIMIT 25/);
  assert.match(sql, /concat\(u\.name, ' - Head of ', d\.name\) = ANY/);
});

test('project-close autocomplete filters completed and archived projects', async () => {
  const rows = [
    {
      id: 1,
      name: 'Active project',
      status: PROJECT_STATUSES.ACTIVE,
      university_name: 'Bocconi',
      division_name: 'Robotics',
      division_color: 'yellow',
      actor_is_project_person: false,
    },
    {
      id: 2,
      name: 'Paused project',
      status: PROJECT_STATUSES.PAUSED,
      university_name: 'Bocconi',
      division_name: 'Robotics',
      division_color: 'yellow',
      actor_is_project_person: false,
    },
    {
      id: 3,
      name: 'Completed project',
      status: PROJECT_STATUSES.COMPLETED,
      university_name: 'Bocconi',
      division_name: 'Robotics',
      division_color: 'yellow',
      actor_is_project_person: false,
    },
    {
      id: 4,
      name: 'Archived project',
      status: PROJECT_STATUSES.ARCHIVED,
      university_name: 'Bocconi',
      division_name: 'Robotics',
      division_color: 'yellow',
      actor_is_project_person: false,
    },
  ];
  let sql;
  let values;
  const choices = await searchVisibleProjects(
    {
      interaction: {
        user: { id: 'caller' },
        member: memberWithRoles('caller', ['Bocconi - Head of Robotics']),
      },
      query: '',
      statuses: OPEN_PROJECT_STATUSES,
    },
    {
      db: {
        async query(text, parameters) {
          sql = text;
          values = parameters;
          return { rows };
        },
      },
    },
  );

  assert.match(sql, /p\.status = ANY\(\$3::text\[\]\)/);
  assert.deepEqual(values[2], [...OPEN_PROJECT_STATUSES]);
  assert.deepEqual(choices.map((choice) => choice.value), ['1', '2']);
});

test('project autocomplete labels keep state readable and fit Discord choice limits', () => {
  const label = projectAutocompleteName({
    id: 3,
    name: 'Test',
    university_name: 'Bocconi',
    division_name: 'Robotics',
    division_color: 'yellow',
    status: PROJECT_STATUSES.COMPLETED,
  });
  assert.equal(label, '#3 Test • Bocconi, 🟨 Robotics • Completed');

  const longLabel = projectAutocompleteName({
    id: 3,
    name: 'A'.repeat(200),
    university_name: 'A'.repeat(120),
    division_name: 'B'.repeat(120),
    division_color: 'yellow',
    status: PROJECT_STATUSES.COMPLETED,
  });
  assert.ok(longLabel.length <= 100);
  assert.match(longLabel, / • Completed$/);
});

test('project autocomplete renders at most Discord’s 25 choices for large result sets', async () => {
  const rows = Array.from({ length: 100 }, (_, index) => ({
    id: index + 1,
    name: `Project ${index + 1}`,
    status: PROJECT_STATUSES.ACTIVE,
    university_name: 'Bocconi',
    division_name: 'Robotics',
    division_color: 'yellow',
    actor_is_project_person: false,
  }));
  const choices = await searchVisibleProjects(
    {
      interaction: {
        user: { id: 'caller' },
        member: memberWithRoles('caller', ['Global President']),
      },
      query: '',
    },
    { db: { query: async () => ({ rows }) } },
  );

  assert.equal(choices.length, 25);
  assert.deepEqual(choices.map((choice) => choice.value), rows.slice(0, 25).map((row) => String(row.id)));
});

test('project setup autocomplete scopes universities and divisions correctly', async () => {
  const calls = [];
  const db = {
    async query(text, values) {
      calls.push({ text, values });
      return { rows: [{ name: 'Bocconi' }] };
    },
  };

  await findProjectUniversities('b', { db });
  await findProjectDivisions('Bocconi', 'p', { db });

  assert.match(calls[0].text, /FROM universities/);
  assert.match(calls[1].text, /JOIN universities/);
});

test('project autocomplete cache contains only universities and divisions', async () => {
  const queries = [];
  await warmProjectAutocompleteCache({
    db: {
      async query(text) {
        queries.push(text);
        if (text.includes('FROM universities')) return { rows: [] };
        if (text.includes('FROM divisions')) return { rows: [] };
        throw new Error(`Unexpected autocomplete query: ${text}`);
      },
    },
  });
  assert.equal(queries.length, 2);
  assert.equal(queries.some((text) => text.includes('FROM members')), false);
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
      summary: 'Public summary',
      members: participantIds.join(','),
      supervisors: '999999999999999',
    }, { db }),
    new RegExp(`at most ${MAX_PROJECT_PARTICIPANTS} unique participants`),
  );
  assert.equal(databaseQueries, 0);
  assert.equal(memberFetches, 0);
});

test('project creation adds every active division Head as a supervisor without duplicating a selected Head', async () => {
  const memberId = '111111111111111111';
  const headId = '222222222222222222';
  const coHeadId = '333333333333333333';
  const division = {
    university_id: 10,
    university_name: 'Bocconi',
    category_id: null,
    showcase_channel_id: null,
    division_id: 20,
    division_name: 'Analysis',
    division_color: 'orange',
    division_role_id: null,
    division_head_role_id: null,
  };
  const createdProject = {
    id: 42,
    name: 'Signals',
    university_id: 10,
    division_id: 20,
    start_date: '2026-07-01',
    expected_end: '2026-08-01',
    notes: null,
    status: PROJECT_STATUSES.ACTIVE,
    discord_channel_id: null,
    showcase_thread_id: null,
    ...division,
  };
  const persistedPeople = [
    { discord_user_id: memberId, role: 'member' },
    { discord_user_id: headId, role: 'supervisor' },
    { discord_user_id: coHeadId, role: 'supervisor' },
  ];
  let insertedPeople;
  let transactionCount = 0;
  let headQueryCount = 0;
  const client = {
    async query(text, values) {
      if (text.includes('FROM divisions') && text.includes('FOR UPDATE')) return { rows: [{ id: division.division_id }] };
      if (text.includes('FROM board_assignments') && text.includes("role = 'head'")) {
        headQueryCount += 1;
        return { rows: [{ discord_user_id: headId }, { discord_user_id: coHeadId }] };
      }
      if (text.includes('SELECT discord_user_id') && text.includes('FOR UPDATE')) return { rows: [] };
      if (text.includes('LEFT JOIN member_divisions')) {
        return {
          rows: [
            { discord_user_id: memberId, member_type: 'researcher', university_id: 10, status: 'active', division_id: 20, is_university_board_member: false },
            { discord_user_id: headId, member_type: 'researcher', university_id: 10, status: 'active', division_id: 20, is_university_board_member: true },
            { discord_user_id: coHeadId, member_type: 'researcher', university_id: 10, status: 'active', division_id: 20, is_university_board_member: true },
          ],
        };
      }
      if (text.includes('INSERT INTO projects')) return { rows: [createdProject] };
      if (text.includes('INSERT INTO project_people')) {
        insertedPeople = values;
        return { rows: [] };
      }
      if (text.includes('INSERT INTO project_reconciliation')) return { rows: [{ desired_generation: 1 }] };
      if (text.includes('INSERT INTO audit_log')) return { rows: [] };
      throw new Error(`Unexpected project creation query: ${text}`);
    },
  };
  const db = {
    async query(text, values) {
      if (text.includes('FROM universities u') && text.includes('JOIN divisions d')) {
        return { rowCount: 1, rows: [division] };
      }
      if (text.includes('SELECT discord_user_id\n       FROM board_assignments')) {
        return { rows: [{ discord_user_id: headId }, { discord_user_id: coHeadId }] };
      }
      if (text.includes('FROM members m')) {
        return { rows: values[2].map((discord_user_id) => ({ discord_user_id })) };
      }
      if (text.includes('FROM members')) {
        return { rows: values[1].map((discord_user_id) => ({ discord_user_id })) };
      }
      if (text.includes('FROM projects p')) return { rowCount: 1, rows: [createdProject] };
      if (text.includes('FROM project_people')) return { rows: persistedPeople };
      if (text.includes('SELECT status FROM project_reconciliation')) return { rows: [{ status: 'pending' }] };
      throw new Error(`Unexpected project service query: ${text}`);
    },
    async transaction(work) {
      transactionCount += 1;
      if (transactionCount === 1) return work(client);
      return work({
        async query(text) {
          if (text.includes('FROM projects p')) return { rowCount: 1, rows: [createdProject] };
          if (text.includes('FROM project_people')) return { rows: persistedPeople };
          if (text.includes('SELECT desired_generation')) return { rowCount: 0, rows: [] };
          throw new Error(`Unexpected reconciliation query: ${text}`);
        },
      });
    },
  };
  const guild = {
    members: {
      async fetch(id) {
        return { id, user: { bot: false } };
      },
    },
  };

  const result = await createProject({
    interaction: {
      guild,
      user: { id: headId },
      member: memberWithRoles(headId, ['Bocconi - Head of Analysis']),
    },
    name: 'Signals',
    university: 'Bocconi',
    division: 'Analysis',
    startDate: '2026-07-01',
    expectedEnd: '2026-08-01',
    summary: 'Public summary',
    notes: null,
    members: memberId,
    supervisors: headId,
  }, { db });

  assert.deepEqual(insertedPeople, [
    42,
    [memberId, headId, coHeadId],
    ['member', 'supervisor', 'supervisor'],
  ]);
  assert.deepEqual(result.people, persistedPeople);
  assert.equal(headQueryCount, 2);
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

test('project participant selection rejects every bot account', async () => {
  const guild = {
    members: {
      async fetch(id) {
        return { id, user: { bot: id === 'bot-account' } };
      },
    },
  };

  await assert.rejects(
    () => assertGuildMembers(guild, ['human-account', 'bot-account']),
    /Bots cannot be assigned to projects: <@bot-account>/,
  );
});

test('project workspace documents stay bounded and keep private handover notes out of the showcase', () => {
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
    showcase_thread_id: 'showcase',
    summary: 'Public summary',
    notes: 'x'.repeat(4_000),
    outcome: 'Public conclusion',
    final_notes: 'Private handover',
  };

  for (const payload of [showcasePostPayload(project, people), projectInfoMessage(project, people)]) {
    assert.equal(payload.embeds, undefined);
    assert.ok(payload.content.length <= 2_000);
    assert.match(payload.content, /\(\+\d+ more\)/);
  }
  const home = projectHomePayload(project, people);
  assert.equal(home.embeds, undefined);
  assert.ok(home.content.length <= 2_000);
  assert.match(home.content, /Pinned project record · Updates automatically$/);
  const showcase = JSON.stringify(showcasePostPayload(project, people));
  assert.equal(showcase.includes('Private handover'), false);
  assert.equal(showcase.includes('x'.repeat(100)), false);

  const guide = projectWorkspaceGuidePayload(project).content;
  assert.match(guide, /^## How to use this space/);
  assert.match(guide, /`\/project-info`/);
  assert.match(guide, /Pinned workspace guide$/);
});

test('project home keeps project-info data in a scannable plain-message hierarchy', () => {
  const project = {
    id: 42,
    name: 'Signals',
    university_name: 'Bocconi',
    division_name: 'Analysis',
    division_color: 'orange',
    status: 'active',
    start_date: '2026-07-01',
    expected_end: '2026-08-01',
    discord_channel_id: 'workspace',
    showcase_thread_id: 'showcase',
    summary: 'Public summary',
    notes: null,
    outcome: null,
    final_notes: null,
  };
  const people = [{ discord_user_id: 'supervisor', role: PROJECT_PERSON_ROLES.SUPERVISOR }];
  const info = projectInfoMessage(project, people).content;
  const home = projectHomePayload(project, people).content;
  assert.match(home, /^## Signals/);
  assert.match(home, /\*\*University:\*\* Bocconi\n\*\*Status:\*\* Active\n\*\*Division:\*\* 🟧 Analysis/);
  assert.match(home, /\*\*Timeline:\*\* 2026-07-01 → 2026-08-01\n\*\*Workspace:\*\* <#workspace>\n\*\*Shareable record:\*\* <#showcase>/);
  assert.match(home, /\*\*Members:\*\* None yet/);
  assert.match(home, /\*\*Supervisors:\*\* <@supervisor>/);
  assert.match(info, /\*\*Workspace:\*\* <#workspace>/);
  assert.match(info, /\*\*Shareable record:\*\* <#showcase>/);
  assert.match(home, /Pinned project record · Updates automatically$/);
});

test('project assignment DM has a compact desktop-first hierarchy', () => {
  const project = {
    id: 42,
    name: 'Signals',
    university_name: 'Bocconi',
    division_name: 'Analysis',
    division_color: 'orange',
    status: 'active',
    start_date: '2026-07-01',
    expected_end: '2026-08-01',
    discord_channel_id: 'workspace',
    showcase_thread_id: 'showcase',
  };
  const handoff = projectAssignmentMessage('guild', project, PROJECT_PERSON_ROLES.SUPERVISOR);
  assert.deepEqual(handoff.allowedMentions, { parse: [] });
  assert.match(handoff.content, /^\*\*You joined Signals\*\*\n\n?Bocconi/);
  assert.match(handoff.content, /\*\*Role\*\*\nSupervisor/);
  assert.match(handoff.content, /\*\*Start here\*\*\n1\. Open the project workspace\./);
  assert.match(handoff.content, /2\. Read the pinned project record and workspace guide\./);
  assert.match(handoff.content, /\[View shareable record\]/);
  assert.doesNotMatch(handoff.content, /Project workspace:|Shareable project record:/);
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
    showcase_channel_id: 'showcase',
    showcase_thread_id: null,
    division_head_role_id: null,
  };
  const closedProject = {
    ...project,
    status: PROJECT_STATUSES.COMPLETED,
    outcome: 'Completed successfully',
    final_notes: 'Ready for handover',
  };
  const people = [{ discord_user_id: 'member', role: 'member' }];
  let projectSelects = 0;
  let lockedProjectSelects = 0;
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
        if (text.includes('FOR UPDATE OF p')) {
          return { rowCount: 1, rows: [project] };
        }
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
            if (text.includes('FOR UPDATE OF p')) {
              lockedProjectSelects += 1;
              return { rowCount: 1, rows: [lockedProjectSelects === 1 ? project : closedProject] };
            }
            projectSelects += 1;
            return { rowCount: 1, rows: [closedProject] };
          }
          if (text.includes('FROM project_people')) return { rows: people };
          return { rows: [] };
        },
      });
    },
  };
  const messages = [];
  const showcaseStarter = { async edit() {} };
  const showcaseThread = {
    id: 'showcase-thread',
    async fetchStarterMessage() { return showcaseStarter; },
  };
  const showcase = {
    type: ChannelType.GuildForum,
    availableTags: [
      { id: 'projects', name: 'Projects' },
      { id: 'active', name: 'Active' },
      { id: 'paused', name: 'Paused' },
      { id: 'completed', name: 'Completed' },
    ],
    threads: { async create() { return showcaseThread; } },
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
      messages.push(message);
      return {
        id: messages.length === 1 ? 'home-message' : `event-${messages.length}`,
        pinned: false,
        async pin() {},
      };
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
        if (id === 'showcase') return showcase;
        if (id === 'project-channel') return channel;
        throw new Error(`Unexpected channel fetch: ${id}`);
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
  assert.match(messages[0].content, /\*\*Conclusion\*\*\nCompleted successfully/);
  assert.match(messages[0].content, /\*\*Internal handover notes\*\*\nReady for handover/);
  assert.match(messages[1].content, /^## How to use this space/);
  assert.equal(JSON.stringify(messages[1]).includes('Ready for handover'), false);
  assert.equal(JSON.stringify(messages[2]).includes('Ready for handover'), false);
  assert.match(messages[2].embeds[0].data.title, /Project completed/);
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
      if (text.includes('FROM project_people')) return { rows: [] };
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
