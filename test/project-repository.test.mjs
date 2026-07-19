import assert from 'node:assert/strict';
import test from 'node:test';

import { insertProjectPeople } from '../src/services/projects/repository.mjs';

test('project participant repository inserts all roles in one set-based query', async () => {
  const calls = [];
  const db = {
    async query(sql, values) {
      calls.push({ sql, values });
      return { rows: [] };
    },
  };
  const people = [
    { discord_user_id: 'member', role: 'member' },
    { discord_user_id: 'supervisor', role: 'supervisor' },
    { discord_user_id: 'liaison', role: 'board_liaison' },
  ];

  await insertProjectPeople(db, 42, people);

  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /unnest\(\$2::text\[\], \$3::text\[\]\)/);
  assert.match(calls[0].sql, /ON CONFLICT \(project_id, discord_user_id\)/);
  assert.deepEqual(calls[0].values, [42, ['member', 'supervisor', 'liaison'], ['member', 'supervisor', 'board_liaison']]);
});
