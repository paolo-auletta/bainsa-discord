import { postBoardActivity } from '../discord/reply.js';
import { hasGlobalAuthority } from '../authorization.js';
import { botCommandChannelScope, commandChannelScope } from '../runtime/command-channels.js';

function sameText(left: unknown, right: unknown) {
  return String(left ?? '').trim().toLowerCase() === String(right ?? '').trim().toLowerCase();
}

function cachedChannels(guild) {
  const cache = guild?.channels?.cache;
  if (!cache) return [];
  if (typeof cache.values === 'function') return [...cache.values()];
  return [];
}

export function findUniversityBotLog(guild, universityName: string) {
  return cachedChannels(guild).find((channel) => {
    const scope = botCommandChannelScope(channel);
    return scope?.kind === 'university' && sameText(scope.universityName, universityName);
  }) ?? null;
}

export function findGlobalBotLog(guild) {
  return cachedChannels(guild).find((channel) =>
    botCommandChannelScope(channel)?.kind === 'global',
  ) ?? null;
}

export function universityActivityChannel(interaction, universityName: string) {
  const currentScope = botCommandChannelScope(interaction.channel);
  if (currentScope?.kind === 'university' && sameText(currentScope.universityName, universityName)) {
    return interaction.channel;
  }
  const routed = findUniversityBotLog(interaction.guild, universityName);
  if (routed) return routed;
  // Lightweight unit/service adapters may not model Discord channel identity.
  // Never use this fallback for a recognized global or project channel.
  return !commandChannelScope(interaction.channel) && interaction.channel?.send
    ? interaction.channel
    : null;
}

export function universityActivityChannels(interaction, universityName: string) {
  const universityChannel = universityActivityChannel(interaction, universityName);
  const globalChannel = interaction.member && hasGlobalAuthority(interaction.member)
    ? findGlobalBotLog(interaction.guild)
    : null;
  return [...new Map(
    [universityChannel, globalChannel]
      .filter(Boolean)
      .map((channel) => [String(channel.id ?? ''), channel]),
  ).values()];
}

export async function postUniversityBoardActivity(interaction, payload, universityName: string) {
  const channels = universityActivityChannels(interaction, universityName);
  if (!channels.length) return { status: 'unavailable', channel: null, mirrors: [] };
  const [primary, ...mirrors] = await Promise.all(
    channels.map((channel) => postBoardActivity(interaction, payload, { channel })),
  );
  return { ...primary, mirrors };
}
