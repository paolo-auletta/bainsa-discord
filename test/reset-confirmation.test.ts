import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { resolve } from 'node:path';

import {
  databaseResetTarget,
  discordResetTarget,
  hasResetConfirmation,
  resetConfirmationToken,
} from '../src/reset-confirmation.js';

test('Discord reset confirmation is bound to the configured guild ID', () => {
  const target = discordResetTarget('configured-guild');

  assert.equal(resetConfirmationToken(target), '--confirm-reset=guild:configured-guild');
  assert.equal(hasResetConfirmation(['--confirm-reset=guild:configured-guild'], target), true);
  assert.equal(hasResetConfirmation(['--confirm-reset=guild:other-guild'], target), false);
  assert.equal(hasResetConfirmation(['--confirm-reset'], target), false);
});

test('database reset confirmation identifies the configured host, port, and database without credentials', () => {
  const target = databaseResetTarget(
    'postgresql://operator:super-secret@db.example.test:6543/bainsa_prod?sslmode=require',
  );

  assert.equal(target, 'db:db.example.test:6543/bainsa_prod');
  assert.doesNotMatch(target, /operator|super-secret|sslmode/);
  assert.equal(hasResetConfirmation(['--confirm-reset=db:db.example.test:6543/bainsa_prod'], target), true);
  assert.equal(hasResetConfirmation(['--confirm-reset=db:db.example.test:5432/bainsa_prod'], target), false);
});

test('database reset confirmation uses PostgreSQL default port and rejects incomplete targets', () => {
  assert.equal(databaseResetTarget('postgres://localhost/bainsa'), 'db:localhost:5432/bainsa');
  assert.throws(() => databaseResetTarget('postgres://localhost'), /database/i);
  assert.throws(() => databaseResetTarget('not a URL'), /PostgreSQL connection URL/);
});

test('database reset refusal prints only the sanitized configured target', () => {
  const result = spawnSync(
    process.execPath,
    [
      '--enable-source-maps',
      resolve(process.cwd(), 'dist/scripts/reset-database.js'),
      '--confirm-reset=db:db.example.test:5432/bainsa_prod',
    ],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        DISCORD_TOKEN: 'test-token',
        DISCORD_CLIENT_ID: 'test-client',
        DISCORD_GUILD_ID: 'test-guild',
        DATABASE_URL: 'postgres://operator:super-secret@db.example.test:6543/bainsa_prod?sslmode=require',
      },
    },
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /--confirm-reset=db:db\.example\.test:6543\/bainsa_prod/);
  assert.doesNotMatch(result.stderr, /operator|super-secret|sslmode/);
});

test('Discord reset script rejects a confirmation for a different configured guild', () => {
  const result = spawnSync(
    process.execPath,
    [
      '--enable-source-maps',
      resolve(process.cwd(), 'dist/scripts/reset-discord.js'),
      '--confirm-reset=guild:other-guild',
    ],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        DISCORD_TOKEN: 'sensitive-test-token',
        DISCORD_CLIENT_ID: 'test-client',
        DISCORD_GUILD_ID: 'configured-guild',
        DATABASE_URL: 'postgres://localhost/test',
      },
    },
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /--confirm-reset=guild:configured-guild/);
  assert.doesNotMatch(result.stderr, /sensitive-test-token/);
});
