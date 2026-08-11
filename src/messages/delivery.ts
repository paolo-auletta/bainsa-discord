import { MessageFlags } from 'discord.js';
import type { InteractionEditReplyOptions, InteractionReplyOptions } from 'discord.js';

import { SAFE_ALLOWED_MENTIONS } from './tokens.js';
import type { BotMessagePayload } from './types.js';

function numericFlags(payload: BotMessagePayload): number {
  return Number(payload.flags ?? 0);
}

export function safePayload(payload: BotMessagePayload): BotMessagePayload {
  return { allowedMentions: SAFE_ALLOWED_MENTIONS, ...payload };
}

export function ephemeralReplyPayload(payload: BotMessagePayload): InteractionReplyOptions {
  return safePayload({
    ...payload,
    flags: numericFlags(payload) | MessageFlags.Ephemeral,
  }) as InteractionReplyOptions;
}

export function interactionEditPayload(payload: BotMessagePayload): InteractionEditReplyOptions {
  const flags = numericFlags(payload) & ~MessageFlags.Ephemeral;
  const edited = safePayload({ ...payload, flags });
  if (!flags) delete edited.flags;
  return edited as InteractionEditReplyOptions;
}
