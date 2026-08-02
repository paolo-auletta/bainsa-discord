import { logger } from '../logger.js';

export function installGracefulShutdown({ client, closeDatabase, stopWorkers = () => {} }) {
  let shuttingDown = false;

  const onSigint = () => void shutdown('SIGINT');
  const onSigterm = () => void shutdown('SIGTERM');

  function removeSignalListeners() {
    process.removeListener('SIGINT', onSigint);
    process.removeListener('SIGTERM', onSigterm);
  }

  async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    removeSignalListeners();
    logger.info('Shutting down bot', { signal });

    try {
      await stopWorkers();
      client.destroy();
      await closeDatabase();
      process.exitCode = 0;
    } catch (error) {
      logger.error('Shutdown failed', { error: error instanceof Error ? error.message : String(error) });
      process.exitCode = 1;
    }
  }

  process.once('SIGINT', onSigint);
  process.once('SIGTERM', onSigterm);

  return {
    shutdown,
    isShuttingDown: () => shuttingDown,
    dispose: removeSignalListeners,
  };
}
