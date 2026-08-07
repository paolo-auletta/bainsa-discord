import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { test } from 'node:test';

import { projectPath } from '../src/project-paths.js';

const migrationDir = projectPath('db', 'migrations');
const migrationUrl = projectPath('db', 'migrations', '003_upgrade_v1_contract.sql');
const onboardingMigrationUrl = projectPath('db', 'migrations', '004_onboarding_name_and_single_division.sql');
const divisionColorMigrationUrl = projectPath('db', 'migrations', '005_division_colors.sql');
const expandedDivisionColorMigrationUrl = projectPath('db', 'migrations', '006_expand_division_colors.sql');
const reconciliationMigrationUrl = projectPath('db', 'migrations', '007_project_reconciliation.sql');
const coPresidentsMigrationUrl = projectPath('db', 'migrations', '008_allow_co_presidents.sql');
const executivePromotionMigrationUrl = projectPath(
  'db',
  'migrations',
  '009_clear_division_roles_on_executive_promotion.sql',
);
const executiveExclusivityMigrationUrl = projectPath(
  'db',
  'migrations',
  '010_enforce_executive_division_exclusivity.sql',
);
const immutableDivisionUniversityMigrationUrl = projectPath(
  'db',
  'migrations',
  '011_make_division_university_immutable.sql',
);
const removedMemberOnboardingMigrationUrl = projectPath(
  'db',
  'migrations',
  '012_removed_member_onboarding.sql',
);

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

async function reconciliationMigrationSql() {
  return readFile(reconciliationMigrationUrl, 'utf8');
}

async function coPresidentsMigrationSql() {
  return readFile(coPresidentsMigrationUrl, 'utf8');
}

async function executivePromotionMigrationSql() {
  return readFile(executivePromotionMigrationUrl, 'utf8');
}

async function executiveExclusivityMigrationSql() {
  return readFile(executiveExclusivityMigrationUrl, 'utf8');
}

async function immutableDivisionUniversityMigrationSql() {
  return readFile(immutableDivisionUniversityMigrationUrl, 'utf8');
}

async function removedMemberOnboardingMigrationSql() {
  return readFile(removedMemberOnboardingMigrationUrl, 'utf8');
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
    '007_project_reconciliation.sql',
    '008_allow_co_presidents.sql',
    '009_clear_division_roles_on_executive_promotion.sql',
    '010_enforce_executive_division_exclusivity.sql',
    '011_make_division_university_immutable.sql',
    '012_removed_member_onboarding.sql',
  ]);
});

test('prevents division university changes from bypassing scoped invariants', async () => {
  const sql = await immutableDivisionUniversityMigrationSql();

  assertIncludes(sql, 'CREATE OR REPLACE FUNCTION prevent_division_university_change()');
  assertIncludes(sql, 'NEW.university_id IS DISTINCT FROM OLD.university_id');
  assertIncludes(sql, 'BEFORE UPDATE OF university_id ON divisions');
});

test('records when an onboarding application follows a member removal', async () => {
  const sql = await removedMemberOnboardingMigrationSql();

  assertIncludes(sql, 'ADD COLUMN IF NOT EXISTS previously_removed boolean NOT NULL DEFAULT false');
  assert.equal(/\bdrop\s+table\b/i.test(sql), false);
  assert.equal(/\btruncate\b/i.test(sql), false);
});

test('allows multiple active university Presidents', async () => {
  const sql = await coPresidentsMigrationSql();

  assertIncludes(sql, 'DROP INDEX IF EXISTS board_assignments_active_president_per_university_unique');
});

test('defers and serializes executive division cleanup across all relevant writes', async () => {
  const sql = await executiveExclusivityMigrationSql();

  assertIncludes(sql, 'DROP TRIGGER IF EXISTS board_assignments_clear_division_roles_on_executive_promotion');
  assertIncludes(sql, 'pg_advisory_xact_lock');
  assertIncludes(sql, 'AFTER INSERT OR UPDATE OF active, role, university_id, discord_user_id ON board_assignments');
  assertIncludes(sql, 'DEFERRABLE INITIALLY DEFERRED');
  assertIncludes(sql, 'member_divisions_enforce_executive_division_exclusivity');
});

test('clears division assignments when an executive board role becomes active', async () => {
  const sql = await executivePromotionMigrationSql();

  assertIncludes(sql, 'CREATE OR REPLACE FUNCTION clear_division_assignments_for_executive_promotion()');
  assertIncludes(sql, "NEW.role IN ('vice_president', 'president')");
  assertIncludes(sql, 'DELETE FROM member_divisions AS md');
  assertIncludes(sql, "AND role = 'head'");
  assertIncludes(sql, 'BEFORE INSERT OR UPDATE OF active, role ON board_assignments');
});

test('adds durable, generation-guarded project reconciliation state', async () => {
  const sql = await reconciliationMigrationSql();
  assertIncludes(sql, 'CREATE TABLE IF NOT EXISTS project_reconciliation');
  assertIncludes(sql, 'desired_generation bigint NOT NULL DEFAULT 0');
  assertIncludes(sql, "status IN ('pending', 'processing', 'succeeded', 'failed')");
  assertIncludes(sql, 'project_reconciliation_repair_idx');
  assertIncludes(sql, "INSERT INTO project_reconciliation (project_id, desired_generation, status)");
  assertIncludes(sql, 'ON CONFLICT (project_id) DO NOTHING');
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
