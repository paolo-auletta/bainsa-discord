import assert from 'node:assert/strict';
import test from 'node:test';

import { createProjectReconciliationWorker } from '../src/services/projects/reconciliation.mjs';

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test('project reconciliation worker stops its interval and waits for an active retry', async () => {
  const started = deferred();
  const release = deferred();
  const worker = createProjectReconciliationWorker({
    guild: {},
    db: {
      async query() {
        started.resolve();
        await release.promise;
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
