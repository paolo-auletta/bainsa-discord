import { ApplicationCommandPermissionType } from 'discord.js';

import { hasGlobalAuthority } from '../authorization.js';

const DISCORD_API_URL = 'https://discord.com/api/v10';
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_REQUEST_ATTEMPTS = 8;

interface DiscordApiRequestOptions {
  method?: string;
  authorization?: string;
  body?: unknown;
}

interface DiscordAccessTokenResponse {
  access_token?: string;
}

interface DiscordRateLimitResponse {
  retry_after?: number;
}

export const COMMAND_VISIBILITY = Object.freeze({
  guide: 'board',
  'member-update': 'executive',
  'member-remove': 'executive',
  'member-info': 'board',
  'division-create': 'president',
  'division-update': 'president',
  'division-add-member': 'board',
  'division-remove-member': 'board',
  'board-update': 'executive',
  'board-info': 'board',
  'project-create': 'board',
  'project-update': 'project',
  'project-close': 'project',
  'project-info': 'project',
});

function memberRoleNames(member) {
  const cache = member?.roles?.cache;
  if (!cache?.some) return [];

  const names = [];
  cache.some((role) => {
    if (typeof role?.name === 'string') names.push(role.name.toLowerCase());
    return false;
  });
  return names;
}

function hasScopedBoardRole(member, universityName, visibility) {
  const prefix = `${universityName} - `.toLowerCase();
  const roleNames = memberRoleNames(member);
  if (visibility === 'president') return roleNames.includes(`${prefix}president`);
  if (visibility === 'executive') {
    return roleNames.includes(`${prefix}president`) || roleNames.includes(`${prefix}vice president`);
  }
  return roleNames.some(
    (roleName) =>
      roleName === `${prefix}president` ||
      roleName === `${prefix}vice president` ||
      roleName.startsWith(`${prefix}head of `),
  );
}

/**
 * Returns whether this interaction's cached member can discover a command in
 * the given command-channel scope. It intentionally performs no API or
 * database lookup: incomplete or stale interaction context is denied.
 */
export function canDiscoverCommand({ commandName, member, channelScope }) {
  const visibility = COMMAND_VISIBILITY[commandName];
  if (!visibility || !channelScope || !member) return false;
  if (channelScope.kind === 'project') return visibility === 'project';
  // Cross-university authority is exercised from the dedicated global bot log.
  // A member who also has a role for this university retains that local route.
  if (channelScope.kind === 'global') return hasGlobalAuthority(member);
  if (channelScope.kind !== 'university' || !channelScope.universityName) return false;
  return hasScopedBoardRole(member, channelScope.universityName, visibility);
}

export function visibleRoleIds(visibility, roles) {
  const global = roles.filter((role) => role.name === 'Global President');
  const presidents = roles.filter((role) => role.name.endsWith(' - President'));
  const executives = roles.filter((role) => role.name.endsWith(' - Vice President'));
  const heads = roles.filter((role) => role.name.includes(' - Head of '));
  const approvedMembers = roles.filter((role) => role.name === 'Researcher' || role.name === 'Alumni');
  const selected = visibility === 'president'
    ? [...global, ...presidents]
    : visibility === 'executive'
      ? [...global, ...presidents, ...executives]
      : visibility === 'project'
        ? [...global, ...presidents, ...executives, ...heads, ...approvedMembers]
        : [...global, ...presidents, ...executives, ...heads];
  return [...new Set(selected.map((role) => String(role.id)))];
}

export function buildCommandPermissionOverwrites({ commandName, guildId, roles }) {
  const visibility = COMMAND_VISIBILITY[commandName];
  if (!visibility) throw new Error(`No command visibility policy is defined for ${commandName}.`);
  return [
    {
      id: String(guildId),
      type: ApplicationCommandPermissionType.Role,
      permission: false,
    },
    ...visibleRoleIds(visibility, roles).map((id) => ({
      id,
      type: ApplicationCommandPermissionType.Role,
      permission: true,
      })),
  ];
}

export async function syncCommandPermissions({
  clientId,
  clientSecret,
  botToken,
  guildId,
  commands,
  allowUnsynced = false,
}) {
  if (!clientSecret) {
    if (!allowUnsynced) {
      throw new Error(
        'DISCORD_CLIENT_SECRET is required to synchronize board-only command visibility. ' +
        'For local development or tests only, pass --allow-unsynced-visibility explicitly.',
      );
    }
    return {
      applied: 0,
      skipped: 'Command visibility sync explicitly disabled for local development or tests.',
    };
  }

  const accessToken = await getCommandPermissionAccessToken(clientId, clientSecret);
  const roles = await discordApiRequest(`/guilds/${guildId}/roles`, {
    authorization: `Bot ${botToken}`,
  }) as Array<{ id: string; name: string }>;
  const managed = commands.filter((command) => COMMAND_VISIBILITY[command.name]);
  for (const command of managed) {
    const path = `/applications/${clientId}/guilds/${guildId}/commands/${command.id}/permissions`;
    const body = {
      permissions: buildCommandPermissionOverwrites({
        commandName: command.name,
        guildId,
        roles,
      }),
    };
    try {
      await discordApiRequest(path, {
        method: 'PUT',
        authorization: `Bearer ${accessToken}`,
        body,
      });
    } catch (error) {
      if (error.message.includes('[10011]')) {
        try {
          const current = await discordApiRequest(path, { authorization: `Bearer ${accessToken}` }) as {
            permissions?: Array<{ id: string; type: number; permission: boolean }>;
          };
          if (sameCommandPermissions(current?.permissions, body.permissions)) continue;
        } catch {
          // Preserve the original PUT error below when verification also fails.
        }
      }
      throw new Error(`Could not sync permissions for /${command.name}: ${error.message}`, { cause: error });
    }
  }

  return { applied: managed.length, skipped: null };
}

function sameCommandPermissions(actual, expected) {
  if (!Array.isArray(actual) || actual.length !== expected.length) return false;
  const key = (permission) => `${permission.id}:${permission.type}:${permission.permission}`;
  const actualKeys = actual.map(key).sort();
  const expectedKeys = expected.map(key).sort();
  return actualKeys.every((value, index) => value === expectedKeys[index]);
}

async function getCommandPermissionAccessToken(clientId, clientSecret) {
  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const response = await fetch(`${DISCORD_API_URL}/oauth2/token`, {
    method: 'POST',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: {
      Authorization: `Basic ${credentials}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      scope: 'applications.commands.permissions.update',
    }),
  });

  if (!response.ok) {
    throw new Error(`Could not obtain an application-command permission token (${response.status}).`);
  }

  const payload = await response.json() as DiscordAccessTokenResponse;
  if (!payload?.access_token) throw new Error('Discord did not return an application-command permission token.');
  return payload.access_token;
}

async function discordApiRequest(
  path,
  { method = 'GET', authorization, body }: DiscordApiRequestOptions = {},
) {
  for (let attempt = 0; attempt < MAX_REQUEST_ATTEMPTS; attempt += 1) {
    const response = await fetch(`${DISCORD_API_URL}${path}`, {
      method,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: {
        Authorization: authorization,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });

    if (response.status === 429 && attempt < MAX_REQUEST_ATTEMPTS - 1) {
      const payload = await response.json().catch(() => ({})) as DiscordRateLimitResponse;
      const retryAfterMs = Math.max(100, Math.ceil(Number(payload.retry_after ?? 1) * 1_000));
      await new Promise((resolve) => setTimeout(resolve, retryAfterMs));
      continue;
    }

    if (!response.ok) {
      const responseText = await response.text().catch(() => '');
      let payload = null;
      try {
        payload = JSON.parse(responseText);
      } catch {
        // Keep the raw response text when Discord does not return JSON.
      }

      if (payload?.code === 10011 && attempt < MAX_REQUEST_ATTEMPTS - 1) {
        await new Promise((resolve) => setTimeout(resolve, 1_500));
        continue;
      }

      let detail = responseText.trim();
      try {
        detail = payload?.message ?? payload?.code
          ? `${payload.message ?? ''}${payload.code ? ` [${payload.code}]` : ''}`.trim()
          : responseText.trim();
      } catch {
        // The raw response text is already available as the fallback.
      }
      throw new Error(
        `Discord command permission request failed (${response.status})${detail ? `: ${detail}` : '.'}`,
      );
    }

    if (response.status === 204) return null;
    return response.json();
  }

  throw new Error('Discord command permission request exhausted its retry attempts.');
}
