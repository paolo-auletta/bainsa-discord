import assert from 'node:assert/strict';
import test from 'node:test';

import { replyBoardActivity, replyEphemeral } from '../src/discord/reply.js';
import { UserFacingError } from '../src/errors.js';
import { assertUniqueCommandNames, buildCommandMap, serializeCommands } from '../src/runtime/command-registry.js';
import { createInteractionDispatcher, routeInteraction } from '../src/runtime/dispatcher.js';

function payloadText(payload) {
  const queue = [...(payload.components ?? []).map((component) => component.toJSON?.() ?? component)];
  const content = [];
  while (queue.length > 0) {
    const component = queue.shift();
    if (component.content) content.push(component.content);
    if (component.components) queue.push(...component.components);
  }
  return content.join('\n');
}

test('command registry rejects duplicate command names', () => {
  assert.throws(
    () => assertUniqueCommandNames([{ name: 'test-command' }, { data: { name: 'test-command' } }]),
    /Duplicate slash command name: test-command/,
  );
});

test('command registry serializes builder-like command data', () => {
  const commands = [
    {
      data: {
        name: 'test-command',
        toJSON: () => ({ name: 'test-command', description: 'Test command' }),
      },
      execute: async () => undefined,
    },
  ];

  assert.equal(buildCommandMap(commands).get('test-command'), commands[0]);
  assert.deepEqual(serializeCommands(commands), [{ name: 'test-command', description: 'Test command' }]);
});

test('command registry uses the serialized name for dispatch and uniqueness', () => {
  const command = {
    name: 'wrapper-name',
    data: {
      name: 'data-name',
      toJSON: () => ({ name: 'serialized-name', description: 'Serialized command' }),
    },
    execute: async () => undefined,
  };

  assert.equal(buildCommandMap([command]).get('serialized-name'), command);
  assert.equal(buildCommandMap([command]).has('wrapper-name'), false);
  assert.deepEqual(serializeCommands([command]), [{ name: 'serialized-name', description: 'Serialized command' }]);
  assert.throws(
    () => assertUniqueCommandNames([
      command,
      {
        name: 'another-wrapper-name',
        data: {
          toJSON: () => ({ name: 'serialized-name' }),
        },
        execute: async () => undefined,
      },
    ]),
    /Duplicate slash command name: serialized-name/,
  );
});

test('command registry accepts names exposed only by a top-level toJSON', () => {
  const command = {
    toJSON: () => ({ name: 'top-level-command', description: 'Top-level command' }),
    execute: async () => undefined,
  };

  assert.equal(buildCommandMap([command]).get('top-level-command'), command);
  assert.deepEqual(serializeCommands([command]), [{ name: 'top-level-command', description: 'Top-level command' }]);
});

test('dispatcher routes chat input commands', async () => {
  let executed = false;
  const dispatch = createInteractionDispatcher({
    commands: [
      {
        name: 'project-create',
        execute: async (interaction) => {
          executed = interaction.commandName === 'project-create';
        },
      },
    ],
    onError: async () => assert.fail('unexpected error handler call'),
  });

  await dispatch({
    commandName: 'project-create',
    member: memberWithRoles(['Global President']),
    channel: { name: 'bot-log', parent: { name: 'LOGS' } },
    isChatInputCommand: () => true,
    isAutocomplete: () => false,
    isButton: () => false,
    isStringSelectMenu: () => false,
    isModalSubmit: () => false,
  });

  assert.equal(executed, true);
});

test('dispatcher blocks bot-targeting commands before execution', async () => {
  let executed = false;
  let captured;
  const dispatch = createInteractionDispatcher({
    commands: [{
      name: 'member-remove',
      execute: async () => {
        executed = true;
      },
    }],
    onError: async (_interaction, error) => {
      captured = error;
    },
  });

  await dispatch({
    commandName: 'member-remove',
    member: memberWithRoles(['Global President']),
    channel: { name: 'bot-log', parent: { name: 'LOGS' } },
    client: { user: { id: '99999999999999999' } },
    options: { data: [{ type: 6, name: 'user', value: '99999999999999999' }] },
    isChatInputCommand: () => true,
    isAutocomplete: () => false,
    isButton: () => false,
    isStringSelectMenu: () => false,
    isModalSubmit: () => false,
    isRepliable: () => true,
  });

  assert.equal(executed, false);
  assert.match(captured.message, /cannot be managed or assigned/);
});

function autocompleteInteraction({ member, channel }) {
  return {
    commandName: 'project-create',
    member,
    channel,
    isChatInputCommand: () => false,
    isAutocomplete: () => true,
    isButton: () => false,
    isStringSelectMenu: () => false,
    isModalSubmit: () => false,
  };
}

function memberWithRoles(names) {
  return {
    roles: {
      cache: names.map((name) => ({ name })),
    },
  };
}

test('dispatcher returns no autocomplete choices before a denied handler can look up data', async () => {
  let databaseLookups = 0;
  let memberLookups = 0;
  const dispatch = createInteractionDispatcher({
    commands: [{
      name: 'project-create',
      autocomplete: async () => {
        databaseLookups += 1;
        memberLookups += 1;
      },
    }],
    onError: async () => assert.fail('unexpected error handler call'),
  });

  for (const interaction of [
    autocompleteInteraction({
      member: memberWithRoles(['Researcher']),
      channel: { name: 'bot-log', parent: { name: 'BAINSA BOCCONI' } },
    }),
    autocompleteInteraction({
      member: memberWithRoles(['Bocconi - Head of Projects']),
      channel: { name: 'general', parent: { name: 'BAINSA BOCCONI' } },
    }),
    autocompleteInteraction({
      member: null,
      channel: { name: 'bot-log', parent: { name: 'BAINSA BOCCONI' } },
    }),
  ]) {
    let choices;
    interaction.respond = async (value) => {
      choices = value;
    };
    await dispatch(interaction);
    assert.deepEqual(choices, []);
  }

  assert.equal(databaseLookups, 0);
  assert.equal(memberLookups, 0);
});

test('dispatcher invokes autocomplete for every authorized board tier', async () => {
  let invocations = 0;
  const dispatch = createInteractionDispatcher({
    commands: [{
      name: 'project-create',
      autocomplete: async () => {
        invocations += 1;
      },
    }],
    onError: async () => assert.fail('unexpected error handler call'),
  });
  for (const { roles, channel } of [
    { roles: ['Global President'], channel: { name: 'bot-log', parent: { name: 'LOGS' } } },
    { roles: ['Bocconi - President'], channel: { name: 'bot-log', parent: { name: 'BAINSA BOCCONI' } } },
    { roles: ['Bocconi - Vice President'], channel: { name: 'bot-log', parent: { name: 'BAINSA BOCCONI' } } },
    { roles: ['Bocconi - Head of Projects'], channel: { name: 'bot-log', parent: { name: 'BAINSA BOCCONI' } } },
  ]) {
    await dispatch(autocompleteInteraction({ member: memberWithRoles(roles), channel }));
  }

  assert.equal(invocations, 4);
});

test('dispatcher rejects a command from a bot-log outside the actor’s allowed scope', async () => {
  let executed = false;
  let captured;
  const dispatch = createInteractionDispatcher({
    commands: [{ name: 'project-create', execute: async () => { executed = true; } }],
    onError: async (_interaction, error) => { captured = error; },
  });

  await dispatch({
    commandName: 'project-create',
    member: memberWithRoles(['Bocconi - Head of Projects']),
    channel: { name: 'bot-log', parent: { name: 'BAINSA SAPIENZA' } },
    isChatInputCommand: () => true,
    isAutocomplete: () => false,
    isButton: () => false,
    isStringSelectMenu: () => false,
    isModalSubmit: () => false,
    isRepliable: () => true,
  });

  assert.equal(executed, false);
  assert.match(captured.message, /not available in this channel/);
});

test('deferred ephemeral replies edit the original response', async () => {
  let edited;
  await replyEphemeral({
    deferred: true,
    replied: false,
    editReply: async (payload) => {
      edited = payload;
    },
    followUp: async () => assert.fail('deferred reply should be edited'),
  }, 'Completed.');

  assert.match(payloadText(edited), /^\*\*Update\*\*\nCompleted\.$/);
  assert.deepEqual(edited.allowedMentions, { parse: [] });
});

test('board activity replies are posted once with a private acknowledgement', async () => {
  let sent;
  let edited;
  await replyBoardActivity({
    deferred: true,
    replied: false,
    channel: {
      send: async (payload) => {
        sent = payload;
      },
    },
    editReply: async (payload) => {
      edited = payload;
    },
  }, { embeds: [{ title: 'Activity' }] });

  assert.deepEqual(sent, {
    allowedMentions: { parse: [] },
    embeds: [{ title: 'Activity' }],
  });
  assert.match(payloadText(edited), /^\*\*Change saved\*\*\nActivity posted in this channel\.$/);
});

test('project-channel mutations can route governance activity to the scoped bot log', async () => {
  let sent;
  let edited;
  await replyBoardActivity({
    deferred: true,
    replied: false,
    channel: { id: 'project', async send() { assert.fail('project channel is not the audit destination'); } },
    editReply: async (payload) => { edited = payload; },
  }, { embeds: [{ title: 'Activity' }] }, {
    channel: { id: 'bot-log', async send(payload) { sent = payload; } },
  });

  assert.deepEqual(sent, {
    allowedMentions: { parse: [] },
    embeds: [{ title: 'Activity' }],
  });
  assert.match(payloadText(edited), /Activity posted in <#bot-log>\./);
});

test('private-only updates never send a board activity message', async () => {
  let sent = false;
  let edited;
  await replyBoardActivity({
    deferred: true,
    replied: false,
    channel: {
      send: async () => {
        sent = true;
      },
    },
    editReply: async (payload) => {
      edited = payload;
    },
  }, null);

  assert.equal(sent, false);
  assert.match(payloadText(edited), /^\*\*Update saved\*\*\nNo board-visible fields changed\.$/);
});

test('activity delivery failures report that the change was saved', async () => {
  let edited;
  await replyBoardActivity({
    commandName: 'test-command',
    user: { id: 'actor' },
    deferred: true,
    replied: false,
    channel: {
      send: async () => {
        throw new Error('Discord unavailable');
      },
    },
    editReply: async (payload) => {
      edited = payload;
    },
  }, { embeds: [{ title: 'Activity' }] });

  assert.match(payloadText(edited), /Change saved; activity delivery failed/);
  assert.match(payloadText(edited), /could not be posted/);
});

test('dispatcher routes onboarding buttons by custom id', async () => {
  let handled = false;
  const dispatch = createInteractionDispatcher({
    commands: [],
    onboarding: {
      canHandle: (customId) => customId === 'onboarding:start',
      handleButton: async () => {
        handled = true;
      },
    },
    onError: async () => assert.fail('unexpected error handler call'),
  });

  await dispatch({
    customId: 'onboarding:start',
    isChatInputCommand: () => false,
    isAutocomplete: () => false,
    isButton: () => true,
    isStringSelectMenu: () => false,
    isModalSubmit: () => false,
  });

  assert.equal(handled, true);
});

test('dispatcher routes guide buttons and select menus by custom id', async () => {
  const handled = [];
  const dispatch = createInteractionDispatcher({
    commands: [],
    guide: {
      canHandle: (customId) => customId.startsWith('guide:'),
      handleComponent: async (interaction) => {
        handled.push(interaction.customId);
      },
    },
    onError: async () => assert.fail('unexpected error handler call'),
  });

  await dispatch({
    customId: 'guide:button',
    isChatInputCommand: () => false,
    isAutocomplete: () => false,
    isButton: () => true,
    isStringSelectMenu: () => false,
    isModalSubmit: () => false,
  });
  await dispatch({
    customId: 'guide:select',
    isChatInputCommand: () => false,
    isAutocomplete: () => false,
    isButton: () => false,
    isStringSelectMenu: () => true,
    isModalSubmit: () => false,
  });

  assert.deepEqual(handled, ['guide:button', 'guide:select']);
});

test('dispatcher routes every project setup component type', async () => {
  const handled = [];
  const projectSetup = {
    canHandle: (customId) => customId.startsWith('pc:'),
    handleButton: async (interaction) => handled.push(`button:${interaction.customId}`),
    handleStringSelect: async (interaction) => handled.push(`strings:${interaction.customId}`),
    handleUserSelect: async (interaction) => handled.push(`users:${interaction.customId}`),
    handleModalSubmit: async (interaction) => handled.push(`modal:${interaction.customId}`),
  };
  const dispatch = createInteractionDispatcher({
    commands: [],
    projectSetup,
    onError: async () => assert.fail('unexpected error handler call'),
  });

  await dispatch({
    customId: 'pc:1:crt',
    isButton: () => true,
  });
  await dispatch({
    customId: 'pc:1:uni',
    isButton: () => false,
    isStringSelectMenu: () => true,
  });
  await dispatch({
    customId: 'pc:1:mem',
    isButton: () => false,
    isUserSelectMenu: () => true,
  });
  await dispatch({
    customId: 'pc:1:nm',
    isButton: () => false,
    isModalSubmit: () => true,
  });

  assert.deepEqual(handled, [
    'button:pc:1:crt',
    'strings:pc:1:uni',
    'users:pc:1:mem',
    'modal:pc:1:nm',
  ]);
});

test('dispatcher routes every profile component type without command-channel authorization', async () => {
  const handled = [];
  const dispatch = createInteractionDispatcher({
    commands: [],
    profiles: {
      canHandle: (customId) => customId.startsWith('profile:'),
      handleButton: async (interaction) => handled.push(`button:${interaction.customId}`),
      handleStringSelect: async (interaction) => handled.push(`strings:${interaction.customId}`),
      handleModalSubmit: async (interaction) => handled.push(`modal:${interaction.customId}`),
    },
    onError: async () => assert.fail('unexpected error handler call'),
  });

  await dispatch({
    customId: 'profile:start',
    channel: { name: 'general' },
    isButton: () => true,
  });
  await dispatch({
    customId: 'profile:tags',
    channel: { name: 'general' },
    isButton: () => false,
    isStringSelectMenu: () => true,
  });
  await dispatch({
    customId: 'profile:identity-modal',
    channel: { name: 'general' },
    isButton: () => false,
    isModalSubmit: () => true,
  });

  assert.deepEqual(handled, [
    'button:profile:start',
    'strings:profile:tags',
    'modal:profile:identity-modal',
  ]);
});

test('dispatcher reports matched component routes without handlers', async () => {
  const cases = [
    {
      label: 'onboarding button',
      component: { canHandle: () => true },
      flags: { isButton: true },
    },
    {
      label: 'guide component',
      component: { canHandle: () => true },
      flags: { isButton: true },
      guide: true,
    },
    {
      label: 'onboarding select',
      component: { canHandle: () => true },
      flags: { isStringSelectMenu: true },
    },
    {
      label: 'onboarding modal',
      component: { canHandle: () => true },
      flags: { isModalSubmit: true },
    },
    {
      label: 'project setup users',
      component: { canHandle: () => true },
      flags: { isUserSelectMenu: true },
      projectSetup: true,
    },
    {
      label: 'project setup strings',
      component: { canHandle: () => true },
      flags: { isStringSelectMenu: true },
      projectSetup: true,
    },
    {
      label: 'project setup modal',
      component: { canHandle: () => true },
      flags: { isModalSubmit: true },
      projectSetup: true,
    },
    {
      label: 'profile button',
      component: { canHandle: () => true },
      flags: { isButton: true },
      profiles: true,
    },
    {
      label: 'profile select',
      component: { canHandle: () => true },
      flags: { isStringSelectMenu: true },
      profiles: true,
    },
    {
      label: 'profile modal',
      component: { canHandle: () => true },
      flags: { isModalSubmit: true },
      profiles: true,
    },
  ];

  for (const testCase of cases) {
    let captured;
    const dispatch = createInteractionDispatcher({
      commands: [],
      ...(testCase.guide
        ? { guide: testCase.component }
        : testCase.projectSetup
          ? { projectSetup: testCase.component }
          : testCase.profiles
            ? { profiles: testCase.component }
            : { onboarding: testCase.component }),
      onError: async (_interaction, error) => {
        captured = error;
      },
    });

    await dispatch({
      customId: `missing:${testCase.label}`,
      isChatInputCommand: () => false,
      isAutocomplete: () => false,
      isButton: () => Boolean(testCase.flags.isButton),
      isStringSelectMenu: () => Boolean(testCase.flags.isStringSelectMenu),
      isUserSelectMenu: () => Boolean(testCase.flags.isUserSelectMenu),
      isModalSubmit: () => Boolean(testCase.flags.isModalSubmit),
      isRepliable: () => true,
    });

    assert.equal(captured instanceof UserFacingError, true, testCase.label);
  }
});

test('dispatcher sends unknown repliable interactions to error handler', async () => {
  let captured;
  const dispatch = createInteractionDispatcher({
    commands: [],
    onError: async (_interaction, error) => {
      captured = error;
    },
  });

  await dispatch({
    commandName: 'missing',
    isChatInputCommand: () => true,
    isAutocomplete: () => false,
    isButton: () => false,
    isStringSelectMenu: () => false,
    isModalSubmit: () => false,
    isRepliable: () => true,
  });

  assert.match(captured.message, /Unknown command: missing/);
});

test('routeInteraction returns expected route names', () => {
  assert.equal(routeInteraction({ isChatInputCommand: () => false, isAutocomplete: () => true }), 'autocomplete');
  assert.equal(routeInteraction({ isUserSelectMenu: () => true }), 'userSelect');
  assert.equal(routeInteraction({}), 'unknown');
});
