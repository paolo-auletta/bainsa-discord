import { channelMention, escapeMarkdown, userMention } from 'discord.js';

import { DISCORD_LIMITS } from './limits.js';
import { EMPTY_VALUES } from './tokens.js';

export function cleanText(value: unknown, fallback: string = EMPTY_VALUES.notProvided): string {
  const normalized = String(value ?? '').trim();
  return normalized || fallback;
}

export function escapeUserText(value: unknown, fallback: string = EMPTY_VALUES.notProvided): string {
  return escapeMarkdown(cleanText(value, fallback));
}

export function truncateText(value: unknown, limit: number, fallback: string = EMPTY_VALUES.notProvided): string {
  const normalized = cleanText(value, fallback);
  const characters = [...normalized];
  if (characters.length <= limit) return normalized;
  return `${characters.slice(0, Math.max(0, limit - 1)).join('').trimEnd()}…`;
}

export function userReference(userOrId: unknown, fallbackName?: string): string {
  const candidate = userOrId && typeof userOrId === 'object'
    ? userOrId as {
        id?: unknown;
        displayName?: unknown;
        username?: unknown;
        user?: { globalName?: unknown; username?: unknown };
      }
    : undefined;
  const id = candidate?.id ?? userOrId;
  const displayName = typeof userOrId === 'object'
    ? candidate?.displayName ?? candidate?.user?.globalName ?? candidate?.user?.username ?? candidate?.username ?? fallbackName
    : fallbackName;
  if (!id) return escapeUserText(displayName, 'Unknown member');
  const reference = userMention(String(id));
  return displayName ? `${escapeUserText(displayName)} (${reference})` : reference;
}

export function channelReference(channelOrId: unknown, fallback = 'Not provisioned'): string {
  const candidate = channelOrId && typeof channelOrId === 'object'
    ? channelOrId as { id?: unknown }
    : undefined;
  const id = candidate?.id ?? channelOrId;
  return id ? channelMention(String(id)) : fallback;
}

export function commandReference(commandName: string): string {
  const normalized = cleanText(commandName).replace(/^\//, '');
  return `\`/${normalized}\``;
}

export function markdownLink(label: string, url: string): string {
  const safeLabel = escapeUserText(label);
  const safeUrl = String(url ?? '').trim().replace(/[()\s]/g, (character) => encodeURIComponent(character));
  return safeUrl ? `[${safeLabel}](${safeUrl})` : safeLabel;
}

export function boundedSingleMessage(chunks: readonly string[], provenance?: string): string {
  const footer = provenance ? `-# ${truncateText(provenance, 300)}` : '';
  const separator = '\n\n';
  const footerCost = footer ? footer.length + separator.length : 0;
  const limit = DISCORD_LIMITS.content - footerCost;
  const rendered: string[] = [];

  for (const rawChunk of chunks) {
    const chunk = String(rawChunk ?? '').trim();
    if (!chunk) continue;
    const prefix = rendered.length > 0 ? separator : '';
    const used = rendered.join(separator).length;
    const remaining = limit - used - prefix.length;
    if (remaining <= 0) break;
    if (chunk.length <= remaining) {
      rendered.push(chunk);
      continue;
    }
    rendered.push(truncateText(chunk, remaining, ''));
    break;
  }

  const body = rendered.join(separator);
  return footer ? `${body}${separator}${footer}` : body;
}
