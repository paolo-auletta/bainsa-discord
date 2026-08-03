#!/usr/bin/env node

import { formatMigrationStatus, runMigrations } from '../src/migrations/runner.js';

const args = new Set(process.argv.slice(2));

if (args.has('--help') || args.has('-h')) {
  console.log('Usage: npm run db:migrate -- [--status]');
  process.exit(0);
}

try {
  const result = await runMigrations({ statusOnly: args.has('--status') });
  console.log(formatMigrationStatus(result));
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
