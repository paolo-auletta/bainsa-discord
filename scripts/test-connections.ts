import { REST, Routes } from 'discord.js';

import { config } from '../src/config.js';
import { closeDatabase, query } from '../src/db.js';
import { logger } from '../src/logger.js';

const rest = new REST({ version: '10' }).setToken(config.discordToken);

try {
  const guild = await rest.get(Routes.guild(config.discordGuildId)) as { id: string; name: string };
  await query('SELECT 1 AS ok');

  logger.info('Connection checks passed', {
    guildId: guild.id,
    guildName: guild.name,
    database: 'ok',
  });
} finally {
  await closeDatabase();
}
