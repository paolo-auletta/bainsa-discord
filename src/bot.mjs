import { Events } from 'discord.js';

import { commands } from './commands/index.mjs';
import { closeDatabase } from './db.mjs';
import { logger } from './logger.mjs';
import { createOnboardingService } from './onboarding/service.mjs';
import { createBotClient } from './runtime/client.mjs';
import { createInteractionDispatcher } from './runtime/dispatcher.mjs';
import { installGracefulShutdown } from './runtime/shutdown.mjs';
import { config } from './config.mjs';
import { warmGovernanceAutocompleteCache } from './services/governance/service.mjs';
import { warmProjectAutocompleteCache } from './services/projects/index.mjs';

const client = createBotClient();
const onboarding = createOnboardingService();
const dispatchInteraction = createInteractionDispatcher({ commands, onboarding });

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

installGracefulShutdown({ client, closeDatabase });

await client.login(config.discordToken);
