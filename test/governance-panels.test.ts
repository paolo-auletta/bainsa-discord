import assert from 'node:assert/strict';
import test from 'node:test';

import { ButtonStyle, ComponentType, MessageFlags } from 'discord.js';

import {
  createGovernancePanelService,
  GOVERNANCE_PANEL_ACTIONS,
} from '../src/services/governance/panels.js';

const ACTOR_ID = '100000000000000001';
const TARGET_ID = '100000000000000002';
const HEAD_ID = '100000000000000003';

function components(payload) {
  const queue = [...(payload.components ?? []).map((component) => component.toJSON?.() ?? component)];
  const values = [];
  while (queue.length > 0) {
    const component = queue.shift();
    values.push(component);
    if (component.components) queue.push(...component.components);
  }
  return values;
}

function action(payload, suffix) {
  const component = components(payload).find((candidate) => candidate.custom_id?.endsWith(`:${suffix}`));
  assert.ok(component, `Missing governance panel action ${suffix}`);
  return component;
}

function panelText(payload) {
  return components(payload)
    .filter((component) => component.type === ComponentType.TextDisplay)
    .map((component) => component.content)
    .join('\n');
}

function directComponents(payload) {
  const root = payload.components[0].toJSON?.() ?? payload.components[0];
  return root.type === ComponentType.Container ? root.components : payload.components;
}

function assertLabelImmediatelyBefore(payload, suffix, label) {
  const children = directComponents(payload);
  const rowIndex = children.findIndex((component) =>
    component.components?.some((candidate) => candidate.custom_id?.endsWith(`:${suffix}`)));
  assert.ok(rowIndex > 0, `Missing labeled control ${suffix}`);
  assert.equal(children[rowIndex - 1].type, ComponentType.TextDisplay);
  assert.match(children[rowIndex - 1].content, new RegExp(`^\\*\\*${label}\\*\\*`));
}

function fields(values) {
  return { getTextInputValue: (name) => values[name] ?? '' };
}

function channel(university = 'Bocconi') {
  return {
    name: 'bot-log',
    parent: { name: `BAINSA ${university}` },
    sent: [],
    async send(payload) { this.sent.push(payload); },
  };
}

function baseInteraction({ customId = null, actorId = ACTOR_ID, currentChannel = channel() } = {}) {
  return {
    customId,
    guildId: 'guild',
    user: { id: actorId },
    member: { roles: { cache: [{ name: 'Global President' }] } },
    channel: currentChannel,
  };
}

function service(overrides = {}) {
  return createGovernancePanelService({
    loadUniversities: async () => [
      { id: 'u1', name: 'Bocconi' },
      { id: 'u2', name: 'Sapienza' },
    ],
    loadDivisions: async (university) => university === 'Bocconi'
      ? [
          { id: 'd1', name: 'Research', color: 'blue' },
          { id: 'd2', name: 'Culture', color: 'pink' },
        ]
      : [{ id: 'd3', name: 'Events', color: 'yellow' }],
    createDivisionOperation: async () => assert.fail('unexpected division creation'),
    updateDivisionOperation: async () => assert.fail('unexpected division update'),
    updateMemberOperation: async () => assert.fail('unexpected member update'),
    loadMemberContext: async () => assert.fail('unexpected member lookup'),
    now: () => 1_000,
    ...overrides,
  });
}

test('division creation infers university scope and mutates only after the final review', async () => {
  let modal;
  let createdInput;
  const activityChannel = channel();
  const panels = service({
    createDivisionOperation: async (_interaction, input) => {
      createdInput = input;
      return {
        divisionName: input.divisionName,
        university: { name: input.university },
        head: input.head,
        textChannel: { id: 'text' },
        voiceChannel: { id: 'voice' },
      };
    },
  });

  await panels.startDivisionCreate({
    ...baseInteraction({ currentChannel: activityChannel }),
    async showModal(next) { modal = next.toJSON(); },
  });
  assert.equal(modal.title, 'Division setup · Name');

  let payload;
  await panels.handleModalSubmit({
    ...baseInteraction({ customId: modal.custom_id, currentChannel: activityChannel }),
    fields: fields({ division_name: 'Research and Insights' }),
    isFromMessage: () => false,
    async reply(next) { payload = next; },
  });
  assert.equal(payload.flags, MessageFlags.Ephemeral | MessageFlags.IsComponentsV2);
  assert.match(panelText(payload), /Set division access and spaces/);
  assert.doesNotMatch(panelText(payload), /Choose a university/);
  assertLabelImmediatelyBefore(payload, GOVERNANCE_PANEL_ACTIONS.DIVISION_CREATE_COLOR, 'Division color');
  assertLabelImmediatelyBefore(payload, GOVERNANCE_PANEL_ACTIONS.DIVISION_CREATE_HEAD, 'Initial Head');
  assertLabelImmediatelyBefore(payload, GOVERNANCE_PANEL_ACTIONS.DIVISION_CREATE_CHANNELS, 'Division spaces');
  assert.equal(createdInput, undefined);

  await panels.handleUserSelect({
    ...baseInteraction({
      customId: action(payload, GOVERNANCE_PANEL_ACTIONS.DIVISION_CREATE_HEAD).custom_id,
      currentChannel: activityChannel,
    }),
    values: [HEAD_ID],
    users: new Map([[HEAD_ID, { id: HEAD_ID, username: 'head' }]]),
    async update(next) { payload = next; },
  });
  await panels.handleButton({
    ...baseInteraction({
      customId: action(payload, GOVERNANCE_PANEL_ACTIONS.DIVISION_CREATE_REVIEW).custom_id,
      currentChannel: activityChannel,
    }),
    async update(next) { payload = next; },
  });
  assert.match(panelText(payload), /Review the new division/);
  assert.equal(createdInput, undefined);

  let waiting;
  let final;
  await panels.handleButton({
    ...baseInteraction({
      customId: action(payload, GOVERNANCE_PANEL_ACTIONS.DIVISION_CREATE_SAVE).custom_id,
      currentChannel: activityChannel,
    }),
    async update(next) { waiting = next; },
    async editReply(next) { final = next; },
  });
  assert.match(panelText(waiting), /Creating Research and Insights/);
  assert.match(panelText(final), /Division created/);
  assert.deepEqual(createdInput, {
    university: 'Bocconi',
    divisionName: 'Research and Insights',
    color: 'blue',
    head: { id: HEAD_ID, username: 'head' },
    createTextChannel: true,
    createVoiceChannel: true,
  });
  assert.equal(activityChannel.sent.length, 1);
});

test('division update confirms its target and treats case-only names as real changes', async () => {
  let updatedInput;
  const activityChannel = channel();
  const panels = service({
    updateDivisionOperation: async (_interaction, input) => {
      updatedInput = input;
      return {
        university: { name: input.university },
        oldName: input.currentName,
        newName: input.newName,
        oldColor: 'blue',
        newColor: input.color,
      };
    },
  });
  let payload;
  await panels.startDivisionUpdate({
    ...baseInteraction({ currentChannel: activityChannel }),
    async reply(next) { payload = next; },
  });
  assert.match(panelText(payload), /Update a division/);

  await panels.handleStringSelect({
    ...baseInteraction({
      customId: action(payload, GOVERNANCE_PANEL_ACTIONS.DIVISION_UPDATE_DIVISION).custom_id,
      currentChannel: activityChannel,
    }),
    values: ['d1'],
    async update(next) { payload = next; },
  });
  assert.match(panelText(payload), /Selected division[\s\S]*Research/);
  assert.doesNotMatch(panelText(payload), /Current name/);
  assert.equal(action(payload, GOVERNANCE_PANEL_ACTIONS.DIVISION_UPDATE_DIVISION_CONTINUE).disabled, false);

  await panels.handleButton({
    ...baseInteraction({
      customId: action(payload, GOVERNANCE_PANEL_ACTIONS.DIVISION_UPDATE_DIVISION_CONTINUE).custom_id,
      currentChannel: activityChannel,
    }),
    async update(next) { payload = next; },
  });
  assert.match(panelText(payload), /Current name[\s\S]*Research/);
  assert.match(panelText(payload), /Current color[\s\S]*Blue/);
  assert.doesNotMatch(panelText(payload), /Blue →/);
  assert.doesNotMatch(panelText(payload), /New name\n/);
  assertLabelImmediatelyBefore(payload, GOVERNANCE_PANEL_ACTIONS.DIVISION_UPDATE_NAME_OPEN, 'New name');
  assertLabelImmediatelyBefore(payload, GOVERNANCE_PANEL_ACTIONS.DIVISION_UPDATE_COLOR, 'New color');
  assert.match(action(payload, GOVERNANCE_PANEL_ACTIONS.DIVISION_UPDATE_BACK_SELECT).label, /Back to division/);

  let nameModal;
  await panels.handleButton({
    ...baseInteraction({
      customId: action(payload, GOVERNANCE_PANEL_ACTIONS.DIVISION_UPDATE_NAME_OPEN).custom_id,
      currentChannel: activityChannel,
    }),
    async showModal(next) { nameModal = next.toJSON(); },
  });
  assert.equal(nameModal.components[0].components[0].value, 'Research');
  await panels.handleModalSubmit({
    ...baseInteraction({ customId: nameModal.custom_id, currentChannel: activityChannel }),
    fields: fields({ division_name: 'RESEARCH' }),
    isFromMessage: () => true,
    async update(next) { payload = next; },
  });
  assert.match(panelText(payload), /Current name:[\s\S]*Research[\s\S]*→[\s\S]*RESEARCH/);
  assert.equal(action(payload, GOVERNANCE_PANEL_ACTIONS.DIVISION_UPDATE_REVIEW).disabled, false);

  await panels.handleStringSelect({
    ...baseInteraction({
      customId: action(payload, GOVERNANCE_PANEL_ACTIONS.DIVISION_UPDATE_COLOR).custom_id,
      currentChannel: activityChannel,
    }),
    values: ['green'],
    async update(next) { payload = next; },
  });
  assert.match(panelText(payload), /Current color[\s\S]*Blue[\s\S]*→[\s\S]*Green/);
  await panels.handleButton({
    ...baseInteraction({
      customId: action(payload, GOVERNANCE_PANEL_ACTIONS.DIVISION_UPDATE_REVIEW).custom_id,
      currentChannel: activityChannel,
    }),
    async update(next) { payload = next; },
  });
  assert.equal(updatedInput, undefined);

  await panels.handleButton({
    ...baseInteraction({
      customId: action(payload, GOVERNANCE_PANEL_ACTIONS.DIVISION_UPDATE_SAVE).custom_id,
      currentChannel: activityChannel,
    }),
    async update() {},
    async editReply() {},
  });
  assert.deepEqual(updatedInput, {
    university: 'Bocconi',
    currentName: 'Research',
    newName: 'RESEARCH',
    color: 'green',
  });
  assert.equal(activityChannel.sent.length, 1);
});

test('member update is member-first, preserves current defaults, and rechecks via the save operation', async () => {
  let savedInput;
  let lookupCount = 0;
  const activityChannel = channel();
  const context = {
    target: { id: TARGET_ID, user: { id: TARGET_ID, username: 'researcher' } },
    member: {
      discord_user_id: TARGET_ID,
      full_name: 'Test Researcher',
      member_type: 'researcher',
      university_id: 'u1',
      university_name: 'Bocconi',
      notes: 'Existing private note',
      status: 'active',
    },
    divisions: [{ id: 'd1', name: 'Research', color: 'blue' }],
    boardRoles: [{ role: 'head', division_name: 'Research' }],
    projects: [{ id: 'p1', name: 'Signals', role: 'member', status: 'active' }],
  };
  const panels = service({
    loadMemberContext: async (_interaction, input) => {
      lookupCount += 1;
      assert.equal(input.user.id, TARGET_ID);
      return context;
    },
    updateMemberOperation: async (_interaction, input) => {
      savedInput = input;
      return {
        target: context.target,
        university: { name: input.university },
        memberType: input.memberType,
        divisions: [],
        previousRecord: { member_type: 'researcher', university_name: 'Bocconi' },
        previousDivisions: context.divisions,
      };
    },
  });

  let payload;
  await panels.startMemberUpdate({
    ...baseInteraction({ currentChannel: activityChannel }),
    async reply(next) { payload = next; },
  });
  assert.match(panelText(payload), /Choose the member first/);
  assert.equal(action(payload, GOVERNANCE_PANEL_ACTIONS.MEMBER_UPDATE_TARGET).type, ComponentType.UserSelect);

  await panels.handleUserSelect({
    ...baseInteraction({
      customId: action(payload, GOVERNANCE_PANEL_ACTIONS.MEMBER_UPDATE_TARGET).custom_id,
      currentChannel: activityChannel,
    }),
    values: [TARGET_ID],
    users: new Map([[TARGET_ID, { id: TARGET_ID, username: 'researcher' }]]),
    async update(next) { payload = next; },
  });
  assert.equal(lookupCount, 0);
  assert.match(panelText(payload), /Selected member/);
  assert.equal(action(payload, GOVERNANCE_PANEL_ACTIONS.MEMBER_UPDATE_TARGET_CONTINUE).disabled, false);

  let loading;
  await panels.handleButton({
    ...baseInteraction({
      customId: action(payload, GOVERNANCE_PANEL_ACTIONS.MEMBER_UPDATE_TARGET_CONTINUE).custom_id,
      currentChannel: activityChannel,
    }),
    async update(next) { loading = next; },
    async editReply(next) { payload = next; },
  });
  assert.match(panelText(loading), /Update a member/);
  assert.doesNotMatch(panelText(loading), /Loading member information/);
  assert.equal(action(loading, GOVERNANCE_PANEL_ACTIONS.MEMBER_UPDATE_TARGET_CONTINUE).label, 'Loading…');
  assert.equal(action(loading, GOVERNANCE_PANEL_ACTIONS.MEMBER_UPDATE_TARGET_CONTINUE).disabled, true);
  assert.equal(action(loading, GOVERNANCE_PANEL_ACTIONS.MEMBER_UPDATE_TARGET).disabled, true);
  assert.equal(action(loading, GOVERNANCE_PANEL_ACTIONS.MEMBER_UPDATE_CANCEL).disabled, true);
  assert.equal(lookupCount, 1);
  assert.match(panelText(payload), /Test Researcher/);
  assert.match(panelText(payload), new RegExp(`Test Researcher \\(<@${TARGET_ID}>\\)`));
  assert.doesNotMatch(panelText(payload), /\[object Object\]/);
  assert.match(panelText(payload), /University:[\s\S]*Bocconi[\s\S]*Divisions:[\s\S]*Research/);
  assert.match(panelText(payload), /Board roles:[\s\S]*Head of Research/);
  assert.match(panelText(payload), /Active projects:[\s\S]*Signals/);
  assert.match(panelText(payload), /\*\*Member:\*\*[^\n]+\n\*\*Type:\*\*/);
  assert.match(panelText(payload), /\*\*Private notes\*\*/);
  assertLabelImmediatelyBefore(payload, GOVERNANCE_PANEL_ACTIONS.MEMBER_UPDATE_TYPE, 'Type');
  assertLabelImmediatelyBefore(payload, GOVERNANCE_PANEL_ACTIONS.MEMBER_UPDATE_DIVISIONS, 'Divisions');
  assert.ok(action(payload, GOVERNANCE_PANEL_ACTIONS.MEMBER_UPDATE_BACK_TARGET));
  const notesAction = action(payload, GOVERNANCE_PANEL_ACTIONS.MEMBER_UPDATE_NOTES_OPEN);
  assert.equal(notesAction.style, ButtonStyle.Primary);
  assert.doesNotMatch(panelText(payload), /Private governance context|never appears in \/member-info|Current state/);
  const divisionSelect = action(payload, GOVERNANCE_PANEL_ACTIONS.MEMBER_UPDATE_DIVISIONS);
  assert.equal(divisionSelect.options.find((option) => option.value === 'd1').default, true);

  await panels.handleStringSelect({
    ...baseInteraction({
      customId: divisionSelect.custom_id,
      currentChannel: activityChannel,
    }),
    values: [],
    async update(next) { payload = next; },
  });
  assert.match(panelText(payload), /Choose at least one division/);
  assert.equal(action(payload, GOVERNANCE_PANEL_ACTIONS.MEMBER_UPDATE_REVIEW).disabled, true);

  await panels.handleStringSelect({
    ...baseInteraction({
      customId: action(payload, GOVERNANCE_PANEL_ACTIONS.MEMBER_UPDATE_DIVISIONS).custom_id,
      currentChannel: activityChannel,
    }),
    values: ['d1'],
    async update(next) { payload = next; },
  });

  await panels.handleStringSelect({
    ...baseInteraction({
      customId: action(payload, GOVERNANCE_PANEL_ACTIONS.MEMBER_UPDATE_TYPE).custom_id,
      currentChannel: activityChannel,
    }),
    values: ['alumni'],
    async update(next) { payload = next; },
  });
  assert.match(panelText(payload), /Type[\s\S]*Researcher → Alumni/);
  assert.match(panelText(payload), /Divisions:[\s\S]*Research → Not applicable to Alumni/);

  let notesModal;
  await panels.handleButton({
    ...baseInteraction({
      customId: action(payload, GOVERNANCE_PANEL_ACTIONS.MEMBER_UPDATE_NOTES_OPEN).custom_id,
      currentChannel: activityChannel,
    }),
    async showModal(next) { notesModal = next.toJSON(); },
  });
  await panels.handleModalSubmit({
    ...baseInteraction({ customId: notesModal.custom_id, currentChannel: activityChannel }),
    fields: fields({ notes: 'Edited private note' }),
    isFromMessage: () => true,
    async update(next) { payload = next; },
  });
  assert.doesNotMatch(panelText(payload), /Private governance context|Current state/);
  await panels.handleButton({
    ...baseInteraction({
      customId: action(payload, GOVERNANCE_PANEL_ACTIONS.MEMBER_UPDATE_REVIEW).custom_id,
      currentChannel: activityChannel,
    }),
    async update(next) { payload = next; },
  });
  assert.match(panelText(payload), /1 active or paused project assignment/);
  assert.match(panelText(payload), /Private notes[\s\S]*Edited/);
  assert.equal(savedInput, undefined);

  await panels.handleButton({
    ...baseInteraction({
      customId: action(payload, GOVERNANCE_PANEL_ACTIONS.MEMBER_UPDATE_SAVE).custom_id,
      currentChannel: activityChannel,
    }),
    async update() {},
    async editReply(next) { payload = next; },
  });
  assert.equal(savedInput.user.id, TARGET_ID);
  assert.equal(savedInput.memberType, 'alumni');
  assert.equal(savedInput.university, 'Bocconi');
  assert.equal(savedInput.divisionsText, '');
  assert.equal(savedInput.notes, 'Edited private note');
  assert.equal(activityChannel.sent.length, 1);
});

test('governance panels are actor-bound before any staged operation can run', async () => {
  let payload;
  const panels = service();
  await panels.startMemberUpdate({
    ...baseInteraction(),
    async reply(next) { payload = next; },
  });
  await assert.rejects(
    () => panels.handleUserSelect({
      ...baseInteraction({
        customId: action(payload, GOVERNANCE_PANEL_ACTIONS.MEMBER_UPDATE_TARGET).custom_id,
        actorId: 'intruder',
      }),
      values: [TARGET_ID],
    }),
    /Only the person who started this setup can use it/,
  );
});
