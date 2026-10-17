const PREFIX = 'be';
const MAX_CUSTOM_ID_LENGTH = 100;

export const BAINSA_EMAIL_ACTIONS = Object.freeze({
  ASK: 'ask',
  HAS_ACCOUNT: 'has',
  REQUEST: 'req',
  REQUEST_MODAL: 'rqm',
  MARK_CREATED: 'done',
});

const knownActions = new Set<string>(Object.values(BAINSA_EMAIL_ACTIONS));

export function bainsaEmailId(action: string, ...parts: unknown[]): string {
  if (!knownActions.has(action)) throw new Error(`Unknown BAINSA email action: ${action}`);
  const customId = [PREFIX, action, ...parts.map(String)].join(':');
  if (customId.length > MAX_CUSTOM_ID_LENGTH) {
    throw new Error(`BAINSA email custom id is too long: ${customId.length}`);
  }
  return customId;
}

export function parseBainsaEmailId(customId: unknown) {
  const [namespace, action, ...parts] = String(customId ?? '').split(':');
  if (namespace !== PREFIX || !knownActions.has(action)) return null;
  return { namespace, action, parts };
}

export function isBainsaEmailCustomId(customId: unknown): boolean {
  return parseBainsaEmailId(customId) != null;
}
