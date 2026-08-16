import { boundedSingleMessage, cleanText, truncateText } from './text.js';
import { SAFE_ALLOWED_MENTIONS } from './tokens.js';
import type { BotMessagePayload, WorkspaceDocumentSpec, WorkspaceSectionSpec } from './types.js';

function sectionChunk(section: WorkspaceSectionSpec): string {
  const body = Array.isArray(section.body) ? section.body.join('\n') : section.body;
  if (!section.heading) return String(body ?? '').trim();
  return `**${truncateText(section.heading, 180)}**\n${String(body ?? '').trim()}`;
}

export function renderWorkspaceDocument(spec: WorkspaceDocumentSpec): BotMessagePayload {
  const chunks: string[] = [`## ${cleanText(spec.title)}`];
  if (spec.metadata?.length) {
    chunks.push(spec.metadata
      .filter((row) => String(row.value ?? '').trim())
      .map((row) => `**${truncateText(row.label, 120)}:** ${cleanText(row.value)}`)
      .join('\n'));
  }
  chunks.push(...(spec.sections ?? []).map(sectionChunk).filter(Boolean));
  return {
    content: boundedSingleMessage(chunks, cleanText(spec.provenance)),
    allowedMentions: SAFE_ALLOWED_MENTIONS,
  };
}
