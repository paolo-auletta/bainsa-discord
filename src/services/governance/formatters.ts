import {
  EmbedBuilder,
  escapeMarkdown,
} from 'discord.js';

import { BOARD_ROLES, divisionLabel, MEMBER_TYPES } from '../../constants.js';
import { divisionHeadRoleName, normalizeDisplayName } from '../../naming.js';
import { boardRoleLabel, memberTypeLabel } from './policy.js';

const MEMBER_INFO_COLOR = 0x5865f2;
const FIELD_VALUE_LIMIT = 1_024;
const DIVISION_LIST_LIMIT = 800;
const BOARD_LIST_LIMIT = 800;
const PROJECT_LIST_LIMIT = FIELD_VALUE_LIMIT;

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

function safeText(value, fallback = 'None') {
  const text = String(value ?? '').trim();
  return escapeMarkdown(text || fallback);
}

function truncateText(value, limit = FIELD_VALUE_LIMIT) {
  if (value.length <= limit) return value;
  return `${value.slice(0, limit - 1).trimEnd()}…`;
}

function memberTypeDisplay(memberType) {
  return memberTypeLabel(memberType);
}

function formatBoardRole(role) {
  if (role.role === BOARD_ROLES.HEAD) {
    return `Head of ${safeText(role.division_name, 'unknown division')}`;
  }
  return safeText(boardRoleLabel(role.role));
}

function titleCase(value, fallback) {
  return safeText(value, fallback)
    .split('_')
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(' ');
}

function formatProject(project) {
  return `${safeText(project.name, 'Unnamed project')} — ${titleCase(project.role, 'Unknown role')}, ${titleCase(project.status, 'Unknown status')}`;
}

function formatBoundedLines(lines, limit, separator = '\n') {
  if (!lines.length) return 'None';

  const rendered = [];
  for (let index = 0; index < lines.length; index += 1) {
    const remaining = lines.length - index - 1;
    const suffix = remaining > 0 ? `${separator}… (+${remaining} more)` : '';
    const candidate = [...rendered, lines[index]].join(separator);
    if (`${candidate}${suffix}`.length > limit) {
      if (!rendered.length) return truncateText(lines[index], limit);
      return truncateText(`${rendered.join(separator)}${separator}… (+${lines.length - index} more)`, limit);
    }
    rendered.push(lines[index]);
  }

  return rendered.join(separator);
}

function formatProjectList(projects) {
  return formatBoundedLines(projects.map(formatProject), PROJECT_LIST_LIMIT);
}

function memberDisplay(info) {
  const name = safeText(info.member.full_name, 'Not recorded');
  return info.target.id ? `${name} (<@${info.target.id}>)` : name;
}

function affiliationDisplay(info, divisions) {
  const university = safeText(info.member.university_name, 'Not assigned');
  return divisions === 'None' ? university : `${university} › ${divisions}`;
}

function infoField(name, value) {
  return { name, value: truncateText(value), inline: false };
}

export function formatMemberInfo(info) {
  const divisions = formatBoundedLines(info.divisions
    .map((division) => divisionLabel(division.name, division.color))
    .map((division) => safeText(division)), DIVISION_LIST_LIMIT, ', ');
  const board = formatBoundedLines(info.boardRoles.map(formatBoardRole), BOARD_LIST_LIMIT, ', ');
  const projects = formatProjectList(info.projects);
  const embed = new EmbedBuilder()
    .setColor(MEMBER_INFO_COLOR)
    .setTitle('🔵 Member information')
    .addFields(
      infoField('Member', memberDisplay(info)),
      infoField('Type', memberTypeDisplay(info.member.member_type)),
      infoField('Affiliation', affiliationDisplay(info, divisions)),
      infoField('Board roles', board),
      infoField('Projects', projects),
    );

  return {
    embeds: [embed],
    allowedMentions: { parse: [] },
  };
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
