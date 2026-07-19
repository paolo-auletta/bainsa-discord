import { ChannelType } from 'discord.js';

import { writeAudit } from '../../audit.mjs';
import {
  assertDivisionAuthority,
  assertNoBotUserIds,
  assertNotBotUser,
  isDivisionHead,
  isGlobalPresident,
  isUniversityPresident,
  isUniversityVicePresident,
} from '../../authorization.mjs';
import {
  BOARD_ROLES,
  divisionLabel,
  MEMBER_TYPES,
  PROJECT_PERSON_ROLES,
  PROJECT_STATUSES,
} from '../../constants.mjs';
import { query, transaction } from '../../db.mjs';
import { UserFacingError, assertUser } from '../../errors.mjs';
import { projectChannelName, universityCategoryName } from '../../naming.mjs';
import { uniqueIds } from './permissions.mjs';
import {
  assertProjectStatusChange,
  assertNoUserOverlap,
  assertProjectIsOpen,
  normalizeProjectName,
  normalizeProjectPersonRole,
  normalizeProjectStatus,
  normalizeRequiredText,
  formatDiscordUserReferences,
  parseDiscordUserIds,
  validateExpectedEndUpdate,
  validateProjectDates,
} from './validation.mjs';
import { lockAndAssertProjectPeopleEligibility, lockMemberEligibilityRows } from './eligibility.mjs';
import { enqueueProjectReconciliation, reconcileProject } from './reconciliation.mjs';

const DEFAULT_DB = { query, transaction };
const PROJECT_AUTOCOMPLETE_CACHE_TTL_MS = 30_000;
const projectAutocompleteCache = {
  loadedAt: 0,
  universities: [],
  divisions: [],
  people: [],
};
const PROJECT_SELECT = `
  p.id,
  p.name,
  p.university_id,
  p.division_id,
  p.start_date::text AS start_date,
  p.expected_end::text AS expected_end,
  p.notes,
  p.status,
  p.channel_id AS discord_channel_id,
  p.showcase_thread_id,
  u.name AS university_name,
  u.category_id,
  u.showcase_channel_id,
  d.name AS division_name,
  d.color AS division_color,
  d.member_role_id AS division_role_id,
  d.head_role_id AS division_head_role_id
`;

function dbClient(db) {
  return db ?? DEFAULT_DB;
}

function optionValue(interaction, name, required = true) {
  return interaction.options.getString(name, required);
}

async function fetchGuildMember(guild, userId) {
  try {
    return await guild.members.fetch(userId);
  } catch {
    return null;
  }
}

async function assertGuildMembers(guild, userIds) {
  assertNoBotUserIds(guild, userIds);
  const fetched = await Promise.all(userIds.map((id) => fetchGuildMember(guild, id)));
  const missing = userIds.filter((_, index) => !fetched[index]);
  assertUser(missing.length === 0, `These users are not in the server: ${formatDiscordUserReferences(missing)}.`);
}

async function findDivision(db, universityName, divisionName) {
  const result = await db.query(
    `SELECT
       u.id AS university_id,
       u.name AS university_name,
       u.category_id,
       u.showcase_channel_id,
       d.id AS division_id,
       d.name AS division_name,
       d.color AS division_color,
       d.member_role_id AS division_role_id,
       d.head_role_id AS division_head_role_id
     FROM universities u
     JOIN divisions d ON d.university_id = u.id
     WHERE lower(u.name) = lower($1)
       AND lower(d.name) = lower($2)
       AND coalesce(u.active, true) = true
       AND coalesce(d.active, true) = true
     LIMIT 1`,
    [universityName, divisionName],
  );
  assertUser(result.rowCount === 1, `${divisionName} is not an active division at ${universityName}.`);
  return result.rows[0];
}

export async function assertActiveUniversityMembers(db, universityId, userIds, fieldName) {
  const result = await db.query(
    `SELECT discord_user_id
     FROM members
     WHERE university_id = $1
       AND discord_user_id = ANY($2::text[])
       AND status = 'active'`,
    [universityId, userIds],
  );
  const accepted = new Set(result.rows.map((row) => String(row.discord_user_id)));
  const rejected = userIds.filter((id) => !accepted.has(String(id)));
  assertUser(
    rejected.length === 0,
    `These ${fieldName} are not accepted active members in this university: ${formatDiscordUserReferences(rejected)}.`,
  );
}

export async function assertActiveDivisionResearchers(db, universityId, divisionId, userIds, fieldName) {
  const result = await db.query(
    `SELECT m.discord_user_id
     FROM members m
     JOIN member_divisions md ON md.discord_user_id = m.discord_user_id
     WHERE m.university_id = $1
       AND md.division_id = $2
       AND m.discord_user_id = ANY($3::text[])
       AND m.member_type = $4
       AND m.status = 'active'`,
    [universityId, divisionId, userIds, MEMBER_TYPES.RESEARCHER],
  );
  const accepted = new Set(result.rows.map((row) => String(row.discord_user_id)));
  const rejected = userIds.filter((id) => !accepted.has(String(id)));
  assertUser(
    rejected.length === 0,
    `These ${fieldName} are not active researchers in this division: ${formatDiscordUserReferences(rejected)}.`,
  );
}

async function getProject(db, projectId) {
  const result = await db.query(
    `SELECT ${PROJECT_SELECT}
     FROM projects p
     JOIN universities u ON u.id = p.university_id
     JOIN divisions d ON d.id = p.division_id
     WHERE p.id = $1
     LIMIT 1`,
    [projectId],
  );
  assertUser(result.rowCount === 1, 'Project not found.');
  return result.rows[0];
}

async function getProjectPeople(db, projectId) {
  const result = await db.query(
    `SELECT discord_user_id, role
     FROM project_people
     WHERE project_id = $1
     ORDER BY role, discord_user_id`,
    [projectId],
  );
  return result.rows;
}

function assertProjectAuthority(member, project) {
  assertDivisionAuthority(member, project.university_name, project.division_name, [
    BOARD_ROLES.HEAD,
    BOARD_ROLES.VICE_PRESIDENT,
    BOARD_ROLES.PRESIDENT,
  ]);
}

export function canViewProject(member, project, people = []) {
  return (
    people.some((person) => String(person.discord_user_id) === String(member.id)) ||
    isGlobalPresident(member) ||
    isUniversityPresident(member, project.university_name) ||
    isUniversityVicePresident(member, project.university_name) ||
    isDivisionHead(member, project.university_name, project.division_name)
  );
}

function assertProjectViewAuthority(member, project, people) {
  assertUser(canViewProject(member, project, people), `You do not have permission to view ${project.name}.`);
}

function findCategoryId(guild, preferredId, fallbackName) {
  if (preferredId && guild.channels.cache.has(String(preferredId))) return String(preferredId);
  const category = guild.channels.cache.find(
    (channel) => channel.type === ChannelType.GuildCategory && channel.name === fallbackName,
  );
  return category?.id ?? null;
}

export function findProjectParentId(guild, project) {
  return findCategoryId(guild, project.category_id, universityCategoryName(project.university_name));
}

function formatPeopleLine(people, role) {
  const ids = people.filter((person) => person.role === role).map((person) => `<@${person.discord_user_id}>`);
  return ids.length ? ids.join(', ') : 'None yet';
}

function formatProjectIntro(project, people, extra = '') {
  return [
    `# ${project.name}`,
    `**University:** ${project.university_name}`,
    `**Division:** ${divisionLabel(project.division_name, project.division_color)}`,
    `**Status:** ${project.status}`,
    `**Timeline:** ${project.start_date} -> ${project.expected_end}`,
    `**Members:** ${formatPeopleLine(people, PROJECT_PERSON_ROLES.MEMBER)}`,
    `**Supervisors:** ${formatPeopleLine(people, PROJECT_PERSON_ROLES.SUPERVISOR)}`,
    project.notes ? `**Notes:** ${project.notes}` : null,
    extra || null,
  ].filter(Boolean).join('\n');
}

function formatShowcasePost(project, people, extra = '') {
  return [
    `**${project.name}** is now tracked in BAINSA ${project.university_name}.`,
    `Division: **${divisionLabel(project.division_name, project.division_color)}**`,
    `Status: **${project.status}**`,
    `Expected end: **${project.expected_end}**`,
    `Supervisors: ${formatPeopleLine(people, PROJECT_PERSON_ROLES.SUPERVISOR)}`,
    extra || project.notes || null,
  ].filter(Boolean).join('\n');
}

async function createShowcaseThread(guild, project, people) {
  if (!project.showcase_channel_id) return null;
  const forum = await guild.channels.fetch(project.showcase_channel_id).catch(() => null);
  if (!forum || forum.type !== ChannelType.GuildForum) return null;
  const existing = forum.availableTags.find((tag) => tag.name.toLowerCase() === project.division_name.toLowerCase());
  const tags = existing
    ? forum.availableTags
    : (await forum.setAvailableTags([...forum.availableTags.map((tag) => ({ id: tag.id, name: tag.name, moderated: tag.moderated })), { name: project.division_name }], `Create ${project.division_name} project tag`)).availableTags;
  const tagId = tags.find((tag) => tag.name.toLowerCase() === project.division_name.toLowerCase())?.id ?? null;
  return forum.threads.create({
    name: project.name,
    appliedTags: tagId ? [tagId] : [],
    message: { content: formatShowcasePost(project, people) },
    reason: `Project ${project.id} showcase post`,
  });
}

async function updateShowcaseThread(guild, project, people, extra = '') {
  if (!project.showcase_thread_id) return;
  const thread = await guild.channels.fetch(project.showcase_thread_id).catch(() => null);
  if (!thread) return;
  await thread.setName(project.name, `Update project ${project.id} showcase`).catch(() => undefined);
  await thread.send({ content: formatShowcasePost(project, people, extra) }).catch(() => undefined);
}

async function updateProjectChannel(guild, project, people, extra = '') {
  if (!project.discord_channel_id) return;
  const channel = await guild.channels.fetch(project.discord_channel_id).catch(() => null);
  if (!channel) return;
  await channel.send({ content: formatProjectIntro(project, people, extra) }).catch(() => undefined);
}

async function createProjectHistory(guild, db, project, people) {
  await updateProjectChannel(guild, project, people);
  try {
    const thread = await createShowcaseThread(guild, project, people);
    if (!thread) return;
    await db.query('UPDATE projects SET showcase_thread_id = $1, updated_at = now() WHERE id = $2', [thread.id, project.id]);
    project.showcase_thread_id = thread.id;
  } catch {
    // Showcase posts are intentionally one-shot best effort, never replayed by reconciliation.
  }
}

export function projectIdFromOption(value) {
  const projectId = String(value ?? '').trim();
  assertUser(/^[1-9]\d*$/.test(projectId), 'Choose a valid project.');
  return projectId;
}

export async function createProject(input, deps = {}) {
  const db = dbClient(deps.db);
  const { interaction } = input;
  const guild = interaction.guild;
  const actor = interaction.member;
  assertUser(Boolean(guild), 'This command can only be used inside the server.');

  const name = normalizeProjectName(input.name);
  const university = normalizeRequiredText(input.university, 'university', 120);
  const division = normalizeRequiredText(input.division, 'division', 120);
  const notes = input.notes == null ? null : normalizeRequiredText(input.notes, 'notes');
  const { startDate, expectedEnd } = validateProjectDates(input.startDate, input.expectedEnd);
  const memberIds = parseDiscordUserIds(input.members, 'members');
  const supervisorIds = parseDiscordUserIds(input.supervisors, 'supervisors');
  assertNoBotUserIds(guild, [...memberIds, ...supervisorIds]);
  assertNoUserOverlap(memberIds, supervisorIds, 'members', 'supervisors');
  const people = [
    ...memberIds.map((id) => ({ discord_user_id: id, role: PROJECT_PERSON_ROLES.MEMBER })),
    ...supervisorIds.map((id) => ({ discord_user_id: id, role: PROJECT_PERSON_ROLES.SUPERVISOR })),
  ];

  const divisionRecord = await findDivision(db, university, division);
  assertDivisionAuthority(actor, divisionRecord.university_name, divisionRecord.division_name, [
    BOARD_ROLES.HEAD,
    BOARD_ROLES.VICE_PRESIDENT,
    BOARD_ROLES.PRESIDENT,
  ]);
  await assertGuildMembers(guild, uniqueIds([...memberIds, ...supervisorIds]));
  await assertActiveDivisionResearchers(db, divisionRecord.university_id, divisionRecord.division_id, memberIds, 'members');
  await assertActiveUniversityMembers(db, divisionRecord.university_id, supervisorIds, 'supervisors');

  const project = await db.transaction(async (client) => {
    await lockAndAssertProjectPeopleEligibility(client, divisionRecord, people);
    const result = await client.query(
      `INSERT INTO projects
        (name, university_id, division_id, start_date, expected_end, notes, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, name, university_id, division_id, start_date::text, expected_end::text, notes, status,
         channel_id AS discord_channel_id, showcase_thread_id`,
      [
        name,
        divisionRecord.university_id,
        divisionRecord.division_id,
        startDate,
        expectedEnd,
        notes,
        PROJECT_STATUSES.ACTIVE,
      ],
    );
    const created = { ...result.rows[0], ...divisionRecord };
    for (const person of people) {
      await client.query(
        `INSERT INTO project_people (project_id, discord_user_id, role)
         VALUES ($1, $2, $3)
         ON CONFLICT (project_id, discord_user_id)
         DO UPDATE SET role = EXCLUDED.role`,
        [created.id, person.discord_user_id, person.role],
      );
    }
    await enqueueProjectReconciliation(client, created.id);
    await writeAudit(client, {
      actorId: interaction.user.id, action: 'project.create', targetType: 'project', targetId: created.id,
      universityId: created.university_id, after: { ...created, people },
    });
    return created;
  });

  const reconciliation = await reconcileProject({ projectId: project.id, guild, db });
  if (reconciliation.status !== 'succeeded') {
    throw new UserFacingError(
      `Project #${project.id} was committed to the database, but Discord reconciliation is pending after a failure. It will retry automatically.`,
    );
  }
  await createProjectHistory(guild, db, reconciliation.project, reconciliation.people);
  return { ...reconciliation.project, people: reconciliation.people };
}

export async function addProjectMember(input, deps = {}) {
  const db = dbClient(deps.db);
  const projectId = projectIdFromOption(input.project);
  const role = normalizeProjectPersonRole(input.role);
  assertNotBotUser(input.interaction, input.user.id);
  const project = await getProject(db, projectId);
  assertProjectAuthority(input.interaction.member, project);
  assertProjectIsOpen(project.status);
  await assertGuildMembers(input.interaction.guild, [input.user.id]);
  if (role === PROJECT_PERSON_ROLES.MEMBER) {
    await assertActiveDivisionResearchers(db, project.university_id, project.division_id, [input.user.id], 'members');
  } else {
    await assertActiveUniversityMembers(db, project.university_id, [input.user.id], `${role}s`);
  }

  await db.transaction(async (client) => {
    await lockAndAssertProjectPeopleEligibility(client, project, [
      { discord_user_id: input.user.id, role },
    ]);
    await client.query(
      `INSERT INTO project_people (project_id, discord_user_id, role)
       VALUES ($1, $2, $3)
       ON CONFLICT (project_id, discord_user_id)
       DO UPDATE SET role = EXCLUDED.role`,
      [project.id, input.user.id, role],
    );
    await enqueueProjectReconciliation(client, project.id);
    await writeAudit(client, {
      actorId: input.interaction.user.id,
      action: 'project.add_member',
      targetType: 'project',
      targetId: project.id,
      universityId: project.university_id,
      after: { user_id: input.user.id, role },
    });
  });
  const reconciliation = await reconcileProject({ projectId: project.id, guild: input.interaction.guild, db });
  if (reconciliation.status !== 'succeeded') {
    throw new UserFacingError(`Project #${project.id} was committed to the database, but Discord reconciliation is pending after a failure. It will retry automatically.`);
  }
  await updateProjectChannel(input.interaction.guild, reconciliation.project, reconciliation.people, `<@${input.user.id}> joined as **${role}**.`);
  return { project: reconciliation.project, people: reconciliation.people };
}

export async function removeProjectMember(input, deps = {}) {
  const db = dbClient(deps.db);
  const projectId = projectIdFromOption(input.project);
  assertNotBotUser(input.interaction, input.user.id);
  const project = await getProject(db, projectId);
  assertProjectAuthority(input.interaction.member, project);
  assertProjectIsOpen(project.status);

  await db.transaction(async (client) => {
    await lockMemberEligibilityRows(client, [input.user.id]);
    await client.query('DELETE FROM project_people WHERE project_id = $1 AND discord_user_id = $2', [
      project.id,
      input.user.id,
    ]);
    await enqueueProjectReconciliation(client, project.id);
    await writeAudit(client, {
      actorId: input.interaction.user.id,
      action: 'project.remove_member',
      targetType: 'project',
      targetId: project.id,
      universityId: project.university_id,
      after: { user_id: input.user.id },
      reason: input.reason ?? null,
    });
  });
  const reconciliation = await reconcileProject({ projectId: project.id, guild: input.interaction.guild, db });
  if (reconciliation.status !== 'succeeded') {
    throw new UserFacingError(`Project #${project.id} was committed to the database, but Discord reconciliation is pending after a failure. It will retry automatically.`);
  }
  await updateProjectChannel(input.interaction.guild, reconciliation.project, reconciliation.people, `<@${input.user.id}> was removed from the project.`);
  return { project: reconciliation.project, people: reconciliation.people };
}

export async function updateProject(input, deps = {}) {
  const db = dbClient(deps.db);
  const projectId = projectIdFromOption(input.project);
  const before = await getProject(db, projectId);
  assertProjectAuthority(input.interaction.member, before);
  assertProjectIsOpen(before.status);
  const patch = {
    name: input.name == null ? before.name : normalizeProjectName(input.name),
    expected_end: input.expectedEnd == null ? before.expected_end : validateExpectedEndUpdate(before.start_date, input.expectedEnd),
    notes: input.notes == null ? before.notes : normalizeRequiredText(input.notes, 'notes'),
    status: input.status == null ? before.status : normalizeProjectStatus(input.status),
  };
  assertProjectStatusChange(before.status, patch.status);

  await db.transaction(async (client) => {
    await client.query(
      `UPDATE projects
       SET name = $1, expected_end = $2, notes = $3, status = $4, updated_at = now()
       WHERE id = $5`,
      [patch.name, patch.expected_end, patch.notes, patch.status, before.id],
    );
    await enqueueProjectReconciliation(client, before.id);
    await writeAudit(client, {
      actorId: input.interaction.user.id,
      action: 'project.update',
      targetType: 'project',
      targetId: before.id,
      universityId: before.university_id,
      before,
      after: patch,
    });
  });
  const reconciliation = await reconcileProject({ projectId: before.id, guild: input.interaction.guild, db });
  if (reconciliation.status !== 'succeeded') {
    throw new UserFacingError(`Project #${before.id} was committed to the database, but Discord reconciliation is pending after a failure. It will retry automatically.`);
  }
  await updateProjectChannel(input.interaction.guild, reconciliation.project, reconciliation.people, 'Project details were updated.');
  await updateShowcaseThread(input.interaction.guild, reconciliation.project, reconciliation.people, 'Project details were updated.');
  return { project: reconciliation.project, people: reconciliation.people };
}

export async function closeProject(input, deps = {}) {
  const db = dbClient(deps.db);
  const projectId = projectIdFromOption(input.project);
  const project = await getProject(db, projectId);
  assertProjectAuthority(input.interaction.member, project);
  assertProjectIsOpen(project.status);
  const outcome = normalizeRequiredText(input.outcome, 'outcome');
  const finalNotes = normalizeRequiredText(input.finalNotes, 'final_notes');

  await db.transaction(async (client) => {
    await client.query(
      `UPDATE projects
       SET status = $1, outcome = $2, final_notes = $3,
           closed_at = now(), updated_at = now()
       WHERE id = $4`,
      [PROJECT_STATUSES.COMPLETED, outcome, finalNotes, project.id],
    );
    await enqueueProjectReconciliation(client, project.id);
    await writeAudit(client, {
      actorId: input.interaction.user.id,
      action: 'project.close',
      targetType: 'project',
      targetId: project.id,
      universityId: project.university_id,
      before: project,
      after: { status: PROJECT_STATUSES.COMPLETED, outcome, final_notes: finalNotes },
    });
  });
  const reconciliation = await reconcileProject({ projectId: project.id, guild: input.interaction.guild, db });
  if (reconciliation.status !== 'succeeded') {
    throw new UserFacingError(`Project #${project.id} was committed to the database, but Discord reconciliation is pending after a failure. It will retry automatically.`);
  }
  await updateProjectChannel(input.interaction.guild, reconciliation.project, reconciliation.people, `**Outcome:** ${outcome}\n**Final notes:** ${finalNotes}`);
  await updateShowcaseThread(input.interaction.guild, reconciliation.project, reconciliation.people, `Completed: ${outcome}`);
  return { project: reconciliation.project, people: reconciliation.people };
}

export async function getProjectInfo(input, deps = {}) {
  const db = dbClient(deps.db);
  const projectId = projectIdFromOption(input.project);
  const project = await getProject(db, projectId);
  const people = await getProjectPeople(db, project.id);
  assertProjectViewAuthority(input.interaction.member, project, people);
  return { project, people };
}

export async function searchVisibleProjects(input, deps = {}) {
  const db = dbClient(deps.db);
  const term = `%${String(input.query ?? '').trim()}%`;
  const result = await db.query(
    `SELECT
       p.id,
       p.name,
       p.status,
       u.name AS university_name,
       d.name AS division_name,
       d.color AS division_color,
       bool_or(pp.discord_user_id IS NOT NULL) AS actor_is_project_person
     FROM projects p
     JOIN universities u ON u.id = p.university_id
     JOIN divisions d ON d.id = p.division_id
     LEFT JOIN project_people pp
       ON pp.project_id = p.id
      AND pp.discord_user_id = $2
     WHERE ($1 = '%%' OR p.name ILIKE $1 OR u.name ILIKE $1 OR d.name ILIKE $1 OR p.id::text ILIKE $1)
     GROUP BY p.id, p.name, p.status, u.name, d.name, d.color
     ORDER BY p.updated_at DESC NULLS LAST, p.id DESC
     LIMIT 100`,
    [term, input.interaction.user.id],
  );
  return result.rows
    .filter((project) =>
      canViewProject(
        input.interaction.member,
        project,
        project.actor_is_project_person ? [{ discord_user_id: input.interaction.user.id }] : [],
      ),
    )
    .slice(0, 25)
    .map((project) => ({
      name: `#${project.id} ${project.name} (${project.university_name} / ${divisionLabel(project.division_name, project.division_color)}, ${project.status})`.slice(0, 100),
      value: String(project.id),
    }));
}

export async function findProjectUniversities(term = '', deps = {}) {
  if (projectAutocompleteCache.loadedAt) {
    refreshProjectAutocompleteCacheInBackground(deps);
    const normalizedTerm = String(term).trim().toLowerCase();
    return projectAutocompleteCache.universities
      .filter((row) => !normalizedTerm || row.name.toLowerCase().includes(normalizedTerm))
      .slice(0, 25);
  }
  const db = dbClient(deps.db);
  const normalizedTerm = String(term).trim();
  const result = await db.query(
    `SELECT name
       FROM universities
      WHERE active = true
        AND ($1 = '' OR name ILIKE $2)
      ORDER BY name
      LIMIT 25`,
    [normalizedTerm, `%${normalizedTerm}%`],
  );
  return result.rows;
}

export async function findProjectDivisions(universityName, term = '', deps = {}) {
  if (!universityName?.trim()) return [];
  if (projectAutocompleteCache.loadedAt) {
    refreshProjectAutocompleteCacheInBackground(deps);
    const normalizedUniversity = universityName.trim().toLowerCase();
    const normalizedTerm = String(term).trim().toLowerCase();
    return projectAutocompleteCache.divisions
      .filter((row) =>
        row.university_name.toLowerCase() === normalizedUniversity &&
        (!normalizedTerm || row.name.toLowerCase().includes(normalizedTerm)),
      )
      .map(({ name, color }) => ({ name, color }))
      .slice(0, 25);
  }
  const db = dbClient(deps.db);
  const normalizedTerm = String(term).trim();
  const result = await db.query(
    `SELECT d.name, d.color
       FROM divisions d
       JOIN universities u ON u.id = d.university_id
      WHERE u.active = true
        AND d.active = true
        AND lower(u.name) = lower($1)
        AND ($2 = '' OR d.name ILIKE $3)
      ORDER BY d.name
      LIMIT 25`,
    [universityName.trim(), normalizedTerm, `%${normalizedTerm}%`],
  );
  return result.rows;
}

export async function findProjectPeople({ universityName, divisionName, role, term = '' }, deps = {}) {
  if (!universityName?.trim()) return [];
  if (role === PROJECT_PERSON_ROLES.MEMBER && !divisionName?.trim()) return [];
  if (projectAutocompleteCache.loadedAt) {
    refreshProjectAutocompleteCacheInBackground(deps);
    const normalizedUniversity = universityName.trim().toLowerCase();
    const normalizedDivision = divisionName?.trim().toLowerCase() ?? '';
    const normalizedTerm = String(term).trim().toLowerCase();
    return projectAutocompleteCache.people
      .filter((row) =>
        row.university_name.toLowerCase() === normalizedUniversity &&
        (role !== PROJECT_PERSON_ROLES.MEMBER || row.division_name?.toLowerCase() === normalizedDivision) &&
        (role !== PROJECT_PERSON_ROLES.MEMBER || row.member_type === MEMBER_TYPES.RESEARCHER) &&
        (!normalizedTerm || row.full_name?.toLowerCase().includes(normalizedTerm) || row.discord_user_id.includes(normalizedTerm)),
      )
      .map(({ discord_user_id, full_name }) => ({ discord_user_id, full_name }))
      .slice(0, 25);
  }
  const db = dbClient(deps.db);
  const normalizedTerm = String(term).trim();
  const result = await db.query(
    `SELECT m.discord_user_id, m.full_name
       FROM members m
       JOIN universities u ON u.id = m.university_id
       LEFT JOIN member_divisions md ON md.discord_user_id = m.discord_user_id
       LEFT JOIN divisions d ON d.id = md.division_id
      WHERE m.status = 'active'
        AND u.active = true
        AND lower(u.name) = lower($1)
        AND ($2::text IS NULL OR (d.active = true AND lower(d.name) = lower($2)))
        AND ($3::text IS NULL OR m.member_type = $3)
        AND ($4 = '' OR coalesce(m.full_name, '') ILIKE $5 OR m.discord_user_id ILIKE $5)
      ORDER BY coalesce(m.full_name, ''), m.discord_user_id
      LIMIT 25`,
    [
      universityName.trim(),
      role === PROJECT_PERSON_ROLES.MEMBER ? divisionName.trim() : null,
      role === PROJECT_PERSON_ROLES.MEMBER ? MEMBER_TYPES.RESEARCHER : null,
      normalizedTerm,
      `%${normalizedTerm}%`,
    ],
  );
  return result.rows;
}

export async function warmProjectAutocompleteCache(deps = {}) {
  const db = dbClient(deps.db);
  const [universities, divisions, people] = await Promise.all([
    db.query(
      `SELECT name
         FROM universities
        WHERE active = true
        ORDER BY name`,
    ),
    db.query(
      `SELECT u.name AS university_name, d.name, d.color
         FROM divisions d
         JOIN universities u ON u.id = d.university_id
        WHERE u.active = true
          AND d.active = true
        ORDER BY u.name, d.name`,
    ),
    db.query(
      `SELECT m.discord_user_id, m.full_name, m.member_type,
              u.name AS university_name, d.name AS division_name
         FROM members m
         JOIN universities u ON u.id = m.university_id
         LEFT JOIN member_divisions md ON md.discord_user_id = m.discord_user_id
         LEFT JOIN divisions d ON d.id = md.division_id AND d.active = true
        WHERE m.status = 'active'
          AND u.active = true
        ORDER BY coalesce(m.full_name, ''), m.discord_user_id`,
    ),
  ]);

  projectAutocompleteCache.universities = universities.rows;
  projectAutocompleteCache.divisions = divisions.rows;
  projectAutocompleteCache.people = people.rows;
  projectAutocompleteCache.loadedAt = Date.now();
  return projectAutocompleteCache;
}

function refreshProjectAutocompleteCacheInBackground(deps) {
  if (Date.now() - projectAutocompleteCache.loadedAt <= PROJECT_AUTOCOMPLETE_CACHE_TTL_MS) return;
  projectAutocompleteCache.loadedAt = Date.now();
  void warmProjectAutocompleteCache(deps).catch(() => {
    projectAutocompleteCache.loadedAt = 0;
  });
}

export function readProjectCreateOptions(interaction) {
  return {
    interaction,
    name: optionValue(interaction, 'name'),
    university: optionValue(interaction, 'university'),
    division: optionValue(interaction, 'division'),
    members: optionValue(interaction, 'members'),
    supervisors: optionValue(interaction, 'supervisors'),
    startDate: optionValue(interaction, 'start_date'),
    expectedEnd: optionValue(interaction, 'expected_end'),
    notes: optionValue(interaction, 'notes', false),
  };
}

export function projectInfoMessage(project, people) {
  const channel = project.discord_channel_id ? `<#${project.discord_channel_id}>` : 'Not provisioned';
  return [
    `**${project.name}** (#${project.id})`,
    `University: **${project.university_name}**`,
    `Division: **${divisionLabel(project.division_name, project.division_color)}**`,
    `Status: **${project.status}**`,
    `Timeline: **${project.start_date}** -> **${project.expected_end}**`,
    `Channel: ${channel}`,
    `Members: ${formatPeopleLine(people, PROJECT_PERSON_ROLES.MEMBER)}`,
    `Supervisors: ${formatPeopleLine(people, PROJECT_PERSON_ROLES.SUPERVISOR)}`,
    `Board liaisons: ${formatPeopleLine(people, PROJECT_PERSON_ROLES.BOARD_LIAISON)}`,
    project.notes ? `Notes: ${project.notes}` : null,
  ]
    .filter(Boolean)
    .join('\n');
}

export function projectSuccessMessage(action, project) {
  const channel = project.discord_channel_id ? ` <#${project.discord_channel_id}>` : '';
  return `${action} **${project.name}** (#${project.id}).${channel}`;
}

export { parseDiscordUserIds, validateProjectDates };
