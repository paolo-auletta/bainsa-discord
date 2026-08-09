import { writeAudit } from '../../audit.js';
import {
  assertDivisionAuthority,
  assertNoBotUserIds,
  assertNotBotUser,
} from '../../authorization.js';
import {
  BOARD_ROLES,
  PROJECT_PERSON_ROLES,
  PROJECT_STATUSES,
} from '../../constants.js';
import { query, transaction } from '../../db.js';
import { assertUser } from '../../errors.js';
import { logger } from '../../logger.js';
import { uniqueIds } from './permissions.js';
import {
  assertActiveProjectMembers,
  assertActiveUniversityMembers,
  findActiveDivision,
  findActiveDivisionHeadIds,
  getProject,
  getProjectForUpdate,
  getProjectPerson,
  getProjectPeople,
  insertProjectPeople,
  lockProjectAndCountPeople,
} from './repository.js';
import {
  assertProjectStatusChange,
  assertNoUserOverlap,
  assertProjectParticipantCount,
  assertProjectParticipantCapacity,
  assertProjectIsOpen,
  normalizeProjectName,
  normalizeProjectLongText,
  normalizeProjectPersonRole,
  normalizeProjectStatus,
  normalizeRequiredText,
  parseDiscordUserIds,
  validateExpectedEndUpdate,
  validateProjectDates,
} from './validation.js';
import {
  assertProjectPeopleEligibility,
  lockAndAssertProjectPeopleEligibility,
  lockDivisionHeadEligibilityRows,
  lockMemberEligibilityRows,
} from './eligibility.js';
import { enqueueProjectReconciliation, reconcileProject } from './reconciliation.js';
import {
  assertGuildMembers,
  findProjectParentId,
  notifyProjectAssignment,
  notifyProjectRemoval,
  sendProjectTransition,
} from './gateway.js';
import {
  findProjectDivisions,
  findProjectUniversities,
  listProjectDivisions,
  listProjectUniversities,
  searchVisibleProjects,
  warmProjectAutocompleteCache,
} from './autocomplete.js';
import { canManageProject, canViewProject } from './policy.js';
import { projectCommandChannelScope } from '../../runtime/command-channels.js';
import { projectInfoMessage, projectSuccessMessage, projectTransitionPayload } from './formatters.js';
import { createProjectSetupService } from './setup.js';
import { mapWithConcurrency } from './concurrency.js';

const DEFAULT_DB = { query, transaction };
type ProjectDependencies = { db?: typeof DEFAULT_DB };

function dbClient(db) {
  return db ?? DEFAULT_DB;
}

function assertProjectManagementAuthority(member, project, people) {
  assertUser(
    canManageProject(member, project, people),
    `Only this project's supervisors and scoped board can manage ${project.name}.`,
  );
}

function assertProjectViewAuthority(member, project, people) {
  assertUser(canViewProject(member, project, people), `You do not have permission to view ${project.name}.`);
}

async function notifyAssignments(guild, project, people, previousRole = null) {
  await mapWithConcurrency(people, 5, async (person) => {
    try {
      await notifyProjectAssignment(guild, project, person, previousRole);
    } catch (error) {
      logger.warn('Project assignment DM could not be delivered', {
        projectId: project.id,
        userId: person.discord_user_id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
}

async function sendTransition(guild, project, payload) {
  try {
    await sendProjectTransition(guild, project, payload);
  } catch (error) {
    logger.warn('Project transition message could not be delivered', {
      projectId: project.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function reconcileCommittedProject({ projectId, guild, db }) {
  const reconciliation = await reconcileProject({ projectId, guild, db });
  if (reconciliation.status === 'succeeded') return reconciliation;

  // The write transaction already committed. Return its persisted state for
  // every retryable reconciliation outcome so callers acknowledge the saved
  // mutation instead of offering an unsafe retry.
  const [project, people] = await Promise.all([
    getProject(db, projectId),
    getProjectPeople(db, projectId),
  ]);
  const statusResult = await db.query(
    'SELECT status FROM project_reconciliation WHERE project_id = $1',
    [projectId],
  );
  const status = statusResult.rows[0]?.status;
  if (status === 'succeeded') return { status, project, people };
  return { status: status === 'failed' ? 'failed' : 'pending', project, people };
}

function projectResult(reconciliation) {
  return {
    ...reconciliation.project,
    people: reconciliation.people,
    reconciliation_pending: reconciliation.status !== 'succeeded',
  };
}

export function projectIdFromOption(value, interaction = null) {
  const channelProject = projectCommandChannelScope(interaction?.channel);
  const projectId = String(value ?? '').trim();
  if (!projectId) {
    assertUser(
      channelProject,
      'Choose a valid project when using this command outside a project channel.',
    );
    return channelProject.projectId;
  }
  assertUser(/^[1-9]\d*$/.test(projectId), 'Choose a valid project.');
  assertUser(
    !channelProject || channelProject.projectId === projectId,
    'A project-channel command can only manage the project that owns this channel.',
  );
  return projectId;
}

export async function createProject(input, deps: ProjectDependencies = {}) {
  const db = dbClient(deps.db);
  const { interaction } = input;
  const guild = interaction.guild;
  const actor = interaction.member;
  assertUser(Boolean(guild), 'This command can only be used inside the server.');

  const name = normalizeProjectName(input.name);
  const university = normalizeRequiredText(input.university, 'university', 120);
  const division = normalizeRequiredText(input.division, 'division', 120);
  const summary = normalizeProjectLongText(input.summary, 'summary');
  const notes = input.notes == null ? null : normalizeProjectLongText(input.notes, 'notes');
  const { startDate, expectedEnd } = validateProjectDates(input.startDate, input.expectedEnd);
  const memberIds = parseDiscordUserIds(input.members, 'members');
  const supervisorIds = parseDiscordUserIds(input.supervisors, 'supervisors');
  assertNoBotUserIds(guild, [...memberIds, ...supervisorIds]);
  assertNoUserOverlap(memberIds, supervisorIds, 'members', 'supervisors');
  assertProjectParticipantCapacity([...memberIds, ...supervisorIds]);

  const divisionRecord = await findActiveDivision(db, university, division);
  assertDivisionAuthority(actor, divisionRecord.university_name, divisionRecord.division_name, [
    BOARD_ROLES.HEAD,
    BOARD_ROLES.VICE_PRESIDENT,
    BOARD_ROLES.PRESIDENT,
  ]);
  await assertGuildMembers(guild, uniqueIds([...memberIds, ...supervisorIds]));
  await assertActiveProjectMembers(db, divisionRecord.university_id, divisionRecord.division_id, memberIds, 'members');
  await assertActiveUniversityMembers(db, divisionRecord.university_id, supervisorIds, 'supervisors');

  const project = await db.transaction(async (client) => {
    await lockDivisionHeadEligibilityRows(client, [divisionRecord.division_id]);
    const divisionHeadIds = await findActiveDivisionHeadIds(client, divisionRecord.division_id);
    assertUser(divisionHeadIds.length > 0, `No active Head is assigned to ${divisionRecord.division_name}.`);
    const resolvedSupervisorIds = uniqueIds([...supervisorIds, ...divisionHeadIds]);
    assertNoUserOverlap(memberIds, resolvedSupervisorIds, 'members', 'supervisors');
    assertProjectParticipantCapacity([...memberIds, ...resolvedSupervisorIds]);
    assertNoBotUserIds(guild, uniqueIds([...memberIds, ...resolvedSupervisorIds]));
    const people = [
      ...memberIds.map((id) => ({ discord_user_id: id, role: PROJECT_PERSON_ROLES.MEMBER })),
      ...resolvedSupervisorIds.map((id) => ({ discord_user_id: id, role: PROJECT_PERSON_ROLES.SUPERVISOR })),
    ];
    await lockMemberEligibilityRows(client, people.map((person) => person.discord_user_id));
    const lockedDivisionHeadIds = await findActiveDivisionHeadIds(client, divisionRecord.division_id);
    assertUser(
      lockedDivisionHeadIds.length === divisionHeadIds.length &&
        lockedDivisionHeadIds.every((headId, index) => headId === divisionHeadIds[index]),
      `The active Head assignments for ${divisionRecord.division_name} changed while the project was being created. Try again.`,
    );
    await assertProjectPeopleEligibility(client, divisionRecord, people);
    const result = await client.query(
      `INSERT INTO projects
        (name, university_id, division_id, start_date, expected_end, summary, notes, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id, name, university_id, division_id, start_date::text, expected_end::text, summary, notes, status,
         outcome, final_notes, closed_at, channel_id AS discord_channel_id, home_message_id, showcase_thread_id`,
      [
        name,
        divisionRecord.university_id,
        divisionRecord.division_id,
        startDate,
        expectedEnd,
        summary,
        notes,
        PROJECT_STATUSES.ACTIVE,
      ],
    );
    const created = { ...result.rows[0], ...divisionRecord };
    await insertProjectPeople(client, created.id, people);
    await enqueueProjectReconciliation(client, created.id);
    await writeAudit(client, {
      actorId: interaction.user.id, action: 'project.create', targetType: 'project', targetId: created.id,
      universityId: created.university_id, after: { ...created, people },
    });
    return created;
  });

  const reconciliation = await reconcileCommittedProject({ projectId: project.id, guild, db });
  if (reconciliation.status === 'succeeded') {
    await notifyAssignments(guild, reconciliation.project, reconciliation.people);
  }
  return projectResult(reconciliation);
}

export async function addProjectMember(input, deps: ProjectDependencies = {}) {
  const db = dbClient(deps.db);
  const projectId = projectIdFromOption(input.project, input.interaction);
  const role = normalizeProjectPersonRole(input.role);
  assertNotBotUser(input.interaction, input.user.id);
  const project = await getProject(db, projectId);
  const currentPeople = await getProjectPeople(db, project.id);
  assertProjectManagementAuthority(input.interaction.member, project, currentPeople);
  assertProjectIsOpen(project.status);
  await assertGuildMembers(input.interaction.guild, [input.user.id]);
  if (role === PROJECT_PERSON_ROLES.MEMBER) {
    await assertActiveProjectMembers(db, project.university_id, project.division_id, [input.user.id], 'members');
  } else {
    await assertActiveUniversityMembers(db, project.university_id, [input.user.id], `${role}s`);
  }

  let previousRole = null;
  await db.transaction(async (client) => {
    const { project: lockedProject, count: existingPeople } = await lockProjectAndCountPeople(client, project.id);
    const lockedPeople = await getProjectPeople(client, lockedProject.id);
    assertProjectManagementAuthority(input.interaction.member, lockedProject, lockedPeople);
    assertProjectIsOpen(lockedProject.status);
    const existingPerson = await getProjectPerson(client, lockedProject.id, input.user.id);
    previousRole = existingPerson?.role ?? null;
    if (!existingPerson) assertProjectParticipantCount(existingPeople + 1);
    await lockAndAssertProjectPeopleEligibility(client, lockedProject, [
      { discord_user_id: input.user.id, role },
    ]);
    await insertProjectPeople(client, lockedProject.id, [{ discord_user_id: input.user.id, role }]);
    await enqueueProjectReconciliation(client, lockedProject.id);
    await writeAudit(client, {
      actorId: input.interaction.user.id,
      action: 'project.add_member',
      targetType: 'project',
      targetId: lockedProject.id,
      universityId: lockedProject.university_id,
      after: { user_id: input.user.id, role },
    });
  });
  const reconciliation = await reconcileCommittedProject({ projectId: project.id, guild: input.interaction.guild, db });
  if (reconciliation.status === 'succeeded') {
    await Promise.all([
      notifyAssignments(
        input.interaction.guild,
        reconciliation.project,
        [{ discord_user_id: input.user.id, role }],
        previousRole,
      ),
      sendTransition(
        input.interaction.guild,
        reconciliation.project,
        projectTransitionPayload({
          project: reconciliation.project,
          title: previousRole ? 'Project role updated' : 'New project participant',
          summary: `<@${input.user.id}> ${previousRole ? `is now a **${role}**` : `joined as a **${role}**`}.`,
          detail: previousRole
            ? `Their previous project role was **${previousRole}**.`
            : 'They received a direct handoff with this workspace and the recommended first step.',
        }),
      ),
    ]);
  }
  return {
    project: projectResult(reconciliation),
    people: reconciliation.people,
    participant: { user: input.user, userId: input.user.id, role, previousRole },
  };
}

export async function removeProjectMember(input, deps: ProjectDependencies = {}) {
  const db = dbClient(deps.db);
  const projectId = projectIdFromOption(input.project, input.interaction);
  assertNotBotUser(input.interaction, input.user.id);
  const project = await getProject(db, projectId);
  const currentPeople = await getProjectPeople(db, project.id);
  assertProjectManagementAuthority(input.interaction.member, project, currentPeople);
  assertProjectIsOpen(project.status);

  let previousRole = null;
  await db.transaction(async (client) => {
    const { project: lockedProject } = await lockProjectAndCountPeople(client, project.id);
    const lockedPeople = await getProjectPeople(client, lockedProject.id);
    assertProjectManagementAuthority(input.interaction.member, lockedProject, lockedPeople);
    assertProjectIsOpen(lockedProject.status);
    await lockMemberEligibilityRows(client, [input.user.id]);
    const existingPerson = await getProjectPerson(client, lockedProject.id, input.user.id);
    assertUser(existingPerson, 'That user is not a project participant.');
    previousRole = existingPerson?.role ?? null;
    await client.query('DELETE FROM project_people WHERE project_id = $1 AND discord_user_id = $2', [
      lockedProject.id,
      input.user.id,
    ]);
    await enqueueProjectReconciliation(client, lockedProject.id);
    await writeAudit(client, {
      actorId: input.interaction.user.id,
      action: 'project.remove_member',
      targetType: 'project',
      targetId: lockedProject.id,
      universityId: lockedProject.university_id,
      after: { user_id: input.user.id },
      reason: input.reason ?? null,
    });
  });
  const reconciliation = await reconcileCommittedProject({ projectId: project.id, guild: input.interaction.guild, db });
  if (reconciliation.status === 'succeeded') {
    await Promise.all([
      notifyProjectRemoval(
        input.interaction.guild,
        reconciliation.project,
        input.user.id,
        input.reason,
      ).catch((error) => {
        logger.warn('Project removal DM could not be delivered', {
          projectId: reconciliation.project.id,
          userId: input.user.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }),
      sendTransition(
        input.interaction.guild,
        reconciliation.project,
        projectTransitionPayload({
          project: reconciliation.project,
          title: 'Project team updated',
          summary: `<@${input.user.id}> is no longer assigned to this project.`,
          detail: 'Their project-channel access was removed. Any private reason was shared only with the affected member and retained in the audit record.',
        }),
      ),
    ]);
  }
  return {
    project: projectResult(reconciliation),
    people: reconciliation.people,
    participant: { user: input.user, userId: input.user.id, role: previousRole },
  };
}

export async function updateProject(input, deps: ProjectDependencies = {}) {
  const db = dbClient(deps.db);
  const projectId = projectIdFromOption(input.project, input.interaction);
  const initial = await getProject(db, projectId);
  const currentPeople = await getProjectPeople(db, initial.id);
  assertProjectManagementAuthority(input.interaction.member, initial, currentPeople);
  assertProjectIsOpen(initial.status);
  const requested = {
    name: input.name == null ? null : normalizeProjectName(input.name),
    expected_end: input.expectedEnd == null ? null : input.expectedEnd,
    summary: input.summary == null ? null : normalizeProjectLongText(input.summary, 'summary'),
    notes: input.notes == null ? null : normalizeProjectLongText(input.notes, 'notes'),
    status: input.status == null ? null : normalizeProjectStatus(input.status),
  };

  const before = await db.transaction(async (client) => {
    const lockedProject = await getProjectForUpdate(client, projectId);
    const lockedPeople = await getProjectPeople(client, lockedProject.id);
    assertProjectManagementAuthority(input.interaction.member, lockedProject, lockedPeople);
    assertProjectIsOpen(lockedProject.status);
    const patch = {
      name: requested.name ?? lockedProject.name,
      expected_end: requested.expected_end == null
        ? lockedProject.expected_end
        : validateExpectedEndUpdate(lockedProject.start_date, requested.expected_end),
      summary: requested.summary ?? lockedProject.summary,
      notes: requested.notes ?? lockedProject.notes,
      status: requested.status ?? lockedProject.status,
    };
    assertProjectStatusChange(lockedProject.status, patch.status);
    await client.query(
      `UPDATE projects
       SET name = $1, expected_end = $2, summary = $3, notes = $4, status = $5, updated_at = now()
       WHERE id = $6`,
      [patch.name, patch.expected_end, patch.summary, patch.notes, patch.status, lockedProject.id],
    );
    await enqueueProjectReconciliation(client, lockedProject.id);
    await writeAudit(client, {
      actorId: input.interaction.user.id,
      action: 'project.update',
      targetType: 'project',
      targetId: lockedProject.id,
      universityId: lockedProject.university_id,
      before: lockedProject,
      after: patch,
    });
    return lockedProject;
  });
  const reconciliation = await reconcileCommittedProject({ projectId: before.id, guild: input.interaction.guild, db });
  if (reconciliation.status === 'succeeded') {
    const changed = [
      before.name !== reconciliation.project.name ? 'name' : null,
      before.expected_end !== reconciliation.project.expected_end ? 'timeline' : null,
      before.notes !== reconciliation.project.notes ? 'internal notes' : null,
      before.summary !== reconciliation.project.summary ? 'public summary' : null,
      before.status !== reconciliation.project.status ? 'status' : null,
    ].filter(Boolean);
    await sendTransition(
      input.interaction.guild,
      reconciliation.project,
      projectTransitionPayload({
        project: reconciliation.project,
        title: 'Project details updated',
        summary: changed.length > 0
          ? `Updated **${changed.join(', ')}**.`
          : 'The project record was checked and remains current.',
        detail: 'The pinned project overview and showcase starter now show the current canonical record.',
      }),
    );
  }
  return {
    before,
    project: projectResult(reconciliation),
    people: reconciliation.people,
  };
}

export async function closeProject(input, deps: ProjectDependencies = {}) {
  const db = dbClient(deps.db);
  const projectId = projectIdFromOption(input.project, input.interaction);
  const initial = await getProject(db, projectId);
  const currentPeople = await getProjectPeople(db, initial.id);
  assertProjectManagementAuthority(input.interaction.member, initial, currentPeople);
  assertProjectIsOpen(initial.status);
  const outcome = normalizeProjectLongText(input.outcome, 'outcome');
  const finalNotes = normalizeProjectLongText(input.finalNotes, 'final_notes');

  const project = await db.transaction(async (client) => {
    const lockedProject = await getProjectForUpdate(client, projectId);
    const lockedPeople = await getProjectPeople(client, lockedProject.id);
    assertProjectManagementAuthority(input.interaction.member, lockedProject, lockedPeople);
    assertProjectIsOpen(lockedProject.status);
    await client.query(
      `UPDATE projects
       SET status = $1, outcome = $2, final_notes = $3,
           closed_at = now(), updated_at = now()
       WHERE id = $4`,
      [PROJECT_STATUSES.COMPLETED, outcome, finalNotes, lockedProject.id],
    );
    await enqueueProjectReconciliation(client, lockedProject.id);
    await writeAudit(client, {
      actorId: input.interaction.user.id,
      action: 'project.close',
      targetType: 'project',
      targetId: lockedProject.id,
      universityId: lockedProject.university_id,
      before: lockedProject,
      after: { status: PROJECT_STATUSES.COMPLETED, outcome, final_notes: finalNotes },
    });
    return lockedProject;
  });
  const reconciliation = await reconcileCommittedProject({ projectId: project.id, guild: input.interaction.guild, db });
  if (reconciliation.status === 'succeeded') {
    await sendTransition(
      input.interaction.guild,
      reconciliation.project,
      projectTransitionPayload({
        project: reconciliation.project,
        title: 'Project completed',
        summary: outcome,
        detail: 'The public conclusion is in the showcase. Private handover notes are in the pinned project overview. Members now have read-only workspace access.',
        color: 0x27AE60,
      }),
    );
  }
  return {
    project: projectResult(reconciliation),
    people: reconciliation.people,
    outcome,
  };
}

export async function getProjectInfo(input, deps: ProjectDependencies = {}) {
  const db = dbClient(deps.db);
  const projectId = projectIdFromOption(input.project, input.interaction);
  const project = await getProject(db, projectId);
  const people = await getProjectPeople(db, project.id);
  assertProjectViewAuthority(input.interaction.member, project, people);
  return { project, people };
}

export const projectCreateSetup = createProjectSetupService({
  createProject,
  findUniversities: listProjectUniversities,
  findDivisions: listProjectDivisions,
});

export {
  assertActiveProjectMembers,
  assertActiveUniversityMembers,
  assertGuildMembers,
  canViewProject,
  findProjectDivisions,
  findProjectParentId,
  findProjectUniversities,
  parseDiscordUserIds,
  projectInfoMessage,
  projectSuccessMessage,
  searchVisibleProjects,
  validateProjectDates,
  warmProjectAutocompleteCache,
};
