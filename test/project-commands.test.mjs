import test from 'node:test';
import assert from 'node:assert/strict';

import { projectCommands } from '../src/commands/projects/index.mjs';

test('exports the v1 project command set', () => {
  assert.deepEqual(
    projectCommands.map((command) => command.data.name),
    [
      'project-create',
      'project-add-member',
      'project-remove-member',
      'project-update',
      'project-close',
      'project-info',
    ],
  );
});

test('project-create requires the core fields and keeps notes optional', () => {
  const command = projectCommands.find((candidate) => candidate.data.name === 'project-create').data.toJSON();
  assert.deepEqual(
    command.options.map((option) => [option.name, option.required]),
    [
      ['name', true],
      ['university', true],
      ['division', true],
      ['members', true],
      ['supervisors', true],
      ['start_date', true],
      ['expected_end', true],
      ['notes', false],
    ],
  );
});

test('project-create autocompletes its scoped setup fields', () => {
  const command = projectCommands.find((candidate) => candidate.data.name === 'project-create');
  for (const name of ['university', 'division', 'members', 'supervisors']) {
    const option = command.data.toJSON().options.find((candidate) => candidate.name === name);
    assert.equal(option.autocomplete, true, name);
  }
  assert.equal(typeof command.autocomplete, 'function');
});

test('project-create member fields search guild members and exclude the Bot account', async () => {
  const command = projectCommands.find((candidate) => candidate.data.name === 'project-create');
  let choices;
  const members = new Map([
    ['1', { id: '1', displayName: 'Ada Lovelace', user: { username: 'ada', bot: false } }],
    ['2', { id: '2', displayName: 'BAINSA Bot', user: { username: 'bainsa', bot: true } }],
  ]);
  const interaction = {
    commandName: 'project-create',
    guild: {
      members: {
        cache: members,
        async fetch(options) {
          assert.deepEqual(options, { query: 'ad', limit: 25 });
          return members;
        },
      },
    },
    options: {
      getFocused: () => ({ name: 'members', value: 'ad' }),
      getString: () => 'Bocconi',
    },
    async respond(nextChoices) {
      choices = nextChoices;
    },
  };

  await command.autocomplete(interaction);

  assert.deepEqual(choices, [{ name: 'Ada Lovelace (@ada)', value: '<@1>' }]);
});

test('project selection commands expose autocomplete', () => {
  for (const command of projectCommands.filter((candidate) => candidate.data.name !== 'project-create')) {
    const option = command.data.toJSON().options.find((candidate) => candidate.name === 'project');
    assert.equal(option.autocomplete, true, command.data.name);
    assert.equal(typeof command.autocomplete, 'function', command.data.name);
  }
});

test('member role and status choices match the permission design', () => {
  const add = projectCommands.find((candidate) => candidate.data.name === 'project-add-member').data.toJSON();
  const role = add.options.find((option) => option.name === 'role');
  assert.deepEqual(
    role.choices.map((choice) => choice.value),
    ['member', 'supervisor', 'board_liaison'],
  );

  const update = projectCommands.find((candidate) => candidate.data.name === 'project-update').data.toJSON();
  const status = update.options.find((option) => option.name === 'status');
  assert.deepEqual(
    status.choices.map((choice) => choice.value),
    ['active', 'paused'],
  );
});
