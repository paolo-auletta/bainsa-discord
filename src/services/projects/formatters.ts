import { EmbedBuilder } from 'discord.js';

import {
  divisionColorDetails,
  divisionLabel,
  PROJECT_PERSON_ROLES,
  PROJECT_STATUSES,
} from '../../constants.js';

const DISCORD_MESSAGE_LIMIT = 2_000;
const DISCORD_AUTOCOMPLETE_CHOICE_LIMIT = 100;
const PEOPLE_LINE_LIMIT = 400;
const EMBED_FIELD_LIMIT = 1_024;

const STATUS_COLORS = Object.freeze({
  [PROJECT_STATUSES.ACTIVE]: 0x2F80ED,
  [PROJECT_STATUSES.PAUSED]: 0xF2994A,
  [PROJECT_STATUSES.COMPLETED]: 0x27AE60,
  [PROJECT_STATUSES.ARCHIVED]: 0x7A7A7A,
});

function truncateMessage(message) {
  if (message.length <= DISCORD_MESSAGE_LIMIT) return message;
  return `${message.slice(0, DISCORD_MESSAGE_LIMIT - 1).trimEnd()}…`;
}

function formatMessage(lines) {
  return truncateMessage(lines.filter(Boolean).join('\n'));
}

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

function projectColor(project) {
  const divisionColor = divisionColorDetails(project.division_color)?.hex;
  return divisionColor ? Number.parseInt(divisionColor.slice(1), 16) : (STATUS_COLORS[project.status] ?? 0x2F80ED);
}

function projectTimeline(project) {
  return `${project.start_date} → ${project.expected_end}`;
}

function embedFieldValue(value) {
  const text = String(value ?? '').trim();
  if (text.length <= EMBED_FIELD_LIMIT) return text;
  return `${text.slice(0, EMBED_FIELD_LIMIT - 1).trimEnd()}…`;
}

function projectTeamFields(people) {
  const fields = [
    {
      name: 'Members',
      value: formatPeopleLine(people, PROJECT_PERSON_ROLES.MEMBER, PEOPLE_LINE_LIMIT),
    },
    {
      name: 'Supervisors',
      value: formatPeopleLine(people, PROJECT_PERSON_ROLES.SUPERVISOR, PEOPLE_LINE_LIMIT),
    },
  ];
  const boardLiaisons = people.filter((person) => person.role === PROJECT_PERSON_ROLES.BOARD_LIAISON);
  if (boardLiaisons.length > 0) {
    fields.push({
      name: 'Board liaisons',
      value: formatPeopleLine(people, PROJECT_PERSON_ROLES.BOARD_LIAISON, PEOPLE_LINE_LIMIT),
    });
  }
  return fields;
}

function projectWorkspaceGuidance(project) {
  if (project.status === PROJECT_STATUSES.COMPLETED || project.status === PROJECT_STATUSES.ARCHIVED) {
    return 'This workspace preserves the project history. Members can read it; supervisors and scoped board retain handover access.';
  }
  return [
    'Keep discussion, drafts, decisions, and internal files in this channel.',
    'Members can run `/project-info`. Supervisors can also update the project, manage participants, and close it here; the project is selected automatically.',
    'Use the showcase post for shareable progress, materials, questions, and expressions of interest.',
  ].join('\n');
}

export function projectHomePayload(project, people) {
  const embed = new EmbedBuilder()
    .setColor(projectColor(project))
    .setTitle(project.name)
    .setDescription(String(project.summary || 'No public project summary has been added yet.').slice(0, 4_096))
    .addFields(
      { name: 'Status', value: projectStatusLabel(project.status), inline: true },
      { name: 'Division', value: divisionLabel(project.division_name, project.division_color), inline: true },
      { name: 'Timeline', value: projectTimeline(project), inline: false },
      ...projectTeamFields(people),
    );

  if (project.notes) embed.addFields({ name: 'Internal working notes', value: embedFieldValue(project.notes) });
  if (project.outcome) embed.addFields({ name: 'Conclusion', value: embedFieldValue(project.outcome) });
  if (project.final_notes) embed.addFields({ name: 'Internal handover notes', value: embedFieldValue(project.final_notes) });
  embed
    .addFields({ name: 'How to use this space', value: projectWorkspaceGuidance(project) })
    .setFooter({ text: `Project #${project.id} · This pinned overview updates automatically` });

  return {
    content: `-# Project #${project.id} · ${project.university_name} project workspace`,
    embeds: [embed],
  };
}

export function showcasePostPayload(project, people) {
  const completed = project.status === PROJECT_STATUSES.COMPLETED || project.status === PROJECT_STATUSES.ARCHIVED;
  const embed = new EmbedBuilder()
    .setColor(projectColor(project))
    .setTitle(project.name)
    .setDescription(String(project.summary || 'The project team has not added a public summary yet.').slice(0, 4_096))
    .addFields(
      { name: 'Status', value: projectStatusLabel(project.status), inline: true },
      { name: 'Division', value: divisionLabel(project.division_name, project.division_color), inline: true },
      { name: 'Timeline', value: projectTimeline(project), inline: false },
      {
        name: 'Contributors',
        value: formatPeopleLine(people, PROJECT_PERSON_ROLES.MEMBER, EMBED_FIELD_LIMIT),
      },
      {
        name: 'Supervisors',
        value: formatPeopleLine(people, PROJECT_PERSON_ROLES.SUPERVISOR, EMBED_FIELD_LIMIT),
      },
    );

  if (project.outcome) embed.addFields({ name: 'Conclusion', value: embedFieldValue(project.outcome) });
  embed
    .addFields({
      name: completed ? 'Project record' : 'Follow or contribute',
      value: completed
        ? 'This project is complete. Its shareable materials and discussion remain below; internal handover notes stay private in the project workspace.'
        : 'Project members can share progress and files below. Interested Researchers can reply with a relevant question or contribution idea, or contact a supervisor.',
    })
    .setFooter({ text: `BAINSA ${project.university_name} · Project #${project.id}` });

  return {
    content: `-# BAINSA ${project.university_name} project record`,
    embeds: [embed],
  };
}

export function projectInfoMessage(project, people) {
  const channel = project.discord_channel_id ? `<#${project.discord_channel_id}>` : 'Not provisioned';
  const showcase = project.showcase_thread_id ? `<#${project.showcase_thread_id}>` : 'Pending';
  const payload = projectHomePayload(project, people);
  const embed = EmbedBuilder.from(payload.embeds[0])
    .setFooter({ text: `Project #${project.id} · Private project record` })
    .addFields(
      { name: 'Workspace', value: channel, inline: true },
      { name: 'Showcase', value: showcase, inline: true },
    );
  return { embeds: [embed] };
}

export function projectTransitionPayload({ project, title, summary, detail = null, color = null }) {
  const embed = new EmbedBuilder()
    .setColor(color ?? projectColor(project))
    .setTitle(title)
    .setDescription(summary)
    .setFooter({ text: `Project #${project.id} · The pinned overview is up to date` });
  if (detail) embed.addFields({ name: 'What this means', value: detail });
  return { embeds: [embed] };
}

export function projectAssignmentMessage(guildId, project, role, previousRole = null) {
  const workspaceUrl = project.discord_channel_id
    ? `https://discord.com/channels/${guildId}/${project.discord_channel_id}`
    : null;
  const showcaseUrl = project.showcase_thread_id
    ? `https://discord.com/channels/${guildId}/${project.showcase_thread_id}`
    : null;
  const roleLabel = projectStatusLabel(role);
  const roleLine = previousRole
    ? `Your project role changed from **${projectStatusLabel(previousRole)}** to **${roleLabel}**.`
    : `You joined as **${roleLabel}**.`;
  const nextStep = role === PROJECT_PERSON_ROLES.SUPERVISOR
    ? 'Read the pinned project overview, welcome the team, and use the project-scoped commands in the workspace to keep the record current.'
    : 'Read the pinned project overview, introduce yourself, and check the latest discussion, files, and decisions.';
  return formatMessage([
    `**You joined ${project.name}**`,
    `${project.university_name} · ${divisionLabel(project.division_name, project.division_color)}`,
    roleLine,
    '',
    `**Start here** · ${nextStep}`,
    workspaceUrl ? `Project workspace: ${workspaceUrl}` : null,
    showcaseUrl ? `Shareable project record: ${showcaseUrl}` : null,
  ]);
}

export function projectRemovalMessage(guildId, project, reason = null) {
  const showcaseUrl = project.showcase_thread_id
    ? `https://discord.com/channels/${guildId}/${project.showcase_thread_id}`
    : null;
  return formatMessage([
    `**Your access to ${project.name} changed**`,
    `You are no longer assigned to this ${project.university_name} project.`,
    reason ? `**Reason shared by the supervisor or board** · ${reason}` : null,
    showcaseUrl ? `The shareable project record remains available here: ${showcaseUrl}` : null,
  ]);
}

export function projectSuccessMessage(action, project) {
  const channel = project.discord_channel_id ? ` <#${project.discord_channel_id}>` : '';
  const pending = project.reconciliation_pending ? ' Discord reconciliation is in progress.' : '';
  return `${action} **${project.name}** (#${project.id}).${channel}${pending}`;
}
