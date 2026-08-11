import { boundedSingleMessage, cleanText, markdownLink } from './text.js';
import { SAFE_ALLOWED_MENTIONS } from './tokens.js';
import type { BotMessagePayload, HandoffMessageSpec } from './types.js';

export function renderHandoffMessage(spec: HandoffMessageSpec): BotMessagePayload {
  const chunks: string[] = [`**${cleanText(spec.title)}**`];
  if (spec.context) chunks.push(cleanText(spec.context));
  for (const section of spec.sections ?? []) {
    const body = Array.isArray(section.body) ? section.body.join('\n') : section.body;
    chunks.push(section.heading ? `**${section.heading}**\n${body}` : String(body ?? ''));
  }
  if (spec.nextActions?.length) {
    chunks.push(`**Start here**\n${spec.nextActions.slice(0, 3).map((step, index) => `${index + 1}. ${step}`).join('\n')}`);
  }
  if (spec.links?.length) chunks.push(spec.links.map((link) => markdownLink(link.label, link.url)).join(' · '));
  if (spec.fallback) chunks.push(cleanText(spec.fallback));
  return {
    content: boundedSingleMessage(chunks, spec.provenance),
    allowedMentions: SAFE_ALLOWED_MENTIONS,
  };
}
