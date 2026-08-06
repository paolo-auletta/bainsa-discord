import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  ModalBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  TextInputBuilder,
  TextInputStyle,
  UserSelectMenuBuilder,
} from 'discord.js';

import { divisionLabel } from '../../constants.js';

const MAX_CUSTOM_ID_LENGTH = 100;
const MAX_NATIVE_SELECTIONS = 25;
const EMBED_COLORS = Object.freeze({
  BRAND: 0x5865f2,
  READY: 0x57f287,
});

export const PROJECT_SETUP_ACTIONS = Object.freeze({
  NAME_OPEN: 'no',
  NAME_MODAL: 'nm',
  UNIVERSITY: 'uni',
  DIVISION: 'div',
  SCOPE_DONE: 'sd',
  MEMBERS: 'mem',
  SUPERVISORS: 'sup',
  PEOPLE_DONE: 'pd',
  DATES_OPEN: 'do',
  DATES_MODAL: 'dm',
  NOTES_OPEN: 'nto',
  NOTES_MODAL: 'ntm',
  REVIEW: 'rev',
  BACK_SCOPE: 'bs',
  BACK_PEOPLE: 'bp',
  BACK_DETAILS: 'bd',
  CREATE: 'crt',
  CANCEL: 'can',
});

const ACTION_VALUES = new Set<string>(Object.values(PROJECT_SETUP_ACTIONS));

export function projectSetupId(sessionId, action) {
  const customId = ['pc', sessionId, action].join(':');
  if (customId.length > MAX_CUSTOM_ID_LENGTH) {
    throw new Error(`Project setup custom id is too long: ${customId.length}`);
  }
  return customId;
}

export function parseProjectSetupId(customId) {
  const [prefix, sessionId, action, ...extra] = String(customId ?? '').split(':');
  if (prefix !== 'pc' || !sessionId || !ACTION_VALUES.has(action) || extra.length > 0) return null;
  return { sessionId, action };
}

function projectEmbed(session, step, description, ready = false) {
  return new EmbedBuilder()
    .setColor(ready ? EMBED_COLORS.READY : EMBED_COLORS.BRAND)
    .setAuthor({ name: `BAINSA · Project setup · Step ${step} of 5` })
    .setTitle(session.name || 'New project')
    .setDescription(description)
    .setFooter({ text: 'Private setup · Expires after 15 minutes of inactivity' });
}

function actionButton(
  session,
  action,
  label,
  style = ButtonStyle.Secondary,
  options: { disabled?: boolean; emoji?: string } = {},
) {
  const button = new ButtonBuilder()
    .setCustomId(projectSetupId(session.id, action))
    .setLabel(label)
    .setStyle(style)
    .setDisabled(Boolean(options.disabled));
  if (options.emoji) button.setEmoji(options.emoji);
  return button;
}

function formatPeople(ids) {
  return ids.length > 0 ? ids.map((id) => `<@${id}>`).join(', ') : 'Not selected yet';
}

function selectedScope(session) {
  if (!session.university) return 'Not selected yet';
  return session.division
    ? `${session.university} · ${divisionLabel(session.division, session.divisionColor)}`
    : `${session.university} · Choose a division`;
}

function universityMenu(session) {
  return new StringSelectMenuBuilder()
    .setCustomId(projectSetupId(session.id, PROJECT_SETUP_ACTIONS.UNIVERSITY))
    .setPlaceholder('Choose the owning university')
    .setMinValues(1)
    .setMaxValues(1)
    .addOptions(
      session.universities.map((university, index) =>
        new StringSelectMenuOptionBuilder()
          .setLabel(university.name.slice(0, 100))
          .setValue(String(index))
          .setDefault(university.name === session.university),
      ),
    );
}

function divisionMenu(session) {
  if (!session.university) {
    return new StringSelectMenuBuilder()
      .setCustomId(projectSetupId(session.id, PROJECT_SETUP_ACTIONS.DIVISION))
      .setPlaceholder('Choose a university first')
      .setDisabled(true)
      .addOptions({ label: 'University required', value: 'pending' });
  }

  return new StringSelectMenuBuilder()
    .setCustomId(projectSetupId(session.id, PROJECT_SETUP_ACTIONS.DIVISION))
    .setPlaceholder('Choose the project division')
    .setMinValues(1)
    .setMaxValues(1)
    .addOptions(
      session.divisions.map((division, index) =>
        new StringSelectMenuOptionBuilder()
          .setLabel(divisionLabel(division.name, division.color).slice(0, 100))
          .setValue(String(index))
          .setDefault(division.name === session.division),
      ),
    );
}

function userMenu(session, action, placeholder, selectedIds) {
  const menu = new UserSelectMenuBuilder()
    .setCustomId(projectSetupId(session.id, action))
    .setPlaceholder(placeholder)
    .setMinValues(1)
    .setMaxValues(MAX_NATIVE_SELECTIONS);
  if (selectedIds.length > 0) menu.setDefaultUsers(selectedIds);
  return menu;
}

export function projectNameModal(session) {
  const input = new TextInputBuilder()
    .setCustomId('project_name')
    .setLabel('Project name')
    .setPlaceholder('e.g. Market Intelligence Sprint')
    .setRequired(true)
    .setStyle(TextInputStyle.Short)
    .setMinLength(1)
    .setMaxLength(80);
  if (session.name) input.setValue(session.name);

  return new ModalBuilder()
    .setCustomId(projectSetupId(session.id, PROJECT_SETUP_ACTIONS.NAME_MODAL))
    .setTitle('Project setup · Name')
    .addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));
}

export function projectDatesModal(session) {
  const start = new TextInputBuilder()
    .setCustomId('start_date')
    .setLabel('Start date')
    .setPlaceholder('YYYY-MM-DD')
    .setRequired(true)
    .setStyle(TextInputStyle.Short)
    .setMinLength(10)
    .setMaxLength(10);
  const end = new TextInputBuilder()
    .setCustomId('expected_end')
    .setLabel('Expected end date')
    .setPlaceholder('YYYY-MM-DD')
    .setRequired(true)
    .setStyle(TextInputStyle.Short)
    .setMinLength(10)
    .setMaxLength(10);
  if (session.startDate) start.setValue(session.startDate);
  if (session.expectedEnd) end.setValue(session.expectedEnd);

  return new ModalBuilder()
    .setCustomId(projectSetupId(session.id, PROJECT_SETUP_ACTIONS.DATES_MODAL))
    .setTitle('Project setup · Timeline')
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(start),
      new ActionRowBuilder<TextInputBuilder>().addComponents(end),
    );
}

export function projectNotesModal(session) {
  const input = new TextInputBuilder()
    .setCustomId('notes')
    .setLabel('Private project notes')
    .setPlaceholder('Optional context for the project team')
    .setRequired(false)
    .setStyle(TextInputStyle.Paragraph)
    .setMaxLength(4_000);
  if (session.notes) input.setValue(session.notes);

  return new ModalBuilder()
    .setCustomId(projectSetupId(session.id, PROJECT_SETUP_ACTIONS.NOTES_MODAL))
    .setTitle('Project setup · Notes')
    .addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));
}

export function scopePayload(session) {
  const embed = projectEmbed(
    session,
    2,
    'Choose the university that owns this project, then its operating division.',
  ).addFields({ name: '🧭 Selected scope', value: selectedScope(session) });

  return {
    content: '',
    embeds: [embed],
    allowedMentions: { parse: [] },
    components: [
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(universityMenu(session)),
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(divisionMenu(session)),
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        actionButton(session, PROJECT_SETUP_ACTIONS.SCOPE_DONE, 'Continue to team', ButtonStyle.Primary, {
          emoji: '→',
          disabled: !session.division,
        }),
        actionButton(session, PROJECT_SETUP_ACTIONS.NAME_OPEN, 'Rename project'),
        actionButton(session, PROJECT_SETUP_ACTIONS.CANCEL, 'Cancel'),
      ),
    ],
  };
}

export function participantsPayload(session) {
  const embed = projectEmbed(
    session,
    3,
    'Build the initial team. Both selectors support multiple people and use Discord names and server nicknames.',
  ).addFields(
    { name: '🧭 Scope', value: selectedScope(session) },
    { name: `👥 Members · ${session.memberIds.length}`, value: formatPeople(session.memberIds) },
    { name: `🛡️ Supervisors · ${session.supervisorIds.length}`, value: formatPeople(session.supervisorIds) },
  );

  return {
    content: '',
    embeds: [embed],
    allowedMentions: { parse: [] },
    components: [
      new ActionRowBuilder<UserSelectMenuBuilder>().addComponents(
        userMenu(session, PROJECT_SETUP_ACTIONS.MEMBERS, 'Select project members', session.memberIds),
      ),
      new ActionRowBuilder<UserSelectMenuBuilder>().addComponents(
        userMenu(session, PROJECT_SETUP_ACTIONS.SUPERVISORS, 'Select project supervisors', session.supervisorIds),
      ),
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        actionButton(session, PROJECT_SETUP_ACTIONS.PEOPLE_DONE, 'Continue to details', ButtonStyle.Primary, {
          emoji: '→',
          disabled: session.memberIds.length === 0 || session.supervisorIds.length === 0,
        }),
        actionButton(session, PROJECT_SETUP_ACTIONS.BACK_SCOPE, 'Back to scope'),
        actionButton(session, PROJECT_SETUP_ACTIONS.NAME_OPEN, 'Rename'),
        actionButton(session, PROJECT_SETUP_ACTIONS.CANCEL, 'Cancel'),
      ),
    ],
  };
}

export function detailsPayload(session) {
  const timeline = session.startDate && session.expectedEnd
    ? `${session.startDate} → ${session.expectedEnd}`
    : 'Dates not set yet';
  const notes = session.notes ? session.notes.slice(0, 1_024) : 'No notes added · Optional';
  const embed = projectEmbed(
    session,
    4,
    'Set the project timeline and add optional private context before reviewing the complete setup.',
  ).addFields(
    { name: '📅 Timeline', value: timeline, inline: true },
    { name: '👥 Team', value: `${session.memberIds.length} members · ${session.supervisorIds.length} supervisors`, inline: true },
    { name: '📝 Notes', value: notes },
  );

  return {
    content: '',
    embeds: [embed],
    allowedMentions: { parse: [] },
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        actionButton(session, PROJECT_SETUP_ACTIONS.DATES_OPEN, session.startDate ? 'Edit dates' : 'Set dates', ButtonStyle.Primary, { emoji: '📅' }),
        actionButton(session, PROJECT_SETUP_ACTIONS.NOTES_OPEN, session.notes ? 'Edit notes' : 'Add notes', ButtonStyle.Secondary, { emoji: '📝' }),
        actionButton(session, PROJECT_SETUP_ACTIONS.REVIEW, 'Review project', ButtonStyle.Success, {
          disabled: !session.startDate || !session.expectedEnd,
        }),
        actionButton(session, PROJECT_SETUP_ACTIONS.BACK_PEOPLE, 'Back to team'),
        actionButton(session, PROJECT_SETUP_ACTIONS.CANCEL, 'Cancel'),
      ),
    ],
  };
}

export function reviewPayload(session) {
  const embed = projectEmbed(
    session,
    5,
    'Everything is ready. Review the setup once more; the project is created only when you press **Create project**.',
    true,
  ).addFields(
    { name: '🧭 Scope', value: selectedScope(session) },
    { name: '📅 Timeline', value: `${session.startDate} → ${session.expectedEnd}` },
    { name: `👥 Members · ${session.memberIds.length}`, value: formatPeople(session.memberIds) },
    { name: `🛡️ Supervisors · ${session.supervisorIds.length}`, value: formatPeople(session.supervisorIds) },
    { name: '📝 Notes', value: session.notes?.slice(0, 1_024) || 'None' },
  );

  return {
    content: '',
    embeds: [embed],
    allowedMentions: { parse: [] },
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        actionButton(session, PROJECT_SETUP_ACTIONS.CREATE, 'Create project', ButtonStyle.Success, { emoji: '✓' }),
        actionButton(session, PROJECT_SETUP_ACTIONS.BACK_DETAILS, 'Back to details'),
        actionButton(session, PROJECT_SETUP_ACTIONS.NAME_OPEN, 'Rename'),
        actionButton(session, PROJECT_SETUP_ACTIONS.CANCEL, 'Cancel'),
      ),
    ],
  };
}

export function cancelledPayload() {
  return {
    content: 'Project setup cancelled. Nothing was created.',
    embeds: [],
    components: [],
  };
}

export { MAX_NATIVE_SELECTIONS as PROJECT_SETUP_SELECTION_LIMIT };
