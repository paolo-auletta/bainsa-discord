import assert from 'node:assert/strict';
import test from 'node:test';

import { UserFacingError } from '../src/errors.js';
import {
  assertBotCommandChannel,
  assertCommandChannel,
  commandChannelScope,
  isBotCommandChannel,
} from '../src/runtime/command-channels.js';

test('only global and university bot-log channels accept commands', () => {
  assert.equal(
    isBotCommandChannel({ name: 'bot-log', parent: { name: 'LOGS' } }),
    true,
  );
  assert.equal(
    isBotCommandChannel({ name: 'bot-log', parent: { name: 'BAINSA BOCCONI' } }),
    true,
  );
  assert.equal(
    isBotCommandChannel({ name: 'admin-log', parent: { name: 'LOGS' } }),
    false,
  );
  assert.equal(
    isBotCommandChannel({ name: 'bot-log', parent: { name: 'GLOBAL BAINSA' } }),
    false,
  );
  assert.equal(isBotCommandChannel({ name: 'bot-log' }), false);
});

test('command channel failures are user-facing', () => {
  assert.throws(
    () => assertBotCommandChannel({ channel: { name: 'general', parent: { name: 'BAINSA BOCCONI' } } }),
    UserFacingError,
  );
});

test('project topics create a narrow project command scope', () => {
  const channel = {
    name: 'project-42-signals',
    topic: 'Private Signals workspace · Bocconi / Analysis · BAINSA project 42',
  };

  assert.deepEqual(commandChannelScope(channel), { kind: 'project', projectId: '42' });
  assert.deepEqual(
    assertCommandChannel({ channel }, 'project-info'),
    { kind: 'project', projectId: '42' },
  );
  assert.throws(
    () => assertCommandChannel({ channel }, 'project-create'),
    /university #bot-log/,
  );
});
