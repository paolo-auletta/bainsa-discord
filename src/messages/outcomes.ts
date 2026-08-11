import type { InteractionActionSpec, InteractionPanelSpec, MessageTone } from './types.js';

export type OutcomeKind =
  | 'success'
  | 'no-change'
  | 'cancelled'
  | 'validation'
  | 'forbidden'
  | 'stale'
  | 'busy'
  | 'reconciliation-pending'
  | 'delivery-failed'
  | 'unexpected';

const OUTCOME_TONES: Readonly<Record<OutcomeKind, MessageTone>> = Object.freeze({
  success: 'success',
  'no-change': 'neutral',
  cancelled: 'neutral',
  validation: 'danger',
  forbidden: 'danger',
  stale: 'warning',
  busy: 'pending',
  'reconciliation-pending': 'pending',
  'delivery-failed': 'warning',
  unexpected: 'danger',
});

export function interactionOutcome({
  outcome,
  title,
  description,
  status,
  actions = [],
}: {
  outcome: OutcomeKind;
  title: string;
  description?: string;
  status?: string;
  actions?: readonly InteractionActionSpec[];
}): InteractionPanelSpec {
  return {
    kind: 'interaction-panel',
    tone: OUTCOME_TONES[outcome],
    title,
    description,
    status,
    actions,
    audience: 'actor',
  };
}
