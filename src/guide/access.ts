import { ROLE_NAMES } from '../constants.js';
import { canDiscoverCommand } from '../runtime/command-permissions.js';
import { GUIDE_CATALOG } from './catalog.js';

function roles(member) {
  const cache = member?.roles?.cache;
  if (!cache) return [];
  if (Array.isArray(cache)) return cache;
  if (typeof cache.values === 'function') return [...cache.values()];
  return [];
}

export function memberRoleNames(member) {
  return roles(member).map((role) => role?.name).filter(Boolean);
}

export function buildGuideAccess({ member, channelScope }) {
  if (!member || !channelScope) return null;
  const roleNames = memberRoleNames(member);
  const global = roleNames.includes(ROLE_NAMES.GLOBAL_PRESIDENT);
  if (channelScope.kind === 'global' && !global) return null;

  const universityName = channelScope.kind === 'university' ? channelScope.universityName : null;
  const presidentRole = universityName ? `${universityName} - President` : null;
  const vicePresidentRole = universityName ? `${universityName} - Vice President` : null;
  const headPrefix = universityName ? `${universityName} - Head of ` : null;
  const president = Boolean(presidentRole && roleNames.includes(presidentRole));
  const vicePresident = Boolean(vicePresidentRole && roleNames.includes(vicePresidentRole));
  const divisions = headPrefix
    ? roleNames
        .filter((roleName) => roleName.startsWith(headPrefix))
        .map((roleName) => roleName.slice(headPrefix.length).trim())
        .filter(Boolean)
    : [];

  if (!global && !president && !vicePresident && divisions.length === 0) return null;

  const availableCommands = new Set(
    GUIDE_CATALOG
      .filter((item) =>
        canDiscoverCommand({
          commandName: item.command,
          member,
          channelScope,
        }),
      )
      .map((item) => item.command),
  );

  const roleLabels = [];
  if (global) roleLabels.push('Global President');
  if (president) roleLabels.push(`President · ${universityName}`);
  if (vicePresident) roleLabels.push(`Vice President · ${universityName}`);
  roleLabels.push(...divisions.map((division) => `Head of ${division} · ${universityName}`));

  return {
    global,
    president,
    vicePresident,
    universityName,
    divisions: [...new Set(divisions)],
    roleLabels,
    availableCommands,
  };
}

export function guideScopeLabel(access, entry = null) {
  if (access.global) return 'All universities';
  if (!entry) {
    if (access.president || access.vicePresident) return access.universityName;
    return access.divisions.map((division) => `${access.universityName} › ${division}`).join('\n');
  }
  if (entry.scopeKind === 'university') return access.universityName;
  if (entry.scopeKind === 'project') {
    if (access.president || access.vicePresident) return `${access.universityName} projects you can view`;
    return `${access.universityName} › ${access.divisions.join(', ')} projects, plus projects you personally join`;
  }
  if (access.president || access.vicePresident) return `${access.universityName} › all divisions`;
  return access.divisions.map((division) => `${access.universityName} › ${division}`).join('\n');
}
