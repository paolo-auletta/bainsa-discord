import { Events } from 'discord.js';

import { commands } from './commands/index.js';
import { closeDatabase, query, transaction } from './db.js';
import { guideInteractions } from './guide/service.js';
import { logger } from './logger.js';
import { createOnboardingService } from './onboarding/service.js';
import { createBotClient } from './runtime/client.js';
import { createInteractionDispatcher } from './runtime/dispatcher.js';
import { isConfiguredGuildEvent } from './runtime/guild-events.js';
import { installGracefulShutdown } from './runtime/shutdown.js';
import { config } from './config.js';
import { createProfileService } from './profiles/index.js';
import { createProfileReconciliationWorker } from './profiles/reconciliation.js';
import { hideDepartedMemberProfile, warmGovernanceAutocompleteCache } from './services/governance/service.js';
import { projectCreateSetup, warmProjectAutocompleteCache } from './services/projects/index.js';
import { createProjectReconciliationWorker } from './services/projects/reconciliation.js';

const client = createBotClient();
const onboarding = createOnboardingService();
const profiles = createProfileService();
const dispatchInteraction = createInteractionDispatcher({
  commands,
  onboarding,
  guide: guideInteractions,
  projectSetup: projectCreateSetup,
  profiles,
});
let projectReconciliationWorker: ReturnType<typeof createProjectReconciliationWorker> | null = null;
let profileReconciliationWorker: ReturnType<typeof createProfileReconciliationWorker> | null = null;

const lifecycle = installGracefulShutdown({
  client,
  closeDatabase,
  stopWorkers: async () => {
    await Promise.all([
      projectReconciliationWorker?.stop(),
      profileReconciliationWorker?.stop(),
    ]);
  },
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
    profileReconciliationWorker = createProfileReconciliationWorker({ guild, db: { query, transaction } });
  } else {
    logger.warn('Reconciliation workers were not started because the configured guild is unavailable');
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
  if (lifecycle.isShuttingDown() || !isConfiguredGuildEvent(member, config.discordGuildId)) return;
  void onboarding.sendJoinDm(member);
});

client.on(Events.GuildMemberRemove, (member) => {
  if (lifecycle.isShuttingDown() || !isConfiguredGuildEvent(member, config.discordGuildId)) return;
  void hideDepartedMemberProfile(member, { db: { query, transaction } }).catch(() => {
    logger.warn('Could not hide departed member directory profile', {
      discordUserId: String(member.id),
    });
  });
});

client.on(Events.Error, (error) => {
  logger.error('Discord client error', { error: error instanceof Error ? error.message : String(error) });
});

await client.login(config.discordToken);
