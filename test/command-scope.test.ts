import assert from 'node:assert/strict';
import test from 'node:test';

import { commands } from '../src/commands/index.js';
import {
  COMMAND_SCOPE_POLICIES,
  resolveCommandContext,
} from '../src/runtime/command-scope.js';

test('the scope policy matrix covers every registered command', () => {
  assert.deepEqual(
    Object.keys(COMMAND_SCOPE_POLICIES).sort(),
    commands.map((command) => command.data.name).sort(),
  );
});

test('command context resolves target, channel, then explicit selection', () => {
  assert.equal(resolveCommandContext({
    commandName: 'member-info',
    channelScope: { kind: 'global' },
    targetUniversity: { id: 'u1', name: 'Bocconi' },
  }).source, 'target');
  assert.equal(resolveCommandContext({
    commandName: 'division-create',
    channelScope: { kind: 'university', universityName: 'Bocconi' },
  }).source, 'channel');
  assert.equal(resolveCommandContext({
    commandName: 'board-info',
    channelScope: { kind: 'global' },
    selectedUniversity: { id: 'u2', name: 'Sapienza' },
  }).source, 'selection');
});

test('command context rejects conflicting target, channel, and selected universities', () => {
  assert.throws(() => resolveCommandContext({
    commandName: 'division-add-member',
    channelScope: { kind: 'university', universityName: 'Bocconi' },
    targetUniversity: 'Sapienza',
  }), /belongs to Sapienza, not this Bocconi/);
  assert.throws(() => resolveCommandContext({
    commandName: 'board-update',
    channelScope: { kind: 'university', universityName: 'Bocconi' },
    selectedUniversity: 'Sapienza',
  }), /scoped to Bocconi, not Sapienza/);
});
