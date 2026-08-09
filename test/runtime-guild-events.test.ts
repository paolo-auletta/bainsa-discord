import assert from 'node:assert/strict';
import test from 'node:test';

import { isConfiguredGuildEvent } from '../src/runtime/guild-events.js';

test('guild lifecycle events are accepted only from the configured BAINSA guild', () => {
  assert.equal(isConfiguredGuildEvent({ guild: { id: 'bainsa' } }, 'bainsa'), true);
  assert.equal(isConfiguredGuildEvent({ guild: { id: 'other-guild' } }, 'bainsa'), false);
  assert.equal(isConfiguredGuildEvent({ id: 'member-without-guild' }, 'bainsa'), false);
});
