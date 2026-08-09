const PREFIX = 'pf';
const MAX_CUSTOM_ID_LENGTH = 100;

export const PROFILE_ACTIONS = Object.freeze({
  START: 'start',
  UNPUBLISH: 'unpub',
  UNPUBLISH_CONFIRM: 'unpub-ok',
  CURRENT: 'current',
  CURRENT_MODAL: 'current-modal',
  DIRECTION: 'direction',
  DIRECTION_OPEN: 'direction-open',
  DIRECTION_MODAL: 'direction-modal',
  TAGS: 'tags',
  CONTACT: 'contact',
  CONTACT_OPEN: 'contact-open',
  CONTACT_MODAL: 'contact-modal',
  REVIEW: 'review',
  PUBLISH: 'publish',
  CANCEL: 'cancel',
});

// These IDs are deliberately stable because they are stored on the persistent
// forum guide. All other IDs include the initiating owner's Discord ID.
export const PROFILE_CUSTOM_IDS = Object.freeze({
  START: `${PREFIX}:${PROFILE_ACTIONS.START}`,
  UNPUBLISH: `${PREFIX}:${PROFILE_ACTIONS.UNPUBLISH}`,
});

const persistentActions = new Set<string>([PROFILE_ACTIONS.START, PROFILE_ACTIONS.UNPUBLISH]);
const sessionActions = new Set<string>(Object.values(PROFILE_ACTIONS).filter((action) => !persistentActions.has(action)));

function assertPart(value: unknown, name: string): string {
  const normalized = String(value ?? '').trim();
  if (!normalized || normalized.includes(':')) throw new Error(`Profile ${name} must be a non-empty custom-ID part.`);
  return normalized;
}

function assertCustomIdLength(customId: string): string {
  if (customId.length > MAX_CUSTOM_ID_LENGTH) {
    throw new Error(`Profile custom id is too long: ${customId.length}`);
  }
  return customId;
}

export function profilePersistentId(action: string): string {
  if (!persistentActions.has(action)) throw new Error('Profile action is not persistent.');
  return assertCustomIdLength([PREFIX, action].join(':'));
}

export function profileSessionId(action: string, sessionId: unknown, ownerId: unknown): string {
  if (!sessionActions.has(action)) throw new Error('Profile action is not session-bound.');
  return assertCustomIdLength([PREFIX, action, assertPart(sessionId, 'session ID'), assertPart(ownerId, 'owner ID')].join(':'));
}

export type ParsedProfileId =
  | { namespace: typeof PREFIX; kind: 'persistent'; action: string }
  | { namespace: typeof PREFIX; kind: 'session'; action: string; sessionId: string; ownerId: string };

export function parseProfileId(customId: unknown): ParsedProfileId | null {
  const raw = String(customId ?? '');
  if (!raw || raw.length > MAX_CUSTOM_ID_LENGTH) return null;
  const [namespace, action, first, second, ...extra] = raw.split(':');
  if (namespace !== PREFIX || !action || extra.length > 0) return null;
  if (persistentActions.has(action) && first == null && second == null) {
    return { namespace: PREFIX, kind: 'persistent', action };
  }
  if (sessionActions.has(action) && first && second) {
    return { namespace: PREFIX, kind: 'session', action, sessionId: first, ownerId: second };
  }
  return null;
}

export function isProfileCustomId(customId: unknown): boolean {
  return parseProfileId(customId) != null;
}
