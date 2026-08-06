import assert from 'node:assert/strict';
import test from 'node:test';

import { commands } from '../src/commands/index.js';
import { assertNoBotCommandTarget } from '../src/authorization.js';
import { serializeCommands } from '../src/runtime/command-registry.js';

const EXPECTED_COMMANDS = {
  guide: [],
  'member-add': ['user', 'member_type', 'university', 'divisions', 'notes'],
  'member-update': ['user', 'member_type', 'university', 'divisions', 'notes'],
  'member-remove': ['user', 'reason'],
  'member-info': ['user'],
  'division-create': ['university', 'division_name', 'color', 'head', 'create_text_channel', 'create_voice_channel'],
  'division-update': ['university', 'current_name', 'new_name', 'color'],
  'division-add-member': ['user', 'university', 'division'],
  'division-remove-member': ['user', 'university', 'division', 'reason'],
  'board-assign': ['user', 'university', 'role', 'division'],
  'board-remove': ['user', 'university', 'role', 'division', 'reason'],
  'board-info': ['university'],
  'project-create': [],
  'project-add-member': ['project', 'user', 'role'],
  'project-remove-member': ['project', 'user', 'reason'],
  'project-update': ['project', 'name', 'expected_end', 'notes', 'status'],
  'project-close': ['project', 'outcome', 'final_notes'],
  'project-info': ['project'],
};

const UNIVERSITY_DEPENDENT_DIVISION_COMMANDS = [
  'member-add',
  'member-update',
  'division-update',
  'division-add-member',
  'division-remove-member',
  'board-assign',
  'board-remove',
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

test('university-dependent division selectors expose ordered autocomplete contracts', () => {
  const divisionOptionNames = new Set(['division', 'divisions', 'current_name']);
  const targetCommands = serializeCommands(commands).filter((command) => {
    const optionNames = command.options.map((option) => option.name);
    return optionNames.includes('university') && optionNames.some((name) => divisionOptionNames.has(name));
  });

  assert.deepEqual(
    targetCommands.map((command) => command.name).sort(),
    [...UNIVERSITY_DEPENDENT_DIVISION_COMMANDS].sort(),
  );

  for (const command of targetCommands) {
    const universityIndex = command.options.findIndex((option) => option.name === 'university');
    const divisionIndex = command.options.findIndex((option) => divisionOptionNames.has(option.name));

    assert.equal(command.options[universityIndex].autocomplete, true, `${command.name}: university autocomplete`);
    assert.equal(command.options[divisionIndex].autocomplete, true, `${command.name}: division autocomplete`);
    assert.ok(universityIndex < divisionIndex, `${command.name}: university must precede division`);
  }
});

test('every command that accepts a user or project participant blocks the Bot account', () => {
  const botId = '99999999999999999';
  const targetCommands = commands.filter((command) =>
    command.data.toJSON().options.some((option) => option.type === 6),
  );

  assert.deepEqual(
    targetCommands.map((command) => command.data.name).sort(),
    [
      'board-assign',
      'board-remove',
      'division-add-member',
      'division-create',
      'division-remove-member',
      'member-add',
      'member-info',
      'member-remove',
      'member-update',
      'project-add-member',
      'project-remove-member',
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
