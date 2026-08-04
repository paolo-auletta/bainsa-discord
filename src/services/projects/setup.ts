import { randomUUID } from 'node:crypto';

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  UserSelectMenuBuilder,
} from 'discord.js';

import { formatBoardActivity } from '../../activity/formatters.js';
import { assertNoBotUserIds } from '../../authorization.js';
import { assertUser } from '../../errors.js';
import { logger } from '../../logger.js';
import { assertNoUserOverlap } from './validation.js';

const PREFIX = 'project-setup';
const SESSION_TTL_MS = 15 * 60 * 1_000;
const MAX_NATIVE_SELECTIONS = 25;

const ACTIONS = Object.freeze({
  MEMBERS: 'members',
  SUPERVISORS: 'supervisors',
  CONFIRM: 'confirm',
  CANCEL: 'cancel',
});
const ACTION_VALUES = new Set<string>(Object.values(ACTIONS));
const SELECT_ACTIONS = new Set<string>([ACTIONS.MEMBERS, ACTIONS.SUPERVISORS]);
const BUTTON_ACTIONS = new Set<string>([ACTIONS.CONFIRM, ACTIONS.CANCEL]);

function projectSetupId(sessionId, action) {
  return `${PREFIX}:${sessionId}:${action}`;
}

function parseProjectSetupId(customId) {
  const [prefix, sessionId, action] = String(customId ?? '').split(':');
  if (prefix !== PREFIX || !sessionId || !ACTION_VALUES.has(action)) return null;
  return { sessionId, action };
}

function uniqueIds(values) {
  return [...new Set((values ?? []).map(String))];
}

function formatSelection(ids) {
  return ids.length ? ids.map((id) => `<@${id}>`).join(', ') : 'Not selected yet';
}

function userSelect(session, action, placeholder, selectedIds) {
  const menu = new UserSelectMenuBuilder()
    .setCustomId(projectSetupId(session.id, action))
    .setPlaceholder(placeholder)
    .setMinValues(1)
    .setMaxValues(MAX_NATIVE_SELECTIONS);
  if (selectedIds.length > 0) menu.setDefaultUsers(selectedIds);
  return menu;
}

function setupPayload(session) {
  return {
    content: [
      `Choose the initial participants for **${session.input.name}**.`,
      `**Members:** ${formatSelection(session.memberIds)}`,
      `**Supervisors:** ${formatSelection(session.supervisorIds)}`,
      '',
      'Discord searches server nicknames and usernames. Both selections are required before creation.',
    ].join('\n'),
    allowedMentions: { parse: [] },
    components: [
      new ActionRowBuilder<UserSelectMenuBuilder>().addComponents(
        userSelect(session, ACTIONS.MEMBERS, 'Select project members', session.memberIds),
      ),
      new ActionRowBuilder<UserSelectMenuBuilder>().addComponents(
        userSelect(session, ACTIONS.SUPERVISORS, 'Select project supervisors', session.supervisorIds),
      ),
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(projectSetupId(session.id, ACTIONS.CONFIRM))
          .setLabel('Create project')
          .setStyle(ButtonStyle.Success)
          .setDisabled(session.memberIds.length === 0 || session.supervisorIds.length === 0 || session.busy),
        new ButtonBuilder()
          .setCustomId(projectSetupId(session.id, ACTIONS.CANCEL))
          .setLabel('Cancel')
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(session.busy),
      ),
    ],
  };
}

export function createProjectSetupService({ createProject, now = () => Date.now() }) {
  const sessions = new Map();
  const actorSessions = new Map();

  function deleteSession(session) {
    sessions.delete(session.id);
    if (actorSessions.get(session.actorId) === session.id) actorSessions.delete(session.actorId);
  }

  function sweepExpiredSessions() {
    const currentTime = now();
    for (const session of sessions.values()) {
      if (session.expiresAt <= currentTime) deleteSession(session);
    }
  }

  function requireSession(interaction, sessionId) {
    sweepExpiredSessions();
    const session = sessions.get(sessionId);
    assertUser(session, 'This project setup has expired. Run /project-create again.');
    assertUser(session.actorId === interaction.user.id, 'Only the person who started this project setup can use it.');
    assertUser(session.guildId === interaction.guildId, 'This project setup belongs to another server.');
    assertUser(!session.busy, 'This project is already being created.');
    return session;
  }

  async function start(interaction, input) {
    sweepExpiredSessions();
    const previousId = actorSessions.get(interaction.user.id);
    if (previousId) {
      const previous = sessions.get(previousId);
      if (previous) deleteSession(previous);
    }

    const session = {
      id: randomUUID(),
      actorId: interaction.user.id,
      guildId: interaction.guildId,
      input: {
        name: input.name,
        university: input.university,
        division: input.division,
        startDate: input.startDate,
        expectedEnd: input.expectedEnd,
        notes: input.notes,
      },
      memberIds: [],
      supervisorIds: [],
      expiresAt: now() + SESSION_TTL_MS,
      busy: false,
    };
    sessions.set(session.id, session);
    actorSessions.set(session.actorId, session.id);
    await interaction.reply({ ...setupPayload(session), flags: MessageFlags.Ephemeral });
  }

  async function handleUserSelect(interaction) {
    const parsed = parseProjectSetupId(interaction.customId);
    if (!parsed || !SELECT_ACTIONS.has(parsed.action)) return;
    const session = requireSession(interaction, parsed.sessionId);
    const selectedIds = uniqueIds(interaction.values);
    assertUser(
      selectedIds.length >= 1 && selectedIds.length <= MAX_NATIVE_SELECTIONS,
      `Choose between 1 and ${MAX_NATIVE_SELECTIONS} users.`,
    );
    assertNoBotUserIds(interaction, selectedIds);

    const memberIds = parsed.action === ACTIONS.MEMBERS ? selectedIds : session.memberIds;
    const supervisorIds = parsed.action === ACTIONS.SUPERVISORS ? selectedIds : session.supervisorIds;
    assertNoUserOverlap(memberIds, supervisorIds, 'members', 'supervisors');

    session.memberIds = memberIds;
    session.supervisorIds = supervisorIds;
    session.expiresAt = now() + SESSION_TTL_MS;
    await interaction.update(setupPayload(session));
  }

  async function handleButton(interaction) {
    const parsed = parseProjectSetupId(interaction.customId);
    if (!parsed || !BUTTON_ACTIONS.has(parsed.action)) return;
    const session = requireSession(interaction, parsed.sessionId);

    if (parsed.action === ACTIONS.CANCEL) {
      deleteSession(session);
      await interaction.update({ content: 'Project creation cancelled.', components: [], embeds: [] });
      return;
    }

    assertUser(session.memberIds.length > 0, 'Choose at least one project member.');
    assertUser(session.supervisorIds.length > 0, 'Choose at least one project supervisor.');
    session.busy = true;
    await interaction.deferUpdate();

    try {
      const result = await createProject({
        ...session.input,
        interaction,
        members: session.memberIds.join(','),
        supervisors: session.supervisorIds.join(','),
      });
      deleteSession(session);

      const activity = formatBoardActivity('project-create', {
        actorId: interaction.user.id,
        result,
      });
      let acknowledgement = `Created **${result.name}** (#${result.id}).`;
      try {
        await interaction.channel.send({ allowedMentions: { parse: [] }, ...activity });
        acknowledgement += ' Activity posted in this channel.';
      } catch (error) {
        logger.error('Project creation activity message could not be posted', {
          command: 'project-create',
          userId: interaction.user.id,
          projectId: result.id,
          error: error instanceof Error ? error.message : String(error),
        });
        acknowledgement += ' The project was saved, but its activity message could not be posted.';
      }
      await interaction.editReply({ content: acknowledgement, components: [], embeds: [] });
    } catch (error) {
      session.busy = false;
      session.expiresAt = now() + SESSION_TTL_MS;
      throw error;
    }
  }

  return {
    canHandle: (customId) => parseProjectSetupId(customId) != null,
    handleButton,
    handleUserSelect,
    start,
  };
}

export function isProjectSetupCustomId(customId) {
  return parseProjectSetupId(customId) != null;
}

export { MAX_NATIVE_SELECTIONS as PROJECT_SETUP_SELECTION_LIMIT };
