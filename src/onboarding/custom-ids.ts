const PREFIX = 'ob';
const LEGACY_START_ID = 'onboarding:start';
const MAX_CUSTOM_ID_LENGTH = 100;

export const ONBOARDING_ACTIONS = Object.freeze({
  START: 'start',
  NAME_MODAL: 'nam',
  MEMBER_TYPE: 'mt',
  UNIVERSITY: 'uni',
  UNIVERSITY_PAGE: 'up',
  UNIVERSITY_DONE: 'ud',
  DIVISIONS: 'div',
  DIVISIONS_PAGE: 'dp',
  DIVISIONS_DONE: 'dd',
  SUBMIT: 'sub',
  CANCEL: 'can',
  APPROVE: 'app',
  REJECT: 'rej',
  REJECT_MODAL: 'rjm',
});

export function onboardingId(action, ...parts) {
  const customId = [PREFIX, action, ...parts.map(String)].join(':');
  if (customId.length > MAX_CUSTOM_ID_LENGTH) {
    throw new Error(`Onboarding custom id is too long: ${customId.length}`);
  }
  return customId;
}

export function parseOnboardingId(customId) {
  if (customId === LEGACY_START_ID) {
    return { namespace: PREFIX, action: ONBOARDING_ACTIONS.START, parts: [] };
  }

  const [namespace, action, ...parts] = String(customId).split(':');
  if (namespace !== PREFIX || !action) return null;
  return { namespace, action, parts };
}

export function isOnboardingCustomId(customId) {
  return parseOnboardingId(customId) != null;
}
