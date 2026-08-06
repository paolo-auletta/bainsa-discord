import { randomUUID } from 'node:crypto';

import { MessageFlags } from 'discord.js';

import { formatBoardActivity } from '../../activity/formatters.js';
import { assertNoBotUserIds } from '../../authorization.js';
import { assertUser } from '../../errors.js';
import { logger } from '../../logger.js';
import {
  cancelledPayload,
  detailsPayload,
  participantsPayload,
  parseProjectSetupId,
  PROJECT_SETUP_ACTIONS,
  PROJECT_SETUP_SELECTION_LIMIT,
  projectDatesModal,
  projectNameModal,
  projectNotesModal,
  reviewPayload,
  scopePayload,
} from './setup-components.js';
import {
  assertNoUserOverlap,
  normalizeProjectName,
  validateProjectDates,
} from './validation.js';

const SESSION_TTL_MS = 15 * 60 * 1_000;
const BUTTON_ACTIONS = new Set<string>([
  PROJECT_SETUP_ACTIONS.NAME_OPEN,
  PROJECT_SETUP_ACTIONS.SCOPE_DONE,
  PROJECT_SETUP_ACTIONS.PEOPLE_DONE,
  PROJECT_SETUP_ACTIONS.DATES_OPEN,
  PROJECT_SETUP_ACTIONS.NOTES_OPEN,
  PROJECT_SETUP_ACTIONS.REVIEW,
  PROJECT_SETUP_ACTIONS.BACK_SCOPE,
  PROJECT_SETUP_ACTIONS.BACK_PEOPLE,
  PROJECT_SETUP_ACTIONS.BACK_DETAILS,
  PROJECT_SETUP_ACTIONS.CREATE,
  PROJECT_SETUP_ACTIONS.CANCEL,
]);
const STRING_SELECT_ACTIONS = new Set<string>([
  PROJECT_SETUP_ACTIONS.UNIVERSITY,
  PROJECT_SETUP_ACTIONS.DIVISION,
]);
const USER_SELECT_ACTIONS = new Set<string>([
  PROJECT_SETUP_ACTIONS.MEMBERS,
  PROJECT_SETUP_ACTIONS.SUPERVISORS,
]);
const MODAL_ACTIONS = new Set<string>([
  PROJECT_SETUP_ACTIONS.NAME_MODAL,
  PROJECT_SETUP_ACTIONS.DATES_MODAL,
  PROJECT_SETUP_ACTIONS.NOTES_MODAL,
]);

function uniqueIds(values) {
  return [...new Set((values ?? []).map(String))];
}

function actorKey(guildId, actorId) {
  return `${guildId}:${actorId}`;
}

function selectedIndex(interaction, choices, label) {
  assertUser(interaction.values.length === 1, `Choose exactly one ${label}.`);
  const rawIndex = interaction.values[0];
  assertUser(/^\d+$/.test(rawIndex), `Choose a ${label} from this list.`);
  const choice = choices[Number(rawIndex)];
  assertUser(choice, `Choose a ${label} from this list.`);
  return choice;
}

function payloadForScreen(session) {
  if (session.screen === 'participants') return participantsPayload(session);
  if (session.screen === 'details') return detailsPayload(session);
  if (session.screen === 'review') return reviewPayload(session);
  return scopePayload(session);
}

async function respondToModal(interaction, payload) {
  if (interaction.isFromMessage?.()) return interaction.update(payload);
  return interaction.reply({ ...payload, flags: MessageFlags.Ephemeral });
}

export function createProjectSetupService({
  createProject,
  findUniversities,
  findDivisions,
  now = () => Date.now(),
}) {
  const sessions = new Map();
  const actorSessions = new Map();

  function deleteSession(session) {
    sessions.delete(session.id);
    const key = actorKey(session.guildId, session.actorId);
    if (actorSessions.get(key) === session.id) actorSessions.delete(key);
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

  function touch(session) {
    session.expiresAt = now() + SESSION_TTL_MS;
  }

  function assertScopeComplete(session) {
    assertUser(session.university, 'Choose a university before continuing.');
    assertUser(session.division, 'Choose a division before continuing.');
  }

  function assertPeopleComplete(session) {
    assertUser(session.memberIds.length > 0, 'Choose at least one project member.');
    assertUser(session.supervisorIds.length > 0, 'Choose at least one project supervisor.');
    assertNoUserOverlap(session.memberIds, session.supervisorIds, 'members', 'supervisors');
  }

  function assertSetupComplete(session) {
    assertUser(session.name, 'Enter a project name before continuing.');
    assertScopeComplete(session);
    assertPeopleComplete(session);
    assertUser(session.startDate && session.expectedEnd, 'Set the project timeline before continuing.');
  }

  async function start(interaction) {
    sweepExpiredSessions();
    const key = actorKey(interaction.guildId, interaction.user.id);
    const previousId = actorSessions.get(key);
    if (previousId) {
      const previous = sessions.get(previousId);
      if (previous) deleteSession(previous);
    }

    const session = {
      id: randomUUID(),
      actorId: interaction.user.id,
      guildId: interaction.guildId,
      name: null,
      university: null,
      division: null,
      divisionColor: null,
      universities: [],
      divisions: [],
      memberIds: [],
      supervisorIds: [],
      startDate: null,
      expectedEnd: null,
      notes: null,
      screen: 'scope',
      expiresAt: now() + SESSION_TTL_MS,
      busy: false,
    };
    sessions.set(session.id, session);
    actorSessions.set(key, session.id);

    try {
      await interaction.showModal(projectNameModal(session));
    } catch (error) {
      deleteSession(session);
      throw error;
    }
  }

  async function handleButton(interaction) {
    const parsed = parseProjectSetupId(interaction.customId);
    if (!parsed || !BUTTON_ACTIONS.has(parsed.action)) return;
    const session = requireSession(interaction, parsed.sessionId);
    touch(session);

    if (parsed.action === PROJECT_SETUP_ACTIONS.NAME_OPEN) {
      await interaction.showModal(projectNameModal(session));
      return;
    }

    if (parsed.action === PROJECT_SETUP_ACTIONS.SCOPE_DONE) {
      assertScopeComplete(session);
      session.screen = 'participants';
      await interaction.update(participantsPayload(session));
      return;
    }

    if (parsed.action === PROJECT_SETUP_ACTIONS.PEOPLE_DONE) {
      assertPeopleComplete(session);
      session.screen = 'details';
      await interaction.update(detailsPayload(session));
      return;
    }

    if (parsed.action === PROJECT_SETUP_ACTIONS.DATES_OPEN) {
      await interaction.showModal(projectDatesModal(session));
      return;
    }

    if (parsed.action === PROJECT_SETUP_ACTIONS.NOTES_OPEN) {
      await interaction.showModal(projectNotesModal(session));
      return;
    }

    if (parsed.action === PROJECT_SETUP_ACTIONS.REVIEW) {
      assertSetupComplete(session);
      session.screen = 'review';
      await interaction.update(reviewPayload(session));
      return;
    }

    if (parsed.action === PROJECT_SETUP_ACTIONS.BACK_SCOPE) {
      session.screen = 'scope';
      await interaction.update(scopePayload(session));
      return;
    }

    if (parsed.action === PROJECT_SETUP_ACTIONS.BACK_PEOPLE) {
      session.screen = 'participants';
      await interaction.update(participantsPayload(session));
      return;
    }

    if (parsed.action === PROJECT_SETUP_ACTIONS.BACK_DETAILS) {
      session.screen = 'details';
      await interaction.update(detailsPayload(session));
      return;
    }

    if (parsed.action === PROJECT_SETUP_ACTIONS.CANCEL) {
      deleteSession(session);
      await interaction.update(cancelledPayload());
      return;
    }

    if (parsed.action !== PROJECT_SETUP_ACTIONS.CREATE) return;
    assertSetupComplete(session);
    session.busy = true;
    await interaction.deferUpdate();

    try {
      const result = await createProject({
        interaction,
        name: session.name,
        university: session.university,
        division: session.division,
        startDate: session.startDate,
        expectedEnd: session.expectedEnd,
        notes: session.notes,
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
      touch(session);
      throw error;
    }
  }

  async function handleStringSelect(interaction) {
    const parsed = parseProjectSetupId(interaction.customId);
    if (!parsed || !STRING_SELECT_ACTIONS.has(parsed.action)) return;
    const session = requireSession(interaction, parsed.sessionId);
    touch(session);

    if (parsed.action === PROJECT_SETUP_ACTIONS.UNIVERSITY) {
      const university = selectedIndex(interaction, session.universities, 'university');
      if (session.university !== university.name) {
        session.university = university.name;
        session.division = null;
        session.divisionColor = null;
        session.memberIds = [];
        session.supervisorIds = [];
      }
      session.divisions = await findDivisions(session.university, '');
      assertUser(session.divisions.length > 0, `No divisions are available for ${session.university}.`);
      await interaction.update(scopePayload(session));
      return;
    }

    const division = selectedIndex(interaction, session.divisions, 'division');
    if (session.division !== division.name) {
      session.division = division.name;
      session.divisionColor = division.color;
      session.memberIds = [];
      session.supervisorIds = [];
    }
    await interaction.update(scopePayload(session));
  }

  async function handleUserSelect(interaction) {
    const parsed = parseProjectSetupId(interaction.customId);
    if (!parsed || !USER_SELECT_ACTIONS.has(parsed.action)) return;
    const session = requireSession(interaction, parsed.sessionId);
    const selectedIds = uniqueIds(interaction.values);
    assertUser(
      selectedIds.length >= 1 && selectedIds.length <= PROJECT_SETUP_SELECTION_LIMIT,
      `Choose between 1 and ${PROJECT_SETUP_SELECTION_LIMIT} users.`,
    );
    assertNoBotUserIds(interaction, selectedIds);

    const memberIds = parsed.action === PROJECT_SETUP_ACTIONS.MEMBERS ? selectedIds : session.memberIds;
    const supervisorIds = parsed.action === PROJECT_SETUP_ACTIONS.SUPERVISORS ? selectedIds : session.supervisorIds;
    assertNoUserOverlap(memberIds, supervisorIds, 'members', 'supervisors');

    session.memberIds = memberIds;
    session.supervisorIds = supervisorIds;
    touch(session);
    await interaction.update(participantsPayload(session));
  }

  async function handleModalSubmit(interaction) {
    const parsed = parseProjectSetupId(interaction.customId);
    if (!parsed || !MODAL_ACTIONS.has(parsed.action)) return;
    const session = requireSession(interaction, parsed.sessionId);
    touch(session);

    if (parsed.action === PROJECT_SETUP_ACTIONS.NAME_MODAL) {
      session.name = normalizeProjectName(interaction.fields.getTextInputValue('project_name'));
      if (session.universities.length === 0) {
        session.universities = await findUniversities('');
        assertUser(session.universities.length > 0, 'No universities are available for projects yet.');
      }
      await respondToModal(interaction, payloadForScreen(session));
      return;
    }

    if (parsed.action === PROJECT_SETUP_ACTIONS.DATES_MODAL) {
      const dates = validateProjectDates(
        interaction.fields.getTextInputValue('start_date'),
        interaction.fields.getTextInputValue('expected_end'),
      );
      session.startDate = dates.startDate;
      session.expectedEnd = dates.expectedEnd;
      session.screen = 'details';
      await respondToModal(interaction, detailsPayload(session));
      return;
    }

    const notes = interaction.fields.getTextInputValue('notes')?.trim() || null;
    session.notes = notes;
    session.screen = 'details';
    await respondToModal(interaction, detailsPayload(session));
  }

  return {
    canHandle: (customId) => parseProjectSetupId(customId) != null,
    handleButton,
    handleStringSelect,
    handleUserSelect,
    handleModalSubmit,
    start,
  };
}

export function isProjectSetupCustomId(customId) {
  return parseProjectSetupId(customId) != null;
}

export { PROJECT_SETUP_SELECTION_LIMIT };
