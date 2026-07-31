import { divisionLabel, PROJECT_PERSON_ROLES } from '../../constants.js';

const DISCORD_MESSAGE_LIMIT = 2_000;
const PEOPLE_LINE_LIMIT = 400;

function truncateMessage(message) {
  if (message.length <= DISCORD_MESSAGE_LIMIT) return message;
  return `${message.slice(0, DISCORD_MESSAGE_LIMIT - 1).trimEnd()}…`;
}

function formatMessage(lines) {
  return truncateMessage(lines.filter(Boolean).join('\n'));
}

export function formatPeopleLine(people, role, maxLength = PEOPLE_LINE_LIMIT) {
  const ids = people.filter((person) => person.role === role).map((person) => `<@${person.discord_user_id}>`);
  if (!ids.length) return 'None yet';

  const rendered = [];
  for (let index = 0; index < ids.length; index += 1) {
    const remaining = ids.length - index - 1;
    const suffix = remaining > 0 ? `, … (+${remaining} more)` : '';
    const candidate = [...rendered, ids[index]].join(', ');
    if (`${candidate}${suffix}`.length > maxLength) {
      return `${rendered.join(', ')}, … (+${ids.length - index} more)`;
    }
    rendered.push(ids[index]);
  }
  return rendered.join(', ');
}

export function formatProjectIntro(project, people, extra = '') {
  return formatMessage([
    `# ${project.name}`,
    `**University:** ${project.university_name}`,
    `**Division:** ${divisionLabel(project.division_name, project.division_color)}`,
    `**Status:** ${project.status}`,
    `**Timeline:** ${project.start_date} -> ${project.expected_end}`,
    `**Members:** ${formatPeopleLine(people, PROJECT_PERSON_ROLES.MEMBER)}`,
    `**Supervisors:** ${formatPeopleLine(people, PROJECT_PERSON_ROLES.SUPERVISOR)}`,
    project.notes ? `**Notes:** ${project.notes}` : null,
    extra || null,
  ]);
}

export function formatShowcasePost(project, people, extra = '') {
  return formatMessage([
    `**${project.name}** is now tracked in BAINSA ${project.university_name}.`,
    `Division: **${divisionLabel(project.division_name, project.division_color)}**`,
    `Status: **${project.status}**`,
    `Expected end: **${project.expected_end}**`,
    `Supervisors: ${formatPeopleLine(people, PROJECT_PERSON_ROLES.SUPERVISOR)}`,
    extra || project.notes || null,
  ]);
}

function optionValue(interaction, name, required = true) {
  return interaction.options.getString(name, required);
}

export function readProjectCreateOptions(interaction) {
  return {
    interaction,
    name: optionValue(interaction, 'name'),
    university: optionValue(interaction, 'university'),
    division: optionValue(interaction, 'division'),
    members: optionValue(interaction, 'members'),
    supervisors: optionValue(interaction, 'supervisors'),
    startDate: optionValue(interaction, 'start_date'),
    expectedEnd: optionValue(interaction, 'expected_end'),
    notes: optionValue(interaction, 'notes', false),
  };
}

export function projectInfoMessage(project, people) {
  const channel = project.discord_channel_id ? `<#${project.discord_channel_id}>` : 'Not provisioned';
  return formatMessage([
    `**${project.name}** (#${project.id})`,
    `University: **${project.university_name}**`,
    `Division: **${divisionLabel(project.division_name, project.division_color)}**`,
    `Status: **${project.status}**`,
    `Timeline: **${project.start_date}** -> **${project.expected_end}**`,
    `Channel: ${channel}`,
    `Members: ${formatPeopleLine(people, PROJECT_PERSON_ROLES.MEMBER)}`,
    `Supervisors: ${formatPeopleLine(people, PROJECT_PERSON_ROLES.SUPERVISOR)}`,
    `Board liaisons: ${formatPeopleLine(people, PROJECT_PERSON_ROLES.BOARD_LIAISON)}`,
    project.notes ? `Notes: ${project.notes}` : null,
  ]);
}

export function projectSuccessMessage(action, project) {
  const channel = project.discord_channel_id ? ` <#${project.discord_channel_id}>` : '';
  const pending = project.reconciliation_pending ? ' Discord reconciliation is in progress.' : '';
  return `${action} **${project.name}** (#${project.id}).${channel}${pending}`;
}
