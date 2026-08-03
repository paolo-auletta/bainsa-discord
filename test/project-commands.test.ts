import test from 'node:test';
import assert from 'node:assert/strict';

import { projectCommands } from '../src/commands/projects/index.js';
import { warmProjectAutocompleteCache } from '../src/services/projects/index.js';

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

test('project-create person fields use the cached university and division membership lists', async () => {
  const command = projectCommands.find((candidate) => candidate.data.name === 'project-create');
  await warmProjectAutocompleteCache({
    db: {
      async query(text) {
        if (text.includes('FROM universities')) return { rows: [{ name: 'Bocconi' }, { name: 'Sapienza' }] };
        if (text.includes('FROM divisions')) return { rows: [{ university_name: 'Bocconi', name: 'Projects', color: 'blue' }] };
        return {
          rows: [
            { discord_user_id: '1', full_name: 'Ada Lovelace', member_type: 'researcher', university_name: 'Bocconi', division_name: 'Projects' },
            { discord_user_id: '2', full_name: 'Beatrice Bianchi', member_type: 'alumni', university_name: 'Bocconi', division_name: 'Projects' },
            { discord_user_id: '3', full_name: 'Carlo Conti', member_type: 'researcher', university_name: 'Bocconi', division_name: 'Analysis' },
            { discord_user_id: '4', full_name: 'Daria De Luca', member_type: 'researcher', university_name: 'Sapienza', division_name: 'Projects' },
          ],
        };
      },
    },
  });

  async function autocomplete(focusedName) {
    let choices;
    await command.autocomplete({
      commandName: 'project-create',
      options: {
        getFocused: () => ({ name: focusedName, value: '' }),
        getString: (name) => ({ university: 'Bocconi', division: 'Projects' })[name] ?? null,
      },
      async respond(nextChoices) {
        choices = nextChoices;
      },
    });
    return choices;
  }

  assert.deepEqual(await autocomplete('members'), [{ name: 'Ada Lovelace (<@1>)', value: '<@1>' }]);
  assert.deepEqual(await autocomplete('supervisors'), [
    { name: 'Ada Lovelace (<@1>)', value: '<@1>' },
    { name: 'Beatrice Bianchi (<@2>)', value: '<@2>' },
    { name: 'Carlo Conti (<@3>)', value: '<@3>' },
  ]);
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
