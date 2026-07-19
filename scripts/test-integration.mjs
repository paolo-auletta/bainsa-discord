#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { readdir } from 'node:fs/promises';

import { assertDisposableTestDatabaseUrl } from '../test/helpers/disposable-postgres.mjs';

const databaseUrl = assertDisposableTestDatabaseUrl(process.env.TEST_DATABASE_URL);
const testFiles = (await readdir(new URL('../test/integration/', import.meta.url)))
  .filter((filename) => filename.endsWith('.test.mjs'))
  .sort()
  .map((filename) => `test/integration/${filename}`);

if (testFiles.length === 0) {
  throw new Error('No PostgreSQL integration tests were found.');
}

const child = spawn(process.execPath, ['--test', '--test-concurrency=1', ...testFiles], {
  env: {
    ...process.env,
    DATABASE_URL: databaseUrl,
    DISCORD_TOKEN: process.env.DISCORD_TOKEN || 'integration-test-token',
    DISCORD_CLIENT_ID: process.env.DISCORD_CLIENT_ID || 'integration-test-client',
    DISCORD_GUILD_ID: process.env.DISCORD_GUILD_ID || 'integration-test-guild',
  },
  stdio: 'inherit',
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exitCode = code ?? 1;
});
