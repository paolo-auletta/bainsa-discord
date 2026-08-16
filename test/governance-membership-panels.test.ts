import assert from 'node:assert/strict';
import test from 'node:test';

import { ButtonStyle, ComponentType, MessageFlags } from 'discord.js';

import {
  createGovernanceMembershipPanelService,
  GOVERNANCE_MEMBERSHIP_PANEL_ACTIONS,
} from '../src/services/governance/membership-panels.js';
import { UserFacingError } from '../src/errors.js';

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
  assert.ok(component, `Missing division membership action ${suffix}`);
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

function baseInteraction({ customId = null, roles = ['Bocconi - President'], actorId = ACTOR_ID } = {}) {
  return {
    customId,
    guildId: 'guild',
    user: { id: actorId },
    member: { roles: { cache: roleCache(roles) } },
    channel: { name: 'bot-log', parent: { name: 'BAINSA Bocconi' } },
  };
}

function context({ divisions = [], boardRoles = [], projects = [], memberType = 'researcher', targetRoles = ['Researcher', 'Bocconi'] } = {}) {
  const target = {
    id: TARGET_ID,
    user: { id: TARGET_ID, username: 'ada' },
    roles: { cache: roleCache(targetRoles) },
  };
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

const allDivisions = [
  { id: 'd-analysis', name: 'Analysis', color: 'orange' },
  { id: 'd-projects', name: 'Projects', color: 'blue' },
  { id: 'd-culture', name: 'Culture', color: 'pink' },
];

function service(overrides = {}) {
  return createGovernanceMembershipPanelService({
    loadUniversities: async () => [{ id: 'u1', name: 'Bocconi' }],
    loadDivisions: async () => allDivisions,
    loadMemberContext: async () => assert.fail('unexpected member lookup'),
    addDivisionMemberOperation: async () => assert.fail('unexpected division addition'),
    removeDivisionMemberOperation: async () => assert.fail('unexpected division removal'),
    formatActivity: (commandName) => ({ content: commandName }),
    postActivity: async () => ({ status: 'posted', channel: null }),
    sendHandoff: async () => undefined,
    ...overrides,
  });
}

async function loadMember(panel, start, interactionOptions = {}) {
  let payload;
  await start({
    ...baseInteraction(interactionOptions),
    async reply(next) { payload = next; },
  });
  assert.equal(payload.flags, MessageFlags.Ephemeral | MessageFlags.IsComponentsV2);
  await panel.handleUserSelect({
    ...baseInteraction({ ...interactionOptions, customId: action(payload, GOVERNANCE_MEMBERSHIP_PANEL_ACTIONS.TARGET).custom_id }),
    values: [TARGET_ID],
    users: new Map([[TARGET_ID, { id: TARGET_ID, username: 'ada' }]]),
    async update(next) { payload = next; },
  });
  await panel.handleButton({
    ...baseInteraction({ ...interactionOptions, customId: action(payload, GOVERNANCE_MEMBERSHIP_PANEL_ACTIONS.TARGET_CONTINUE).custom_id }),
    async update() {},
    async editReply(next) { payload = next; },
  });
  return payload;
}

test('division removal shows all memberships, scopes the selector, and previews current-to-new affiliation', async () => {
  let operationInput;
  const member = context({ divisions: [allDivisions[0], allDivisions[1]] });
  const panel = service({
    loadMemberContext: async () => member,
    removeDivisionMemberOperation: async (_interaction, input) => {
      operationInput = input;
      return { target: member.target, university: { name: 'Bocconi' }, division: { name: input.division } };
    },
  });
  const options = { roles: ['Bocconi - Head of Projects'] };
  let payload = await loadMember(panel, panel.startDivisionRemoveMember, options);
  assert.match(panelText(payload), /Analysis[\s\S]*Outside your scope/);
  assert.match(panelText(payload), /Projects[\s\S]*Can remove/);
  assert.match(panelText(payload), /\*\*Active projects:\*\*[\s\S]*\n\n\*\*Current division memberships:\*\*\n•/);
  const selector = action(payload, GOVERNANCE_MEMBERSHIP_PANEL_ACTIONS.DIVISION);
  assert.deepEqual(selector.options.map((option) => option.value), ['d-projects']);

  await panel.handleStringSelect({
    ...baseInteraction({ ...options, customId: selector.custom_id }),
    values: ['d-projects'],
    async update(next) { payload = next; },
  });
  assert.match(panelText(payload), /\*\*Divisions:\*\*[^\n]*Analysis[^\n]*Projects →[^\n]*Analysis/);
  await panel.handleButton({
    ...baseInteraction({ ...options, customId: action(payload, GOVERNANCE_MEMBERSHIP_PANEL_ACTIONS.REVIEW).custom_id }),
    async update(next) { payload = next; },
  });
  assert.match(panelText(payload), /Review division removal/);
  assert.match(panelText(payload), /\*\*Member:\*\*[\s\S]*Ada Lovelace/);
  assert.match(panelText(payload), /\*\*University:\*\* Bocconi/);
  assert.match(panelText(payload), /\*\*Division being removed:\*\* 🟦 Projects/);
  assert.match(panelText(payload), /\*\*Division memberships:\*\*\n🟧 Analysis, 🟦 Projects → 🟧 Analysis/);
  assert.equal(action(payload, GOVERNANCE_MEMBERSHIP_PANEL_ACTIONS.SAVE).label, 'Remove member from division');
  assert.equal(action(payload, GOVERNANCE_MEMBERSHIP_PANEL_ACTIONS.CANCEL).style, ButtonStyle.Danger);
  await panel.handleButton({
    ...baseInteraction({ ...options, customId: action(payload, GOVERNANCE_MEMBERSHIP_PANEL_ACTIONS.SAVE).custom_id }),
    async update() {},
    async editReply(next) { payload = next; },
  });
  assert.equal(operationInput.division, 'Projects');
});

test('division addition previews the new affiliation and saves only after review', async () => {
  let operationInput;
  const member = context({ divisions: [allDivisions[0]] });
  const panel = service({
    loadMemberContext: async () => member,
    addDivisionMemberOperation: async (_interaction, input) => {
      operationInput = input;
      return { target: member.target, university: { name: 'Bocconi' }, division: { name: input.division } };
    },
  });
  let payload = await loadMember(panel, panel.startDivisionAddMember);
  const selector = action(payload, GOVERNANCE_MEMBERSHIP_PANEL_ACTIONS.DIVISION);
  await panel.handleStringSelect({
    ...baseInteraction({ customId: selector.custom_id }),
    values: ['d-culture'],
    async update(next) { payload = next; },
  });
  assert.match(panelText(payload), /\*\*Divisions:\*\*[^\n]*Analysis →[^\n]*Analysis[^\n]*Culture/);
  assert.doesNotMatch(panelText(payload), /Current division memberships/);
  assert.equal(operationInput, undefined);
  await panel.handleButton({
    ...baseInteraction({ customId: action(payload, GOVERNANCE_MEMBERSHIP_PANEL_ACTIONS.REVIEW).custom_id }),
    async update(next) { payload = next; },
  });
  assert.match(panelText(payload), /Review division addition/);
  assert.match(panelText(payload), /\*\*Division being added:\*\* 🟪 Culture/);
  assert.match(panelText(payload), /\*\*Division memberships:\*\*\n🟧 Analysis → 🟧 Analysis, 🟪 Culture/);
  assert.equal(action(payload, GOVERNANCE_MEMBERSHIP_PANEL_ACTIONS.SAVE).label, 'Add member to division');
  await panel.handleButton({
    ...baseInteraction({ customId: action(payload, GOVERNANCE_MEMBERSHIP_PANEL_ACTIONS.SAVE).custom_id }),
    async update() {},
    async editReply(next) { payload = next; },
  });
  assert.equal(operationInput.division, 'Culture');
});

test('a denied division change preserves the proposed membership and directs the actor back to safe choices', async () => {
  const member = context({ divisions: [allDivisions[0]] });
  const panel = service({
    loadMemberContext: async () => member,
    addDivisionMemberOperation: async () => {
      throw new UserFacingError('Only a board member of Bocconi can manage this division membership.');
    },
  });
  let payload = await loadMember(panel, panel.startDivisionAddMember);
  await panel.handleStringSelect({
    ...baseInteraction({ customId: action(payload, GOVERNANCE_MEMBERSHIP_PANEL_ACTIONS.DIVISION).custom_id }),
    values: ['d-culture'],
    async update(next) { payload = next; },
  });
  await panel.handleButton({
    ...baseInteraction({ customId: action(payload, GOVERNANCE_MEMBERSHIP_PANEL_ACTIONS.REVIEW).custom_id }),
    async update(next) { payload = next; },
  });
  await panel.handleButton({
    ...baseInteraction({ customId: action(payload, GOVERNANCE_MEMBERSHIP_PANEL_ACTIONS.SAVE).custom_id }),
    async update() {},
    async editReply(next) { payload = next; },
  });

  assert.match(panelText(payload), /Division membership not changed/);
  assert.match(panelText(payload), /Only a board member of Bocconi/);
  assert.match(panelText(payload), /What was preserved[\s\S]*No division membership was changed/);
  assert.match(panelText(payload), /How to correct it[\s\S]*valid in-scope option/);
  assert.match(panelText(payload), /Where to continue[\s\S]*return to division choices/);
  assert.equal(action(payload, GOVERNANCE_MEMBERSHIP_PANEL_ACTIONS.BACK_CHOICE).label, 'Back to choices');
});

test('division removal explains project and last-division blockers before review', async () => {
  const member = context({
    divisions: [allDivisions[0], allDivisions[1]],
    projects: [{ id: 'p1', name: 'Signals', role: 'member', division_id: 'd-projects', division_name: 'Projects' }],
  });
  const panel = service({ loadMemberContext: async () => member });
  let payload = await loadMember(panel, panel.startDivisionRemoveMember);
  assert.match(panelText(payload), /Projects[\s\S]*Cannot remove[\s\S]*Signals/);
  assert.deepEqual(action(payload, GOVERNANCE_MEMBERSHIP_PANEL_ACTIONS.DIVISION).options.map((option) => option.value), ['d-analysis']);

  const lastPanel = service({ loadMemberContext: async () => context({ divisions: [allDivisions[0]] }) });
  payload = await loadMember(lastPanel, lastPanel.startDivisionRemoveMember);
  assert.match(panelText(payload), /must keep at least one division/);
  assert.equal(maybeAction(payload, GOVERNANCE_MEMBERSHIP_PANEL_ACTIONS.DIVISION), null);
  assert.equal(action(payload, GOVERNANCE_MEMBERSHIP_PANEL_ACTIONS.REVIEW).disabled, true);
});

test('division membership panels recheck authority, reject the Bot, and invalidate cancellation', async () => {
  const unauthorized = service();
  await assert.rejects(
    unauthorized.startDivisionAddMember({
      ...baseInteraction({ roles: ['Researcher'] }),
      async reply() { assert.fail('ordinary members cannot open this panel'); },
    }),
    /Only a board member of Bocconi/,
  );

  const botPanel = service({ loadMemberContext: async () => context({ targetRoles: ['Bot'] }) });
  let payload = await loadMember(botPanel, botPanel.startDivisionAddMember, { roles: ['Bocconi - Head of Projects'] });
  assert.match(panelText(payload), /Bot member cannot be managed/);

  const panel = service();
  await panel.startDivisionAddMember({
    ...baseInteraction(),
    async reply(next) { payload = next; },
  });
  const cancelId = action(payload, GOVERNANCE_MEMBERSHIP_PANEL_ACTIONS.CANCEL).custom_id;
  await panel.handleButton({
    ...baseInteraction({ customId: cancelId }),
    async update(next) { payload = next; },
  });
  assert.match(panelText(payload), /cancelled/);
  await assert.rejects(() => panel.handleButton({ ...baseInteraction({ customId: cancelId }) }), /expired/);
});
