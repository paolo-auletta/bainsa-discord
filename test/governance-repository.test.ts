import assert from 'node:assert/strict';
import test from 'node:test';

import {
  deactivateExactBoardAssignment,
  listActiveBoardAssignments,
  lockUniversityForUpdate,
} from '../src/services/governance/repository.js';

test('governance repository preserves board transaction lock and exact-removal contracts', async () => {
  const calls = [];
  const db = {
    async query(text, values) {
      calls.push({ text, values });
      return { rows: [] };
    },
  };

  await lockUniversityForUpdate(db, 7);
  await listActiveBoardAssignments(db, 7, { forUpdate: true });
  await deactivateExactBoardAssignment(db, 'member-1', 7, 'head', null);

  assert.match(calls[0].text, /SELECT id FROM universities WHERE id = \$1 FOR UPDATE/);
  assert.match(calls[1].text, /FOR UPDATE OF br/);
  assert.match(calls[2].text, /division_id IS NOT DISTINCT FROM \$4/);
  assert.deepEqual(calls[2].values, ['member-1', 7, 'head', null]);
});
