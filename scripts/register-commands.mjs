import { REST, Routes } from 'discord.js';

import { commands } from '../src/commands/index.mjs';
import { config } from '../src/config.mjs';
import { logger } from '../src/logger.mjs';
import { serializeCommands } from '../src/runtime/command-registry.mjs';
import { syncCommandPermissions } from '../src/runtime/command-permissions.mjs';

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
});

if (permissionSync.skipped) {
  logger.warn('Skipped guild command visibility sync', { reason: permissionSync.skipped });
} else {
  logger.info('Synced guild command visibility', {
    guildId: config.discordGuildId,
    commandCount: permissionSync.applied,
  });
}
