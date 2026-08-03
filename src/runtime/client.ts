import { Client, GatewayIntentBits } from 'discord.js';

export function createBotClient() {
  return new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
  });
}
