import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { test } from 'node:test';

const migrationDir = new URL('../db/migrations/', import.meta.url);
const migrationUrl = new URL('../db/migrations/003_upgrade_v1_contract.sql', import.meta.url);
const onboardingMigrationUrl = new URL('../db/migrations/004_onboarding_name_and_single_division.sql', import.meta.url);
const divisionColorMigrationUrl = new URL('../db/migrations/005_division_colors.sql', import.meta.url);
const expandedDivisionColorMigrationUrl = new URL('../db/migrations/006_expand_division_colors.sql', import.meta.url);

async function migrationSql() {
  return readFile(migrationUrl, 'utf8');
}

async function onboardingMigrationSql() {
  return readFile(onboardingMigrationUrl, 'utf8');
}

async function divisionColorMigrationSql() {
  return readFile(divisionColorMigrationUrl, 'utf8');
}

async function expandedDivisionColorMigrationSql() {
  return readFile(expandedDivisionColorMigrationUrl, 'utf8');
}

function assertIncludes(sql, snippet) {
  assert.ok(sql.includes(snippet), `Expected migration to include: ${snippet}`);
}

test('keeps migrations append-only from the live V1 upgrade path', async () => {
  const filenames = (await readdir(migrationDir))
    .filter((filename) => filename.endsWith('.sql'))
    .sort();

  assert.deepEqual(filenames, [
    '003_upgrade_v1_contract.sql',
    '004_onboarding_name_and_single_division.sql',
    '005_division_colors.sql',
    '006_expand_division_colors.sql',
  ]);
});

test('preserves the legacy migration table shape', async () => {
  const sql = await migrationSql();

  assertIncludes(sql, 'CREATE TABLE IF NOT EXISTS schema_migrations');
  assertIncludes(sql, 'filename text PRIMARY KEY');
  assertIncludes(sql, 'checksum char(64) NOT NULL');
  assertIncludes(sql, 'applied_at timestamptz NOT NULL DEFAULT now()');
  assertIncludes(sql, 'execution_ms integer NOT NULL');
});

test('upgrades universities and divisions in place', async () => {
  const sql = await migrationSql();

  assertIncludes(sql, 'ALTER TABLE universities RENAME COLUMN discord_category_id TO category_id');
  assertIncludes(sql, 'ALTER TABLE universities RENAME COLUMN discord_board_channel_id TO board_channel_id');
  assertIncludes(sql, 'ALTER TABLE divisions RENAME COLUMN discord_general_channel_id TO text_channel_id');
  assertIncludes(sql, 'ALTER TABLE divisions RENAME COLUMN discord_voice_channel_id TO voice_channel_id');
  assertIncludes(sql, 'COALESCE(is_cross_university, false) = true');
  assertIncludes(sql, 'SET active = false');
});

test('defines the core V1 tables and integrity constraints', async () => {
  const sql = await migrationSql();

  for (const table of [
    'members',
    'member_divisions',
    'board_assignments',
    'projects',
    'project_people',
    'onboarding_requests',
    'audit_log',
    'provisioned_messages',
  ]) {
    assertIncludes(sql, `CREATE TABLE IF NOT EXISTS ${table}`);
  }

  assertIncludes(sql, "CHECK (member_type IN ('researcher', 'alumni'))");
  assertIncludes(sql, "CHECK (status IN ('active', 'removed'))");
  assertIncludes(sql, "CHECK (role IN ('head', 'vice_president', 'president', 'global_president'))");
  assertIncludes(sql, "CHECK (status IN ('active', 'paused', 'completed', 'archived'))");
  assertIncludes(sql, "CHECK (role IN ('member', 'supervisor', 'board_liaison'))");
  assertIncludes(sql, "CHECK (status IN ('draft', 'pending', 'approved', 'rejected', 'cancelled'))");
  assertIncludes(sql, 'FOREIGN KEY (division_id, university_id) REFERENCES divisions(id, university_id)');
  assertIncludes(sql, 'CHECK (expected_end >= start_date)');
  assertIncludes(sql, 'ALTER TABLE projects ALTER COLUMN start_date SET NOT NULL');
  assertIncludes(sql, 'ALTER TABLE projects ALTER COLUMN expected_end SET NOT NULL');
  assertIncludes(sql, 'PRIMARY KEY (discord_user_id, division_id)');
  assertIncludes(sql, 'member division must belong to the member university');
});

test('keeps canonical integration columns', async () => {
  const sql = await migrationSql();

  for (const column of [
    'discord_role_id text',
    'category_id text',
    'announcements_channel_id text',
    'board_channel_id text',
    'showcase_channel_id text',
    'onboarding_review_channel_id text',
    'member_role_id text',
    'head_role_id text',
    'text_channel_id text',
    'voice_channel_id text',
    'discord_user_id text',
    'member_type text,',
    'university_id bigint REFERENCES universities(id)',
    'division_ids bigint[] NOT NULL DEFAULT ARRAY[]::bigint[]',
    'channel_id text',
    'showcase_thread_id text',
    'start_date date NOT NULL',
    'expected_end date NOT NULL',
    'review_message_id text',
    'reviewed_by text',
    'review_reason text',
    'reviewed_at timestamptz',
    'guild_id text',
    'message_id text',
  ]) {
    assertIncludes(sql, column);
  }

  assert.equal(sql.includes('division_ids jsonb'), false);
  assert.equal(sql.includes('review jsonb'), false);
});

test('onboarding drafts can be created before member type and university are chosen', async () => {
  const sql = await migrationSql();

  assertIncludes(sql, 'ALTER TABLE onboarding_requests ALTER COLUMN member_type DROP NOT NULL');
  assertIncludes(sql, 'ALTER TABLE onboarding_requests ALTER COLUMN university_id DROP NOT NULL');
  assertIncludes(sql, 'ADD CONSTRAINT onboarding_requests_shape_check');
  assertIncludes(sql, "status IN ('draft', 'cancelled')");
  assertIncludes(sql, 'OR (member_type IS NOT NULL AND university_id IS NOT NULL)');
});

test('has uniqueness, lookup indexes, and onboarding validation', async () => {
  const sql = await migrationSql();

  assertIncludes(sql, 'CREATE UNIQUE INDEX IF NOT EXISTS universities_name_ci_unique');
  assertIncludes(sql, 'CREATE UNIQUE INDEX IF NOT EXISTS divisions_university_name_ci_unique');
  assertIncludes(sql, 'board_assignments_active_member_role_unique');
  assertIncludes(sql, 'board_assignments_active_head_per_division_unique');
  assertIncludes(sql, 'onboarding_requests_one_open_per_user_unique');
  assertIncludes(sql, 'CREATE OR REPLACE FUNCTION validate_onboarding_divisions()');
  assertIncludes(sql, 'onboarding division_ids must belong to the selected university');
});

test('does not add cross-university project representation or destructive data removal', async () => {
  const sql = (await migrationSql()).toLowerCase();

  assert.equal(sql.includes('cross_university_projects'), false);
  assert.equal(sql.includes('cross_university_project'), false);
  assert.equal(/\bdrop\s+table\b/.test(sql), false);
  assert.equal(/\btruncate\b/.test(sql), false);
  assert.equal(/\bdelete\s+from\b/.test(sql), false);
});

test('records onboarding names and restricts researcher onboarding to one division', async () => {
  const sql = await onboardingMigrationSql();

  assertIncludes(sql, 'ADD COLUMN IF NOT EXISTS full_name text');
  assertIncludes(sql, 'ADD COLUMN IF NOT EXISTS full_name_required boolean NOT NULL DEFAULT false');
  assertIncludes(sql, 'onboarding_requests_submitted_name_check');
  assertIncludes(sql, "researcher onboarding requests can include only one division");
  assert.equal(/\bdrop\s+table\b/i.test(sql), false);
  assert.equal(/\btruncate\b/i.test(sql), false);
});

test('adds semantic division colors and backfills the standard divisions', async () => {
  const sql = await divisionColorMigrationSql();

  assertIncludes(sql, "ADD COLUMN IF NOT EXISTS color text NOT NULL DEFAULT 'blue'");
  assertIncludes(sql, "WHEN 'analysis' THEN 'orange'");
  assertIncludes(sql, "WHEN 'culture' THEN 'pink'");
  assertIncludes(sql, 'divisions_color_check');
});

test('expands division colors to eight square-icon choices', async () => {
  const sql = await expandedDivisionColorMigrationSql();

  assertIncludes(sql, 'DROP CONSTRAINT IF EXISTS divisions_color_check');
  assertIncludes(sql, "CHECK (color IN ('red', 'orange', 'yellow', 'green', 'blue', 'pink', 'brown', 'black'))");
});
