import { closeDatabase, pool } from '../src/db.js';
import { config } from '../src/config.js';
import { INITIAL_SERVER_PLAN } from '../src/constants.js';
import { createProvisionClient, provisionDiscord } from '../src/provision/index.js';

const dryRun = process.argv.includes('--dry-run');
const client = createProvisionClient();

try {
  await client.login(config.discordToken);
  await provisionDiscord({
    client,
    config,
    db: pool,
    dryRun,
    plan: INITIAL_SERVER_PLAN,
    logger: console,
  });
} finally {
  client.destroy();
  await closeDatabase();
}
