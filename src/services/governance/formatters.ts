import { escapeMarkdown } from 'discord.js';

import { BOARD_ROLES, divisionLabel, MEMBER_TYPES } from '../../constants.js';
import {
  normalizeUserReference,
  renderEventCard,
  renderHandoffMessage,
  userReference,
} from '../../messages/index.js';
import { divisionHeadRoleName, divisionRoleName, normalizeDisplayName } from '../../naming.js';
import { boardRoleLabel, memberTypeLabel } from './policy.js';

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
    divisionRoleName(universityName, divisionName),
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
  return `${safeText(project.name, 'Unnamed project')} — ${titleCase(project.role, 'Unknown role')} · ${titleCase(project.status, 'Unknown status')}`;
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
  const target = normalizeUserReference(info.target);
  const recordedName = typeof info.member.full_name === 'string' ? info.member.full_name.trim() : '';
  const name = recordedName || target.displayName || 'Not recorded';
  return userReference(target.id, name);
}

function infoField(label, value, inline = false) {
  return { label, value: truncateText(value), inline };
}

function summaryBody(body) {
  return Array.isArray(body) ? body.join('\n') : String(body ?? '');
}

export function memberRecordSummary(info) {
  const divisions = formatBoundedLines(info.divisions
    .map((division) => divisionLabel(division.name, division.color))
    .map((division) => safeText(division)), DIVISION_LIST_LIMIT, ', ');
  const board = formatBoundedLines(info.boardRoles.map(formatBoardRole), BOARD_LIST_LIMIT, ', ');
  const projects = formatProjectList(info.projects);
  const memberType = memberTypeDisplay(info.member.member_type);
  return {
    title: 'Member information',
    metadata: [
      infoField('Member', memberDisplay(info)),
      infoField('Type', memberType),
      infoField('University', safeText(info.member.university_name, 'Not assigned')),
      infoField('Divisions', divisions === 'None' && memberType === 'Alumni' ? 'Not applicable to Alumni' : divisions),
    ],
    sections: [
      { heading: 'Board roles', body: board === 'None' ? 'No active board roles' : board },
      { heading: 'Active projects', body: projects === 'None' ? 'No active project assignments' : projects },
    ],
  };
}

export function formatMemberInfo(info) {
  const summary = memberRecordSummary(info);
  return renderEventCard({
    kind: 'event-card',
    tone: 'brand',
    title: summary.title,
    description: 'Current canonical membership and active assignments',
    subject: { ...summary.metadata[0], inline: true },
    details: [
      { ...summary.metadata[1], inline: true },
      { label: '\u200b', value: '\u200b', inline: false },
      { ...summary.metadata[2], inline: true },
      { ...summary.metadata[3], inline: true },
      ...summary.sections.map((section) => infoField(section.heading, summaryBody(section.body))),
    ],
    footer: 'Member record · Current database state',
    audience: 'actor',
  });
}

export function boardRecordSummary(info) {
  const presidents = info.rows.filter((row) => row.role === BOARD_ROLES.PRESIDENT);
  const vicePresidents = info.rows.filter((row) => row.role === BOARD_ROLES.VICE_PRESIDENT);
  const divisions = info.divisions ?? [...new Map(
    info.rows
      .filter((row) => row.role === BOARD_ROLES.HEAD && row.division_name)
      .map((row) => [String(row.division_id ?? row.division_name), {
        id: row.division_id,
        name: row.division_name,
        color: row.division_color,
      }]),
  ).values()];
  const headRows = divisions.map((division) => ({
    division,
    assignments: info.rows.filter((row) =>
      row.role === BOARD_ROLES.HEAD
      && (
        String(row.division_id ?? '') === String(division.id ?? '')
        || (!row.division_id && row.division_name === division.name)
      )),
  }));
  const headedDivisionCount = headRows.filter((entry) => entry.assignments.length > 0).length;
  const memberList = (rows, empty) => rows.length
    ? formatBoundedLines(rows.map((row) => userReference(row.discord_user_id, row.full_name)), BOARD_LIST_LIMIT, ', ')
    : empty;
  const countLabel = (count, singular, plural = `${singular}s`) => `${count} ${count === 1 ? singular : plural}`;
  const description = info.rows.length
    ? [
        countLabel(presidents.length, 'President'),
        countLabel(vicePresidents.length, 'Vice President'),
        `${headedDivisionCount} of ${headRows.length} divisions headed`,
      ].join(' · ')
    : 'No active leadership assignments are recorded';
  return {
    title: `${safeText(info.university.name)} board`,
    description,
    leadership: [
      infoField('Presidents', memberList(presidents, 'No active President')),
      infoField('Vice Presidents', memberList(vicePresidents, 'No active Vice Presidents')),
    ],
    divisions: headRows.map(({ division, assignments }) => infoField(
      safeText(divisionLabel(division.name, division.color)),
      memberList(assignments, 'No active Head'),
    )),
  };
}

export function formatBoardInfo(info) {
  const summary = boardRecordSummary(info);
  const divisionLines = summary.divisions.length
    ? summary.divisions.map((field) => `**${field.label}** · ${field.value === 'No active Head' ? '*No active Head*' : field.value}`)
    : ['No active divisions are recorded.'];
  const roster = renderEventCard({
    kind: 'event-card',
    tone: info.rows.length ? 'brand' : 'warning',
    title: summary.title,
    description: summary.description,
    subject: summary.leadership[0],
    details: [
      summary.leadership[1],
      infoField('\u200b', '\u200b'),
      infoField('Division Heads', formatBoundedLines(divisionLines, FIELD_VALUE_LIMIT)),
    ],
    audience: 'university',
  });

  if (!info.rows.length) return roster;

  const issues = [...new Map(info.rows
    .filter((row) => row.missingRoles.length > 0 || (row.unexpectedRoles?.length ?? 0) > 0)
    .map((row) => [
      [
        row.discord_user_id,
        [...row.missingRoles].sort().join(','),
        [...(row.unexpectedRoles ?? [])].sort().join(','),
      ].join('|'),
      row,
    ])).values()];
  const issueField = (row) => {
    const absentMember = row.missingRoles.includes('member not in server');
    const position = row.role === BOARD_ROLES.HEAD
      ? `Head of ${safeText(divisionLabel(row.division_name, row.division_color), 'unknown division')}`
      : safeText(boardRoleLabel(row.role));
    return infoField(
      'Member',
      [
        userReference(row.discord_user_id, row.full_name),
        `**Board position:** ${position}`,
        `**Observed:** ${absentMember
          ? 'Member is no longer in Discord'
          : [
              ...(row.missingRoles.length ? [`Missing ${row.missingRoles.map((role) => safeText(role)).join(', ')}`] : []),
              ...(row.unexpectedRoles?.length ? [`Unexpected ${row.unexpectedRoles.map((role) => safeText(role)).join(', ')}`] : []),
            ].join(' · ')}`,
        `**Recovery:** ${absentMember ? 'Confirm membership, then update the board.' : 'Open `/board-update` and save the roster again.'}`,
      ].join('\n'),
    );
  };
  if (!issues.length) return roster;

  const health = renderEventCard({
    kind: 'event-card',
    tone: 'warning',
    title: `Discord consistency · ${issues.length} ${issues.length === 1 ? 'issue' : 'issues'}`,
    description: 'The canonical board assignments are valid; these Discord access problems need recovery.',
    subject: issueField(issues[0]),
    details: issues.slice(1).map(issueField),
    footer: 'Discord check · Roster was not changed',
    audience: 'university',
  });
  return {
    ...roster,
    embeds: [...(roster.embeds ?? []), ...(health.embeds ?? [])],
  };
}

function boardAccessLabel(result) {
  if (result.role === BOARD_ROLES.HEAD) {
    return result.division ? `Head of ${result.division.name}` : 'All division Head roles';
  }
  return boardRoleLabel(result.role);
}

function boardAccessScope(result) {
  return result.division
    ? `${result.university.name} › ${result.division.name}`
    : result.university.name;
}

export function formatBoardAssignmentHandoff(result) {
  return renderHandoffMessage({
    kind: 'handoff-message',
    tone: 'success',
    title: 'Your BAINSA board access changed',
    context: 'A board role was assigned to you.',
    sections: [
      { heading: 'Role', body: boardAccessLabel(result) },
      { heading: 'Scope', body: boardAccessScope(result) },
    ],
    nextActions: ['Open the university board space and run `/guide` to see the commands available to your new role.'],
    provenance: 'BAINSA governance · Access handoff',
    audience: 'member',
  });
}

export function formatBoardRemovalHandoff(result, reason = null) {
  return renderHandoffMessage({
    kind: 'handoff-message',
    tone: 'changed',
    title: 'Your BAINSA board access changed',
    context: 'A board role was removed. Your base BAINSA membership remains unchanged.',
    sections: [
      { heading: 'Role removed', body: boardAccessLabel(result) },
      { heading: 'Scope', body: boardAccessScope(result) },
      ...(reason ? [{ heading: 'Reason shared by the board', body: safeText(reason) }] : []),
    ],
    nextActions: ['Run `/guide` in a board command channel to see the commands still available to you.'],
    provenance: 'BAINSA governance · Access handoff',
    audience: 'member',
  });
}

export function formatBoardUpdateHandoff(result, change) {
  const before = change.before?.length ? change.before.join(', ') : 'No board role';
  const after = change.after?.length ? change.after.join(', ') : 'No board role';
  return renderHandoffMessage({
    kind: 'handoff-message',
    tone: 'changed',
    title: 'Your BAINSA board access changed',
    context: `The ${result.university.name} board roster was updated.`,
    sections: [
      { heading: 'Board roles', body: before === after ? after : `${before} → ${after}` },
      { heading: 'University', body: result.university.name },
    ],
    nextActions: ['Run `/guide` in the university board space to see the commands available to your current role.'],
    provenance: 'BAINSA governance · Board update',
    audience: 'member',
  });
}

export function formatDivisionMemberHandoff(result, { removed = false, reason = null } = {}) {
  return renderHandoffMessage({
    kind: 'handoff-message',
    tone: removed ? 'changed' : 'success',
    title: 'Your BAINSA division access changed',
    context: removed
      ? 'A division membership was removed. Your university membership remains unchanged.'
      : 'A division membership was added to your BAINSA access.',
    sections: [
      { heading: removed ? 'Division removed' : 'Division added', body: result.division.name },
      { heading: 'University', body: result.university.name },
      ...(removed && reason ? [{ heading: 'Reason shared by the board', body: safeText(reason) }] : []),
    ],
    nextActions: removed
      ? ['Run `/guide` in a board command channel if you still hold board access.']
      : ['Open the division space and review its current work before contributing.'],
    provenance: 'BAINSA governance · Access handoff',
    audience: 'member',
  });
}
