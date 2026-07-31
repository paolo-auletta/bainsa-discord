#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { projectPath } from '../src/project-paths.js';
import { assertDisposableTestDatabaseUrl } from '../test/helpers/disposable-postgres.js';

const databaseUrl = assertDisposableTestDatabaseUrl(process.env.TEST_DATABASE_URL);
const integrationDirectory = projectPath('dist', 'test', 'integration');
const testFiles = (await readdir(integrationDirectory))
  .filter((filename) => filename.endsWith('.test.js'))
  .sort()
  .map((filename) => join(integrationDirectory, filename));

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
