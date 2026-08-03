import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { assertDisposableTestDatabaseUrl } from './helpers/disposable-postgres.js';

test('disposable PostgreSQL integration URLs require a local test database', () => {
  const url = 'postgres://postgres:postgres@127.0.0.1:5432/bainsa_discord_test';
  assert.equal(assertDisposableTestDatabaseUrl(url), url);

  assert.throws(
    () => assertDisposableTestDatabaseUrl('postgres://postgres:postgres@example.com/bainsa_discord_test'),
    /localhost, 127\.0\.0\.1, or ::1/,
  );
  assert.throws(
    () => assertDisposableTestDatabaseUrl('postgres://postgres:postgres@localhost/bainsa_discord'),
    /standalone "test" segment/,
  );
});

test('integration command only reads TEST_DATABASE_URL', async () => {
  const source = await readFile(new URL('../scripts/test-integration.js', import.meta.url), 'utf8');

  assert.match(source, /process\.env\.TEST_DATABASE_URL/);
  assert.doesNotMatch(source, /process\.env\.DATABASE_URL/);
});
