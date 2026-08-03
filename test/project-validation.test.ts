import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseDiscordUserIds,
  projectIdFromOption,
  validateProjectDates,
} from '../src/services/projects/index.js';
import {
  assertNoUserOverlap,
  assertProjectParticipantCapacity,
  assertProjectIsOpen,
  formatDiscordUserReferences,
  assertProjectStatusChange,
  normalizeProjectPersonRole,
  normalizeProjectStatus,
  validateExpectedEndUpdate,
} from '../src/services/projects/validation.js';
import {
  DISCORD_CHANNEL_PERMISSION_OVERWRITE_LIMIT,
  MAX_PROJECT_PARTICIPANTS,
  PROJECT_PERSON_ROLES,
  PROJECT_RESERVED_PERMISSION_OVERWRITES,
  PROJECT_STATUSES,
} from '../src/constants.js';
import { UserFacingError } from '../src/errors.js';

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

test('project participant capacity accepts the limit after deduplicating input', () => {
  const participantIds = Array.from(
    { length: MAX_PROJECT_PARTICIPANTS },
    (_, index) => String(100000000000000 + index),
  );

  assert.doesNotThrow(() => assertProjectParticipantCapacity(participantIds.slice(0, -1)));
  assert.doesNotThrow(() => assertProjectParticipantCapacity(participantIds));
  assert.doesNotThrow(() => assertProjectParticipantCapacity([...participantIds, participantIds.at(-1)]));
  assert.throws(
    () => assertProjectParticipantCapacity([...participantIds, '999999999999999']),
    new RegExp(`at most ${MAX_PROJECT_PARTICIPANTS} unique participants`),
  );
  assert.equal(
    MAX_PROJECT_PARTICIPANTS + PROJECT_RESERVED_PERMISSION_OVERWRITES,
    DISCORD_CHANNEL_PERMISSION_OVERWRITE_LIMIT,
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
