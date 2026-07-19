import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import pg from 'pg';

const { Pool } = pg;

const LOCK_KEY = 'bainsa-discord:migrations';
const DEFAULT_MIGRATIONS_DIR = fileURLToPath(
  new URL('../../db/migrations/', import.meta.url),
);

function migrationChecksum(sql) {
  return createHash('sha256').update(sql).digest('hex');
}

async function discoverMigrations(migrationsDir = DEFAULT_MIGRATIONS_DIR) {
  const entries = await readdir(migrationsDir, { withFileTypes: true });
  const filenames = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.sql'))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));

  return Promise.all(
    filenames.map(async (filename) => {
      const fullPath = path.join(migrationsDir, filename);
      const sql = await readFile(fullPath, 'utf8');
      return {
        filename,
        fullPath,
        sql,
        checksum: migrationChecksum(sql),
      };
    }),
  );
}

async function migrationTableExists(client) {
  const result = await client.query(
    "SELECT to_regclass('public.schema_migrations') AS table_name",
  );
  return result.rows[0]?.table_name === 'schema_migrations';
}

async function ensureMigrationTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename text PRIMARY KEY,
      checksum char(64) NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now(),
      execution_ms integer NOT NULL
    )
  `);
}

async function readAppliedMigrations(client, { createTable = false } = {}) {
  if (createTable) {
    await ensureMigrationTable(client);
  } else if (!(await migrationTableExists(client))) {
    return new Map();
  }

  const result = await client.query(`
    SELECT filename, checksum, applied_at, execution_ms
    FROM schema_migrations
    ORDER BY filename
  `);

  return new Map(
    result.rows.map((row) => [
      row.filename,
      {
        filename: row.filename,
        checksum: String(row.checksum).trim(),
        appliedAt: row.applied_at,
        executionMs: row.execution_ms,
      },
    ]),
  );
}

function assertAppliedChecksumsUnchanged(migrations, applied) {
  for (const migration of migrations) {
    const appliedMigration = applied.get(migration.filename);
    if (!appliedMigration) {
      continue;
    }

    if (appliedMigration.checksum !== migration.checksum) {
      throw new Error(
        [
          `Applied migration has been modified: ${migration.filename}`,
          `database checksum: ${appliedMigration.checksum}`,
          `local checksum:    ${migration.checksum}`,
        ].join('\n'),
      );
    }
  }
}

function buildStatus(migrations, applied) {
  const localFilenames = new Set(migrations.map((migration) => migration.filename));
  const rows = migrations.map((migration) => {
    const appliedMigration = applied.get(migration.filename);
    const checksumMatches = !appliedMigration
      ? null
      : appliedMigration.checksum === migration.checksum;

    return {
      filename: migration.filename,
      status: appliedMigration ? 'applied' : 'pending',
      checksum: migration.checksum,
      appliedAt: appliedMigration?.appliedAt ?? null,
      executionMs: appliedMigration?.executionMs ?? null,
      checksumMatches,
    };
  });

  const recordedOnly = [...applied.values()]
    .filter((migration) => !localFilenames.has(migration.filename))
    .map((migration) => ({
      filename: migration.filename,
      status: 'recorded_not_local',
      checksum: migration.checksum,
      appliedAt: migration.appliedAt,
      executionMs: migration.executionMs,
      checksumMatches: null,
    }));

  return [...recordedOnly, ...rows].sort((left, right) =>
    left.filename.localeCompare(right.filename),
  );
}

function makePool(databaseUrl) {
  return new Pool({
    connectionString: databaseUrl,
    ssl: databaseUrl.includes('localhost') ? false : { rejectUnauthorized: false },
    max: 1,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 10_000,
  });
}

async function acquireLock(client) {
  await client.query('SELECT pg_advisory_lock(hashtext($1))', [LOCK_KEY]);
}

async function releaseLock(client) {
  await client.query('SELECT pg_advisory_unlock(hashtext($1))', [LOCK_KEY]);
}

async function applyMigration(client, migration) {
  const startedAt = performance.now();
  await client.query('BEGIN');

  try {
    await client.query(migration.sql);
    const executionMs = Math.max(0, Math.round(performance.now() - startedAt));
    await client.query(
      `
        INSERT INTO schema_migrations (filename, checksum, applied_at, execution_ms)
        VALUES ($1, $2, now(), $3)
      `,
      [migration.filename, migration.checksum, executionMs],
    );
    await client.query('COMMIT');
    return { filename: migration.filename, executionMs };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

export async function runMigrations({
  databaseUrl = process.env.DATABASE_URL,
  migrationsDir = DEFAULT_MIGRATIONS_DIR,
  statusOnly = false,
} = {}) {
  if (!databaseUrl?.trim()) {
    throw new Error('DATABASE_URL is required to run migrations.');
  }

  const migrations = await discoverMigrations(migrationsDir);
  const pool = makePool(databaseUrl);
  const client = await pool.connect();
  let lockAcquired = false;

  try {
    await acquireLock(client);
    lockAcquired = true;

    const applied = await readAppliedMigrations(client, { createTable: !statusOnly });
    const status = buildStatus(migrations, applied);
    assertAppliedChecksumsUnchanged(migrations, applied);

    if (statusOnly) {
      return {
        migrationsDir,
        applied: status.filter((row) => row.status === 'applied').length,
        pending: status.filter((row) => row.status === 'pending').length,
        recordedNotLocal: status.filter((row) => row.status === 'recorded_not_local').length,
        status,
      };
    }

    const appliedNow = [];
    for (const migration of migrations) {
      if (!applied.has(migration.filename)) {
        appliedNow.push(await applyMigration(client, migration));
      }
    }

    const finalApplied = await readAppliedMigrations(client);
    const finalStatus = buildStatus(migrations, finalApplied);

    return {
      migrationsDir,
      appliedNow,
      applied: finalStatus.filter((row) => row.status === 'applied').length,
      pending: finalStatus.filter((row) => row.status === 'pending').length,
      recordedNotLocal: finalStatus.filter((row) => row.status === 'recorded_not_local').length,
      status: finalStatus,
    };
  } finally {
    if (lockAcquired) {
      try {
        await releaseLock(client);
      } catch {
        // Connection close will release the session lock if explicit unlock fails.
      }
    }
    client.release();
    await pool.end();
  }
}

export function formatMigrationStatus(result) {
  const lines = [
    `Migrations directory: ${result.migrationsDir}`,
    `Applied local migrations: ${result.applied}`,
    `Pending local migrations: ${result.pending}`,
    `Recorded but not local: ${result.recordedNotLocal}`,
  ];

  if (result.appliedNow?.length) {
    lines.push('');
    lines.push('Applied now:');
    for (const migration of result.appliedNow) {
      lines.push(`- ${migration.filename} (${migration.executionMs}ms)`);
    }
  }

  lines.push('');
  lines.push('Status:');
  for (const row of result.status) {
    const checksumText =
      row.checksumMatches === false ? ' checksum-mismatch' : '';
    lines.push(`- ${row.filename}: ${row.status}${checksumText}`);
  }

  return lines.join('\n');
}
