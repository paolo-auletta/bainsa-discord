import assert from 'node:assert/strict';
import test from 'node:test';

import { ButtonStyle, ComponentType, MessageFlags } from 'discord.js';

import {
  createProjectSetupService,
  PROJECT_SETUP_SELECTION_LIMIT,
} from '../src/services/projects/setup.js';
import { PROJECT_SETUP_ACTIONS } from '../src/services/projects/setup-components.js';

const MEMBER_ID = '111111111111111111';
const SUPERVISOR_ID = '222222222222222222';
const BOT_ID = '999999999999999999';

function componentPayload(payload) {
  const components = payload.components.map((component) => component.toJSON?.() ?? component);
  if (components.length === 1 && components[0].type === ComponentType.Container) {
    return components[0].components;
  }
  return components;
}

function componentForAction(payload, action) {
  const queue = [...componentPayload(payload)];
  while (queue.length > 0) {
    const component = queue.shift();
    if (component.custom_id?.endsWith(`:${action}`)) return component;
    if (component.components) queue.push(...component.components);
  }
  assert.fail(`Missing project setup component for action ${action}`);
}

function summaryContent(payload) {
  const summary = componentPayload(payload)[0];
  assert.equal(summary.type, ComponentType.TextDisplay);
  return summary.content;
}

function bottomButtons(payload) {
  const components = componentPayload(payload);
  const row = components.at(-1);
  assert.equal(row.type, ComponentType.ActionRow);
  return row.components;
}

function allText(payload) {
  return componentPayload(payload)
    .filter((component) => component.type === ComponentType.TextDisplay)
    .map((component) => component.content)
    .join('\n');
}

function assertConsistentSummary(payload, projectName) {
  const content = summaryContent(payload);
  assert.match(content, new RegExp(`^## ${projectName}`));
  assert.match(content, /\*\*Project summary\*\*/);
  assert.match(content, /\*\*Scope\*\*/);
  assert.match(content, /\*\*Team\*\*/);
  assert.match(content, /\*\*Timeline\*\*/);
  assert.match(content, /\*\*Notes\*\*/);
  assert.doesNotMatch(content, /^>/m);
  assert.doesNotMatch(content, /BAINSA · Project setup|Private setup/);
}

function baseInteraction(customId = null) {
  return {
    customId,
    user: { id: 'actor' },
    guildId: 'guild',
    client: { user: { id: BOT_ID } },
  };
}

function fieldValues(values) {
  return { getTextInputValue: (name) => values[name] ?? '' };
}

function setupService(overrides = {}) {
  return createProjectSetupService({
    createProject: async () => assert.fail('unexpected project creation'),
    findUniversities: async () => [{ name: 'Bocconi' }, { name: 'Sapienza' }],
    findDivisions: async (university) => university === 'Bocconi'
      ? [{ name: 'Projects', color: 'blue' }, { name: 'Analysis', color: 'orange' }]
      : [{ name: 'Culture', color: 'pink' }],
    ...overrides,
  });
}

async function beginSetup(service, name = 'Native project') {
  let modal;
  await service.start({
    ...baseInteraction(),
    showModal: async (next) => { modal = next.toJSON(); },
  });
  assert.equal(modal.title, 'Project setup · Name');

  let payload;
  await service.handleModalSubmit({
    ...baseInteraction(modal.custom_id),
    fields: fieldValues({ project_name: name }),
    isFromMessage: () => false,
    reply: async (next) => { payload = next; },
  });
  assert.equal(payload.flags, MessageFlags.Ephemeral | MessageFlags.IsComponentsV2);
  return payload;
}

async function chooseScope(service, initialPayload) {
  let payload;
  await service.handleStringSelect({
    ...baseInteraction(componentForAction(initialPayload, PROJECT_SETUP_ACTIONS.UNIVERSITY).custom_id),
    values: ['0'],
    update: async (next) => { payload = next; },
  });

  await service.handleStringSelect({
    ...baseInteraction(componentForAction(payload, PROJECT_SETUP_ACTIONS.DIVISION).custom_id),
    values: ['0'],
    update: async (next) => { payload = next; },
  });

  await service.handleButton({
    ...baseInteraction(componentForAction(payload, PROJECT_SETUP_ACTIONS.SCOPE_DONE).custom_id),
    update: async (next) => { payload = next; },
  });
  return payload;
}

async function chooseTeam(service, initialPayload) {
  let payload;
  await service.handleUserSelect({
    ...baseInteraction(componentForAction(initialPayload, PROJECT_SETUP_ACTIONS.MEMBERS).custom_id),
    values: [MEMBER_ID, MEMBER_ID],
    users: new Map([[MEMBER_ID, { id: MEMBER_ID, username: 'member-name' }]]),
    update: async (next) => { payload = next; },
  });

  await service.handleUserSelect({
    ...baseInteraction(componentForAction(payload, PROJECT_SETUP_ACTIONS.SUPERVISORS).custom_id),
    values: [SUPERVISOR_ID],
    users: new Map([[SUPERVISOR_ID, { id: SUPERVISOR_ID, username: 'supervisor-name' }]]),
    update: async (next) => { payload = next; },
  });
  return payload;
}

async function completeDetails(service, participantPayload) {
  let payload;
  await service.handleButton({
    ...baseInteraction(componentForAction(participantPayload, PROJECT_SETUP_ACTIONS.PEOPLE_DONE).custom_id),
    update: async (next) => { payload = next; },
  });
  assertConsistentSummary(payload, 'Native project');
  assert.match(allText(payload), /\*\*Project timeline\*\*/);
  assert.match(allText(payload), /\*\*Project notes\*\*/);
  assert.doesNotMatch(allText(payload), /Add the required timeline|Not added · Optional/);
  assert.equal(componentForAction(payload, PROJECT_SETUP_ACTIONS.DATES_OPEN).style, ButtonStyle.Primary);
  assert.equal(componentForAction(payload, PROJECT_SETUP_ACTIONS.NOTES_OPEN).style, ButtonStyle.Primary);
  assert.deepEqual(bottomButtons(payload).map((button) => button.label), [
    'Continue to review',
    'Back to team',
    'Cancel setup',
  ]);

  let datesModal;
  await service.handleButton({
    ...baseInteraction(componentForAction(payload, PROJECT_SETUP_ACTIONS.DATES_OPEN).custom_id),
    showModal: async (modal) => { datesModal = modal.toJSON(); },
  });
  await service.handleModalSubmit({
    ...baseInteraction(datesModal.custom_id),
    fields: fieldValues({ start_date: '2026-08-01', expected_end: '2026-09-01' }),
    isFromMessage: () => true,
    update: async (next) => { payload = next; },
  });

  let notesModal;
  await service.handleButton({
    ...baseInteraction(componentForAction(payload, PROJECT_SETUP_ACTIONS.NOTES_OPEN).custom_id),
    showModal: async (modal) => { notesModal = modal.toJSON(); },
  });
  await service.handleModalSubmit({
    ...baseInteraction(notesModal.custom_id),
    fields: fieldValues({ notes: 'Private context' }),
    isFromMessage: () => true,
    update: async (next) => { payload = next; },
  });

  await service.handleButton({
    ...baseInteraction(componentForAction(payload, PROJECT_SETUP_ACTIONS.REVIEW).custom_id),
    update: async (next) => { payload = next; },
  });
  return payload;
}

test('project setup renders a polished five-step wizard and creates only from review', async () => {
  let createdInput;
  let activity;
  let finalReply;
  const result = {
    id: '7',
    name: 'Native project',
    university_name: 'Bocconi',
    division_name: 'Projects',
    start_date: '2026-08-01',
    expected_end: '2026-09-01',
    people: [
      { discord_user_id: MEMBER_ID, role: 'member' },
      { discord_user_id: SUPERVISOR_ID, role: 'supervisor' },
    ],
  };
  const service = setupService({
    createProject: async (input) => {
      createdInput = input;
      return result;
    },
    now: () => 1_000,
  });

  const scope = await beginSetup(service);
  assert.equal(scope.flags, MessageFlags.Ephemeral | MessageFlags.IsComponentsV2);
  assertConsistentSummary(scope, result.name);
  assert.match(allText(scope), /\*\*University\*\*/);
  assert.match(allText(scope), /\*\*Division\*\*/);
  assert.doesNotMatch(allText(scope), /responsible for this project|ordinary project members/);
  assert.equal(componentForAction(scope, PROJECT_SETUP_ACTIONS.UNIVERSITY).type, ComponentType.StringSelect);
  assert.equal(componentForAction(scope, PROJECT_SETUP_ACTIONS.DIVISION).disabled, true);
  assert.deepEqual(bottomButtons(scope).map((button) => button.label), [
    'Continue to team',
    'Back to name',
    'Cancel setup',
  ]);

  const participants = await chooseScope(service, scope);
  assertConsistentSummary(participants, result.name);
  assert.match(allText(participants), /\*\*Members\*\*/);
  assert.match(allText(participants), /\*\*Supervisors\*\*/);
  assert.doesNotMatch(allText(participants), /support multiple people|Select one or more people/);
  const members = componentForAction(participants, PROJECT_SETUP_ACTIONS.MEMBERS);
  const supervisors = componentForAction(participants, PROJECT_SETUP_ACTIONS.SUPERVISORS);
  assert.equal(members.type, ComponentType.UserSelect);
  assert.equal(supervisors.type, ComponentType.UserSelect);
  assert.equal(members.max_values, PROJECT_SETUP_SELECTION_LIMIT);
  assert.equal(supervisors.max_values, PROJECT_SETUP_SELECTION_LIMIT);
  assert.equal(componentForAction(participants, PROJECT_SETUP_ACTIONS.PEOPLE_DONE).disabled, true);
  assert.deepEqual(bottomButtons(participants).map((button) => button.label), [
    'Continue to details',
    'Back to scope',
    'Cancel setup',
  ]);

  const selected = await chooseTeam(service, participants);
  assert.equal(createdInput, undefined);
  assert.match(summaryContent(selected), /\*\*Team\*\* · 1 member · 1 supervisor/);
  assert.equal(componentForAction(selected, PROJECT_SETUP_ACTIONS.PEOPLE_DONE).disabled, false);

  const review = await completeDetails(service, selected);
  assert.equal(createdInput, undefined);
  assert.match(
    summaryContent(review),
    /^## Review the project · Native project\n\n\*\*Scope\*\*/,
  );
  assert.doesNotMatch(allText(review), /Project summary|Check the complete setup/);
  assert.match(allText(review), /Private context/);
  assert.deepEqual(bottomButtons(review).map((button) => button.label), [
    'Create project',
    'Back to details',
    'Cancel setup',
  ]);
  assert.equal(componentForAction(review, PROJECT_SETUP_ACTIONS.CREATE).style, ButtonStyle.Primary);
  await service.handleButton({
    ...baseInteraction(componentForAction(review, PROJECT_SETUP_ACTIONS.CREATE).custom_id),
    member: { roles: { cache: [] } },
    channel: { send: async (payload) => { activity = payload; } },
    deferUpdate: async () => undefined,
    editReply: async (payload) => { finalReply = payload; },
  });

  assert.equal(createdInput.name, result.name);
  assert.equal(createdInput.university, 'Bocconi');
  assert.equal(createdInput.division, 'Projects');
  assert.equal(createdInput.members, MEMBER_ID);
  assert.equal(createdInput.supervisors, SUPERVISOR_ID);
  assert.equal(createdInput.startDate, result.start_date);
  assert.equal(createdInput.expectedEnd, result.expected_end);
  assert.equal(createdInput.notes, 'Private context');
  assert.equal(activity.allowedMentions.parse.length, 0);
  const activityEmbed = activity.embeds[0].toJSON();
  assert.equal(
    activityEmbed.fields.find((field) => field.name === 'Members').value,
    `member-name (<@${MEMBER_ID}>)`,
  );
  assert.equal(
    activityEmbed.fields.find((field) => field.name === 'Supervisors').value,
    `supervisor-name (<@${SUPERVISOR_ID}>)`,
  );
  assert.equal(finalReply.flags, MessageFlags.IsComponentsV2);
  assert.match(allText(finalReply), /Created \*\*Native project\*\*/);
});

test('project setup rejects the Bot and cross-role duplicate selections', async () => {
  const service = setupService();
  const participants = await chooseScope(service, await beginSetup(service, 'Safety'));

  await assert.rejects(
    () => service.handleUserSelect({
      ...baseInteraction(componentForAction(participants, PROJECT_SETUP_ACTIONS.MEMBERS).custom_id),
      values: [BOT_ID],
      update: async () => assert.fail('must not update'),
    }),
    /Bot member cannot be managed/,
  );

  await service.handleUserSelect({
    ...baseInteraction(componentForAction(participants, PROJECT_SETUP_ACTIONS.MEMBERS).custom_id),
    values: [MEMBER_ID],
    update: async () => undefined,
  });
  await assert.rejects(
    () => service.handleUserSelect({
      ...baseInteraction(componentForAction(participants, PROJECT_SETUP_ACTIONS.SUPERVISORS).custom_id),
      values: [MEMBER_ID],
      update: async () => assert.fail('must not update'),
    }),
    /cannot contain the same user/,
  );
});

test('project setup cancellation creates nothing and invalidates its controls', async () => {
  let createCalls = 0;
  let cancelled;
  const service = setupService({
    createProject: async () => {
      createCalls += 1;
      return null;
    },
  });
  const scope = await beginSetup(service, 'Cancelled');
  const cancelId = componentForAction(scope, PROJECT_SETUP_ACTIONS.CANCEL).custom_id;

  await service.handleButton({
    ...baseInteraction(cancelId),
    update: async (payload) => { cancelled = payload; },
  });
  assert.equal(createCalls, 0);
  assert.match(allText(cancelled), /Project setup cancelled/);
  assert.match(allText(cancelled), /Nothing was created/);

  await assert.rejects(
    () => service.handleButton({ ...baseInteraction(cancelId), update: async () => undefined }),
    /expired/,
  );
});

test('project setup rejects unauthorized and expired interactions safely', async () => {
  let currentTime = 1_000;
  const service = setupService({ now: () => currentTime });
  const scope = await beginSetup(service, 'Protected');
  const universityId = componentForAction(scope, PROJECT_SETUP_ACTIONS.UNIVERSITY).custom_id;

  await assert.rejects(
    () => service.handleStringSelect({
      ...baseInteraction(universityId),
      user: { id: 'different-actor' },
      values: ['0'],
      update: async () => assert.fail('must not update'),
    }),
    /Only the person who started/,
  );

  currentTime += 16 * 60 * 1_000;
  await assert.rejects(
    () => service.handleStringSelect({
      ...baseInteraction(universityId),
      values: ['0'],
      update: async () => assert.fail('must not update'),
    }),
    /expired/,
  );
});
