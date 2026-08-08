import assert from 'node:assert/strict';
import test from 'node:test';

import {
  hideProfileAndEnqueue,
  loadActiveMemberProfile,
  publishProfileAndEnqueue,
} from '../src/profiles/repository.js';

const profile = {
  headline: 'Applied researcher improving practical tools',
  about: 'I enjoy collaborative research that helps people solve difficult problems.',
  current_role: 'MSc student',
  goals: 'Explore research collaborations in applied machine learning.',
  selected_tags: ['ai_data'],
};

test('publishing locks canonical active membership, quotes current_role, and enqueues one generation', async () => {
  const calls = [];
  const db = {
    async query(sql, values) {
      calls.push({ sql, values });
      if (calls.length === 1) return { rows: [{ discord_user_id: 'owner' }], rowCount: 1 };
      if (calls.length === 2) return { rows: [{ discord_user_id: 'owner', visibility: 'published' }], rowCount: 1 };
      return { rows: [{ desired_generation: '7' }], rowCount: 1 };
    },
  };

  const result = await publishProfileAndEnqueue(db, 'owner', profile);
  assert.equal(result.desiredGeneration, '7');
  assert.match(calls[0].sql, /FOR UPDATE OF m/);
  assert.match(calls[1].sql, /"current_role"/);
  assert.match(calls[1].sql, /ON CONFLICT \(discord_user_id\)/);
  assert.match(calls[2].sql, /desired_generation = member_profile_reconciliation\.desired_generation \+ 1/);
  assert.deepEqual(calls[1].values.slice(0, 6), [
    'owner', profile.headline, profile.about, profile.current_role, profile.goals, ['ai_data'],
  ]);
});

test('hiding a profile queues deletion only while Discord state could remain', async () => {
  const calls = [];
  const db = {
    async query(sql) {
      calls.push(sql);
      if (calls.length === 1) {
        return { rows: [{ discord_user_id: 'owner', visibility: 'hidden', forum_thread_id: 'thread', forum_message_id: 'thread' }], rowCount: 1 };
      }
      return { rows: [{ desired_generation: '2' }], rowCount: 1 };
    },
  };
  assert.deepEqual((await hideProfileAndEnqueue(db, 'owner'))?.desiredGeneration, '2');
  assert.match(calls[0], /visibility <> 'hidden' OR forum_thread_id IS NOT NULL/);

  const hidden = { async query() { return { rows: [], rowCount: 0 }; } };
  assert.equal(await hideProfileAndEnqueue(hidden, 'owner'), null);
});

test('active profile loading derives member, university, and active division canonically', async () => {
  let sql = '';
  await loadActiveMemberProfile({
    async query(statement) {
      sql = statement;
      return { rows: [] };
    },
  }, 'owner');
  assert.match(sql, /JOIN universities u/);
  assert.match(sql, /member_divisions md/);
  assert.match(sql, /coalesce\(d\.active, true\) = true/);
  assert.match(sql, /m\.status = 'active'/);
  assert.match(sql, /p\."current_role"/);
});
