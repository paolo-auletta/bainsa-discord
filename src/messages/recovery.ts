import { escapeMarkdown } from 'discord.js';

import type { InteractionActionSpec, InteractionPanelSpec, MessageTone } from './types.js';

export type RecoveryPanelKind =
  | 'validation'
  | 'forbidden'
  | 'stale'
  | 'reconciliation'
  | 'unexpected';

interface RecoveryDefaults {
  title: string;
  tone: MessageTone;
  preservedState: string;
  correction: string;
  continueWith: string;
}

const RECOVERY_DEFAULTS: Readonly<Record<RecoveryPanelKind, RecoveryDefaults>> = Object.freeze({
  validation: {
    title: 'Action needs attention',
    tone: 'danger',
    preservedState: 'No shared BAINSA state was changed.',
    correction: 'Correct the condition described above before trying again.',
    continueWith: 'Return to the current step or run the command again.',
  },
  forbidden: {
    title: 'This action is outside your current access',
    tone: 'danger',
    preservedState: 'No shared BAINSA state was changed.',
    correction: 'Use a permitted scope or ask the appropriate board member to continue.',
    continueWith: 'Run /guide to check the commands and scope available to you.',
  },
  stale: {
    title: 'This control is no longer current',
    tone: 'warning',
    preservedState: 'No shared BAINSA state was changed.',
    correction: 'Reload the current record or roster before trying again.',
    continueWith: 'Run the command again to start from the latest state.',
  },
  reconciliation: {
    title: 'Change saved; Discord follow-up needs attention',
    tone: 'warning',
    preservedState: 'The canonical BAINSA record remains saved.',
    correction: 'Use the recovery action described above; do not repeat the completed change.',
    continueWith: 'Contact a President or administrator if the follow-up does not complete.',
  },
  unexpected: {
    title: 'Something went wrong',
    tone: 'danger',
    preservedState: 'No shared BAINSA state was changed.',
    correction: 'Try the action again. If this continues, contact a President.',
    continueWith: 'Return to the current step or run the command again.',
  },
});

function safeText(value: string) {
  return escapeMarkdown(String(value ?? '').trim());
}

export function recoveryKindForMessage(message: string): 'validation' | 'forbidden' | 'stale' {
  const normalized = String(message ?? '').toLowerCase();
  if (
    normalized.includes('no longer available')
    || normalized.includes('expired')
    || normalized.includes('changed while')
    || normalized.includes('changed during')
    || normalized.includes('access changed')
    || normalized.includes('reload')
  ) return 'stale';
  if (
    normalized.startsWith('only ')
    || normalized.includes('cannot manage')
    || normalized.includes('cannot remove')
    || normalized.includes('not available in this channel')
    || normalized.includes('outside your scope')
    || normalized.includes('not authorized')
  ) return 'forbidden';
  return 'validation';
}

/**
 * Builds the private recovery state used when a protected workflow cannot
 * continue. The four sections deliberately answer the same questions in the
 * same order without exposing audit details or private reasons.
 */
export function interactionRecovery({
  kind = 'validation',
  title,
  whatHappened,
  preservedState,
  correction,
  continueWith,
  actions = [],
}: {
  kind?: RecoveryPanelKind;
  title?: string;
  whatHappened: string;
  preservedState?: string;
  correction?: string;
  continueWith?: string;
  actions?: readonly InteractionActionSpec[];
}): InteractionPanelSpec {
  const defaults = RECOVERY_DEFAULTS[kind];
  return {
    kind: 'interaction-panel',
    tone: defaults.tone,
    title: title ?? defaults.title,
    sections: [
      { heading: 'What happened', body: safeText(whatHappened) },
      { heading: 'What was preserved', body: safeText(preservedState ?? defaults.preservedState) },
      { heading: 'How to correct it', body: safeText(correction ?? defaults.correction) },
      { heading: 'Where to continue', body: safeText(continueWith ?? defaults.continueWith) },
    ],
    actions,
    audience: 'actor',
  };
}
