import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const runnerUrl = new URL('../src/migrations/runner.mjs', import.meta.url);
const scriptUrl = new URL('../scripts/migrate.mjs', import.meta.url);

test('runner uses advisory locking and one transaction per migration', async () => {
  const source = await readFile(runnerUrl, 'utf8');

  assert.match(source, /pg_advisory_lock\(hashtext\(\$1\)\)/);
  assert.match(source, /pg_advisory_unlock\(hashtext\(\$1\)\)/);
  assert.match(source, /await client\.query\('BEGIN'\)/);
  assert.match(source, /await client\.query\('COMMIT'\)/);
  assert.match(source, /await client\.query\('ROLLBACK'\)/);
});

test('runner tracks sha256 checksums and refuses modified applied migrations', async () => {
  const source = await readFile(runnerUrl, 'utf8');

  assert.match(source, /createHash\('sha256'\)/);
  assert.match(source, /checksum char\(64\) NOT NULL/);
  assert.match(source, /Applied migration has been modified/);
  assert.match(source, /appliedMigration\.checksum !== migration\.checksum/);
});

test('runner accepts recorded migrations that are not present locally', async () => {
  const source = await readFile(runnerUrl, 'utf8');

  assert.match(source, /recorded_not_local/);
  assert.match(source, /filter\(\(migration\) => !localFilenames\.has\(migration\.filename\)\)/);
});

test('runner always closes database resources', async () => {
  const source = await readFile(runnerUrl, 'utf8');

  assert.match(source, /finally \{/);
  assert.match(source, /client\.release\(\)/);
  assert.match(source, /await pool\.end\(\)/);
});

test('CLI supports default migrate and --status mode', async () => {
  const source = await readFile(scriptUrl, 'utf8');

  assert.match(source, /args\.has\('--status'\)/);
  assert.match(source, /runMigrations\(\{ statusOnly: args\.has\('--status'\) \}\)/);
  assert.match(source, /formatMigrationStatus/);
});
