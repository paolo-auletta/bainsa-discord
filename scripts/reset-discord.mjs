#!/usr/bin/env node

import {
  ChannelType,
  Client,
  GatewayIntentBits,
  REST,
  Routes,
} from 'discord.js';
import { config } from '../src/config.mjs';

const CONFIRMATION_FLAG = '--confirm-reset';

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log(`Usage: npm run discord:reset -- ${CONFIRMATION_FLAG}`);
  process.exit(0);
}

if (!process.argv.includes(CONFIRMATION_FLAG)) {
  console.error(`Refusing to reset Discord without ${CONFIRMATION_FLAG}.`);
  process.exit(1);
}

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

try {
  await client.login(config.discordToken);
  const guild = await client.guilds.fetch(config.discordGuildId);
  const [channels, roles, events] = await Promise.all([
    guild.channels.fetch(),
    guild.roles.fetch(),
    guild.scheduledEvents.fetch(),
  ]);

  const rest = new REST({ version: '10' }).setToken(config.discordToken);
  await rest.put(
    Routes.applicationGuildCommands(config.discordClientId, config.discordGuildId),
    { body: [] },
  );

  let eventCount = 0;
  for (const event of events.values()) {
    await event.delete('BAINSA clean deployment reset');
    eventCount += 1;
  }

  const orderedChannels = [...channels.values()]
    .filter(Boolean)
    .sort((left, right) => {
      const leftCategory = left.type === ChannelType.GuildCategory ? 1 : 0;
      const rightCategory = right.type === ChannelType.GuildCategory ? 1 : 0;
      return leftCategory - rightCategory || right.rawPosition - left.rawPosition;
    });

  let channelCount = 0;
  for (const channel of orderedChannels) {
    await channel.delete('BAINSA clean deployment reset');
    channelCount += 1;
  }

  const editableRoles = [...roles.values()]
    .filter((role) => role.id !== guild.id && !role.managed)
    .sort((left, right) => right.position - left.position);

  let roleCount = 0;
  for (const role of editableRoles) {
    if (!role.editable) {
      throw new Error(`Cannot delete role "${role.name}" because it is above the bot role.`);
    }
    await role.delete('BAINSA clean deployment reset');
    roleCount += 1;
  }

  console.log(
    `Reset Discord guild ${guild.name}: ${channelCount} channels, ${roleCount} roles, ` +
      `${eventCount} scheduled events, and all guild commands removed.`,
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  client.destroy();
}
