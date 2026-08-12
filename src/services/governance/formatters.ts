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

function inlineFieldSpacer() {
  return { label: '\u200b', value: '\u200b', inline: true };
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
      // Discord lays out inline fields in three columns. Reserve the final
      // column so identity sits together above university membership.
      inlineFieldSpacer(),
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

function discordChannelUrl(guildId, channelId) {
  return guildId && channelId ? `https://discord.com/channels/${guildId}/${channelId}` : null;
}

function boardResponsibility(roleLabel) {
  if (roleLabel.startsWith('Head of ')) {
    return 'Guide the division’s priorities, orient members, and keep project access aligned with active work.';
  }
  if (roleLabel === 'President') {
    return 'Steward the university board, confirm authority changes, and keep governance records aligned with Discord access.';
  }
  return 'Coordinate university operations, support division leadership, and help recover access when a workflow cannot complete.';
}

function handoffLinks(guildId, entries) {
  return entries
    .map(({ label, channelId }) => {
      const url = discordChannelUrl(guildId, channelId);
      return url ? { label, url } : null;
    })
    .filter(Boolean);
}

export function formatMemberAccessHandoff(result) {
  const beforeDivisions = result.previousDivisions?.map((division) => safeText(division.name)) ?? [];
  const afterDivisions = result.divisions?.map((division) => safeText(division.name)) ?? [];
  const beforeType = result.previousRecord?.member_type
    ? memberTypeLabel(result.previousRecord.member_type)
    : 'Not recorded';
  const afterType = memberTypeLabel(result.memberType);
  const beforeUniversity = result.previousRecord?.university_name ?? 'Not recorded';
  const changes = [
    beforeType !== afterType ? `Member type: ${beforeType} → ${afterType}` : null,
    beforeUniversity !== result.university.name
      ? `University: ${safeText(beforeUniversity)} → ${safeText(result.university.name)}`
      : null,
    JSON.stringify([...beforeDivisions].sort()) !== JSON.stringify([...afterDivisions].sort())
      ? `Divisions: ${beforeDivisions.join(', ') || 'None'} → ${afterDivisions.join(', ') || 'None'}`
      : null,
  ].filter(Boolean);
  const links = handoffLinks(result.guildId, result.divisions.map((division) => ({
    label: `Open ${division.name}`,
    channelId: division.text_channel_id,
  })));
  return renderHandoffMessage({
    kind: 'handoff-message',
    tone: 'changed',
    title: 'Your BAINSA membership access changed',
    statusLabel: 'Membership scope updated',
    context: `Your current membership is ${afterType} at ${safeText(result.university.name)}.`,
    sections: [
      { heading: 'What changed', body: changes.join('\n') || 'Your recorded access was refreshed.' },
      { heading: 'Spaces available now', body: afterDivisions.join(', ') || 'University-wide member spaces only' },
      { heading: 'What remains', body: 'Your active project assignments and board responsibilities were preserved unless a separate handoff says otherwise.' },
    ],
    nextActions: ['Open a space available to you and run `/guide` to see the commands for your current access.'],
    links,
    fallback: 'If a space listed here is missing, contact your university board through a channel you can still access.',
    provenance: 'BAINSA governance · Membership access handoff',
    audience: 'member',
  });
}

export function formatMemberRemovalHandoff(result, { shareableReason = null } = {}) {
  const removedScopes = [
    ...(result.divisions ?? []).map((division) => `${safeText(division.name)} division`),
    ...(result.boardRoles ?? []).map((role) => role.role === BOARD_ROLES.HEAD
      ? `Head of ${safeText(role.division_name, 'a division')}`
      : boardRoleLabel(role.role)),
    ...(result.projects ?? []).map((project) => `${safeText(project.name)} project`),
  ];
  return renderHandoffMessage({
    kind: 'handoff-message',
    tone: 'danger',
    title: 'Your BAINSA membership access ended',
    statusLabel: 'Server membership removed',
    context: `Your membership at ${safeText(result.universityName)} was removed. You will no longer be able to use BAINSA server spaces.`,
    sections: [
      { heading: 'Access removed', body: removedScopes.length ? removedScopes.join(', ') : 'BAINSA member spaces' },
      ...(shareableReason ? [{ heading: 'Explanation shared with you', body: safeText(shareableReason) }] : []),
      { heading: 'What remains private', body: 'Internal board notes and any non-shareable review details are not included in this message.' },
    ],
    nextActions: ['Save any personal records you already hold outside Discord; server content may no longer be available.'],
    fallback: 'If you believe this was a mistake or need clarification, contact the BAINSA university board through your existing external contact route.',
    provenance: 'BAINSA governance · Membership removal handoff',
    audience: 'member',
  });
}

export function formatDivisionHeadHandoff(result) {
  const links = handoffLinks(result.guildId, [
    { label: 'Open division workspace', channelId: result.textChannel?.id },
    { label: 'Open university board', channelId: result.university.board_channel_id },
  ]);
  return renderHandoffMessage({
    kind: 'handoff-message',
    tone: 'success',
    title: `You are now Head of ${safeText(result.divisionName)}`,
    statusLabel: 'Board authority assigned',
    context: `${safeText(result.university.name)} › ${safeText(result.divisionName)}`,
    sections: [
      { heading: 'Spaces available now', body: links.length ? 'Your division workspace and university board space are available.' : 'Your division and university board access is being provisioned.' },
      { heading: 'Responsibility', body: boardResponsibility(`Head of ${result.divisionName}`) },
    ],
    nextActions: [
      'Open the division workspace and review its current guidance.',
      'Run `/guide` in the university board space to see your governance commands.',
    ],
    links,
    fallback: 'If either space is missing, contact the university President or Vice President.',
    provenance: 'BAINSA governance · Initial Head handoff',
    audience: 'member',
  });
}

export function formatBoardAssignmentHandoff(result) {
  const roleLabel = boardAccessLabel(result);
  const boardUrl = discordChannelUrl(result.guildId, result.university.board_channel_id);
  return renderHandoffMessage({
    kind: 'handoff-message',
    tone: 'success',
    title: `You are now ${safeText(roleLabel)}`,
    statusLabel: 'Board authority assigned',
    context: `Your authority applies to ${safeText(boardAccessScope(result))}.`,
    sections: [
      { heading: 'Role', body: safeText(roleLabel) },
      { heading: 'Scope', body: safeText(boardAccessScope(result)) },
      { heading: 'Responsibility', body: boardResponsibility(roleLabel) },
    ],
    nextActions: ['Open the university board space and run `/guide` to see the commands available to your new role.'],
    links: boardUrl ? [{ label: 'Open university board', url: boardUrl }] : [],
    fallback: 'If the board space is missing, contact the university President or a Global President.',
    provenance: 'BAINSA governance · Access handoff',
    audience: 'member',
  });
}

export function formatBoardRemovalHandoff(result, reason = null) {
  return renderHandoffMessage({
    kind: 'handoff-message',
    tone: 'danger',
    title: 'Your BAINSA board authority changed',
    statusLabel: 'Board authority removed',
    context: 'A board role was removed. Your base BAINSA membership remains unchanged.',
    sections: [
      { heading: 'Role removed', body: safeText(boardAccessLabel(result)) },
      { heading: 'Scope', body: safeText(boardAccessScope(result)) },
      ...(reason ? [{ heading: 'Reason shared by the board', body: safeText(reason) }] : []),
    ],
    nextActions: result.remainingRoles?.length
      ? ['Open the university board space and run `/guide` to review the commands available to your remaining role.']
      : ['Continue using the member and division spaces that remain available to you.'],
    links: result.remainingRoles?.length && result.university.board_channel_id
      ? [{ label: 'Open university board', url: discordChannelUrl(result.guildId, result.university.board_channel_id) }]
      : [],
    fallback: 'If this change is unexpected, contact the university board through a space you still share.',
    provenance: 'BAINSA governance · Access handoff',
    audience: 'member',
  });
}

export function formatBoardUpdateHandoff(result, change) {
  const before = change.before?.length ? change.before.map((role) => safeText(role)).join(', ') : 'No board role';
  const after = change.after?.length ? change.after.map((role) => safeText(role)).join(', ') : 'No board role';
  const added = change.after?.filter((role) => !change.before?.includes(role)).map((role) => safeText(role)) ?? [];
  const assigned = added.length > 0;
  const fullyRemoved = after === 'No board role';
  const links = handoffLinks(result.guildId, [
    ...((change.nextRoles ?? []).filter((role) => role.role === BOARD_ROLES.HEAD).map((role) => ({
      label: `Open ${role.division_name}`,
      channelId: result.divisions?.find((division) => String(division.id) === String(role.division_id))?.text_channel_id,
    }))),
    { label: 'Open university board', channelId: fullyRemoved ? null : result.university.board_channel_id },
  ]);
  return renderHandoffMessage({
    kind: 'handoff-message',
    tone: fullyRemoved ? 'danger' : assigned ? 'success' : 'changed',
    title: fullyRemoved ? 'Your BAINSA board authority ended' : 'Your BAINSA board authority changed',
    statusLabel: fullyRemoved ? 'Board authority removed' : assigned ? 'Board authority assigned' : 'Board authority updated',
    context: `The ${safeText(result.university.name)} board roster was updated.`,
    sections: [
      { heading: 'Board roles', body: before === after ? after : `${before} → ${after}` },
      { heading: 'University', body: safeText(result.university.name) },
      ...(added.length ? [{ heading: 'Responsibility added', body: added.map(boardResponsibility).join('\n') }] : []),
      { heading: 'What remains', body: fullyRemoved
        ? 'Your base BAINSA membership and eligible member spaces remain unchanged.'
        : `You retain ${after}.` },
    ],
    nextActions: fullyRemoved
      ? ['Continue using the member and division spaces available to your base membership.']
      : ['Open the university board space and run `/guide` to see the commands available to your current authority.'],
    links,
    fallback: fullyRemoved
      ? 'If this change is unexpected, contact the university board through a space you still share.'
      : 'If a newly available space is missing, contact the university President or a Global President.',
    provenance: 'BAINSA governance · Board update',
    audience: 'member',
  });
}

export function formatDivisionMemberHandoff(result, { removed = false, reason = null } = {}) {
  return renderHandoffMessage({
    kind: 'handoff-message',
    tone: removed ? 'danger' : 'success',
    title: 'Your BAINSA division access changed',
    statusLabel: removed ? 'Division access removed' : 'Division access added',
    context: removed
      ? 'A division membership was removed. Your university membership remains unchanged.'
      : 'A division membership was added to your BAINSA access.',
    sections: [
      { heading: removed ? 'Division removed' : 'Division added', body: safeText(result.division.name) },
      { heading: 'University', body: safeText(result.university.name) },
      ...(removed && reason ? [{ heading: 'Reason shared by the board', body: safeText(reason) }] : []),
    ],
    nextActions: removed
      ? ['Continue in the university and division spaces that remain available to you.']
      : ['Open the division space and review its current work before contributing.'],
    links: !removed && result.division.text_channel_id
      ? [{ label: 'Open division workspace', url: discordChannelUrl(result.guildId, result.division.text_channel_id) }]
      : [],
    fallback: removed
      ? 'If this change is unexpected, contact the university board through a space you still share.'
      : 'If the division space is missing, contact the division Head or university board.',
    provenance: 'BAINSA governance · Access handoff',
    audience: 'member',
  });
}
