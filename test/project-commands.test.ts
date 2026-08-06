import test from 'node:test';
import assert from 'node:assert/strict';

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

test('project-create opens a zero-argument private wizard', async () => {
  const command = projectCommands.find((candidate) => candidate.data.name === 'project-create').data.toJSON();
  assert.deepEqual(command.options, []);

  const definition = projectCommands.find((candidate) => candidate.data.name === 'project-create');
  let modal;
  await definition.execute({
    user: { id: 'actor-native-selectors' },
    guildId: 'guild',
    showModal: async (payload) => { modal = payload.toJSON(); },
  });

  assert.equal(modal.title, 'Project setup · Name');
  assert.match(modal.custom_id, /^pc:/);
  assert.equal(modal.components[0].components[0].custom_id, 'project_name');
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
