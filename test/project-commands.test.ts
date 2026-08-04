import test from 'node:test';
import assert from 'node:assert/strict';

import { ComponentType } from 'discord.js';

import { projectCommands } from '../src/commands/projects/index.js';

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
      ['start_date', true],
      ['expected_end', true],
      ['notes', false],
    ],
  );
});

test('project-create autocompletes its scoped setup fields', () => {
  const command = projectCommands.find((candidate) => candidate.data.name === 'project-create');
  for (const name of ['university', 'division']) {
    const option = command.data.toJSON().options.find((candidate) => candidate.name === name);
    assert.equal(option.autocomplete, true, name);
  }
  assert.equal(typeof command.autocomplete, 'function');
});

test('project-create opens native Discord user selectors for members and supervisors', async () => {
  const command = projectCommands.find((candidate) => candidate.data.name === 'project-create');
  let reply;
  const values = {
    name: 'Native selectors', university: 'Bocconi', division: 'Projects',
    start_date: '2026-08-01', expected_end: '2026-09-01', notes: null,
  };
  await command.execute({
    user: { id: 'actor-native-selectors' },
    guildId: 'guild',
    options: { getString: (name) => values[name] ?? null },
    reply: async (payload) => { reply = payload; },
  });

  const components = reply.components.map((row) => row.toJSON());
  assert.equal(components[0].components[0].type, ComponentType.UserSelect);
  assert.equal(components[1].components[0].type, ComponentType.UserSelect);
  assert.equal(components[0].components[0].max_values, 25);
  assert.equal(components[1].components[0].max_values, 25);
  assert.equal(components[2].components[0].disabled, true);
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
