const REQUIRED_ENV = [
  'DISCORD_TOKEN',
  'DISCORD_CLIENT_ID',
  'DISCORD_GUILD_ID',
  'DATABASE_URL',
];

export function loadConfig(env = process.env) {
  const missing = REQUIRED_ENV.filter((name) => !env[name]?.trim());
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }

  return Object.freeze({
    discordToken: env.DISCORD_TOKEN,
    discordClientId: env.DISCORD_CLIENT_ID,
    discordClientSecret: env.DISCORD_CLIENT_SECRET?.trim() || null,
    discordGuildId: env.DISCORD_GUILD_ID,
    databaseUrl: env.DATABASE_URL,
    anonymousFeedbackUrl: env.ANONYMOUS_FEEDBACK_URL?.trim() || null,
    logLevel: env.LOG_LEVEL?.trim() || 'info',
  });
}

export const config = loadConfig();
