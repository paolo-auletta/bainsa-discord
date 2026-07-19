import { BOARD_ROLES, ROLE_NAMES } from './constants.mjs';
import { assertUser } from './errors.mjs';
import { divisionHeadRoleName, universityBoardRoleName } from './naming.mjs';

const USER_LIST_OPTIONS = new Set(['members', 'supervisors']);

export function botUserId(context) {
  return context?.client?.user?.id
    ?? context?.guild?.members?.me?.id
    ?? context?.members?.me?.id
    ?? null;
}

export function assertNotBotUser(context, userId) {
  const botId = botUserId(context);
  assertUser(!botId || String(userId) !== String(botId), 'The Bot member cannot be managed or assigned by commands.');
}

export function assertNoBotUserIds(context, userIds) {
  for (const userId of userIds ?? []) assertNotBotUser(context, userId);
}

export function assertNoBotCommandTarget(interaction) {
  const botId = botUserId(interaction);
  if (!botId) return;

  const visit = (options = []) => {
    for (const option of options) {
      if (option.type === 6 && String(option.value) === String(botId)) return true;
      if (USER_LIST_OPTIONS.has(option.name) && listContainsUserId(option.value, botId)) return true;
      if (visit(option.options)) return true;
    }
    return false;
  };

  assertUser(!visit(interaction.options?.data), 'The Bot member cannot be managed or assigned by commands.');
}

function listContainsUserId(value, userId) {
  const escaped = String(userId).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|[\\s,;])(?:<@!?${escaped}>|${escaped})(?=$|[\\s,;])`).test(String(value ?? ''));
}

export function hasRole(member, roleName) {
  return member.roles.cache.some((role) => role.name === roleName);
}

export function isGlobalPresident(member) {
  return hasRole(member, ROLE_NAMES.GLOBAL_PRESIDENT);
}

export function isUniversityPresident(member, universityName) {
  return hasRole(member, universityBoardRoleName(universityName, 'President'));
}

export function isUniversityVicePresident(member, universityName) {
  return hasRole(member, universityBoardRoleName(universityName, 'Vice President'));
}

export function isDivisionHead(member, universityName, divisionName) {
  return hasRole(member, divisionHeadRoleName(universityName, divisionName));
}

export function assertUniversityAuthority(member, universityName, allowed) {
  if (isGlobalPresident(member)) return;
  const checks = {
    [BOARD_ROLES.PRESIDENT]: () => isUniversityPresident(member, universityName),
    [BOARD_ROLES.VICE_PRESIDENT]: () => isUniversityVicePresident(member, universityName),
  };
  assertUser(
    allowed.some((role) => checks[role]?.()),
    `You do not have permission to manage ${universityName}.`,
  );
}

export function assertDivisionAuthority(member, universityName, divisionName, allowed) {
  if (isGlobalPresident(member)) return;
  const checks = {
    [BOARD_ROLES.PRESIDENT]: () => isUniversityPresident(member, universityName),
    [BOARD_ROLES.VICE_PRESIDENT]: () => isUniversityVicePresident(member, universityName),
    [BOARD_ROLES.HEAD]: () => isDivisionHead(member, universityName, divisionName),
  };
  assertUser(
    allowed.some((role) => checks[role]?.()),
    `You do not have permission to manage ${divisionName} at ${universityName}.`,
  );
}
