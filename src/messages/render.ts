import { renderEventCard } from './render-event-card.js';
import { renderHandoffMessage } from './render-handoff-message.js';
import { renderInteractionPanel } from './render-interaction-panel.js';
import { renderWorkspaceDocument } from './render-workspace-document.js';
import type { BotMessagePayload, BotMessageSpec } from './types.js';

export function renderBotMessage(spec: BotMessageSpec): BotMessagePayload {
  if (spec.kind === 'event-card') return renderEventCard(spec);
  if (spec.kind === 'workspace-document') return renderWorkspaceDocument(spec);
  if (spec.kind === 'interaction-panel') return renderInteractionPanel(spec);
  return renderHandoffMessage(spec);
}
