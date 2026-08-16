import { boundedSingleMessage, cleanText, markdownLink, truncateText } from './text.js';
import { SAFE_ALLOWED_MENTIONS } from './tokens.js';
import type { BotMessagePayload, HandoffMessageSpec } from './types.js';

export function renderHandoffMessage(spec: HandoffMessageSpec): BotMessagePayload {
  const head: string[] = [`**${truncateText(cleanText(spec.title), 180, '')}**`];
  if (spec.statusLabel) head.push(`**Status**
${truncateText(cleanText(spec.statusLabel), 120, '')}`);
  if (spec.context) head.push(truncateText(cleanText(spec.context), 360, ''));
  const details: string[] = [];
  for (const section of spec.sections ?? []) {
    const body = Array.isArray(section.body) ? section.body.join('\n') : section.body;
    details.push(section.heading ? `**${section.heading}**\n${body}` : String(body ?? ''));
  }
  const recovery: string[] = [];
  if (spec.nextActions?.length) {
    recovery.push(`**What to do next**\n${spec.nextActions.slice(0, 3).map((step, index) =>
      `${index + 1}. ${truncateText(step, 180, '')}`).join('\n')}`);
  }
  if (spec.links?.length) {
    recovery.push(truncateText(spec.links.map((link) => markdownLink(link.label, link.url)).join(' · '), 240, ''));
  }
  if (spec.fallback) recovery.push(`**If you need help**\n${truncateText(cleanText(spec.fallback), 240, '')}`);

  // Recovery must survive unusually long names, reasons, or translated copy.
  // Reserve its budget before details so a 2,000-character handoff never loses
  // the one action or fallback that lets a member recover.
  const reservedRecovery = boundedSingleMessage(recovery);
  const boundedProvenance = spec.provenance ? truncateText(spec.provenance, 120) : undefined;
  const reservedProvenance = boundedProvenance ? `-# ${boundedProvenance}` : '';
  const separators = 2 * Math.max(0, head.length + details.length + (reservedRecovery ? 1 : 0) - 1);
  const fixedLength = head.join('\n\n').length
    + reservedRecovery.length
    + reservedProvenance.length
    + separators
    + (reservedProvenance ? 2 : 0);
  const detailBudget = Math.max(0, 2_000 - fixedLength);
  const boundedDetails: string[] = [];
  let usedDetails = 0;
  for (const detail of details) {
    const separatorCost = boundedDetails.length ? 2 : 0;
    const remaining = detailBudget - usedDetails - separatorCost;
    if (remaining <= 0) break;
    boundedDetails.push(truncateText(detail, remaining, ''));
    usedDetails += separatorCost + boundedDetails.at(-1).length;
    if (detail.length > remaining) break;
  }

  return {
    content: boundedSingleMessage(
      [...head, ...boundedDetails, ...(reservedRecovery ? [reservedRecovery] : [])],
      boundedProvenance,
    ),
    allowedMentions: SAFE_ALLOWED_MENTIONS,
  };
}
