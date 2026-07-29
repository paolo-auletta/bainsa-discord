import { Events } from 'discord.js';

import { commands } from './commands/index.mjs';
import { closeDatabase, query, transaction } from './db.mjs';
import { guideInteractions } from './guide/service.mjs';
import { logger } from './logger.mjs';
import { createOnboardingService } from './onboarding/service.mjs';
import { createBotClient } from './runtime/client.mjs';
import { createInteractionDispatcher } from './runtime/dispatcher.mjs';
import { installGracefulShutdown } from './runtime/shutdown.mjs';
import { config } from './config.mjs';
import { warmGovernanceAutocompleteCache } from './services/governance/service.mjs';
import { warmProjectAutocompleteCache } from './services/projects/index.mjs';
import { createProjectReconciliationWorker } from './services/projects/reconciliation.mjs';

const client = createBotClient();
const onboarding = createOnboardingService();
const dispatchInteraction = createInteractionDispatcher({ commands, onboarding, guide: guideInteractions });
let projectReconciliationWorker = null;

client.once(Events.ClientReady, (readyClient) => {
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
  void dispatchInteraction(interaction).catch((error) => {
    logger.error('Unhandled interaction dispatch failure', {
      error: error instanceof Error ? error.message : String(error),
      stack: error?.stack,
    });
  });
});

client.on(Events.GuildMemberAdd, (member) => {
  void onboarding.sendJoinDm(member);
});

client.on(Events.Error, (error) => {
  logger.error('Discord client error', { error: error instanceof Error ? error.message : String(error) });
});

installGracefulShutdown({ client, closeDatabase, stopWorkers: () => projectReconciliationWorker?.stop() });

await client.login(config.discordToken);
