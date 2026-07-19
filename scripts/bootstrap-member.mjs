#!/usr/bin/env node

import { Client, GatewayIntentBits } from 'discord.js';
import { config } from '../src/config.mjs';

function valuesFor(option) {
  const values = [];
  for (let index = 2; index < process.argv.length; index += 1) {
    if (process.argv[index] === option && process.argv[index + 1]) {
      values.push(process.argv[index + 1]);
      index += 1;
    }
  }
  return values;
}

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log(
    'Usage: npm run discord:bootstrap -- --user-id USER_ID --role "Researcher" --role "Bocconi"',
  );
  process.exit(0);
}

const [userId] = valuesFor('--user-id');
const roleNames = [...new Set(valuesFor('--role').map((name) => name.trim()).filter(Boolean))];

if (!userId || roleNames.length === 0) {
  console.error('Both --user-id and at least one --role are required.');
  process.exit(1);
}

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers] });

try {
  await client.login(config.discordToken);
  const guild = await client.guilds.fetch(config.discordGuildId);
  const [member, roles] = await Promise.all([
    guild.members.fetch(userId),
    guild.roles.fetch(),
  ]);

  const resolvedRoles = roleNames.map((name) => {
    const matches = [...roles.values()].filter((role) => role.name === name);
    if (matches.length !== 1) {
      throw new Error(`Expected exactly one Discord role named "${name}", found ${matches.length}.`);
    }
    return matches[0];
  });

  await member.roles.add(resolvedRoles, 'BAINSA initial access bootstrap');
  console.log(`Assigned ${resolvedRoles.map((role) => role.name).join(', ')} to ${member.user.username}.`);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  client.destroy();
}
