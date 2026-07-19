#!/usr/bin/env node

import { closeDatabase, pool } from '../src/db.mjs';

const CONFIRMATION_FLAG = '--confirm-reset';

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log(`Usage: npm run db:reset -- ${CONFIRMATION_FLAG}`);
  process.exit(0);
}

if (!process.argv.includes(CONFIRMATION_FLAG)) {
  console.error(`Refusing to reset the database without ${CONFIRMATION_FLAG}.`);
  process.exit(1);
}

const applicationTables = [
  'audit_log',
  'audit_logs',
  'board_assignments',
  'discord_roles',
  'divisions',
  'member_divisions',
  'members',
  'onboarding_requests',
  'pending_requests',
  'project_people',
  'projects',
  'provisioned_messages',
  'registry_posts',
  'schema_migrations',
  'team_members',
  'teams',
  'universities',
];

const quotedTables = applicationTables.map((table) => `public."${table}"`).join(',\n  ');

try {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`DROP TABLE IF EXISTS\n  ${quotedTables}\nCASCADE`);
    await client.query('DROP FUNCTION IF EXISTS public.validate_onboarding_divisions() CASCADE');
    await client.query('DROP FUNCTION IF EXISTS public.validate_member_division_university() CASCADE');
    await client.query('DROP FUNCTION IF EXISTS public.set_updated_at() CASCADE');
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }

  console.log(`Reset ${applicationTables.length} known BAINSA database tables and helper functions.`);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await closeDatabase();
}
