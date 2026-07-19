import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseDiscordUserIds,
  projectIdFromOption,
  validateProjectDates,
} from '../src/services/projects/index.mjs';
import {
  assertNoUserOverlap,
  assertProjectIsOpen,
  formatDiscordUserReferences,
  assertProjectStatusChange,
  normalizeProjectPersonRole,
  normalizeProjectStatus,
  validateExpectedEndUpdate,
} from '../src/services/projects/validation.mjs';
import { PROJECT_PERSON_ROLES, PROJECT_STATUSES } from '../src/constants.mjs';
import { UserFacingError } from '../src/errors.mjs';

test('parseDiscordUserIds accepts mentions, raw IDs, separators, and dedupes', () => {
  assert.deepEqual(
    parseDiscordUserIds('<@123456789012345678>, <@!222222222222222222> 123456789012345678', 'members'),
    ['123456789012345678', '222222222222222222'],
  );
});

test('parseDiscordUserIds rejects empty and malformed values', () => {
  assert.throws(() => parseDiscordUserIds('', 'members'), UserFacingError);
  assert.throws(() => parseDiscordUserIds('not-a-user', 'members'), /mentions or numeric user IDs/);
});

test('date validation preserves ISO values and rejects reversed timelines', () => {
  assert.deepEqual(validateProjectDates('2026-01-02', '2026-02-03'), {
    startDate: '2026-01-02',
    expectedEnd: '2026-02-03',
  });
  assert.throws(() => validateProjectDates('2026-02-03', '2026-01-02'), /expected_end/);
  assert.equal(validateExpectedEndUpdate('2026-01-02', '2026-01-03'), '2026-01-03');
});

test('project role and status validation only accepts v1 values', () => {
  assert.equal(normalizeProjectPersonRole(PROJECT_PERSON_ROLES.SUPERVISOR), PROJECT_PERSON_ROLES.SUPERVISOR);
  assert.equal(normalizeProjectStatus(PROJECT_STATUSES.PAUSED), PROJECT_STATUSES.PAUSED);
  assert.throws(() => normalizeProjectPersonRole('owner'), /role must/);
  assert.throws(() => normalizeProjectStatus(PROJECT_STATUSES.COMPLETED), /project-close/);
  assert.throws(() => normalizeProjectStatus(PROJECT_STATUSES.ARCHIVED), /project-close/);
  assert.throws(() => normalizeProjectStatus('deleted'), /status/);
});

test('project-create rejects users repeated as member and supervisor', () => {
  assert.doesNotThrow(() => assertNoUserOverlap(['1'], ['2'], 'members', 'supervisors'));
  assert.throws(
    () => assertNoUserOverlap(['1', '2'], ['2', '3'], 'members', 'supervisors'),
    /cannot contain the same user: <@2>/,
  );
});

test('user-facing errors use Discord mentions instead of raw IDs', () => {
  assert.equal(
    formatDiscordUserReferences(['123456789012345678', '222222222222222222']),
    '<@123456789012345678>, <@222222222222222222>',
  );
});

test('status transitions prevent lifecycle changes through project-update', () => {
  assert.doesNotThrow(() => assertProjectStatusChange(PROJECT_STATUSES.ACTIVE, PROJECT_STATUSES.PAUSED));
  assert.throws(
    () => assertProjectStatusChange(PROJECT_STATUSES.ARCHIVED, PROJECT_STATUSES.ACTIVE),
    /project-close/,
  );
  assert.throws(
    () => assertProjectStatusChange(PROJECT_STATUSES.COMPLETED, PROJECT_STATUSES.PAUSED),
    /project-close/,
  );
});

test('only active or paused projects can be changed', () => {
  assert.doesNotThrow(() => assertProjectIsOpen(PROJECT_STATUSES.ACTIVE));
  assert.doesNotThrow(() => assertProjectIsOpen(PROJECT_STATUSES.PAUSED));
  assert.throws(() => assertProjectIsOpen(PROJECT_STATUSES.COMPLETED), /cannot be changed/);
  assert.throws(() => assertProjectIsOpen(PROJECT_STATUSES.ARCHIVED), /cannot be changed/);
});

test('project IDs must be canonical positive integer autocomplete values', () => {
  assert.equal(projectIdFromOption('42'), '42');
  for (const value of ['', '0', '-1', 'project-42', '42abc', ' 42 2 ']) {
    assert.throws(() => projectIdFromOption(value), /Choose a valid project/);
  }
});
