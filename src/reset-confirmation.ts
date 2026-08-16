const CONFIRMATION_FLAG = '--confirm-reset';

export function resetConfirmationToken(target: string) {
  return `${CONFIRMATION_FLAG}=${target}`;
}

export function hasResetConfirmation(args: readonly string[], target: string) {
  return args.includes(resetConfirmationToken(target));
}

export function discordResetTarget(guildId: string) {
  return `guild:${guildId}`;
}

export function databaseResetTarget(databaseUrl: string) {
  let url: URL;
  try {
    url = new URL(databaseUrl);
  } catch {
    throw new Error('DATABASE_URL must be a valid PostgreSQL connection URL to reset the database.');
  }

  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname) {
    throw new Error('DATABASE_URL must identify a PostgreSQL host and database to reset the database.');
  }

  const database = url.pathname.slice(1);
  if (!database) {
    throw new Error('DATABASE_URL must identify a PostgreSQL database to reset the database.');
  }

  return `db:${url.hostname}:${url.port || '5432'}/${database}`;
}
