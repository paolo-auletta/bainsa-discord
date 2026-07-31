import assert from 'node:assert/strict';
import test from 'node:test';

import { UserFacingError } from '../src/errors.js';
import { assertBotCommandChannel, isBotCommandChannel } from '../src/runtime/command-channels.js';

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
