import {
  divisionLabel,
  PROJECT_PERSON_ROLES,
  PROJECT_STATUSES,
} from '../../constants.js';
import {
  channelReference,
  escapeUserText,
  interactionOutcome,
  renderEventCard,
  renderHandoffMessage,
  renderInteractionPanel,
  renderWorkspaceDocument,
} from '../../messages/index.js';

const DISCORD_AUTOCOMPLETE_CHOICE_LIMIT = 100;
const PEOPLE_LINE_LIMIT = 400;
const EMBED_FIELD_LIMIT = 1_024;

export function projectStatusLabel(status) {
  const normalized = String(status ?? '').trim().toLowerCase();
  if (!normalized) return 'Unknown';
  return normalized
    .split(/[_\s-]+/)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(' ');
}

function truncateChoicePart(value, maxLength) {
  const text = String(value ?? '').trim();
  if (text.length <= maxLength) return text;
  if (maxLength <= 1) return '…'.slice(0, maxLength);
  return `${text.slice(0, maxLength - 1).trimEnd()}…`;
}

export function projectAutocompleteName(project) {
  const prefix = `#${project.id} `;
  const context = ` • ${project.university_name}, ${divisionLabel(project.division_name, project.division_color)}`;
  const status = ` • ${projectStatusLabel(project.status)}`;
  const projectName = truncateChoicePart(
    project.name,
    Math.max(1, DISCORD_AUTOCOMPLETE_CHOICE_LIMIT - prefix.length - context.length - status.length),
  );
  const complete = `${prefix}${projectName}${context}${status}`;
  if (complete.length <= DISCORD_AUTOCOMPLETE_CHOICE_LIMIT) return complete;

  // University and division names are user-controlled. Keep the ID, project
  // name, and state visible even if the scope itself is unusually long.
  const scope = truncateChoicePart(
    context.slice(3),
    Math.max(1, DISCORD_AUTOCOMPLETE_CHOICE_LIMIT - prefix.length - projectName.length - status.length - 3),
  );
  return `${prefix}${projectName} • ${scope}${status}`.slice(0, DISCORD_AUTOCOMPLETE_CHOICE_LIMIT);
}

export function projectAutocompleteChoice(project) {
  return {
    name: projectAutocompleteName(project),
    value: String(project.id),
  };
}

export function formatPeopleLine(
  people,
  role,
  maxLength = PEOPLE_LINE_LIMIT,
  formatPerson = (person) => `<@${person.discord_user_id}>`,
) {
  const references = people.filter((person) => person.role === role).map(formatPerson);
  if (!references.length) return 'None yet';

  const rendered = [];
  for (let index = 0; index < references.length; index += 1) {
    const remaining = references.length - index - 1;
    const suffix = remaining > 0 ? `, … (+${remaining} more)` : '';
    const candidate = [...rendered, references[index]].join(', ');
    if (`${candidate}${suffix}`.length > maxLength) {
      return `${rendered.join(', ')}, … (+${references.length - index} more)`;
    }
    rendered.push(references[index]);
  }
  return rendered.join(', ');
}

function projectTimeline(project) {
  return `${project.start_date} → ${project.expected_end}`;
}

function projectText(value, fallback = 'Not provided') {
  return escapeUserText(value, fallback);
}

function embedFieldValue(value) {
  const text = String(value ?? '').trim();
  if (text.length <= EMBED_FIELD_LIMIT) return text;
  return `${text.slice(0, EMBED_FIELD_LIMIT - 1).trimEnd()}…`;
}

function projectHomeMarker(project) {
  return `Project #${project.id} · Pinned project record · Updates automatically`;
}

function projectMetadata(project, { includeLinks = true } = {}) {
  const rows = [
    { label: 'University', value: projectText(project.university_name) },
    { label: 'Status', value: projectStatusLabel(project.status) },
    { label: 'Division', value: projectText(divisionLabel(project.division_name, project.division_color)) },
    { label: 'Timeline', value: projectTimeline(project) },
  ];
  if (includeLinks) {
    rows.push(
      { label: 'Workspace', value: channelReference(project.discord_channel_id) },
      { label: 'Shareable record', value: channelReference(project.showcase_thread_id, 'Pending') },
    );
  }
  return rows;
}

export function projectTeamSummaryLines(people) {
  const team = [
    `**Members:** ${formatPeopleLine(people, PROJECT_PERSON_ROLES.MEMBER, PEOPLE_LINE_LIMIT)}`,
    `**Supervisors:** ${formatPeopleLine(people, PROJECT_PERSON_ROLES.SUPERVISOR, PEOPLE_LINE_LIMIT)}`,
  ];
  const boardLiaisons = people.filter((person) => person.role === PROJECT_PERSON_ROLES.BOARD_LIAISON);
  if (boardLiaisons.length > 0) {
    team.push(`**Board liaisons:** ${formatPeopleLine(people, PROJECT_PERSON_ROLES.BOARD_LIAISON, PEOPLE_LINE_LIMIT)}`);
  }
  return team;
}

function privateProjectSections(project, people) {
  const sections = [
    {
      heading: 'Summary',
      body: projectText(project.summary, 'No public project summary has been added yet.').slice(0, 1_024),
    },
    { heading: 'Team', body: projectTeamSummaryLines(people) },
  ];
  if (project.notes) sections.push({ heading: 'Internal working notes', body: projectText(embedFieldValue(project.notes)) });
  if (project.outcome) sections.push({ heading: 'Conclusion', body: projectText(embedFieldValue(project.outcome)) });
  if (project.final_notes) sections.push({ heading: 'Internal handover notes', body: projectText(embedFieldValue(project.final_notes)) });
  return sections;
}

export function projectRecordSummary(project, people, { includeLinks = true } = {}) {
  return {
    title: projectText(project.name, 'Unnamed project'),
    metadata: projectMetadata(project, { includeLinks }),
    sections: privateProjectSections(project, people),
  };
}

export function projectHomePayload(project, people) {
  const record = projectRecordSummary(project, people);
  return renderWorkspaceDocument({
    kind: 'workspace-document',
    ...record,
    provenance: projectHomeMarker(project),
    audience: 'workspace',
  });
}

export function projectWorkspaceGuidePayload(project) {
  const closed = project.status === PROJECT_STATUSES.COMPLETED || project.status === PROJECT_STATUSES.ARCHIVED;
  return renderWorkspaceDocument({
    kind: 'workspace-document',
    title: 'How to use this space',
    sections: closed
      ? [{ body: 'This workspace preserves the project history. Members can read it; supervisors and scoped board retain handover access.' }]
      : [
          { body: 'Keep discussion, drafts, decisions, and internal files in this private workspace.' },
          {
            heading: 'Everyone',
            body: 'Run `/project-info` for the current project record, then use this channel for day-to-day work.',
          },
          {
            heading: 'Supervisors & scoped board',
            body: 'Run project commands here to update the project, manage participants, or close it. The project is selected automatically.',
          },
          { body: 'Use the showcase post for shareable progress, materials, questions, and expressions of interest.' },
        ],
    provenance: `Project #${project.id} · Pinned workspace guide`,
    audience: 'workspace',
  });
}

export function showcasePostPayload(project, people) {
  const completed = project.status === PROJECT_STATUSES.COMPLETED || project.status === PROJECT_STATUSES.ARCHIVED;
  const sections = [
    {
      heading: 'Summary',
      body: projectText(project.summary, 'The project team has not added a public summary yet.').slice(0, 1_024),
    },
    {
      heading: 'Contributors',
      body: formatPeopleLine(people, PROJECT_PERSON_ROLES.MEMBER, EMBED_FIELD_LIMIT),
    },
    {
      heading: 'Supervisors',
      body: formatPeopleLine(people, PROJECT_PERSON_ROLES.SUPERVISOR, EMBED_FIELD_LIMIT),
    },
  ];
  if (project.outcome) sections.push({ heading: 'Conclusion', body: projectText(embedFieldValue(project.outcome)) });
  sections.push({
    heading: completed ? 'Project record' : 'Follow or contribute',
    body: completed
      ? 'This project is complete. Its shareable materials and discussion remain below; internal handover notes stay private in the project workspace.'
      : 'Project members can share progress and files below. Interested Researchers can reply with a relevant question or contribution idea, or contact a supervisor.',
  });
  return renderWorkspaceDocument({
    kind: 'workspace-document',
    title: projectText(project.name, 'Unnamed project'),
    metadata: projectMetadata(project, { includeLinks: false }),
    sections,
    provenance: `BAINSA ${project.university_name} · Project #${project.id} · Shareable project record`,
    audience: 'university',
  });
}

export function projectInfoMessage(project, people) {
  const record = projectRecordSummary(project, people);
  return renderWorkspaceDocument({
    kind: 'workspace-document',
    ...record,
    provenance: `Project #${project.id} · Private project record`,
    audience: 'actor',
  });
}

export function projectTransitionPayload({ project, title, summary, detail = null, color = null }) {
  return renderEventCard({
    kind: 'event-card',
    tone: color === 0x27AE60 ? 'success' : 'changed',
    title,
    subject: { label: 'Project', value: projectText(project.name, 'Unnamed project') },
    scope: `${projectText(project.university_name)} › ${projectText(project.division_name)}`,
    details: detail ? [{ label: 'What this means', value: detail }] : [],
    result: { label: 'Result', value: summary },
    discordState: 'The pinned project record is up to date.',
    footer: `Project #${project.id}`,
    audience: 'workspace',
  });
}

export function projectAssignmentMessage(guildId, project, role, previousRole = null) {
  const workspaceUrl = project.discord_channel_id
    ? `https://discord.com/channels/${guildId}/${project.discord_channel_id}`
    : null;
  const showcaseUrl = project.showcase_thread_id
    ? `https://discord.com/channels/${guildId}/${project.showcase_thread_id}`
    : null;
  const roleLabel = projectStatusLabel(role);
  const safeProjectName = projectText(project.name, 'this project');
  const title = previousRole ? `Your role on ${safeProjectName} changed` : `You joined ${safeProjectName}`;
  const roleLine = previousRole
    ? `${projectStatusLabel(previousRole)} → ${roleLabel}`
    : roleLabel;
  const nextStep = role === PROJECT_PERSON_ROLES.SUPERVISOR
    ? 'Read the two pinned messages, welcome the team, and use project commands in the workspace to keep the record current.'
    : 'Read the two pinned messages, introduce yourself, and follow the latest discussion, files, and decisions.';
  return renderHandoffMessage({
    kind: 'handoff-message',
    tone: previousRole ? 'changed' : 'success',
    title,
    context: `${projectText(project.university_name)} · ${projectText(divisionLabel(project.division_name, project.division_color))}`,
    sections: [{ heading: 'Role', body: roleLine }],
    nextActions: [
      workspaceUrl ? 'Open the project workspace.' : 'Wait for the project workspace to finish provisioning.',
      'Read the pinned project record and workspace guide.',
      nextStep,
    ],
    links: [
      ...(workspaceUrl ? [{ label: 'Open workspace', url: workspaceUrl }] : []),
      ...(showcaseUrl ? [{ label: 'View shareable record', url: showcaseUrl }] : []),
    ],
    fallback: workspaceUrl ? null : 'If the workspace does not appear shortly, contact a project supervisor.',
    provenance: `Project #${project.id} · Access handoff`,
    audience: 'member',
  });
}

export function projectRemovalMessage(guildId, project, reason = null) {
  const showcaseUrl = project.showcase_thread_id
    ? `https://discord.com/channels/${guildId}/${project.showcase_thread_id}`
    : null;
  return renderHandoffMessage({
    kind: 'handoff-message',
    tone: 'changed',
    title: `Your access to ${projectText(project.name, 'this project')} changed`,
    context: `You are no longer assigned to this ${projectText(project.university_name)} project.`,
    sections: reason ? [{ heading: 'Reason shared by the supervisor or board', body: projectText(reason) }] : [],
    links: showcaseUrl ? [{ label: 'View the shareable project record', url: showcaseUrl }] : [],
    provenance: `Project #${project.id} · Access handoff`,
    audience: 'member',
  });
}

export function projectSuccessMessage(action, project) {
  const channel = project.discord_channel_id ? ` <#${project.discord_channel_id}>` : '';
  const pending = project.reconciliation_pending ? ' Discord reconciliation is in progress.' : '';
  return renderInteractionPanel(interactionOutcome({
    outcome: project.reconciliation_pending ? 'reconciliation-pending' : 'success',
    title: project.reconciliation_pending ? 'Project saved; Discord is catching up' : 'Project saved',
    description: `${action} **${projectText(project.name, 'this project')}** (#${project.id}).${channel}${pending}`,
  }));
}
