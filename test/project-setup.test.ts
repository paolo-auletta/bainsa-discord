import assert from 'node:assert/strict';
import test from 'node:test';

import { ButtonStyle, ComponentType } from 'discord.js';

import {
  createProjectSetupService,
  PROJECT_SETUP_SELECTION_LIMIT,
} from '../src/services/projects/setup.js';

const MEMBER_ID = '111111111111111111';
const SUPERVISOR_ID = '222222222222222222';

function componentPayload(payload) {
  return payload.components.map((row) => row.toJSON());
}

function baseInteraction(customId = null) {
  return {
    customId,
    user: { id: 'actor' },
    guildId: 'guild',
    client: { user: { id: 'bot' } },
  };
}

test('project setup uses native user selectors and submits their selected IDs', async () => {
  let initialReply;
  let selectedPayload;
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
  const service = createProjectSetupService({
    createProject: async (input) => {
      createdInput = input;
      return result;
    },
    now: () => 1_000,
  });

  await service.start({
    ...baseInteraction(),
    reply: async (payload) => { initialReply = payload; },
  }, {
    name: result.name,
    university: 'Bocconi',
    division: 'Projects',
    startDate: result.start_date,
    expectedEnd: result.expected_end,
    notes: null,
  });

  const initialComponents = componentPayload(initialReply);
  const memberSelectId = initialComponents[0].components[0].custom_id;
  const supervisorSelectId = initialComponents[1].components[0].custom_id;
  assert.equal(initialComponents[0].components[0].type, ComponentType.UserSelect);
  assert.equal(initialComponents[0].components[0].max_values, PROJECT_SETUP_SELECTION_LIMIT);
  assert.equal(initialComponents[2].components[0].style, ButtonStyle.Success);
  assert.equal(initialComponents[2].components[0].disabled, true);

  await service.handleUserSelect({
    ...baseInteraction(memberSelectId),
    values: [MEMBER_ID],
    update: async (payload) => { selectedPayload = payload; },
  });
  let selectedComponents = componentPayload(selectedPayload);
  assert.equal(selectedComponents[2].components[0].disabled, true);

  await service.handleUserSelect({
    ...baseInteraction(supervisorSelectId),
    values: [SUPERVISOR_ID],
    update: async (payload) => { selectedPayload = payload; },
  });
  selectedComponents = componentPayload(selectedPayload);
  assert.equal(selectedComponents[2].components[0].disabled, false);

  const confirmId = selectedComponents[2].components[0].custom_id;
  await service.handleButton({
    ...baseInteraction(confirmId),
    member: { roles: { cache: [] } },
    channel: { send: async (payload) => { activity = payload; } },
    deferUpdate: async () => undefined,
    editReply: async (payload) => { finalReply = payload; },
  });

  assert.equal(createdInput.members, MEMBER_ID);
  assert.equal(createdInput.supervisors, SUPERVISOR_ID);
  assert.equal(createdInput.interaction.user.id, 'actor');
  assert.equal(activity.allowedMentions.parse.length, 0);
  assert.match(finalReply.content, /Created \*\*Native project\*\*/);
  assert.deepEqual(finalReply.components, []);
});

test('project setup rejects the Bot and cross-role duplicate selections', async () => {
  let reply;
  const service = createProjectSetupService({ createProject: async () => assert.fail('must not create') });
  await service.start({
    ...baseInteraction(),
    reply: async (payload) => { reply = payload; },
  }, {
    name: 'Safety', university: 'Bocconi', division: 'Projects',
    startDate: '2026-08-01', expectedEnd: '2026-09-01', notes: null,
  });
  const components = componentPayload(reply);

  await assert.rejects(
    () => service.handleUserSelect({
      ...baseInteraction(components[0].components[0].custom_id),
      client: { user: { id: 'bot' } },
      values: ['bot'],
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
