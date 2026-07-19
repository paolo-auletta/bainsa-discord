import { PROJECT_PERSON_ROLES, PROJECT_STATUSES } from '../../constants.mjs';
import { UserFacingError, assertUser } from '../../errors.mjs';
import { normalizeDisplayName } from '../../naming.mjs';
import { assertDateOrder, parseIsoDate } from '../../validation.mjs';

const DISCORD_ID_PATTERN = /^\d{15,25}$/;
const USER_MENTION_PATTERN = /^<@!?(\d{15,25})>$/;

export function formatDiscordUserReferences(userIds) {
  return userIds.map((userId) => `<@${userId}>`).join(', ');
}

export function normalizeProjectName(value) {
  try {
    return normalizeDisplayName(value, 'name');
  } catch (error) {
    throw new UserFacingError(error.message);
  }
}

export function normalizeRequiredText(value, fieldName, maxLength = 4_000) {
  const normalized = value?.trim().replace(/\s+/g, ' ');
  assertUser(Boolean(normalized), `${fieldName} is required.`);
  assertUser(normalized.length <= maxLength, `${fieldName} must be at most ${maxLength} characters.`);
  return normalized;
}

export function parseDiscordUserIds(value, fieldName) {
  const tokens = String(value ?? '')
    .split(/[\s,;]+/)
    .map((token) => token.trim())
    .filter(Boolean);

  const ids = [];
  const seen = new Set();

  for (const token of tokens) {
    const mentionMatch = token.match(USER_MENTION_PATTERN);
    const id = mentionMatch?.[1] ?? token;
    if (!DISCORD_ID_PATTERN.test(id)) {
      throw new UserFacingError(`${fieldName} must contain only Discord mentions or numeric user IDs.`);
    }
    if (!seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }

  assertUser(ids.length > 0, `${fieldName} must include at least one user.`);
  return ids;
}

export function assertNoUserOverlap(leftIds, rightIds, leftFieldName, rightFieldName) {
  const rightSet = new Set(rightIds.map(String));
  const overlap = leftIds.filter((id) => rightSet.has(String(id)));
  assertUser(
    overlap.length === 0,
    `${leftFieldName} and ${rightFieldName} cannot contain the same user: ${formatDiscordUserReferences(overlap)}.`,
  );
}

export function validateProjectDates(startDate, expectedEnd) {
  const start = parseIsoDate(startDate, 'start_date');
  const end = parseIsoDate(expectedEnd, 'expected_end');
  assertDateOrder(start, end);
  return { startDate: start, expectedEnd: end };
}

export function validateExpectedEndUpdate(startDate, expectedEnd) {
  if (expectedEnd == null) return null;
  const end = parseIsoDate(expectedEnd, 'expected_end');
  assertDateOrder(startDate, end);
  return end;
}

export function normalizeProjectPersonRole(value) {
  const role = String(value ?? '').trim();
  assertUser(
    Object.values(PROJECT_PERSON_ROLES).includes(role),
    'role must be member, supervisor, or board_liaison.',
  );
  return role;
}

export function normalizeProjectStatus(value) {
  if (value == null) return null;
  const status = String(value).trim();
  assertUser(
    [PROJECT_STATUSES.ACTIVE, PROJECT_STATUSES.PAUSED].includes(status),
    'status can only be active or paused. Use /project-close for completed projects.',
  );
  return status;
}

export function assertProjectStatusChange(currentStatus, nextStatus) {
  if (!nextStatus || nextStatus === currentStatus) return;
  assertUser(
    currentStatus !== PROJECT_STATUSES.ARCHIVED && currentStatus !== PROJECT_STATUSES.COMPLETED,
    'Use /project-close for completed projects.',
  );
}

export function assertProjectIsOpen(status) {
  assertUser(
    [PROJECT_STATUSES.ACTIVE, PROJECT_STATUSES.PAUSED].includes(status),
    'Completed or archived projects cannot be changed.',
  );
}
