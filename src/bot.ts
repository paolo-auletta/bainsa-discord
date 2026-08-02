import { Events } from 'discord.js';

import { commands } from './commands/index.js';
import { closeDatabase, query, transaction } from './db.js';
import { guideInteractions } from './guide/service.js';
import { logger } from './logger.js';
import { createOnboardingService } from './onboarding/service.js';
import { createBotClient } from './runtime/client.js';
import { createInteractionDispatcher } from './runtime/dispatcher.js';
import { installGracefulShutdown } from './runtime/shutdown.js';
import { config } from './config.js';
import { warmGovernanceAutocompleteCache } from './services/governance/service.js';
import { warmProjectAutocompleteCache } from './services/projects/index.js';
import { createProjectReconciliationWorker } from './services/projects/reconciliation.js';

const client = createBotClient();
const onboarding = createOnboardingService();
const dispatchInteraction = createInteractionDispatcher({ commands, onboarding, guide: guideInteractions });
let projectReconciliationWorker: ReturnType<typeof createProjectReconciliationWorker> | null = null;
const lifecycle = installGracefulShutdown({
  client,
  closeDatabase,
  stopWorkers: () => projectReconciliationWorker?.stop(),
});

client.once(Events.ClientReady, (readyClient) => {
  if (lifecycle.isShuttingDown()) return;
  logger.info('BAINSA Discord bot is online', {
    botUserId: readyClient.user.id,
    guildId: config.discordGuildId,
  });
  void warmGovernanceAutocompleteCache().catch((error) => {
    logger.warn('Could not warm governance autocomplete cache', {
      error: error instanceof Error ? error.message : String(error),
    });
  });
  void warmProjectAutocompleteCache().catch((error) => {
    logger.warn('Could not warm project autocomplete cache', {
      error: error instanceof Error ? error.message : String(error),
    });
  });
  const guild = readyClient.guilds.cache.get(config.discordGuildId);
  if (guild) {
    projectReconciliationWorker = createProjectReconciliationWorker({ guild, db: { query, transaction } });
  } else {
    logger.warn('Project reconciliation worker was not started because the configured guild is unavailable');
  }
});

client.on(Events.InteractionCreate, (interaction) => {
  if (lifecycle.isShuttingDown()) return;
  void dispatchInteraction(interaction).catch((error) => {
    logger.error('Unhandled interaction dispatch failure', {
      error: error instanceof Error ? error.message : String(error),
      stack: error?.stack,
    });
  });
});

client.on(Events.GuildMemberAdd, (member) => {
  if (lifecycle.isShuttingDown()) return;
  void onboarding.sendJoinDm(member);
});

client.on(Events.Error, (error) => {
  logger.error('Discord client error', { error: error instanceof Error ? error.message : String(error) });
});

await client.login(config.discordToken);
