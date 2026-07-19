import { closeDatabase, pool } from '../src/db.mjs';
import { config } from '../src/config.mjs';
import { INITIAL_SERVER_PLAN } from '../src/constants.mjs';
import { createProvisionClient, provisionDiscord } from '../src/provision/index.mjs';

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
