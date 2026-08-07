import { MEMBER_TYPES, PROJECT_PERSON_ROLES, PROJECT_STATUSES } from '../../constants.js';
import { assertUser } from '../../errors.js';
import { formatDiscordUserReferences } from './validation.js';

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
  await q.query(
    `SELECT discord_user_id
       FROM members
      WHERE discord_user_id = ANY($1::text[])
      ORDER BY discord_user_id
      FOR UPDATE`,
    [ids],
  );
  return ids;
}

// Project creation and every governance write that can change active Heads
// acquire these rows before member locks. This makes the Head set for a
// division a short, transactionally stable application boundary.
export async function lockDivisionHeadEligibilityRows(q, divisionIds) {
  const ids = [...new Set<string>(divisionIds.filter((id) => id != null).map((id) => String(id)))]
    .sort((left, right) => left.localeCompare(right));
  if (ids.length === 0) return ids;
  await q.query(
    `SELECT id
       FROM divisions
      WHERE id = ANY($1::bigint[])
      ORDER BY id
      FOR UPDATE`,
    [ids],
  );
  return ids;
}

async function membershipRows(q, userIds) {
  const result = await q.query(
    `SELECT m.discord_user_id, m.member_type, m.university_id, m.status, md.division_id,
            EXISTS (
              SELECT 1
                FROM board_assignments br
               WHERE br.discord_user_id = m.discord_user_id
                 AND br.university_id = m.university_id
                 AND br.active = true
                 AND br.role IN ('head', 'vice_president', 'president')
            ) AS is_university_board_member
       FROM members m
       LEFT JOIN member_divisions md ON md.discord_user_id = m.discord_user_id
      WHERE m.discord_user_id = ANY($1::text[])`,
    [sortedDiscordUserIds(userIds)],
  );
  return result.rows;
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

function isEligibleForProjectPerson(member, project, role) {
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
  const result = await q.query(
    `SELECT p.id, p.name, p.university_id, p.division_id, pp.role,
            EXISTS (
              SELECT 1
                FROM board_assignments br
               WHERE br.discord_user_id = pp.discord_user_id
                 AND br.university_id = p.university_id
                 AND br.active = true
                 AND br.role IN ('head', 'vice_president', 'president')
            ) AS is_university_board_member
       FROM project_people pp
       JOIN projects p ON p.id = pp.project_id
      WHERE pp.discord_user_id = $1
        AND p.status = ANY($2::text[])
      ORDER BY p.name, p.id, pp.role`,
    [String(userId), ACTIVE_PROJECT_STATUSES],
  );
  const allowedDivisions = new Set(divisionIds.map((divisionId) => String(divisionId)));
  const additionalBoardUniversities = new Set(
    additionalBoardUniversityIds.map((candidate) => String(candidate)),
  );
  const incompatible = result.rows.filter((project) => {
    if (String(project.university_id) !== String(universityId)) return true;
    if (project.role !== PROJECT_PERSON_ROLES.MEMBER) return false;
    if (
      project.is_university_board_member === true ||
      additionalBoardUniversities.has(String(project.university_id))
    ) return false;
    return memberType !== MEMBER_TYPES.RESEARCHER || !allowedDivisions.has(String(project.division_id));
  });

  assertUser(
    incompatible.length === 0,
    `Cannot update this member because it would make them ineligible for active projects: ${incompatible
      .map((project) => `#${project.id} ${project.name}`)
      .join(', ')}. Remove or reassign their project participation first.`,
  );
}
