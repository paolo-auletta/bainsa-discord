import assert from 'node:assert/strict';
import test from 'node:test';

import { createProfileReconciliationWorker, reconcileProfile } from '../src/profiles/reconciliation.js';

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test('a reconciliation claim is generation guarded and skips an already processing row', async () => {
  const calls = [];
  const db = {
    async transaction(work) { return work(this); },
    async query(sql) {
      calls.push(sql);
      if (sql.includes('SELECT desired_generation')) return { rows: [], rowCount: 0 };
      throw new Error(`Unexpected query: ${sql}`);
    },
  };
  const result = await reconcileProfile({ discordUserId: 'owner', guild: {}, db });
  assert.deepEqual(result, { status: 'skipped', discordUserId: 'owner' });
  assert.match(calls[0], /FOR UPDATE SKIP LOCKED/);
  assert.match(calls[0], /started_at < now\(\) - interval '5 minutes'/);
});

test('profile worker stops its timer and waits for an in-flight maintenance lookup', async () => {
  const started = deferred();
  const release = deferred();
  let queries = 0;
  const worker = createProfileReconciliationWorker({
    guild: { id: 'guild' },
    db: {
      async query() {
        queries += 1;
        if (queries === 1) {
          started.resolve();
          await release.promise;
        }
        return { rows: [] };
      },
    },
    intervalMs: 60_000,
  });
  await started.promise;
  let stopped = false;
  const stopping = worker.stop().then(() => { stopped = true; });
  await Promise.resolve();
  assert.equal(stopped, false);
  release.resolve();
  await stopping;
  assert.equal(stopped, true);
});
