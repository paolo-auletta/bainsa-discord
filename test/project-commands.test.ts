import test from 'node:test';
import assert from 'node:assert/strict';

import { projectCommands } from '../src/commands/projects/index.js';

test('exports the v1 project command set', () => {
  assert.deepEqual(
    projectCommands.map((command) => command.data.name),
    [
      'project-create',
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

test('only project-info keeps the inline autocomplete selector', () => {
  const info = projectCommands.find((candidate) => candidate.data.name === 'project-info');
  const option = info.data.toJSON().options.find((candidate) => candidate.name === 'project');
  assert.equal(option.autocomplete, true);
  assert.equal(option.required, false);
  assert.equal(typeof info.autocomplete, 'function');
});

test('project update and close open zero-argument private panel flows', () => {
  for (const commandName of ['project-update', 'project-close']) {
    const command = projectCommands.find((candidate) => candidate.data.name === commandName).data.toJSON();
    assert.deepEqual(command.options, [], commandName);
    assert.match(command.description, /private guided/i, commandName);
  }
});

test('standalone project participant commands are removed', () => {
  assert.equal(projectCommands.some((candidate) => candidate.data.name === 'project-add-member'), false);
  assert.equal(projectCommands.some((candidate) => candidate.data.name === 'project-remove-member'), false);
});
