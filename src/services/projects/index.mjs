import { writeAudit } from '../../audit.mjs';
import {
  assertDivisionAuthority,
  assertNoBotUserIds,
  assertNotBotUser,
} from '../../authorization.mjs';
import {
  BOARD_ROLES,
  PROJECT_PERSON_ROLES,
  PROJECT_STATUSES,
} from '../../constants.mjs';
import { query, transaction } from '../../db.mjs';
import { UserFacingError, assertUser } from '../../errors.mjs';
import { uniqueIds } from './permissions.mjs';
import {
  assertActiveDivisionResearchers,
  assertActiveUniversityMembers,
  findActiveDivision,
  getProject,
  getProjectPeople,
  insertProjectPeople,
  lockProjectAndCountPeople,
  projectPersonExists,
  setProjectShowcaseThreadId,
} from './repository.mjs';
import {
  assertProjectStatusChange,
  assertNoUserOverlap,
  assertProjectParticipantCount,
  assertProjectParticipantCapacity,
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
import {
  assertGuildMembers,
  createShowcaseThread,
  findProjectParentId,
  updateProjectChannel,
  updateShowcaseThread,
} from './gateway.mjs';
import {
  findProjectDivisions,
  findProjectPeople,
  findProjectUniversities,
  searchVisibleProjects,
  warmProjectAutocompleteCache,
} from './autocomplete.mjs';
import { canViewProject } from './policy.mjs';
import { projectInfoMessage, projectSuccessMessage, readProjectCreateOptions } from './formatters.mjs';

const DEFAULT_DB = { query, transaction };

function dbClient(db) {
  return db ?? DEFAULT_DB;
}

function assertProjectAuthority(member, project) {
  assertDivisionAuthority(member, project.university_name, project.division_name, [
    BOARD_ROLES.HEAD,
    BOARD_ROLES.VICE_PRESIDENT,
    BOARD_ROLES.PRESIDENT,
  ]);
}

function assertProjectViewAuthority(member, project, people) {
  assertUser(canViewProject(member, project, people), `You do not have permission to view ${project.name}.`);
}

async function createProjectHistory(guild, db, project, people) {
  await updateProjectChannel(guild, project, people);
  try {
    const thread = await createShowcaseThread(guild, project, people);
    if (!thread) return;
    await setProjectShowcaseThreadId(db, project.id, thread.id);
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
  assertProjectParticipantCapacity([...memberIds, ...supervisorIds]);
  const people = [
    ...memberIds.map((id) => ({ discord_user_id: id, role: PROJECT_PERSON_ROLES.MEMBER })),
    ...supervisorIds.map((id) => ({ discord_user_id: id, role: PROJECT_PERSON_ROLES.SUPERVISOR })),
  ];

  const divisionRecord = await findActiveDivision(db, university, division);
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
    await insertProjectPeople(client, created.id, people);
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
    const existingPeople = await lockProjectAndCountPeople(client, project.id);
    const existingPerson = await projectPersonExists(client, project.id, input.user.id);
    if (!existingPerson) assertProjectParticipantCount(existingPeople + 1);
    await lockAndAssertProjectPeopleEligibility(client, project, [
      { discord_user_id: input.user.id, role },
    ]);
    await insertProjectPeople(client, project.id, [{ discord_user_id: input.user.id, role }]);
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

export {
  assertActiveDivisionResearchers,
  assertActiveUniversityMembers,
  assertGuildMembers,
  canViewProject,
  findProjectDivisions,
  findProjectParentId,
  findProjectPeople,
  findProjectUniversities,
  parseDiscordUserIds,
  projectInfoMessage,
  projectSuccessMessage,
  readProjectCreateOptions,
  searchVisibleProjects,
  validateProjectDates,
  warmProjectAutocompleteCache,
};
