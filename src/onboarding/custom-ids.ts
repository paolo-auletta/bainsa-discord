const PREFIX = 'ob';
const LEGACY_START_ID = 'onboarding:start';
const LEGACY_STATUS_ID = 'onboarding:status';
const MAX_CUSTOM_ID_LENGTH = 100;

export const ONBOARDING_ACTIONS = Object.freeze({
  START: 'start',
  STATUS: 'sts',
  NAME_MODAL: 'nam',
  MEMBER_TYPE: 'mt',
  MEMBER_TYPE_DONE: 'mtd',
  UNIVERSITY: 'uni',
  UNIVERSITY_PAGE: 'up',
  UNIVERSITY_DONE: 'ud',
  DIVISIONS: 'div',
  DIVISIONS_PAGE: 'dp',
  DIVISIONS_DONE: 'dd',
  BACK_NAME: 'bn',
  BACK_MEMBER_TYPE: 'bmt',
  BACK_UNIVERSITY: 'bu',
  BACK_DIVISIONS: 'bd',
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
  if (customId === LEGACY_STATUS_ID) {
    return { namespace: PREFIX, action: ONBOARDING_ACTIONS.STATUS, parts: [] };
  }

  const [namespace, action, ...parts] = String(customId).split(':');
  if (namespace !== PREFIX || !action) return null;
  return { namespace, action, parts };
}

export function isOnboardingCustomId(customId) {
  return parseOnboardingId(customId) != null;
}
