import { logger } from '../logger.mjs';

export function installGracefulShutdown({ client, closeDatabase }) {
  let shuttingDown = false;

  async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('Shutting down bot', { signal });

    try {
      client.destroy();
      await closeDatabase();
      process.exitCode = 0;
    } catch (error) {
      logger.error('Shutdown failed', { error: error instanceof Error ? error.message : String(error) });
      process.exitCode = 1;
    }
  }

  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));

  return shutdown;
}
