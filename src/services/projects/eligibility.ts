import { MEMBER_TYPES, PROJECT_PERSON_ROLES, PROJECT_STATUSES } from '../../constants.js';
import { assertUser } from '../../errors.js';
import { formatDiscordUserReferences } from './validation.js';
import {
  loadActiveProjectAssignmentsForMember,
  loadProjectMembershipRows,
  lockProjectDivisionEligibilityRows,
  lockProjectMemberEligibilityRows,
} from './repository.js';

// Every project_people or membership writer must enter this boundary before it
// changes durable state.  Sorting Discord IDs gives concurrent multi-person
// project writes one shared member-row lock order.
export const PROJECT_PARTICIPANT_ELIGIBILITY_BOUNDARY = 'project-participant-eligibility';
export const ACTIVE_PROJECT_STATUSES = Object.freeze([
  PROJECT_STATUSES.ACTIVE,
  PROJECT_STATUSES.PAUSED,
]);

export function sortedDiscordUserIds(userIds) {
  return [...new Set<string>(userIds.map((userId) => String(userId)))].sort((left, right) =>
    left.localeCompare(right),
  );
}

export async function lockMemberEligibilityRows(q, userIds) {
  const ids = sortedDiscordUserIds(userIds);
  if (ids.length === 0) return ids;
  await lockProjectMemberEligibilityRows(q, ids);
  return ids;
}

// Project creation and every governance write that can change active Heads
// acquire these rows before member locks. This makes the Head set for a
// division a short, transactionally stable application boundary.
export async function lockDivisionHeadEligibilityRows(q, divisionIds) {
  const ids = [...new Set<string>(divisionIds.filter((id) => id != null).map((id) => String(id)))]
    .sort((left, right) => left.localeCompare(right));
  if (ids.length === 0) return ids;
  await lockProjectDivisionEligibilityRows(q, ids);
  return ids;
}

async function membershipRows(q, userIds) {
  return loadProjectMembershipRows(q, sortedDiscordUserIds(userIds));
}

function membershipIndex(rows) {
  const members = new Map();
  for (const row of rows) {
    const userId = String(row.discord_user_id);
    let member = members.get(userId);
    if (!member) {
      member = {
        member_type: row.member_type,
        university_id: row.university_id,
        status: row.status,
        divisionIds: new Set(),
        isUniversityBoardMember: false,
      };
      members.set(userId, member);
    }
    if (row.division_id != null) member.divisionIds.add(String(row.division_id));
    member.isUniversityBoardMember ||= row.is_university_board_member === true;
  }
  return members;
}

// Keep this predicate as the single semantic definition of project-person
// eligibility. Callers may load the member state from PostgreSQL or construct
// the desired state they are about to persist, but they must not duplicate the
// role/division/board exception rules.
export function isEligibleForProjectPerson(member, project, role) {
  if (!member || member.status !== 'active' || String(member.university_id) !== String(project.university_id)) {
    return false;
  }
  if (role === PROJECT_PERSON_ROLES.MEMBER) {
    if (member.isUniversityBoardMember) return true;
    return member.member_type === MEMBER_TYPES.RESEARCHER && member.divisionIds.has(String(project.division_id));
  }
  return role === PROJECT_PERSON_ROLES.SUPERVISOR || role === PROJECT_PERSON_ROLES.BOARD_LIAISON;
}

function roleFieldName(role) {
  return role === PROJECT_PERSON_ROLES.MEMBER ? 'members' : `${role}s`;
}

export async function assertProjectPeopleEligibility(q, project, people) {
  const members = membershipIndex(await membershipRows(q, people.map((person) => person.discord_user_id)));
  const rejectedByRole = new Map();

  for (const person of people) {
    if (isEligibleForProjectPerson(members.get(String(person.discord_user_id)), project, person.role)) continue;
    const rejected = rejectedByRole.get(person.role) ?? [];
    rejected.push(String(person.discord_user_id));
    rejectedByRole.set(person.role, rejected);
  }

  for (const [role, rejected] of rejectedByRole) {
    const message = role === PROJECT_PERSON_ROLES.MEMBER
      ? `These ${roleFieldName(role)} are neither active researchers in this division nor board members of this university: ${formatDiscordUserReferences(rejected)}.`
      : `These ${roleFieldName(role)} are not accepted active members in this university: ${formatDiscordUserReferences(rejected)}.`;
    assertUser(false, message);
  }
}

export async function lockAndAssertProjectPeopleEligibility(q, project, people) {
  await lockMemberEligibilityRows(q, people.map((person) => person.discord_user_id));
  await assertProjectPeopleEligibility(q, project, people);
}

export async function assertMemberProjectAssignmentEligibility(q, {
  userId,
  memberType,
  universityId,
  divisionIds,
  additionalBoardUniversityIds = [],
}) {
  const rows = await loadActiveProjectAssignmentsForMember(q, userId, ACTIVE_PROJECT_STATUSES);
  const allowedDivisions = new Set(divisionIds.map((divisionId) => String(divisionId)));
  const additionalBoardUniversities = new Set(
    additionalBoardUniversityIds.map((candidate) => String(candidate)),
  );
  const incompatible = rows.filter((project) => {
    const desiredMember = {
      member_type: memberType,
      university_id: universityId,
      status: 'active',
      divisionIds: allowedDivisions,
      isUniversityBoardMember: project.is_university_board_member === true ||
        additionalBoardUniversities.has(String(project.university_id)),
    };
    return !isEligibleForProjectPerson(desiredMember, project, project.role);
  });

  assertUser(
    incompatible.length === 0,
    `Cannot update this member because it would make them ineligible for active projects: ${incompatible
      .map((project) => `#${project.id} ${project.name}`)
      .join(', ')}. Remove or reassign their project participation first.`,
  );
}
