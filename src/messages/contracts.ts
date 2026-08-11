import type {
  EventCardSpec,
  HandoffMessageSpec,
  InteractionActionSpec,
  InteractionModalSpec,
  InteractionPanelSpec,
  WorkspaceDocumentSpec,
} from './types.js';

export function eventCard(spec: EventCardSpec): EventCardSpec {
  return spec;
}

export function workspaceDocument(spec: WorkspaceDocumentSpec): WorkspaceDocumentSpec {
  return spec;
}

export function interactionPanel(spec: InteractionPanelSpec): InteractionPanelSpec {
  return spec;
}

export function interactionModal(spec: InteractionModalSpec): InteractionModalSpec {
  return spec;
}

export function interactionAction(spec: InteractionActionSpec): InteractionActionSpec {
  return spec;
}

export function handoffMessage(spec: HandoffMessageSpec): HandoffMessageSpec {
  return spec;
}
