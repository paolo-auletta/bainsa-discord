import assert from 'node:assert/strict';
import test from 'node:test';

import { installGracefulShutdown } from '../src/runtime/shutdown.js';

test('graceful shutdown exposes its state before awaiting resource cleanup', async () => {
  const calls: string[] = [];
  let releaseWorker: () => void = () => {};
  const workerStopped = new Promise<void>((resolve) => {
    releaseWorker = resolve;
  });
  const lifecycle = installGracefulShutdown({
    client: {
      destroy() {
        calls.push('client');
      },
    },
    async stopWorkers() {
      calls.push('worker:start');
      await workerStopped;
      calls.push('worker:end');
    },
    async closeDatabase() {
      calls.push('database');
    },
  });

  assert.equal(lifecycle.isShuttingDown(), false);
  const shutdown = lifecycle.shutdown('TEST');
  assert.equal(lifecycle.isShuttingDown(), true);
  assert.deepEqual(calls, ['worker:start']);

  releaseWorker();
  await shutdown;

  assert.deepEqual(calls, ['worker:start', 'worker:end', 'client', 'database']);
});
