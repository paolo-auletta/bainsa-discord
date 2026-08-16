import { BOARD_ROLES, MEMBER_TYPES, ROLE_NAMES } from '../../constants.js';
import {
  hasRole,
  isGlobalPresident,
  isUniversityPresident,
  isUniversityVicePresident,
} from '../../authorization.js';
import { assertUser } from '../../errors.js';
import { divisionHeadRoleName } from '../../naming.js';

export const BOARD_ROLE_CHOICES = Object.freeze([
  { name: 'Head', value: BOARD_ROLES.HEAD },
  { name: 'Vice President', value: BOARD_ROLES.VICE_PRESIDENT },
  { name: 'President', value: BOARD_ROLES.PRESIDENT },
]);

export const MEMBER_TYPE_CHOICES = Object.freeze([
  { name: 'Researcher', value: MEMBER_TYPES.RESEARCHER },
  { name: 'Alumni', value: MEMBER_TYPES.ALUMNI },
]);

export function parseDivisionList(value) {
  if (!value?.trim()) return [];
  const seen = new Set();
  const divisions = [];

  for (const rawPart of value.split(',')) {
    const name = rawPart.trim().replace(/\s+/g, ' ');
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    divisions.push(name);
  }

  return divisions;
}

export function memberTypeLabel(memberType) {
  return memberType === MEMBER_TYPES.ALUMNI ? 'Alumni' : 'Researcher';
}

export function boardRoleLabel(role) {
  if (role === BOARD_ROLES.GLOBAL_PRESIDENT) return 'Global President';
  if (role === BOARD_ROLES.PRESIDENT) return 'President';
  if (role === BOARD_ROLES.VICE_PRESIDENT) return 'Vice President';
  return 'Head';
}

export function assertHeadAssignmentCompatible(boardRoles, universityName) {
  const normalizedUniversity = String(universityName).toLowerCase();
  const executiveRole = boardRoles.find(
    (boardRole) =>
      String(boardRole.university_name ?? '').toLowerCase() === normalizedUniversity
      && [BOARD_ROLES.PRESIDENT, BOARD_ROLES.VICE_PRESIDENT].includes(boardRole.role),
  );
  if (!executiveRole) return;

  const executiveLabel = boardRoleLabel(executiveRole.role);
  assertUser(
    false,
    `This member is already an active ${executiveLabel} of ${universityName} and cannot also be assigned as a division Head. Remove the ${executiveLabel} role first or choose another member.`,
  );
}

export function assertMemberType(value) {
  assertUser(
    Object.values(MEMBER_TYPES).includes(value),
    'member_type must be either Researcher or Alumni.',
  );
}

export function assertBoardRole(value) {
  assertUser(
    [BOARD_ROLES.HEAD, BOARD_ROLES.VICE_PRESIDENT, BOARD_ROLES.PRESIDENT].includes(value),
    'role must be head, vice_president, or president.',
  );
}

export function assertNoDivisionRolesForAlumni(memberType, divisions) {
  assertUser(
    memberType !== MEMBER_TYPES.ALUMNI || divisions.length === 0,
    'Alumni cannot be assigned division roles.',
  );
}

export function memberRequiresDivision(memberType, boardRoles, universityName) {
  if (memberType !== MEMBER_TYPES.RESEARCHER) return false;
  const normalizedUniversity = String(universityName ?? '').toLowerCase();
  const hasExecutiveExemption = boardRoles.some((boardRole) => {
    if (boardRole.role === BOARD_ROLES.GLOBAL_PRESIDENT) return true;
    return (
      [BOARD_ROLES.PRESIDENT, BOARD_ROLES.VICE_PRESIDENT].includes(boardRole.role)
      && String(boardRole.university_name ?? '').toLowerCase() === normalizedUniversity
    );
  });
  return !hasExecutiveExemption;
}

export function assertMemberDivisionRequirement(memberType, divisions, boardRoles, universityName) {
  assertUser(
    !memberRequiresDivision(memberType, boardRoles, universityName) || divisions.length > 0,
    'Researchers must belong to at least one division. Only Global Presidents, Presidents, and Vice Presidents can have no division.',
  );
}

export function assertHeadDivisionMembership(boardRoles, divisions, universityName) {
  const selectedDivisionIds = new Set(divisions.map((division) => String(division.id)));
  const missingHeadMembership = boardRoles.find((boardRole) =>
    boardRole.role === BOARD_ROLES.HEAD
    && String(boardRole.university_name ?? '').toLowerCase() === String(universityName).toLowerCase()
    && boardRole.division_id != null
    && !selectedDivisionIds.has(String(boardRole.division_id)),
  );
  if (!missingHeadMembership) return;

  assertUser(
    false,
    `Remove the member's Head of ${missingHeadMembership.division_name ?? 'this division'} board role before removing their division membership.`,
  );
}

export function assertCanManageMember(actorMember, targetUniversityName, targetMember) {
  assertUser(!hasRole(targetMember, ROLE_NAMES.BOT), 'The Bot member cannot be managed.');
  if (isGlobalPresident(actorMember)) return;
  assertUser(
    !hasRole(targetMember, ROLE_NAMES.GLOBAL_PRESIDENT),
    'You cannot manage Global President members.',
  );

  const isPresident = isUniversityPresident(actorMember, targetUniversityName);
  const isVicePresident = isUniversityVicePresident(actorMember, targetUniversityName);
  assertUser(
    isPresident || isVicePresident,
    `You can only manage members in ${memberManagementUniversityName(actorMember, targetUniversityName)}.`,
  );
  assertUser(
    !(isVicePresident && isUniversityPresident(targetMember, targetUniversityName)),
    'A Vice President cannot manage their university President.',
  );
}

export function assertCanManageBoardMember(
  actorMember,
  targetUniversityName,
  targetMember,
  targetBoardRoles = [],
) {
  assertCanManageMember(actorMember, targetUniversityName, targetMember);
  if (
    isUniversityVicePresident(actorMember, targetUniversityName)
    && !isUniversityPresident(actorMember, targetUniversityName)
  ) {
    assertUser(
      !targetBoardRoles.some((role) =>
        role.role === BOARD_ROLES.PRESIDENT
        && String(role.university_name ?? '').toLowerCase() === String(targetUniversityName).toLowerCase(),
      ),
      'A Vice President cannot manage their university President.',
    );
  }
}

function memberManagementUniversityName(member, fallbackUniversityName) {
  const boardRole = member.roles.cache.find?.((role) =>
    /^(?<university>.+) - (?:President|Vice President)$/.test(role.name),
  );
  const match = boardRole?.name.match(/^(?<university>.+) - (?:President|Vice President)$/);
  return match?.groups?.university ?? fallbackUniversityName;
}

export function assertCanRemoveMember(actorMember, targetUniversityName, targetMember) {
  assertUser(!hasRole(targetMember, ROLE_NAMES.BOT), 'The Bot member cannot be removed.');

  if (isGlobalPresident(actorMember)) return;

  assertUser(
    !hasRole(targetMember, ROLE_NAMES.GLOBAL_PRESIDENT),
    'Only a Global President can remove a Global President.',
  );

  if (isUniversityVicePresident(actorMember, targetUniversityName)) {
    assertUser(
      !isUniversityPresident(targetMember, targetUniversityName),
      'A Vice President cannot remove their university President.',
    );
    return;
  }

  assertUser(
    isUniversityPresident(actorMember, targetUniversityName),
    `Only the President or Vice President of ${targetUniversityName} can remove this member.`,
  );
}

export function assertCanAssignBoardRole(actorMember, universityName, role) {
  assertBoardRole(role);
  if (isGlobalPresident(actorMember)) return;

  if (role === BOARD_ROLES.PRESIDENT) {
    assertUser(
      isUniversityPresident(actorMember, universityName),
      `Only the President of ${universityName} can assign a university President there.`,
    );
    return;
  }

  assertUser(
    isUniversityPresident(actorMember, universityName) || isUniversityVicePresident(actorMember, universityName),
    `Only the President or Vice President of ${universityName} can assign board roles there.`,
  );
}

export function assertCanRemoveBoardRole(actorMember, universityName, role) {
  assertBoardRole(role);
  if (isGlobalPresident(actorMember)) return;

  if (role === BOARD_ROLES.PRESIDENT) {
    assertUser(
      isUniversityPresident(actorMember, universityName),
      `Only the President of ${universityName} can remove a university President there.`,
    );
    return;
  }

  assertUser(
    isUniversityPresident(actorMember, universityName) || isUniversityVicePresident(actorMember, universityName),
    `Only the President or Vice President of ${universityName} can remove board roles there.`,
  );
}

export function assertBoardRoleDivisionShape(role, divisionName) {
  if (role === BOARD_ROLES.HEAD) {
    assertUser(divisionName, 'division is required when assigning or removing a Head role.');
    return;
  }
  assertUser(!divisionName, 'division can only be used with Head roles.');
}

export function assertBoardAssignDivisionShape(role, divisionName) {
  if (role === BOARD_ROLES.HEAD) {
    assertUser(divisionName, 'division is required when assigning a Head role.');
    return;
  }
  assertUser(!divisionName, 'division can only be used with Head roles.');
}

export function assertBoardRemoveDivisionShape(role, divisionName) {
  if (role !== BOARD_ROLES.HEAD) {
    assertUser(!divisionName, 'division can only be used with Head roles.');
  }
}

export function isDivisionHeadFor(actorMember, universityName, divisionName) {
  return hasRole(actorMember, divisionHeadRoleName(universityName, divisionName));
}
