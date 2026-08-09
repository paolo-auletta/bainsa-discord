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
  assert.match(content, /\*\*Public summary\*\*/);
  assert.match(content, /\*\*Internal notes\*\*/);
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
  assert.match(allText(payload), /\*\*Summary and internal notes\*\*/);
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
    fields: fieldValues({ summary: 'Public project context', notes: 'Private context' }),
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
  let waitingReply;
  const result = {
    id: '7',
    name: 'Native project',
    university_name: 'Bocconi',
    division_name: 'Projects',
    start_date: '2026-08-01',
    expected_end: '2026-09-01',
    reconciliation_pending: true,
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
  assert.doesNotMatch(allText(participants), /Division oversight/);
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
  assert.match(
    allText(review),
    /The selected division's active Head\(s\) will automatically be included in the project channel as supervisors\./,
  );
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
    update: async (payload) => {
      assert.equal(createdInput, undefined);
      waitingReply = payload;
    },
    editReply: async (payload) => { finalReply = payload; },
  });

  assert.equal(createdInput.name, result.name);
  assert.match(allText(waitingReply), /Creating Native project/);
  assert.match(allText(waitingReply), /message will update/i);
  assert.equal(componentPayload(waitingReply).some((component) => component.type === ComponentType.ActionRow), false);
  assert.equal(createdInput.university, 'Bocconi');
  assert.equal(createdInput.division, 'Projects');
  assert.equal(createdInput.members, MEMBER_ID);
  assert.equal(createdInput.supervisors, SUPERVISOR_ID);
  assert.equal(createdInput.startDate, result.start_date);
  assert.equal(createdInput.expectedEnd, result.expected_end);
  assert.equal(createdInput.summary, 'Public project context');
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
  assert.match(allText(finalReply), /Discord reconciliation is pending and will retry automatically/);
  await assert.rejects(
    () => service.handleButton({
      ...baseInteraction(componentForAction(review, PROJECT_SETUP_ACTIONS.CREATE).custom_id),
      update: async () => assert.fail('must not retry project creation'),
    }),
    /expired/,
  );
});

test('project setup preserves its last valid scope when loading a new university fails', async () => {
  const service = setupService({
    findDivisions: async (university) => {
      if (university === 'Sapienza') throw new Error('Division lookup unavailable');
      return [{ name: 'Projects', color: 'blue' }];
    },
  });
  const scope = await beginSetup(service, 'Scope recovery');
  let selectedScope;
  await service.handleStringSelect({
    ...baseInteraction(componentForAction(scope, PROJECT_SETUP_ACTIONS.UNIVERSITY).custom_id),
    values: ['0'],
    update: async (payload) => { selectedScope = payload; },
  });

  await assert.rejects(
    () => service.handleStringSelect({
      ...baseInteraction(componentForAction(selectedScope, PROJECT_SETUP_ACTIONS.UNIVERSITY).custom_id),
      values: ['1'],
      update: async () => assert.fail('must not update after a failed lookup'),
    }),
    /Division lookup unavailable/,
  );

  await service.handleStringSelect({
    ...baseInteraction(componentForAction(selectedScope, PROJECT_SETUP_ACTIONS.DIVISION).custom_id),
    values: ['0'],
    update: async (payload) => { selectedScope = payload; },
  });
  assert.match(summaryContent(selectedScope), /Bocconi · 🟦 Projects/);
});

test('project setup pagination makes universities and divisions after the first 25 selectable', async () => {
  const universities = Array.from({ length: 26 }, (_, index) => ({
    name: `University ${String(index + 1).padStart(2, '0')}`,
  }));
  const divisions = Array.from({ length: 26 }, (_, index) => ({
    name: `Division ${String(index + 1).padStart(2, '0')}`,
    color: 'blue',
  }));
  const service = setupService({
    findUniversities: async () => universities,
    findDivisions: async () => divisions,
  });
  let payload = await beginSetup(service, 'Paginated project');
  const firstUniversityMenu = componentForAction(payload, PROJECT_SETUP_ACTIONS.UNIVERSITY);
  assert.equal(firstUniversityMenu.options.length, 25);
  assert.equal(componentForAction(payload, PROJECT_SETUP_ACTIONS.UNIVERSITY_PREVIOUS).disabled, true);

  await service.handleButton({
    ...baseInteraction(componentForAction(payload, PROJECT_SETUP_ACTIONS.UNIVERSITY_NEXT).custom_id),
    update: async (next) => { payload = next; },
  });
  const lastUniversityMenu = componentForAction(payload, PROJECT_SETUP_ACTIONS.UNIVERSITY);
  assert.deepEqual(lastUniversityMenu.options.map((option) => option.value), ['25']);
  await service.handleStringSelect({
    ...baseInteraction(lastUniversityMenu.custom_id),
    values: ['25'],
    update: async (next) => { payload = next; },
  });

  assert.equal(componentForAction(payload, PROJECT_SETUP_ACTIONS.DIVISION).options.length, 25);
  await service.handleButton({
    ...baseInteraction(componentForAction(payload, PROJECT_SETUP_ACTIONS.DIVISION_NEXT).custom_id),
    update: async (next) => { payload = next; },
  });
  const lastDivisionMenu = componentForAction(payload, PROJECT_SETUP_ACTIONS.DIVISION);
  assert.deepEqual(lastDivisionMenu.options.map((option) => option.value), ['25']);
  await service.handleStringSelect({
    ...baseInteraction(lastDivisionMenu.custom_id),
    values: ['25'],
    update: async (next) => { payload = next; },
  });

  assert.match(summaryContent(payload), /University 26 · 🟦 Division 26/);
  assert.ok(componentPayload(payload).length <= 10, 'Discord containers support at most 10 child components');
});

test('project setup keeps a committed project closed when acknowledgement delivery fails', async () => {
  let createCalls = 0;
  let followUp;
  const service = setupService({
    createProject: async () => {
      createCalls += 1;
      return {
        id: '8',
        name: 'Native project',
        university_name: 'Bocconi',
        division_name: 'Projects',
        start_date: '2026-08-01',
        expected_end: '2026-09-01',
        reconciliation_pending: false,
        people: [
          { discord_user_id: MEMBER_ID, role: 'member' },
          { discord_user_id: SUPERVISOR_ID, role: 'supervisor' },
        ],
      };
    },
  });
  const participants = await chooseScope(service, await beginSetup(service));
  const review = await completeDetails(service, await chooseTeam(service, participants));
  const createId = componentForAction(review, PROJECT_SETUP_ACTIONS.CREATE).custom_id;

  await service.handleButton({
    ...baseInteraction(createId),
    channel: { send: async () => undefined },
    update: async () => undefined,
    editReply: async () => { throw new Error('Discord acknowledgement unavailable'); },
    followUp: async (payload) => { followUp = payload; },
  });

  assert.equal(createCalls, 1);
  assert.match(followUp.content, /Created \*\*Native project\*\* \(#8\)/);
  assert.equal(followUp.flags, MessageFlags.Ephemeral);
  await assert.rejects(
    () => service.handleButton({
      ...baseInteraction(createId),
      update: async () => assert.fail('must not retry project creation'),
    }),
    /expired/,
  );
});

test('project setup replaces a failed pre-commit wait with retry, back, and cancel controls', async () => {
  const service = setupService({
    createProject: async () => { throw new Error('Database unavailable'); },
  });
  const participants = await chooseScope(service, await beginSetup(service));
  const review = await completeDetails(service, await chooseTeam(service, participants));
  let waiting;
  let failed;

  await service.handleButton({
    ...baseInteraction(componentForAction(review, PROJECT_SETUP_ACTIONS.CREATE).custom_id),
    update: async (payload) => { waiting = payload; },
    editReply: async (payload) => { failed = payload; },
  });

  assert.match(allText(waiting), /Creating Native project/);
  assert.match(allText(failed), /Project not created/);
  assert.match(allText(failed), /Nothing was saved/);
  assert.deepEqual(bottomButtons(failed).map((button) => button.label), [
    'Try creating project',
    'Back to details',
    'Cancel setup',
  ]);

  let details;
  await service.handleButton({
    ...baseInteraction(componentForAction(failed, PROJECT_SETUP_ACTIONS.BACK_DETAILS).custom_id),
    update: async (payload) => { details = payload; },
  });
  assert.match(allText(details), /Set the project details/);
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
