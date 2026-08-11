import { EmbedBuilder } from 'discord.js';

import { DISCORD_LIMITS } from './limits.js';
import { EVENT_MARKERS, MESSAGE_COLORS, MESSAGE_LABELS, SAFE_ALLOWED_MENTIONS } from './tokens.js';
import { cleanText, truncateText } from './text.js';
import type { BotMessagePayload, EventCardSpec, MessageFieldSpec } from './types.js';

function normalizedField(field: MessageFieldSpec, valueLimit: number = DISCORD_LIMITS.embedFieldValue) {
  return {
    name: truncateText(field.label, DISCORD_LIMITS.embedFieldName),
    value: truncateText(field.value, valueLimit),
    inline: Boolean(field.inline),
  };
}

export function renderEventCard(spec: EventCardSpec): BotMessagePayload {
  const title = `${EVENT_MARKERS[spec.tone]} ${cleanText(spec.title)}`;
  const ordered: MessageFieldSpec[] = [spec.subject];
  if (spec.scope) ordered.push({ label: MESSAGE_LABELS.scope, value: spec.scope });
  ordered.push(...(spec.details ?? []));
  if (spec.result) ordered.push(spec.result);
  if (spec.discordState) ordered.push({ label: MESSAGE_LABELS.discordState, value: spec.discordState });
  if (spec.actor) ordered.push({ label: MESSAGE_LABELS.actor, value: spec.actor });

  const renderedTitle = truncateText(title, DISCORD_LIMITS.embedTitle);
  const description = spec.description
    ? truncateText(spec.description, DISCORD_LIMITS.embedDescription)
    : '';
  const footer = spec.footer ? truncateText(spec.footer, 2_048) : '';
  let total = renderedTitle.length + description.length + footer.length;
  const fields = [];
  for (const field of ordered.filter((item) => String(item?.value ?? '').trim()).slice(0, DISCORD_LIMITS.embedFields)) {
    const name = truncateText(field.label, DISCORD_LIMITS.embedFieldName);
    const remaining = DISCORD_LIMITS.embedTotal - total - name.length;
    if (remaining <= 0) break;
    const normalized = normalizedField(field, Math.min(DISCORD_LIMITS.embedFieldValue, remaining));
    fields.push(normalized);
    total += normalized.name.length + normalized.value.length;
  }
  const embed = new EmbedBuilder()
    .setColor(MESSAGE_COLORS[spec.tone])
    .setTitle(renderedTitle)
    .addFields(...fields);
  if (description) embed.setDescription(description);
  if (footer) embed.setFooter({ text: footer });

  return { embeds: [embed], allowedMentions: SAFE_ALLOWED_MENTIONS };
}
