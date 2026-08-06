import assert from 'node:assert/strict';
import test from 'node:test';

import { ButtonStyle, ComponentType, MessageFlags } from 'discord.js';

import {
  createProjectSetupService,
  PROJECT_SETUP_SELECTION_LIMIT,
} from '../src/services/projects/setup.js';

const MEMBER_ID = '111111111111111111';
const SUPERVISOR_ID = '222222222222222222';
const BOT_ID = '999999999999999999';

function componentPayload(payload) {
  return payload.components.map((row) => row.toJSON());
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
  assert.equal(payload.flags, MessageFlags.Ephemeral);
  return payload;
}

async function chooseScope(service, initialPayload) {
  let payload;
  let components = componentPayload(initialPayload);
  await service.handleStringSelect({
    ...baseInteraction(components[0].components[0].custom_id),
    values: ['0'],
    update: async (next) => { payload = next; },
  });

  components = componentPayload(payload);
  await service.handleStringSelect({
    ...baseInteraction(components[1].components[0].custom_id),
    values: ['0'],
    update: async (next) => { payload = next; },
  });

  components = componentPayload(payload);
  await service.handleButton({
    ...baseInteraction(components[2].components[0].custom_id),
    update: async (next) => { payload = next; },
  });
  return payload;
}

async function chooseTeam(service, initialPayload) {
  let payload;
  let components = componentPayload(initialPayload);
  await service.handleUserSelect({
    ...baseInteraction(components[0].components[0].custom_id),
    values: [MEMBER_ID, MEMBER_ID],
    update: async (next) => { payload = next; },
  });

  components = componentPayload(payload);
  await service.handleUserSelect({
    ...baseInteraction(components[1].components[0].custom_id),
    values: [SUPERVISOR_ID],
    update: async (next) => { payload = next; },
  });
  return payload;
}

async function completeDetails(service, participantPayload) {
  let payload;
  let components = componentPayload(participantPayload);
  await service.handleButton({
    ...baseInteraction(components[2].components[0].custom_id),
    update: async (next) => { payload = next; },
  });

  components = componentPayload(payload);
  let datesModal;
  await service.handleButton({
    ...baseInteraction(components[0].components[0].custom_id),
    showModal: async (modal) => { datesModal = modal.toJSON(); },
  });
  await service.handleModalSubmit({
    ...baseInteraction(datesModal.custom_id),
    fields: fieldValues({ start_date: '2026-08-01', expected_end: '2026-09-01' }),
    isFromMessage: () => true,
    update: async (next) => { payload = next; },
  });

  components = componentPayload(payload);
  let notesModal;
  await service.handleButton({
    ...baseInteraction(components[0].components[1].custom_id),
    showModal: async (modal) => { notesModal = modal.toJSON(); },
  });
  await service.handleModalSubmit({
    ...baseInteraction(notesModal.custom_id),
    fields: fieldValues({ notes: 'Private context' }),
    isFromMessage: () => true,
    update: async (next) => { payload = next; },
  });

  components = componentPayload(payload);
  await service.handleButton({
    ...baseInteraction(components[0].components[2].custom_id),
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
  let components = componentPayload(scope);
  assert.equal(scope.embeds[0].data.title, result.name);
  assert.match(scope.embeds[0].data.author.name, /Step 2 of 5/);
  assert.equal(components[0].components[0].type, ComponentType.StringSelect);
  assert.equal(components[1].components[0].disabled, true);

  const participants = await chooseScope(service, scope);
  components = componentPayload(participants);
  assert.equal(participants.embeds[0].data.title, result.name);
  assert.match(participants.embeds[0].data.author.name, /Step 3 of 5/);
  assert.equal(components[0].components[0].type, ComponentType.UserSelect);
  assert.equal(components[1].components[0].type, ComponentType.UserSelect);
  assert.equal(components[0].components[0].max_values, PROJECT_SETUP_SELECTION_LIMIT);
  assert.equal(components[1].components[0].max_values, PROJECT_SETUP_SELECTION_LIMIT);
  assert.equal(components[2].components[0].disabled, true);

  const selected = await chooseTeam(service, participants);
  assert.equal(createdInput, undefined);
  assert.match(selected.embeds[0].data.fields[1].name, /Members · 1/);
  components = componentPayload(selected);
  assert.equal(components[2].components[0].disabled, false);

  const review = await completeDetails(service, selected);
  assert.equal(createdInput, undefined);
  assert.equal(review.embeds[0].data.title, result.name);
  assert.match(review.embeds[0].data.author.name, /Step 5 of 5/);
  assert.equal(review.embeds[0].data.color, 0x57f287);
  assert.match(review.embeds[0].data.fields.at(-1).value, /Private context/);

  components = componentPayload(review);
  assert.equal(components[0].components[0].style, ButtonStyle.Success);
  await service.handleButton({
    ...baseInteraction(components[0].components[0].custom_id),
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
  assert.match(finalReply.content, /Created \*\*Native project\*\*/);
  assert.deepEqual(finalReply.components, []);
});

test('project setup rejects the Bot and cross-role duplicate selections', async () => {
  const service = setupService();
  const participants = await chooseScope(service, await beginSetup(service, 'Safety'));
  const components = componentPayload(participants);

  await assert.rejects(
    () => service.handleUserSelect({
      ...baseInteraction(components[0].components[0].custom_id),
      values: [BOT_ID],
      update: async () => assert.fail('must not update'),
    }),
    /Bot member cannot be managed/,
  );

  await service.handleUserSelect({
    ...baseInteraction(components[0].components[0].custom_id),
    values: [MEMBER_ID],
    update: async () => undefined,
  });
  await assert.rejects(
    () => service.handleUserSelect({
      ...baseInteraction(components[1].components[0].custom_id),
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
  const cancelId = componentPayload(scope)[2].components[2].custom_id;

  await service.handleButton({
    ...baseInteraction(cancelId),
    update: async (payload) => { cancelled = payload; },
  });
  assert.equal(createCalls, 0);
  assert.equal(cancelled.content, 'Project setup cancelled. Nothing was created.');
  assert.deepEqual(cancelled.components, []);

  await assert.rejects(
    () => service.handleButton({ ...baseInteraction(cancelId), update: async () => undefined }),
    /expired/,
  );
});

test('project setup rejects unauthorized and expired interactions safely', async () => {
  let currentTime = 1_000;
  const service = setupService({ now: () => currentTime });
  const scope = await beginSetup(service, 'Protected');
  const universityId = componentPayload(scope)[0].components[0].custom_id;

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
