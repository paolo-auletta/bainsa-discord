import assert from 'node:assert/strict';
import test from 'node:test';

import { replyEphemeral, replyPersistent } from '../src/discord/reply.mjs';
import { assertUniqueCommandNames, buildCommandMap, serializeCommands } from '../src/runtime/command-registry.mjs';
import { createInteractionDispatcher, routeInteraction } from '../src/runtime/dispatcher.mjs';

test('command registry rejects duplicate command names', () => {
  assert.throws(
    () => assertUniqueCommandNames([{ name: 'member-add' }, { data: { name: 'member-add' } }]),
    /Duplicate slash command name: member-add/,
  );
});

test('command registry serializes builder-like command data', () => {
  const commands = [
    {
      data: {
        name: 'member-add',
        toJSON: () => ({ name: 'member-add', description: 'Add member' }),
      },
      execute: async () => undefined,
    },
  ];

  assert.equal(buildCommandMap(commands).get('member-add'), commands[0]);
  assert.deepEqual(serializeCommands(commands), [{ name: 'member-add', description: 'Add member' }]);
});

test('dispatcher routes chat input commands', async () => {
  let executed = false;
  const dispatch = createInteractionDispatcher({
    commands: [
      {
        name: 'ping',
        execute: async (interaction) => {
          executed = interaction.commandName === 'ping';
        },
      },
    ],
    onError: async () => assert.fail('unexpected error handler call'),
  });

  await dispatch({
    commandName: 'ping',
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

  assert.deepEqual(edited, { content: 'Completed.' });
});

test('persistent command replies are sent to the channel with an ephemeral acknowledgement', async () => {
  let sent;
  let edited;
  await replyPersistent({
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
  }, 'Completed.');

  assert.deepEqual(sent, {
    allowedMentions: { parse: [] },
    content: 'Completed.',
  });
  assert.deepEqual(edited, { content: 'Command output posted in this channel.' });
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
  assert.equal(routeInteraction({}), 'unknown');
});
