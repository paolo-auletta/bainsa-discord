import { BOARD_ROLES, divisionLabel, MEMBER_TYPES } from '../../constants.mjs';
import { divisionHeadRoleName, normalizeDisplayName } from '../../naming.mjs';
import { boardRoleLabel, memberTypeLabel } from './policy.mjs';

function universityAccessRoleName(universityName) {
  return normalizeDisplayName(universityName);
}

export function roleNamesForDivisionHead(universityName, divisionName) {
  return [
    universityAccessRoleName(universityName),
    divisionHeadRoleName(universityName, divisionName),
  ];
}

export function projectChannelCleanupTargets(projects) {
  return [...new Set(projects.map((project) => project.channel_id).filter(Boolean))];
}

export function memberRemovalCleanupPlan({ divisions = [], boardRoles = [], projects = [] }) {
  return {
    divisionIds: divisions.map((division) => String(division.id)),
    boardAssignments: boardRoles.map((role) => ({
      role: role.role,
      university: role.university_name ?? null,
      division: role.division_name ?? null,
    })),
    projectAssignments: projects.map((project) => ({
      id: String(project.id),
      role: project.role,
      channelId: project.channel_id ?? null,
    })),
    projectChannelIds: projectChannelCleanupTargets(projects),
  };
}

export function resolveDivisionTextForMemberUpdate(memberType, previousDivisions, providedDivisionsText) {
  if (providedDivisionsText !== undefined) return providedDivisionsText;
  if (memberType === MEMBER_TYPES.ALUMNI) return '';
  return previousDivisions.map((division) => division.name).join(', ');
}

export function formatMemberInfo(info) {
  const divisions = info.divisions.map((division) => divisionLabel(division.name, division.color)).join(', ') || 'None';
  const board = info.boardRoles
    .map((role) =>
      role.role === BOARD_ROLES.HEAD
        ? `Head of ${role.division_name}`
        : boardRoleLabel(role.role),
    )
    .join(', ') || 'None';
  const projects = info.projects
    .map((project) => `${project.name} (${project.role}, ${project.status})`)
    .join('\n') || 'None';

  return [
    `**${info.target.user.tag ?? info.target.displayName ?? info.target.id}**`,
    `Name: ${info.member.full_name ?? 'Not recorded'}`,
    `Type: ${memberTypeLabel(info.member.member_type)}`,
    `University: ${info.member.university_name ?? 'None'}`,
    `Divisions: ${divisions}`,
    `Board roles: ${board}`,
    `Projects:\n${projects}`,
  ].join('\n');
}

export function formatBoardInfo(info) {
  if (!info.rows.length) return `No board roles are recorded for ${info.university.name}.`;
  return info.rows
    .map((row) => {
      const role =
        row.role === BOARD_ROLES.HEAD
          ? `Head of ${row.division_name ? divisionLabel(row.division_name, row.division_color) : 'unknown division'}`
          : boardRoleLabel(row.role);
      const missing = row.missingRoles.length ? ` Missing: ${row.missingRoles.join(', ')}` : '';
      return `<@${row.discord_user_id}> - ${role}.${missing}`;
    })
    .join('\n');
}
