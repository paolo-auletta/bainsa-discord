import { REST, Routes } from 'discord.js';

import { config } from '../src/config.mjs';
import { closeDatabase, query } from '../src/db.mjs';
import { logger } from '../src/logger.mjs';

const rest = new REST({ version: '10' }).setToken(config.discordToken);

try {
  const guild = await rest.get(Routes.guild(config.discordGuildId));
  await query('SELECT 1 AS ok');

  logger.info('Connection checks passed', {
    guildId: guild.id,
    guildName: guild.name,
    database: 'ok',
  });
} finally {
  await closeDatabase();
}
