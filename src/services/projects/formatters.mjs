import { divisionLabel, PROJECT_PERSON_ROLES } from '../../constants.mjs';

export function formatPeopleLine(people, role) {
  const ids = people.filter((person) => person.role === role).map((person) => `<@${person.discord_user_id}>`);
  return ids.length ? ids.join(', ') : 'None yet';
}

export function formatProjectIntro(project, people, extra = '') {
  return [
    `# ${project.name}`,
    `**University:** ${project.university_name}`,
    `**Division:** ${divisionLabel(project.division_name, project.division_color)}`,
    `**Status:** ${project.status}`,
    `**Timeline:** ${project.start_date} -> ${project.expected_end}`,
    `**Members:** ${formatPeopleLine(people, PROJECT_PERSON_ROLES.MEMBER)}`,
    `**Supervisors:** ${formatPeopleLine(people, PROJECT_PERSON_ROLES.SUPERVISOR)}`,
    project.notes ? `**Notes:** ${project.notes}` : null,
    extra || null,
  ].filter(Boolean).join('\n');
}

export function formatShowcasePost(project, people, extra = '') {
  return [
    `**${project.name}** is now tracked in BAINSA ${project.university_name}.`,
    `Division: **${divisionLabel(project.division_name, project.division_color)}**`,
    `Status: **${project.status}**`,
    `Expected end: **${project.expected_end}**`,
    `Supervisors: ${formatPeopleLine(people, PROJECT_PERSON_ROLES.SUPERVISOR)}`,
    extra || project.notes || null,
  ].filter(Boolean).join('\n');
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
  return [
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
  ]
    .filter(Boolean)
    .join('\n');
}

export function projectSuccessMessage(action, project) {
  const channel = project.discord_channel_id ? ` <#${project.discord_channel_id}>` : '';
  return `${action} **${project.name}** (#${project.id}).${channel}`;
}
