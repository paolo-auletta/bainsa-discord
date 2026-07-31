import { REST, Routes } from 'discord.js';

import { commands } from '../src/commands/index.js';
import { config } from '../src/config.js';
import { logger } from '../src/logger.js';
import { serializeCommands } from '../src/runtime/command-registry.js';
import { syncCommandPermissions } from '../src/runtime/command-permissions.js';

const allowUnsyncedVisibility = process.argv.slice(2).includes('--allow-unsynced-visibility');
if (!config.discordClientSecret && !allowUnsyncedVisibility) {
  throw new Error(
    'DISCORD_CLIENT_SECRET is required for production command registration because command visibility ' +
    'must be synchronized. For local development or tests only, rerun with --allow-unsynced-visibility.',
  );
}

const rest = new REST({ version: '10' }).setToken(config.discordToken);
const body = serializeCommands(commands);

const registered = await rest.put(
  Routes.applicationGuildCommands(config.discordClientId, config.discordGuildId),
  { body },
);

logger.info('Registered guild slash commands', {
  guildId: config.discordGuildId,
  commandCount: body.length,
});

// Discord can briefly lag between command replacement and permission updates.
await new Promise((resolve) => setTimeout(resolve, 2_500));

const permissionSync = await syncCommandPermissions({
  clientId: config.discordClientId,
  clientSecret: config.discordClientSecret,
  botToken: config.discordToken,
  guildId: config.discordGuildId,
  commands: registered,
  allowUnsynced: allowUnsyncedVisibility,
});

if (permissionSync.skipped) {
  logger.warn('Skipped guild command visibility sync', { reason: permissionSync.skipped });
} else {
  logger.info('Synced guild command visibility', {
    guildId: config.discordGuildId,
    commandCount: permissionSync.applied,
  });
}
