import assert from 'node:assert/strict';
import test from 'node:test';

import { ComponentType, MessageFlags } from 'discord.js';

import {
  createGovernanceMembershipPanelService,
  GOVERNANCE_MEMBERSHIP_PANEL_ACTIONS,
} from '../src/services/governance/membership-panels.js';

const ACTOR_ID = '100000000000000001';
const TARGET_ID = '100000000000000002';

function roleCache(names) {
  return names.map((name) => ({ name }));
}

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
  assert.ok(component, `Missing governance membership action ${suffix}`);
  return component;
}

function maybeAction(payload, suffix) {
  return components(payload).find((candidate) => candidate.custom_id?.endsWith(`:${suffix}`)) ?? null;
}

function panelText(payload) {
  return components(payload)
    .filter((component) => component.type === ComponentType.TextDisplay)
    .map((component) => component.content)
    .join('\n');
}

function channel(university = 'Bocconi') {
  return {
    id: 'bot-log',
    name: 'bot-log',
    parent: { name: `BAINSA ${university}` },
  };
}

function baseInteraction({
  customId = null,
  actorId = ACTOR_ID,
  roles = ['Bocconi - President'],
  currentChannel = channel(),
} = {}) {
  return {
    customId,
    guildId: 'guild',
    user: { id: actorId },
    member: { roles: { cache: roleCache(roles) } },
    channel: currentChannel,
  };
}

function targetMember(roleNames = ['Researcher', 'Bocconi']) {
  return {
    id: TARGET_ID,
    displayName: 'Ada',
    user: { id: TARGET_ID, username: 'ada' },
    roles: { cache: roleCache(roleNames) },
  };
}

function memberContext({
  target = targetMember(),
  memberType = 'researcher',
  divisions = [],
  boardRoles = [],
  projects = [],
} = {}) {
  return {
    target,
    member: {
      discord_user_id: TARGET_ID,
      full_name: 'Ada Lovelace',
      member_type: memberType,
      university_id: 'u1',
      university_name: 'Bocconi',
      status: 'active',
    },
    divisions,
    boardRoles,
    projects,
  };
}

function service(overrides = {}) {
  return createGovernanceMembershipPanelService({
    loadUniversities: async () => [{ id: 'u1', name: 'Bocconi' }],
    loadDivisions: async () => [
      { id: 'd-projects', name: 'Projects', color: 'blue' },
      { id: 'd-analysis', name: 'Analysis', color: 'orange' },
      { id: 'd-culture', name: 'Culture', color: 'pink' },
    ],
    loadMemberContext: async () => assert.fail('unexpected member lookup'),
    loadBoardAssignments: async () => [],
    addBoardMemberOperation: async () => assert.fail('unexpected board addition'),
    removeBoardMemberOperation: async () => assert.fail('unexpected board removal'),
    addDivisionMemberOperation: async () => assert.fail('unexpected division addition'),
    removeDivisionMemberOperation: async () => assert.fail('unexpected division removal'),
    formatActivity: (commandName) => ({ content: commandName }),
    postActivity: async () => ({ status: 'posted' }),
    sendHandoff: async () => undefined,
    ...overrides,
  });
}

async function chooseMember(panels, start, interactionOptions = {}) {
  let payload;
  await start({
    ...baseInteraction(interactionOptions),
    async reply(next) { payload = next; },
  });
  assert.equal(payload.flags, MessageFlags.Ephemeral | MessageFlags.IsComponentsV2);

  await panels.handleUserSelect({
    ...baseInteraction({
      ...interactionOptions,
      customId: action(payload, GOVERNANCE_MEMBERSHIP_PANEL_ACTIONS.TARGET).custom_id,
    }),
    values: [TARGET_ID],
    users: new Map([[TARGET_ID, { id: TARGET_ID, username: 'ada' }]]),
    async update(next) { payload = next; },
  });
  return payload;
}

test('board add member is member-first, derives university, filters occupied roles, and saves only after review', async () => {
  let operationInput;
  let activityCommand;
  let handoff;
  const context = memberContext({
    divisions: [{ id: 'd-culture', name: 'Culture', color: 'pink' }],
    boardRoles: [{
      role: 'head',
      university_name: 'Bocconi',
      division_id: 'd-culture',
      division_name: 'Culture',
    }],
  });
  const panels = service({
    loadMemberContext: async () => context,
    loadBoardAssignments: async () => [
      { discord_user_id: 'other-vp', role: 'vice_president', division_name: null },
      { discord_user_id: 'other-head', role: 'head', division_name: 'Analysis' },
      { discord_user_id: TARGET_ID, role: 'head', division_name: 'Culture' },
    ],
    addBoardMemberOperation: async (_interaction, input) => {
      operationInput = input;
      return {
        target: context.target,
        university: { name: input.university },
        role: input.role,
        division: { name: input.division },
      };
    },
    formatActivity: (commandName) => {
      activityCommand = commandName;
      return { content: commandName };
    },
    sendHandoff: async (_target, payload) => { handoff = payload; },
  });

  let payload = await chooseMember(panels, panels.startBoardAddMember);
  assert.match(panelText(payload), /Selected member/);
  assert.equal(operationInput, undefined);

  let loading;
  await panels.handleButton({
    ...baseInteraction({
      customId: action(payload, GOVERNANCE_MEMBERSHIP_PANEL_ACTIONS.TARGET_CONTINUE).custom_id,
    }),
    async update(next) { loading = next; },
    async editReply(next) { payload = next; },
  });
  assert.equal(action(loading, GOVERNANCE_MEMBERSHIP_PANEL_ACTIONS.TARGET).disabled, true);
  assert.equal(action(loading, GOVERNANCE_MEMBERSHIP_PANEL_ACTIONS.TARGET_CONTINUE).label, 'Loading…');
  assert.match(panelText(payload), /Current board roles/);

  const roleSelect = action(payload, GOVERNANCE_MEMBERSHIP_PANEL_ACTIONS.ROLE);
  assert.deepEqual(roleSelect.options.map((option) => option.value), ['head', 'president']);
  await panels.handleStringSelect({
    ...baseInteraction({ customId: roleSelect.custom_id }),
    values: ['head'],
    async update(next) { payload = next; },
  });
  const divisionSelect = action(payload, GOVERNANCE_MEMBERSHIP_PANEL_ACTIONS.DIVISION);
  assert.deepEqual(divisionSelect.options.map((option) => option.value), ['d-projects']);
  await panels.handleStringSelect({
    ...baseInteraction({ customId: divisionSelect.custom_id }),
    values: ['d-projects'],
    async update(next) { payload = next; },
  });
  await panels.handleButton({
    ...baseInteraction({ customId: action(payload, GOVERNANCE_MEMBERSHIP_PANEL_ACTIONS.REVIEW).custom_id }),
    async update(next) { payload = next; },
  });
  assert.match(panelText(payload), /Displaced assignments[\s\S]*Head of Culture/);
  assert.match(panelText(payload), /Division access after confirmation[\s\S]*Projects/);
  assert.equal(operationInput, undefined);

  const saveId = action(payload, GOVERNANCE_MEMBERSHIP_PANEL_ACTIONS.SAVE).custom_id;
  await panels.handleButton({
    ...baseInteraction({ customId: saveId }),
    async update() {},
    async editReply(next) { payload = next; },
  });
  assert.deepEqual(operationInput, {
    user: { id: TARGET_ID, username: 'ada' },
    university: 'Bocconi',
    role: 'head',
    division: 'Projects',
  });
  assert.equal(activityCommand, 'board-add-member');
  assert.match(handoff.content, /Head of Projects/);
  assert.match(panelText(payload), /Access added/);
  await assert.rejects(
    () => panels.handleButton({ ...baseInteraction({ customId: saveId }) }),
    /expired/,
  );
});

test('board remove member lists multiple assignments, supports explicit all-Heads removal, and keeps the reason private', async () => {
  let operationInput;
  let activityInput;
  let handoff;
  const context = memberContext({
    divisions: [
      { id: 'd-projects', name: 'Projects', color: 'blue' },
      { id: 'd-analysis', name: 'Analysis', color: 'orange' },
    ],
    boardRoles: [
      { role: 'head', university_name: 'Bocconi', division_id: 'd-projects', division_name: 'Projects' },
      { role: 'head', university_name: 'Bocconi', division_id: 'd-analysis', division_name: 'Analysis' },
      { role: 'vice_president', university_name: 'Bocconi', division_id: null, division_name: null },
      { role: 'president', university_name: 'Sapienza', division_id: null, division_name: null },
    ],
  });
  const panels = service({
    loadMemberContext: async () => context,
    removeBoardMemberOperation: async (_interaction, input) => {
      operationInput = input;
      return {
        target: context.target,
        university: { name: input.university },
        role: input.role,
        division: null,
      };
    },
    formatActivity: (commandName, input) => {
      activityInput = { commandName, input };
      return { content: commandName };
    },
    sendHandoff: async (_target, payload) => { handoff = payload; },
  });
  const interactionOptions = { roles: ['Bocconi - Vice President'] };
  let payload = await chooseMember(panels, panels.startBoardRemoveMember, interactionOptions);
  await panels.handleButton({
    ...baseInteraction({
      ...interactionOptions,
      customId: action(payload, GOVERNANCE_MEMBERSHIP_PANEL_ACTIONS.TARGET_CONTINUE).custom_id,
    }),
    async update() {},
    async editReply(next) { payload = next; },
  });
  assert.match(panelText(payload), /President · Sapienza — Read only/);
  const assignments = action(payload, GOVERNANCE_MEMBERSHIP_PANEL_ACTIONS.ASSIGNMENT);
  assert.deepEqual(
    assignments.options.map((option) => option.label),
    ['All Head roles', 'Head of Projects', 'Head of Analysis', 'Vice President'],
  );
  await panels.handleStringSelect({
    ...baseInteraction({ ...interactionOptions, customId: assignments.custom_id }),
    values: ['hall'],
    async update(next) { payload = next; },
  });

  let modal;
  await panels.handleButton({
    ...baseInteraction({
      ...interactionOptions,
      customId: action(payload, GOVERNANCE_MEMBERSHIP_PANEL_ACTIONS.REASON_OPEN).custom_id,
    }),
    async showModal(next) { modal = next.toJSON(); },
  });
  await panels.handleModalSubmit({
    ...baseInteraction({ ...interactionOptions, customId: modal.custom_id }),
    fields: { getTextInputValue: () => 'Term completed' },
    isFromMessage: () => true,
    async update(next) { payload = next; },
  });
  await panels.handleButton({
    ...baseInteraction({
      ...interactionOptions,
      customId: action(payload, GOVERNANCE_MEMBERSHIP_PANEL_ACTIONS.REVIEW).custom_id,
    }),
    async update(next) { payload = next; },
  });
  assert.match(panelText(payload), /All Head roles/);
  assert.doesNotMatch(panelText(payload), /Term completed/);

  await panels.handleButton({
    ...baseInteraction({
      ...interactionOptions,
      customId: action(payload, GOVERNANCE_MEMBERSHIP_PANEL_ACTIONS.SAVE).custom_id,
    }),
    async update() {},
    async editReply(next) { payload = next; },
  });
  assert.deepEqual(operationInput, {
    user: { id: TARGET_ID, username: 'ada' },
    university: 'Bocconi',
    role: 'head',
    division: null,
    reason: 'Term completed',
  });
  assert.equal(activityInput.commandName, 'board-remove-member');
  assert.equal(JSON.stringify(activityInput.input).includes('Term completed'), false);
  assert.match(handoff.content, /Term completed/);
});

test('a Vice President is blocked after confirming a President target', async () => {
  const context = memberContext({
    target: targetMember(['Researcher', 'Bocconi', 'Bocconi - President']),
    boardRoles: [{ role: 'president', university_name: 'Bocconi', division_id: null, division_name: null }],
  });
  const panels = service({ loadMemberContext: async () => context });
  const interactionOptions = { roles: ['Bocconi - Vice President'] };
  let payload = await chooseMember(panels, panels.startBoardRemoveMember, interactionOptions);
  await panels.handleButton({
    ...baseInteraction({
      ...interactionOptions,
      customId: action(payload, GOVERNANCE_MEMBERSHIP_PANEL_ACTIONS.TARGET_CONTINUE).custom_id,
    }),
    async update() {},
    async editReply(next) { payload = next; },
  });
  assert.match(panelText(payload), /Vice President cannot manage their university President/);
  assert.equal(action(payload, GOVERNANCE_MEMBERSHIP_PANEL_ACTIONS.TARGET).disabled, false);
});

test('division panels recheck caller authority and reject the Bot target', async () => {
  const panels = service({
    loadMemberContext: async () => memberContext({ target: targetMember(['Bot']) }),
  });

  await assert.rejects(
    panels.startDivisionAddMember({
      ...baseInteraction({ roles: ['Researcher'] }),
      async reply() { assert.fail('an ordinary member must not receive a management panel'); },
    }),
    /Only a board member of Bocconi/,
  );

  const interactionOptions = { roles: ['Bocconi - Head of Projects'] };
  let payload = await chooseMember(panels, panels.startDivisionAddMember, interactionOptions);
  await panels.handleButton({
    ...baseInteraction({
      ...interactionOptions,
      customId: action(payload, GOVERNANCE_MEMBERSHIP_PANEL_ACTIONS.TARGET_CONTINUE).custom_id,
    }),
    async update() {},
    async editReply(next) { payload = next; },
  });
  assert.match(panelText(payload), /Bot member cannot be managed/);
});

test('division remove member shows every division but offers only the Head-owned removable role', async () => {
  let operationInput;
  const context = memberContext({
    divisions: [
      { id: 'd-analysis', name: 'Analysis', color: 'orange' },
      { id: 'd-projects', name: 'Projects', color: 'blue' },
    ],
  });
  const panels = service({
    loadMemberContext: async () => context,
    removeDivisionMemberOperation: async (_interaction, input) => {
      operationInput = input;
      return {
        target: context.target,
        university: { name: input.university },
        division: { name: input.division },
      };
    },
  });
  const interactionOptions = { roles: ['Bocconi - Head of Projects'] };
  let payload = await chooseMember(panels, panels.startDivisionRemoveMember, interactionOptions);
  await panels.handleButton({
    ...baseInteraction({
      ...interactionOptions,
      customId: action(payload, GOVERNANCE_MEMBERSHIP_PANEL_ACTIONS.TARGET_CONTINUE).custom_id,
    }),
    async update() {},
    async editReply(next) { payload = next; },
  });
  assert.match(panelText(payload), /Analysis[\s\S]*Read only outside your scope/);
  assert.match(panelText(payload), /Projects[\s\S]*Removable/);
  const divisions = action(payload, GOVERNANCE_MEMBERSHIP_PANEL_ACTIONS.DIVISION);
  assert.deepEqual(divisions.options.map((option) => option.value), ['d-projects']);

  await panels.handleStringSelect({
    ...baseInteraction({ ...interactionOptions, customId: divisions.custom_id }),
    values: ['d-projects'],
    async update(next) { payload = next; },
  });
  await panels.handleButton({
    ...baseInteraction({
      ...interactionOptions,
      customId: action(payload, GOVERNANCE_MEMBERSHIP_PANEL_ACTIONS.REVIEW).custom_id,
    }),
    async update(next) { payload = next; },
  });
  assert.match(panelText(payload), /Divisions after confirmation[\s\S]*Analysis/);
  await panels.handleButton({
    ...baseInteraction({
      ...interactionOptions,
      customId: action(payload, GOVERNANCE_MEMBERSHIP_PANEL_ACTIONS.SAVE).custom_id,
    }),
    async update() {},
    async editReply(next) { payload = next; },
  });
  assert.equal(operationInput.division, 'Projects');
});

test('division removal explains project and last-division blockers before review', async () => {
  const projectBlocked = memberContext({
    divisions: [
      { id: 'd-projects', name: 'Projects', color: 'blue' },
      { id: 'd-analysis', name: 'Analysis', color: 'orange' },
    ],
    projects: [{ id: 'p1', name: 'Signals', role: 'member', division_id: 'd-projects', division_name: 'Projects' }],
  });
  const panels = service({ loadMemberContext: async () => projectBlocked });
  let payload = await chooseMember(panels, panels.startDivisionRemoveMember);
  await panels.handleButton({
    ...baseInteraction({ customId: action(payload, GOVERNANCE_MEMBERSHIP_PANEL_ACTIONS.TARGET_CONTINUE).custom_id }),
    async update() {},
    async editReply(next) { payload = next; },
  });
  assert.match(panelText(payload), /Projects[\s\S]*Blocked:[\s\S]*Signals/);
  assert.deepEqual(
    action(payload, GOVERNANCE_MEMBERSHIP_PANEL_ACTIONS.DIVISION).options.map((option) => option.value),
    ['d-analysis'],
  );

  const lastDivision = memberContext({
    divisions: [{ id: 'd-projects', name: 'Projects', color: 'blue' }],
  });
  const lastPanels = service({ loadMemberContext: async () => lastDivision });
  payload = await chooseMember(lastPanels, lastPanels.startDivisionRemoveMember);
  await lastPanels.handleButton({
    ...baseInteraction({ customId: action(payload, GOVERNANCE_MEMBERSHIP_PANEL_ACTIONS.TARGET_CONTINUE).custom_id }),
    async update() {},
    async editReply(next) { payload = next; },
  });
  assert.match(panelText(payload), /must keep at least one division/);
  assert.equal(maybeAction(payload, GOVERNANCE_MEMBERSHIP_PANEL_ACTIONS.DIVISION), null);
  assert.equal(action(payload, GOVERNANCE_MEMBERSHIP_PANEL_ACTIONS.REVIEW).disabled, true);
});

test('division add member lists only non-member divisions inside the caller Head scope', async () => {
  let operationInput;
  const context = memberContext({
    divisions: [{ id: 'd-analysis', name: 'Analysis', color: 'orange' }],
  });
  const panels = service({
    loadMemberContext: async () => context,
    addDivisionMemberOperation: async (_interaction, input) => {
      operationInput = input;
      return {
        target: context.target,
        university: { name: input.university },
        division: { name: input.division },
      };
    },
  });
  const interactionOptions = { roles: ['Bocconi - Head of Projects'] };
  let payload = await chooseMember(panels, panels.startDivisionAddMember, interactionOptions);
  await panels.handleButton({
    ...baseInteraction({
      ...interactionOptions,
      customId: action(payload, GOVERNANCE_MEMBERSHIP_PANEL_ACTIONS.TARGET_CONTINUE).custom_id,
    }),
    async update() {},
    async editReply(next) { payload = next; },
  });
  assert.match(panelText(payload), /Analysis — Current/);
  const divisions = action(payload, GOVERNANCE_MEMBERSHIP_PANEL_ACTIONS.DIVISION);
  assert.deepEqual(divisions.options.map((option) => option.value), ['d-projects']);
  await panels.handleStringSelect({
    ...baseInteraction({ ...interactionOptions, customId: divisions.custom_id }),
    values: ['d-projects'],
    async update(next) { payload = next; },
  });
  await panels.handleButton({
    ...baseInteraction({
      ...interactionOptions,
      customId: action(payload, GOVERNANCE_MEMBERSHIP_PANEL_ACTIONS.REVIEW).custom_id,
    }),
    async update(next) { payload = next; },
  });
  await panels.handleButton({
    ...baseInteraction({
      ...interactionOptions,
      customId: action(payload, GOVERNANCE_MEMBERSHIP_PANEL_ACTIONS.SAVE).custom_id,
    }),
    async update() {},
    async editReply(next) { payload = next; },
  });
  assert.equal(operationInput.division, 'Projects');
});

test('governance membership panels are actor-bound and cancellation invalidates the session', async () => {
  const panels = service();
  let payload;
  await panels.startDivisionAddMember({
    ...baseInteraction({ roles: ['Bocconi - Head of Projects'] }),
    async reply(next) { payload = next; },
  });
  const targetId = action(payload, GOVERNANCE_MEMBERSHIP_PANEL_ACTIONS.TARGET).custom_id;
  await assert.rejects(
    () => panels.handleUserSelect({
      ...baseInteraction({
        customId: targetId,
        actorId: 'intruder',
        roles: ['Bocconi - Head of Projects'],
      }),
      values: [TARGET_ID],
    }),
    /Only the person who started this setup can use it/,
  );
  const cancelId = action(payload, GOVERNANCE_MEMBERSHIP_PANEL_ACTIONS.CANCEL).custom_id;
  await panels.handleButton({
    ...baseInteraction({ customId: cancelId, roles: ['Bocconi - Head of Projects'] }),
    async update(next) { payload = next; },
  });
  assert.match(panelText(payload), /cancelled/);
  await assert.rejects(
    () => panels.handleButton({
      ...baseInteraction({ customId: cancelId, roles: ['Bocconi - Head of Projects'] }),
    }),
    /expired/,
  );
});

test('a committed change reports delivery failures without exposing an unsafe retry', async () => {
  const context = memberContext({
    divisions: [
      { id: 'd-analysis', name: 'Analysis', color: 'orange' },
      { id: 'd-projects', name: 'Projects', color: 'blue' },
    ],
  });
  const panels = service({
    loadMemberContext: async () => context,
    removeDivisionMemberOperation: async (_interaction, input) => ({
      target: context.target,
      university: { name: input.university },
      division: { name: input.division },
    }),
    postActivity: async () => ({ status: 'failed' }),
    sendHandoff: async () => { throw new Error('DM disabled'); },
  });
  let payload = await chooseMember(panels, panels.startDivisionRemoveMember);
  await panels.handleButton({
    ...baseInteraction({ customId: action(payload, GOVERNANCE_MEMBERSHIP_PANEL_ACTIONS.TARGET_CONTINUE).custom_id }),
    async update() {},
    async editReply(next) { payload = next; },
  });
  const divisions = action(payload, GOVERNANCE_MEMBERSHIP_PANEL_ACTIONS.DIVISION);
  await panels.handleStringSelect({
    ...baseInteraction({ customId: divisions.custom_id }),
    values: ['d-projects'],
    async update(next) { payload = next; },
  });
  await panels.handleButton({
    ...baseInteraction({ customId: action(payload, GOVERNANCE_MEMBERSHIP_PANEL_ACTIONS.REVIEW).custom_id }),
    async update(next) { payload = next; },
  });
  await panels.handleButton({
    ...baseInteraction({ customId: action(payload, GOVERNANCE_MEMBERSHIP_PANEL_ACTIONS.SAVE).custom_id }),
    async update() {},
    async editReply(next) { payload = next; },
  });
  assert.match(panelText(payload), /governance change was saved/i);
  assert.match(panelText(payload), /activity card could not be posted/i);
  assert.match(panelText(payload), /could not be reached by DM/i);
  assert.equal(components(payload).some((component) => component.custom_id), false);
});
