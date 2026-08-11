import assert from 'node:assert/strict';
import test from 'node:test';

import { ComponentType, MessageFlags } from 'discord.js';

import {
  createProjectManagementPanelService,
  PROJECT_MANAGEMENT_ACTIONS,
} from '../src/services/projects/management-panels.js';

const ACTOR_ID = '200000000000000001';
const EXISTING_ID = '200000000000000002';
const REMOVED_ID = '200000000000000003';
const ADDED_ID = '200000000000000004';

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
  assert.ok(component, `Missing project panel action ${suffix}`);
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

function botLog() {
  return {
    name: 'bot-log',
    parent: { name: 'BAINSA BOCCONI' },
    sent: [],
    async send(payload) { this.sent.push(payload); },
  };
}

function projectChannel() {
  return { name: 'project-42-signals', topic: 'Private workspace · project 42' };
}

function baseInteraction({ customId = null, channel = botLog(), guild = null }: {
  customId?: string | null;
  channel?: ReturnType<typeof botLog> | ReturnType<typeof projectChannel>;
  guild?: unknown;
} = {}) {
  return {
    customId,
    guildId: 'guild',
    user: { id: ACTOR_ID },
    member: { roles: { cache: [] } },
    channel,
    guild,
  };
}

function context() {
  return {
    project: {
      id: '42',
      name: 'Signals',
      university_name: 'Bocconi',
      division_name: 'Research',
      division_color: 'blue',
      start_date: '2026-08-01',
      expected_end: '2026-09-01',
      summary: 'Original summary',
      notes: 'Private context',
      status: 'active',
      updated_at: '2026-08-10T10:00:00.000Z',
      discord_channel_id: 'workspace',
      reconciliation_pending: false,
    },
    people: [
      { discord_user_id: EXISTING_ID, role: 'supervisor' },
      { discord_user_id: REMOVED_ID, role: 'member' },
    ],
  };
}

function service(overrides = {}) {
  return createProjectManagementPanelService({
    searchProjects: async () => [{ name: 'Signals · Bocconi › Research', value: '42' }],
    loadProjectContext: async () => context(),
    updateProjectOperation: async () => assert.fail('unexpected project update'),
    closeProjectOperation: async () => assert.fail('unexpected project closure'),
    now: () => 1_000,
    ...overrides,
  });
}

test('project update confirms selection, replaces the complete team, and saves one reviewed change', async () => {
  let savedInput;
  let contextLoads = 0;
  const activityChannel = botLog();
  const projectContext = context();
  const panels = service({
    loadProjectContext: async () => {
      contextLoads += 1;
      return projectContext;
    },
    updateProjectOperation: async (input) => {
      savedInput = input;
      return {
        before: projectContext.project,
        project: {
          ...projectContext.project,
          name: input.name,
          status: 'paused',
          reconciliation_pending: false,
        },
        people: input.people,
        participantChanges: {
          added: [{ userId: ADDED_ID, role: 'supervisor' }],
          removed: [{ userId: REMOVED_ID, role: 'member' }],
          roleChanged: [],
        },
      };
    },
  });

  let payload;
  await panels.startProjectUpdate({
    ...baseInteraction({ channel: activityChannel }),
    async reply(next) { payload = next; },
  });
  assert.equal(payload.flags, MessageFlags.Ephemeral | MessageFlags.IsComponentsV2);
  assert.match(panelText(payload), /Choose a project to update/);

  await panels.handleStringSelect({
    ...baseInteraction({
      customId: action(payload, PROJECT_MANAGEMENT_ACTIONS.UPDATE_PROJECT).custom_id,
      channel: activityChannel,
    }),
    values: ['42'],
    async update(next) { payload = next; },
  });
  assert.equal(contextLoads, 0);
  assert.match(panelText(payload), /Selected project[\s\S]*Signals/);
  assert.equal(action(payload, PROJECT_MANAGEMENT_ACTIONS.UPDATE_PROJECT_CONTINUE).disabled, false);

  let loading;
  await panels.handleButton({
    ...baseInteraction({
      customId: action(payload, PROJECT_MANAGEMENT_ACTIONS.UPDATE_PROJECT_CONTINUE).custom_id,
      channel: activityChannel,
    }),
    async update(next) { loading = next; },
    async editReply(next) { payload = next; },
  });
  assert.match(panelText(loading), /Choose a project to update/);
  assert.doesNotMatch(panelText(loading), /Loading project information/);
  assert.equal(action(loading, PROJECT_MANAGEMENT_ACTIONS.UPDATE_PROJECT_CONTINUE).label, 'Loading…');
  assert.equal(action(loading, PROJECT_MANAGEMENT_ACTIONS.UPDATE_PROJECT_CONTINUE).disabled, true);
  assert.equal(action(loading, PROJECT_MANAGEMENT_ACTIONS.UPDATE_PROJECT).disabled, true);
  assert.equal(action(loading, PROJECT_MANAGEMENT_ACTIONS.UPDATE_SEARCH_OPEN).disabled, true);
  assert.equal(action(loading, PROJECT_MANAGEMENT_ACTIONS.UPDATE_CANCEL).disabled, true);
  assert.equal(contextLoads, 1);
  assert.match(panelText(payload), /Update Signals/);
  assert.match(panelText(payload), /University[\s\S]*Bocconi/);
  assert.match(panelText(payload), /Summary[\s\S]*Original summary/);
  assertLabelImmediatelyBefore(payload, PROJECT_MANAGEMENT_ACTIONS.UPDATE_STATUS, 'Status');
  assertLabelImmediatelyBefore(payload, PROJECT_MANAGEMENT_ACTIONS.UPDATE_DETAILS_OPEN, 'Project details');
  assertLabelImmediatelyBefore(payload, PROJECT_MANAGEMENT_ACTIONS.UPDATE_TEAM_OPEN, 'Project team');
  assert.ok(action(payload, PROJECT_MANAGEMENT_ACTIONS.UPDATE_BACK_SELECT));
  assert.match(
    panelText(payload),
    /\*\*Project:\*\* Signals[\s\S]*\*\*Timeline:\*\* 2026-08-01 → 2026-09-01\n\n\*\*Workspace:\*\* <#workspace>\n\*\*Shareable record:\*\* Pending\n\n\*\*Members:\*\* <@200000000000000003>\n\*\*Supervisors:\*\* <@200000000000000002>\n\n\*\*Internal notes:\*\* Private context\n\*\*Summary:\*\* Original summary/,
  );
  assert.doesNotMatch(panelText(payload), /\*\*Team:?\*\*/);
  assert.equal(savedInput, undefined);

  let detailsModal;
  await panels.handleButton({
    ...baseInteraction({
      customId: action(payload, PROJECT_MANAGEMENT_ACTIONS.UPDATE_DETAILS_OPEN).custom_id,
      channel: activityChannel,
    }),
    async showModal(next) { detailsModal = next.toJSON(); },
  });
  await panels.handleModalSubmit({
    ...baseInteraction({ customId: detailsModal.custom_id, channel: activityChannel }),
    fields: fields({
      name: 'SIGNALS',
      expected_end: projectContext.project.expected_end,
      summary: projectContext.project.summary,
      notes: projectContext.project.notes,
    }),
    isFromMessage: () => true,
    async update(next) { payload = next; },
  });
  assert.match(panelText(payload), /Project:[\s\S]*Signals → SIGNALS/);
  assert.equal(action(payload, PROJECT_MANAGEMENT_ACTIONS.UPDATE_REVIEW).disabled, false);

  await panels.handleStringSelect({
    ...baseInteraction({
      customId: action(payload, PROJECT_MANAGEMENT_ACTIONS.UPDATE_STATUS).custom_id,
      channel: activityChannel,
    }),
    values: ['paused'],
    async update(next) { payload = next; },
  });
  await panels.handleButton({
    ...baseInteraction({
      customId: action(payload, PROJECT_MANAGEMENT_ACTIONS.UPDATE_TEAM_OPEN).custom_id,
      channel: activityChannel,
    }),
    async update(next) { payload = next; },
  });
  assert.match(panelText(payload), /Manage the project team/);
  assert.match(panelText(payload), /Status[\s\S]*Active → Paused/);
  assertLabelImmediatelyBefore(payload, PROJECT_MANAGEMENT_ACTIONS.UPDATE_TEAM_MEMBERS, 'Members');
  assertLabelImmediatelyBefore(payload, PROJECT_MANAGEMENT_ACTIONS.UPDATE_TEAM_SUPERVISORS, 'Supervisors');
  const memberSelect = action(payload, PROJECT_MANAGEMENT_ACTIONS.UPDATE_TEAM_MEMBERS);
  const supervisorSelect = action(payload, PROJECT_MANAGEMENT_ACTIONS.UPDATE_TEAM_SUPERVISORS);
  assert.deepEqual(memberSelect.default_values, [{ id: REMOVED_ID, type: 'user' }]);
  assert.deepEqual(supervisorSelect.default_values, [{ id: EXISTING_ID, type: 'user' }]);

  await panels.handleUserSelect({
    ...baseInteraction({
      customId: memberSelect.custom_id,
      channel: activityChannel,
    }),
    values: [EXISTING_ID, ADDED_ID],
    async update(next) { payload = next; },
  });
  await panels.handleUserSelect({
    ...baseInteraction({
      customId: action(payload, PROJECT_MANAGEMENT_ACTIONS.UPDATE_TEAM_SUPERVISORS).custom_id,
      channel: activityChannel,
    }),
    values: [ADDED_ID],
    async update(next) { payload = next; },
  });
  assert.match(panelText(payload), new RegExp(`Members[\\s\\S]*<@${REMOVED_ID}>[\\s\\S]*→[\\s\\S]*<@${EXISTING_ID}>`));
  assert.match(panelText(payload), new RegExp(`Supervisors[\\s\\S]*<@${EXISTING_ID}>[\\s\\S]*→[\\s\\S]*<@${ADDED_ID}>`));
  await panels.handleButton({
    ...baseInteraction({
      customId: action(payload, PROJECT_MANAGEMENT_ACTIONS.UPDATE_REVIEW).custom_id,
      channel: activityChannel,
    }),
    async update(next) { payload = next; },
  });
  assert.match(panelText(payload), /Review the project update/);
  assert.deepEqual(
    components(payload)
      .filter((component) => component.type === ComponentType.Button)
      .map((component) => component.label),
    ['Save project update', 'Back to project', 'Cancel update'],
  );
  assert.equal(savedInput, undefined);

  let waiting;
  let final;
  await panels.handleButton({
    ...baseInteraction({
      customId: action(payload, PROJECT_MANAGEMENT_ACTIONS.UPDATE_SAVE).custom_id,
      channel: activityChannel,
    }),
    async update(next) { waiting = next; },
    async editReply(next) { final = next; },
  });
  assert.match(panelText(waiting), /Saving SIGNALS/);
  assert.match(panelText(final), /Project updated/);
  assert.equal(savedInput.project, '42');
  assert.equal(savedInput.name, 'SIGNALS');
  assert.equal(savedInput.status, 'paused');
  assert.equal(savedInput.expectedUpdatedAt, projectContext.project.updated_at);
  assert.deepEqual(savedInput.expectedPeople, projectContext.people);
  assert.deepEqual(savedInput.people, [
    { discord_user_id: EXISTING_ID, role: 'member' },
    { discord_user_id: ADDED_ID, role: 'supervisor' },
  ]);
  assert.deepEqual(savedInput.removalReasons, {});
  assert.equal(activityChannel.sent.length, 1);
});

test('project closure infers its project channel, requires both closure fields, and posts to university bot-log', async () => {
  let closedInput;
  const universityLog = botLog();
  const guild = { channels: { cache: [universityLog] } };
  const workspace = projectChannel();
  const panels = service({
    loadProjectContext: async (input) => {
      assert.equal(input.project, null);
      return context();
    },
    closeProjectOperation: async (input) => {
      closedInput = input;
      return {
        project: { ...context().project, status: 'completed', reconciliation_pending: false },
        people: context().people,
        outcome: input.outcome,
      };
    },
  });

  let payload;
  await panels.startProjectClose({
    ...baseInteraction({ channel: workspace, guild }),
    async reply(next) { payload = next; },
  });
  assert.match(panelText(payload), /Close Signals/);
  assert.doesNotMatch(panelText(payload), /Choose another project/);

  let modal;
  await panels.handleButton({
    ...baseInteraction({
      customId: action(payload, PROJECT_MANAGEMENT_ACTIONS.CLOSE_DETAILS_OPEN).custom_id,
      channel: workspace,
      guild,
    }),
    async showModal(next) { modal = next.toJSON(); },
  });
  await panels.handleModalSubmit({
    ...baseInteraction({ customId: modal.custom_id, channel: workspace, guild }),
    fields: fields({
      outcome: 'Published the final research report.',
      final_notes: 'Private handover context.',
    }),
    isFromMessage: () => true,
    async update(next) { payload = next; },
  });
  assert.match(panelText(payload), /Review project closure/);
  assert.match(panelText(payload), /Private handover context/);
  assert.equal(closedInput, undefined);

  await panels.handleButton({
    ...baseInteraction({
      customId: action(payload, PROJECT_MANAGEMENT_ACTIONS.CLOSE_SAVE).custom_id,
      channel: workspace,
      guild,
    }),
    async update() {},
    async editReply(next) { payload = next; },
  });
  assert.equal(closedInput.project, '42');
  assert.equal(closedInput.outcome, 'Published the final research report.');
  assert.equal(closedInput.finalNotes, 'Private handover context.');
  assert.equal(universityLog.sent.length, 1);
  assert.doesNotMatch(JSON.stringify(universityLog.sent[0]), /Private handover context/);
});

test('project closure waits for explicit confirmation before loading a selected bot-log project', async () => {
  let contextLoads = 0;
  const panels = service({
    loadProjectContext: async () => {
      contextLoads += 1;
      return context();
    },
  });
  let payload;
  await panels.startProjectClose({
    ...baseInteraction(),
    async reply(next) { payload = next; },
  });
  await panels.handleStringSelect({
    ...baseInteraction({
      customId: action(payload, PROJECT_MANAGEMENT_ACTIONS.CLOSE_PROJECT).custom_id,
    }),
    values: ['42'],
    async update(next) { payload = next; },
  });
  assert.equal(contextLoads, 0);
  assert.match(panelText(payload), /Selected project[\s\S]*Signals/);

  let loading;
  await panels.handleButton({
    ...baseInteraction({
      customId: action(payload, PROJECT_MANAGEMENT_ACTIONS.CLOSE_PROJECT_CONTINUE).custom_id,
    }),
    async update(next) { loading = next; },
    async editReply(next) { payload = next; },
  });
  assert.match(panelText(loading), /Loading project for closure/);
  assert.equal(contextLoads, 1);
  assert.match(panelText(payload), /Close Signals/);
});

test('a failed project save preserves staged work and offers a safe retry', async () => {
  const panels = service({
    updateProjectOperation: async () => { throw new Error('database offline'); },
  });
  let payload;
  await panels.startProjectUpdate({
    ...baseInteraction({ channel: projectChannel() }),
    async reply(next) { payload = next; },
  });
  await panels.handleStringSelect({
    ...baseInteraction({
      customId: action(payload, PROJECT_MANAGEMENT_ACTIONS.UPDATE_STATUS).custom_id,
      channel: projectChannel(),
    }),
    values: ['paused'],
    async update(next) { payload = next; },
  });
  await panels.handleButton({
    ...baseInteraction({
      customId: action(payload, PROJECT_MANAGEMENT_ACTIONS.UPDATE_REVIEW).custom_id,
      channel: projectChannel(),
    }),
    async update(next) { payload = next; },
  });
  await panels.handleButton({
    ...baseInteraction({
      customId: action(payload, PROJECT_MANAGEMENT_ACTIONS.UPDATE_SAVE).custom_id,
      channel: projectChannel(),
    }),
    async update() {},
    async editReply(next) { payload = next; },
  });
  assert.match(panelText(payload), /Project update not saved/);
  assert.ok(action(payload, PROJECT_MANAGEMENT_ACTIONS.UPDATE_SAVE));
  assert.ok(action(payload, PROJECT_MANAGEMENT_ACTIONS.UPDATE_BACK_OVERVIEW));
});

test('project management panels ignore unknown IDs and bind active sessions to their actor', async () => {
  const panels = service();
  assert.equal(panels.canHandle('pm:session:not-real'), false);
  let payload;
  await panels.startProjectUpdate({
    ...baseInteraction(),
    async reply(next) { payload = next; },
  });
  await assert.rejects(
    () => panels.handleStringSelect({
      ...baseInteraction({ customId: action(payload, PROJECT_MANAGEMENT_ACTIONS.UPDATE_PROJECT).custom_id }),
      user: { id: 'intruder' },
      values: ['42'],
    }),
    /Only the person who started this setup can use it/,
  );
});
