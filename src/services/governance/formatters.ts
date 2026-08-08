import {
  ContainerBuilder,
  escapeMarkdown,
  MessageFlags,
  SeparatorBuilder,
  SeparatorSpacingSize,
  TextDisplayBuilder,
} from 'discord.js';

import { BOARD_ROLES, divisionLabel, MEMBER_TYPES } from '../../constants.js';
import { divisionHeadRoleName, normalizeDisplayName } from '../../naming.js';
import { boardRoleLabel, memberTypeLabel } from './policy.js';

const MEMBER_INFO_ACCENT_COLOR = 0x5865f2;
const TEXT_DISPLAY_LIMIT = 4_000;
const HEADER_SECTION_LIMIT = 400;
const PROFILE_SECTION_LIMIT = 400;
const ACCESS_SECTION_LIMIT = 1_300;
const DIVISION_LIST_LIMIT = 700;
const BOARD_LIST_LIMIT = 450;
const PROJECT_LIST_LIMIT = 1_800;

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

function textDisplay(content) {
  return new TextDisplayBuilder().setContent(content);
}

function separator() {
  return new SeparatorBuilder()
    .setDivider(true)
    .setSpacing(SeparatorSpacingSize.Large);
}

function safeText(value, fallback = 'None') {
  const text = String(value ?? '').trim();
  return escapeMarkdown(text || fallback);
}

function truncateText(value, limit = TEXT_DISPLAY_LIMIT) {
  if (value.length <= limit) return value;
  return `${value.slice(0, limit - 1).trimEnd()}…`;
}

function memberTypeDisplay(memberType) {
  const icon = memberType === MEMBER_TYPES.ALUMNI ? '🎓' : '🔬';
  return `${icon} ${memberTypeLabel(memberType)}`;
}

function formatBoardRole(role) {
  if (role.role === BOARD_ROLES.HEAD) {
    return `Head of ${safeText(role.division_name, 'unknown division')}`;
  }
  return safeText(boardRoleLabel(role.role));
}

function formatProject(project) {
  return `• **${safeText(project.name, 'Unnamed project')}** · ${safeText(project.role, 'Unknown role')} · ${safeText(project.status, 'Unknown status')}`;
}

function formatBoundedLines(lines, limit) {
  if (!lines.length) return 'None';

  const rendered = [];
  for (let index = 0; index < lines.length; index += 1) {
    const remaining = lines.length - index - 1;
    const suffix = remaining > 0 ? `\n… (+${remaining} more)` : '';
    const candidate = [...rendered, lines[index]].join('\n');
    if (`${candidate}${suffix}`.length > limit) {
      if (!rendered.length) return truncateText(lines[index], limit);
      return truncateText(`${rendered.join('\n')}\n… (+${lines.length - index} more)`, limit);
    }
    rendered.push(lines[index]);
  }

  return rendered.join('\n');
}

function formatProjectList(projects) {
  return formatBoundedLines(projects.map(formatProject), PROJECT_LIST_LIMIT);
}

export function formatMemberInfo(info) {
  const targetTag = info.target.user?.tag ?? info.target.displayName ?? info.target.id;
  const targetMention = info.target.id ? `<@${info.target.id}>` : 'Unknown member';
  const divisions = formatBoundedLines(info.divisions
    .map((division) => divisionLabel(division.name, division.color))
    .map((division) => safeText(division)), DIVISION_LIST_LIMIT);
  const board = formatBoundedLines(info.boardRoles.map(formatBoardRole), BOARD_LIST_LIMIT);
  const projects = formatProjectList(info.projects);

  const container = new ContainerBuilder()
    .setAccentColor(MEMBER_INFO_ACCENT_COLOR)
    .addTextDisplayComponents(
      textDisplay(truncateText([
        `## ${safeText(info.member.full_name, 'Not recorded')}`,
        `${safeText(targetTag)} · ${targetMention}`,
      ].join('\n'), HEADER_SECTION_LIMIT)),
    )
    .addSeparatorComponents(separator())
    .addTextDisplayComponents(
      textDisplay(truncateText([
        '**Profile**',
        '',
        `**Type** · ${memberTypeDisplay(info.member.member_type)}`,
        `**University** · ${safeText(info.member.university_name)}`,
      ].join('\n'), PROFILE_SECTION_LIMIT)),
    )
    .addSeparatorComponents(separator())
    .addTextDisplayComponents(
      textDisplay(truncateText([
        '**Access & leadership**',
        '',
        '**Divisions**',
        divisions,
        '',
        '**Board roles**',
        board,
      ].join('\n'), ACCESS_SECTION_LIMIT)),
    )
    .addSeparatorComponents(separator())
    .addTextDisplayComponents(
      textDisplay([
        '**Projects**',
        '',
        projects,
      ].join('\n')),
    );

  return {
    components: [container],
    flags: MessageFlags.IsComponentsV2,
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
