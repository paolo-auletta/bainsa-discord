import pg from 'pg';
import type { PoolClient, QueryConfigValues, QueryResult, QueryResultRow } from 'pg';

import { config } from './config.js';
import { buildPostgresConnectionOptions } from './database-options.js';

const { Pool } = pg;

export const pool = new Pool({
  ...buildPostgresConnectionOptions({
    databaseUrl: config.databaseUrl,
    databaseSslCa: config.databaseSslCa,
  }),
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
});

export function query<Row extends QueryResultRow = QueryResultRow>(
  text: string,
  values: QueryConfigValues<unknown[]> = [],
): Promise<QueryResult<Row>> {
  return pool.query<Row>(text, values);
}

export async function transaction<Result>(work: (client: PoolClient) => Promise<Result>): Promise<Result> {
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
}

export function closeDatabase() {
  return pool.end();
}
