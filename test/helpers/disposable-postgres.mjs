import pg from 'pg';

import { buildPostgresConnectionOptions } from '../../src/database-options.mjs';

const { Pool } = pg;
const TEST_DATABASE_NAME = /(?:^|[_-])test(?:[_-]|$)/i;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

export function assertDisposableTestDatabaseUrl(databaseUrl) {
  if (!databaseUrl?.trim()) {
    throw new Error('TEST_DATABASE_URL is required for disposable PostgreSQL integration tests.');
  }

  let parsed;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new Error('TEST_DATABASE_URL must be a valid PostgreSQL connection URL.');
  }

  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) {
    throw new Error('TEST_DATABASE_URL must use the postgres:// or postgresql:// protocol.');
  }
  if (!LOCAL_HOSTS.has(parsed.hostname)) {
    throw new Error('TEST_DATABASE_URL must target localhost, 127.0.0.1, or ::1.');
  }

  const databaseName = decodeURIComponent(parsed.pathname).replace(/^\/+/, '');
  if (!TEST_DATABASE_NAME.test(databaseName)) {
    throw new Error('TEST_DATABASE_URL database name must contain a standalone "test" segment.');
  }

  return databaseUrl;
}

export function createDisposableTestDatabase(databaseUrl = process.env.TEST_DATABASE_URL) {
  const connectionString = assertDisposableTestDatabaseUrl(databaseUrl);
  const pool = new Pool({
    ...buildPostgresConnectionOptions({ databaseUrl: connectionString, databaseSslCa: null }),
    max: 2,
    idleTimeoutMillis: 5_000,
    connectionTimeoutMillis: 10_000,
  });

  return {
    query(text, values = []) {
      return pool.query(text, values);
    },
    async transaction(work) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await work(client);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },
    async resetPublicSchema() {
      await pool.query('DROP SCHEMA IF EXISTS public CASCADE');
      await pool.query('CREATE SCHEMA public');
    },
    async close() {
      await pool.end();
    },
  };
}

export function failTransactionQuery(database, matches) {
  return {
    query: database.query.bind(database),
    async transaction(work) {
      return database.transaction(async (client) => work({
        ...client,
        async query(text, values = []) {
          if (matches(text, values)) throw new Error('Controlled integration transaction failure');
          return client.query(text, values);
        },
      }));
    },
  };
}
