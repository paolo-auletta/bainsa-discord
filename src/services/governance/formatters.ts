import {
  ContainerBuilder,
  escapeMarkdown,
  MessageFlags,
  TextDisplayBuilder,
} from 'discord.js';

import { BOARD_ROLES, divisionLabel, MEMBER_TYPES } from '../../constants.js';
import { divisionHeadRoleName, normalizeDisplayName } from '../../naming.js';
import { boardRoleLabel, memberTypeLabel } from './policy.js';

const MEMBER_PROFILE_COLOR = 0x5865f2;
const TEXT_DISPLAY_LIMIT = 4_000;
const INLINE_SUMMARY_LIMIT = 600;
const PROJECT_SUMMARY_LIMIT = 2_400;

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

function profileName(target, member) {
  return member.full_name ?? target.displayName ?? target.user?.globalName ?? target.user?.username ?? target.id;
}

function accountName(target) {
  return target.user?.username ?? target.user?.tag ?? target.displayName ?? 'Discord member';
}

function projectRoleLabel(role) {
  return String(role ?? 'member')
    .split('_')
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(' ');
}

function projectStatusLabel(status) {
  const label = String(status ?? 'active');
  return `${label.slice(0, 1).toUpperCase()}${label.slice(1)}`;
}

function compactList(values, emptyLabel, separator = ', ', limit = INLINE_SUMMARY_LIMIT) {
  const text = values.filter(Boolean).join(separator);
  if (!text) return emptyLabel;
  return text.length <= limit
    ? text
    : `${text.slice(0, limit - 1).trimEnd()}…`;
}

function escaped(value) {
  return escapeMarkdown(String(value ?? ''));
}

function accountLine(target) {
  const mention = target.id ? `<@${target.id}>` : escaped(target.displayName ?? 'Discord member');
  const handle = accountName(target).replaceAll('`', 'ʼ');
  return `${mention}  \`@${handle}\``;
}

function membershipLine(member) {
  const icon = member.member_type === MEMBER_TYPES.ALUMNI ? '🎓' : '🔬';
  const university = escaped(member.university_name ?? 'Not assigned');
  return `${icon} **${memberTypeLabel(member.member_type)}** — 🏛️ **${university}**`;
}

export function formatMemberInfo(info) {
  const divisions = compactList(
    info.divisions.map((division) => escaped(divisionLabel(division.name, division.color))),
    'None',
  );
  const leadership = compactList(
    info.boardRoles
      .map((role) =>
        escaped(
          role.role === BOARD_ROLES.HEAD
            ? `Head of ${role.division_name}`
            : boardRoleLabel(role.role),
        ),
    ),
    'None',
  );
  const projects = compactList(
    info.projects.map((project) =>
      `**${escaped(project.name)}** — ${projectRoleLabel(project.role)} — ${projectStatusLabel(project.status)}`,
    ),
    'None',
    '\n',
    PROJECT_SUMMARY_LIMIT,
  );
  const content = [
    `## ${escaped(profileName(info.target, info.member))}`,
    accountLine(info.target),
    '',
    membershipLine(info.member),
    `🧭 **Divisions:** ${divisions}`,
    `🛡️ **Leadership:** ${leadership}`,
    `🚀 **Projects:**${info.projects.length > 0 ? `\n${projects}` : ` ${projects}`}`,
  ].join('\n');
  if (content.length > TEXT_DISPLAY_LIMIT) {
    throw new Error('Member profile summary exceeds the Discord text display limit.');
  }
  const container = new ContainerBuilder()
    .setAccentColor(MEMBER_PROFILE_COLOR)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(content));

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
