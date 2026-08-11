import assert from 'node:assert/strict';
import test from 'node:test';

import { commands } from '../src/commands/index.js';
import { assertNoBotCommandTarget } from '../src/authorization.js';
import { serializeCommands } from '../src/runtime/command-registry.js';

const EXPECTED_COMMANDS = {
  guide: [],
  'member-update': [],
  'member-remove': ['user', 'reason'],
  'member-info': ['user'],
  'division-create': [],
  'division-update': [],
  'division-add-member': [],
  'division-remove-member': [],
  'board-update': [],
  'board-info': ['university'],
  'project-create': [],
  'project-update': [],
  'project-close': [],
  'project-info': ['project'],
};

const PANEL_GOVERNANCE_COMMANDS = [
  'division-add-member',
  'division-remove-member',
  'board-update',
];

test('every v1 command is registered with a complete slash-command contract', () => {
  assert.deepEqual(
    commands.map((command) => command.data.name).sort(),
    Object.keys(EXPECTED_COMMANDS).sort(),
  );

  for (const command of commands) {
    const json = command.data.toJSON();
    assert.equal(typeof command.execute, 'function', command.data.name);
    assert.equal(json.dm_permission, false, command.data.name);
    assert.ok(json.description, command.data.name);
    assert.deepEqual(json.options.map((option) => option.name), EXPECTED_COMMANDS[json.name], json.name);
  }

  assert.equal(serializeCommands(commands).length, Object.keys(EXPECTED_COMMANDS).length);
});

test('member admission is handled by onboarding, not a slash command', () => {
  assert.equal(commands.some((command) => command.data.name === 'member-add'), false);
});

test('governance panels expose no obsolete inline scope options', () => {
  const serialized = new Map(serializeCommands(commands).map((command) => [command.name, command]));
  for (const commandName of PANEL_GOVERNANCE_COMMANDS) {
    assert.deepEqual(serialized.get(commandName).options, [], commandName);
  }
});

test('every command with an inline user target blocks the Bot account', () => {
  const botId = '99999999999999999';
  const targetCommands = commands.filter((command) =>
    command.data.toJSON().options.some((option) => option.type === 6),
  );

  assert.deepEqual(
    targetCommands.map((command) => command.data.name).sort(),
    [
      'member-info',
      'member-remove',
    ].sort(),
  );

  for (const command of targetCommands) {
    const options = command.data.toJSON().options.map((option) => {
      if (option.type === 6) return { type: 6, name: option.name, value: botId };
      return { type: option.type, name: option.name, value: 'placeholder' };
    });
    assert.throws(
      () => assertNoBotCommandTarget({ client: { user: { id: botId } }, options: { data: options } }),
      /cannot be managed or assigned/,
      command.data.name,
    );
  }
});
