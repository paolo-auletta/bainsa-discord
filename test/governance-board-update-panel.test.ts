import assert from 'node:assert/strict';
import test from 'node:test';

import { ButtonStyle, ComponentType, MessageFlags } from 'discord.js';

import {
  BOARD_UPDATE_PANEL_ACTIONS,
  createBoardUpdatePanelService,
} from '../src/services/governance/board-update-panel.js';

const ACTOR_ID = '100000000000000001';
const PRESIDENT_ID = '100000000000000002';
const VP_ID = '100000000000000003';
const HEAD_ID = '100000000000000004';
const SECOND_HEAD_ID = '100000000000000005';

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
  assert.ok(component, `Missing board update action ${suffix}`);
  return component;
}

function text(payload) {
  return components(payload)
    .filter((component) => component.type === ComponentType.TextDisplay)
    .map((component) => component.content)
    .join('\n');
}

function interaction({ customId = null, roles = ['Bocconi - President'] } = {}) {
  return {
    customId,
    guildId: 'guild',
    user: { id: ACTOR_ID },
    member: { roles: { cache: roleCache(roles) } },
    channel: { name: 'bot-log', parent: { name: 'BAINSA Bocconi' } },
  };
}

const divisions = [
  { id: 'd1', name: 'Analysis', color: 'orange' },
  { id: 'd2', name: 'Culture', color: 'pink' },
  { id: 'd3', name: 'Projects', color: 'blue' },
  { id: 'd4', name: 'Events', color: 'green' },
  { id: 'd5', name: 'Partnerships', color: 'red' },
];

const currentAssignments = [
  { discord_user_id: PRESIDENT_ID, role: 'president', division_id: null, division_name: null },
  { discord_user_id: VP_ID, role: 'vice_president', division_id: null, division_name: null },
  { discord_user_id: HEAD_ID, role: 'head', division_id: 'd3', division_name: 'Projects' },
];

function service(overrides = {}) {
  return createBoardUpdatePanelService({
    loadUniversities: async () => [{ id: 'u1', name: 'Bocconi' }],
    loadDivisions: async () => divisions,
    loadBoardAssignments: async () => currentAssignments,
    loadMemberContext: async (testInteraction, { user }) => ({
      target: {
        id: user.id,
        roles: { cache: roleCache(['Researcher', 'Bocconi']) },
      },
      member: { status: 'active', university_name: 'Bocconi' },
      boardRoles: user.id === ACTOR_ID
        ? [{
            role: testInteraction.member.roles.cache.some((role) => role.name === 'Bocconi - Vice President')
              ? 'vice_president'
              : 'president',
            university_name: 'Bocconi',
          }]
        : [],
    }),
    updateOperation: async () => assert.fail('unexpected board update'),
    formatActivity: () => ({ content: 'activity' }),
    postActivity: async () => ({ status: 'posted' }),
    sendHandoff: async () => undefined,
    ...overrides,
  });
}

async function startEditor(panel, options = {}) {
  let payload;
  await panel.start({
    ...interaction(options),
    async reply(next) { payload = next; },
  });
  assert.equal(payload.flags, MessageFlags.Ephemeral | MessageFlags.IsComponentsV2);
  await panel.handleButton({
    ...interaction({ ...options, customId: action(payload, BOARD_UPDATE_PANEL_ACTIONS.EDIT).custom_id }),
    async update(next) { payload = next; },
  });
  return payload;
}

test('board update renders every active position on one page when the roster fits', async () => {
  const panel = service();
  const payload = await startEditor(panel);

  const president = action(payload, 'up');
  const vicePresident = action(payload, 'uv');
  const projects = action(payload, 'h2');
  assert.equal(president.max_values, 25);
  assert.equal(vicePresident.max_values, 25);
  assert.equal(projects.max_values, 25);
  assert.deepEqual(projects.default_values.map((value) => value.id), [HEAD_ID]);
  assert.match(text(payload), /University leadership[\s\S]*Division leadership/);
  assert.ok(action(payload, 'h3'));
  assert.ok(action(payload, 'h4'));
  assert.match(text(payload), /Events/);
  assert.match(text(payload), /Partnerships/);
  assert.match(text(payload), /\*\*Positions shown:\*\* All 7/);
  assert.equal(
    components(payload).some((component) =>
      component.custom_id?.endsWith(`:${BOARD_UPDATE_PANEL_ACTIONS.NEXT}`),
    ),
    false,
  );
});

test('large boards paginate by leadership group instead of cutting an arbitrary position list', async () => {
  const extendedDivisions = [
    ...divisions,
    { id: 'd6', name: 'Research', color: 'yellow' },
    { id: 'd7', name: 'Operations', color: 'black' },
  ];
  const panel = service({ loadDivisions: async () => extendedDivisions });
  let payload = await startEditor(panel);

  assert.ok(action(payload, 'h0'));
  assert.ok(action(payload, 'h6'));
  assert.equal(components(payload).some((component) => component.custom_id?.endsWith(':up')), false);
  assert.equal(action(payload, BOARD_UPDATE_PANEL_ACTIONS.NEXT).label, 'Next: University leadership');
  await panel.handleButton({
    ...interaction({ customId: action(payload, BOARD_UPDATE_PANEL_ACTIONS.NEXT).custom_id }),
    async update(next) { payload = next; },
  });
  assert.ok(action(payload, 'up'));
  assert.ok(action(payload, 'uv'));
  assert.equal(components(payload).some((component) => component.custom_id?.endsWith(':h0')), false);
  assert.equal(action(payload, BOARD_UPDATE_PANEL_ACTIONS.PREVIOUS).label, 'Back: Division leadership');
});

test('board update authorizes an active database President without relying on a Discord role name', async () => {
  const panel = service();
  const payload = await startEditor(panel, { roles: [] });

  assert.equal(action(payload, 'up').disabled, false);
  assert.match(text(payload), /Update the Bocconi board/);
});

test('board update shows current-to-new changes and saves co-Heads as one roster update', async () => {
  let operationInput;
  let activityCommand;
  const handoffs = [];
  const panel = service({
    updateOperation: async (_interaction, input) => {
      operationInput = input;
      return {
        university: { name: 'Bocconi' },
        positionChanges: [{
          label: 'Head of Projects',
          currentUserIds: [HEAD_ID],
          nextUserIds: [HEAD_ID, SECOND_HEAD_ID],
        }],
        memberChanges: [{
          target: { id: SECOND_HEAD_ID },
          before: [],
          after: ['Head of Projects'],
        }],
      };
    },
    formatActivity: (commandName) => {
      activityCommand = commandName;
      return { content: commandName };
    },
    sendHandoff: async (target) => { handoffs.push(target.id); },
  });
  let payload = await startEditor(panel);
  const projects = action(payload, 'h2');
  await panel.handleUserSelect({
    ...interaction({ customId: projects.custom_id }),
    values: [HEAD_ID, SECOND_HEAD_ID],
    async update(next) { payload = next; },
  });
  assert.match(text(payload), new RegExp(`<@${HEAD_ID}> → <@${HEAD_ID}>, <@${SECOND_HEAD_ID}>`));

  await panel.handleButton({
    ...interaction({ customId: action(payload, BOARD_UPDATE_PANEL_ACTIONS.REVIEW).custom_id }),
    async update() {},
    async editReply(next) { payload = next; },
  });
  assert.match(text(payload), /Positions changing[\s\S]*1/);
  assert.match(text(payload), /Head of .*Projects/);
  assert.equal(action(payload, BOARD_UPDATE_PANEL_ACTIONS.CANCEL).style, ButtonStyle.Danger);

  await panel.handleButton({
    ...interaction({ customId: action(payload, BOARD_UPDATE_PANEL_ACTIONS.SAVE).custom_id }),
    async update() {},
    async editReply(next) { payload = next; },
  });
  assert.equal(activityCommand, 'board-update');
  assert.deepEqual(handoffs, [SECOND_HEAD_ID]);
  assert.ok(operationInput.assignments.some((assignment) =>
    assignment.userId === SECOND_HEAD_ID && assignment.role === 'head' && assignment.divisionId === 'd3',
  ));
  assert.match(text(payload), /Board updated/);
});

test('board review places each leadership group roster on a new line', async () => {
  const panel = service();
  let payload = await startEditor(panel);

  await panel.handleUserSelect({
    ...interaction({ customId: action(payload, 'uv').custom_id }),
    values: [VP_ID, HEAD_ID],
    async update(next) { payload = next; },
  });
  await panel.handleButton({
    ...interaction({ customId: action(payload, BOARD_UPDATE_PANEL_ACTIONS.REVIEW).custom_id }),
    async update() {},
    async editReply(next) { payload = next; },
  });

  assert.match(text(payload), /\*\*University leadership:\*\*\n• \*\*Vice President:/);
  assert.match(text(payload), /\*\*Division leadership:\*\*\n• \*\*Head of .*Projects:/);
});

test('a Vice President sees Presidents read-only while all manageable seats stay multi-select', async () => {
  const panel = service();
  const payload = await startEditor(panel, { roles: ['Bocconi - Vice President'] });

  assert.equal(action(payload, 'up').disabled, true);
  assert.equal(action(payload, 'uv').disabled, false);
  assert.equal(action(payload, 'uv').max_values, 25);
  assert.equal(action(payload, 'h0').max_values, 25);
  assert.match(text(payload), /President · View only/);
});
