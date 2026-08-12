import { randomUUID } from 'node:crypto';

import { MessageFlags } from 'discord.js';

import { formatBoardActivity } from '../../activity/formatters.js';
import { postUniversityBoardActivity } from '../../activity/router.js';
import { assertNoBotUserIds } from '../../authorization.js';
import { config } from '../../config.js';
import { UserFacingError, assertUser } from '../../errors.js';
import { logger } from '../../logger.js';
import {
  ephemeralReplyPayload,
  interactionOutcome,
  renderInteractionPanel,
} from '../../messages/index.js';
import { botCommandChannelScope } from '../../runtime/command-channels.js';
import { resolveCommandContext } from '../../runtime/command-scope.js';
import {
  cancelledPayload,
  creatingPayload,
  creationFailedPayload,
  createdPayload,
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
  PROJECT_SETUP_ACTIONS.UNIVERSITY_PREVIOUS,
  PROJECT_SETUP_ACTIONS.UNIVERSITY_NEXT,
  PROJECT_SETUP_ACTIONS.UNIVERSITY_CONTINUE,
  PROJECT_SETUP_ACTIONS.DIVISION_PREVIOUS,
  PROJECT_SETUP_ACTIONS.DIVISION_NEXT,
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
  return interaction.reply({
    ...payload,
    flags: MessageFlags.Ephemeral | MessageFlags.IsComponentsV2,
  });
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
    assertUser(session.summary, 'Add a public project summary before continuing.');
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
      fixedUniversity: false,
      universityConfirmed: false,
      division: null,
      divisionColor: null,
      universities: [],
      divisions: [],
      universityPage: 0,
      divisionPage: 0,
      memberIds: [],
      supervisorIds: [],
      participantUsers: new Map(),
      startDate: null,
      expectedEnd: null,
      summary: null,
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

    if (parsed.action === PROJECT_SETUP_ACTIONS.UNIVERSITY_CONTINUE) {
      assertUser(session.university, 'Choose a university before continuing.');
      resolveCommandContext({
        commandName: 'project-create',
        channelScope: botCommandChannelScope(interaction.channel),
        selectedUniversity: session.university,
      });
      session.busy = true;
      await interaction.update(renderInteractionPanel({
        kind: 'interaction-panel',
        tone: 'pending',
        title: `Loading ${session.university} divisions`,
        description: `${config.botName} is confirming your scope before loading active divisions.`,
        status: 'This private setup will update when the divisions are ready.',
        audience: 'actor',
      }));
      try {
        const divisions = await findDivisions(session.university, '');
        assertUser(divisions.length > 0, `No divisions are available for ${session.university}.`);
        session.divisions = divisions;
        session.universityConfirmed = true;
        session.division = null;
        session.divisionColor = null;
        session.divisionPage = 0;
        session.busy = false;
        await interaction.editReply(scopePayload(session));
      } catch (error) {
        session.busy = false;
        await interaction.editReply(scopePayload(session));
        throw error;
      }
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

    const pagination = {
      [PROJECT_SETUP_ACTIONS.UNIVERSITY_PREVIOUS]: { field: 'universityPage', delta: -1, count: session.universities.length },
      [PROJECT_SETUP_ACTIONS.UNIVERSITY_NEXT]: { field: 'universityPage', delta: 1, count: session.universities.length },
      [PROJECT_SETUP_ACTIONS.DIVISION_PREVIOUS]: { field: 'divisionPage', delta: -1, count: session.divisions.length },
      [PROJECT_SETUP_ACTIONS.DIVISION_NEXT]: { field: 'divisionPage', delta: 1, count: session.divisions.length },
    }[parsed.action];
    if (pagination) {
      const lastPage = Math.max(0, Math.ceil(pagination.count / 25) - 1);
      session[pagination.field] = Math.min(lastPage, Math.max(0, session[pagination.field] + pagination.delta));
      await interaction.update(scopePayload(session));
      return;
    }

    if (parsed.action !== PROJECT_SETUP_ACTIONS.CREATE) return;
    assertSetupComplete(session);
    resolveCommandContext({
      commandName: 'project-create',
      channelScope: botCommandChannelScope(interaction.channel),
      selectedUniversity: session.university,
    });
    session.busy = true;
    try {
      await interaction.update(creatingPayload(session));
    } catch (error) {
      session.busy = false;
      touch(session);
      throw error;
    }

    let result;
    try {
      result = await createProject({
        interaction,
        name: session.name,
        university: session.university,
        division: session.division,
        startDate: session.startDate,
        expectedEnd: session.expectedEnd,
        summary: session.summary,
        notes: session.notes,
        members: session.memberIds.join(','),
        supervisors: session.supervisorIds.join(','),
      });
    } catch (error) {
      session.busy = false;
      touch(session);
      const message = error instanceof UserFacingError
        ? error.message
        : `${config.botName} could not create the project. Review the setup and try again.`;
      await interaction.editReply(creationFailedPayload(session, message));
      return;
    }

    // The database transaction committed. Never reactivate this setup after
    // this point: a retry could create a duplicate project.
    deleteSession(session);

    try {
      const activity = formatBoardActivity('project-create', {
        actorId: interaction.user.id,
        result: {
          ...result,
          people: result.people.map((person) => ({
            ...person,
            user: session.participantUsers.get(String(person.discord_user_id)),
          })),
        },
      });
      let acknowledgement = `Created **${result.name}** (#${result.id}).`;
      if (result.reconciliation_pending) {
        acknowledgement += ' Discord reconciliation is pending and will retry automatically.';
      }
      try {
        const delivery = await postUniversityBoardActivity(
          interaction,
          activity,
          result.university_name,
        );
        if (delivery.status !== 'posted') throw new Error('University bot-log is unavailable.');
        acknowledgement += ' Activity posted in the university bot-log.';
      } catch (error) {
        logger.error('Project creation activity message could not be posted', {
          command: 'project-create',
          userId: interaction.user.id,
          projectId: result.id,
          error: error instanceof Error ? error.message : String(error),
        });
        acknowledgement += ' The project was saved, but its activity message could not be posted.';
      }
      await interaction.editReply(createdPayload(acknowledgement));
    } catch (error) {
      logger.error('Project creation acknowledgement could not be delivered', {
        command: 'project-create',
        userId: interaction.user.id,
        projectId: result.id,
        error: error instanceof Error ? error.message : String(error),
      });
      if (typeof interaction.followUp === 'function') {
        try {
          await interaction.followUp(ephemeralReplyPayload(renderInteractionPanel(interactionOutcome({
            outcome: 'delivery-failed',
            title: 'Project created; confirmation delivery failed',
            description: `Created **${result.name}** (#${result.id}), but the initial confirmation could not be delivered.`,
            status: 'The project was saved. Do not submit the setup again.',
          }))));
        } catch (followUpError) {
          logger.error('Project creation follow-up acknowledgement could not be delivered', {
            command: 'project-create',
            userId: interaction.user.id,
            projectId: result.id,
            error: followUpError instanceof Error ? followUpError.message : String(followUpError),
          });
        }
      }
    }
  }

  async function handleStringSelect(interaction) {
    const parsed = parseProjectSetupId(interaction.customId);
    if (!parsed || !STRING_SELECT_ACTIONS.has(parsed.action)) return;
    const session = requireSession(interaction, parsed.sessionId);
    touch(session);

    if (parsed.action === PROJECT_SETUP_ACTIONS.UNIVERSITY) {
      assertUser(!session.fixedUniversity, 'The university is fixed by this command channel.');
      const university = selectedIndex(interaction, session.universities, 'university');
      if (session.university !== university.name) {
        session.university = university.name;
        session.universityConfirmed = false;
        session.division = null;
        session.divisionColor = null;
        session.memberIds = [];
        session.supervisorIds = [];
        session.participantUsers.clear();
        session.divisionPage = 0;
      }
      session.divisions = [];
      await interaction.update(scopePayload(session));
      return;
    }

    const division = selectedIndex(interaction, session.divisions, 'division');
    if (session.division !== division.name) {
      session.division = division.name;
      session.divisionColor = division.color;
      session.memberIds = [];
      session.supervisorIds = [];
      session.participantUsers.clear();
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

    for (const id of selectedIds) {
      const member = interaction.members?.get(id);
      session.participantUsers.set(
        id,
        member?.displayName ? member : interaction.users?.get(id) ?? member ?? null,
      );
    }

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
      const resolved = resolveCommandContext({
        commandName: 'project-create',
        channelScope: botCommandChannelScope(interaction.channel),
        requireUniversity: false,
      });
      if (resolved.universityName) {
        const university = session.universities.find(
          (candidate) => candidate.name.toLowerCase() === resolved.universityName.toLowerCase(),
        );
        assertUser(university, `The ${resolved.universityName} bot-log is not linked to an active university.`);
        const divisions = await findDivisions(university.name, '');
        assertUser(divisions.length > 0, `No divisions are available for ${university.name}.`);
        session.university = university.name;
        session.fixedUniversity = true;
        session.universityConfirmed = true;
        session.divisions = divisions;
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

    const summary = interaction.fields.getTextInputValue('summary')?.trim();
    assertUser(summary, 'Add a public project summary.');
    const notes = interaction.fields.getTextInputValue('notes')?.trim() || null;
    session.summary = summary;
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
