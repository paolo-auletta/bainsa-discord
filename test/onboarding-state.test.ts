import assert from 'node:assert/strict';
import test from 'node:test';

import { MEMBER_TYPES } from '../src/constants.js';
import { ONBOARDING_ACTIONS, isOnboardingCustomId, onboardingId, parseOnboardingId } from '../src/onboarding/custom-ids.js';
import {
  canSubmitOnboardingRequest,
  hasValidFullName,
  normalizeFullName,
  nextDraftState,
  normalizeSelectedDivisionIds,
  pageItems,
} from '../src/onboarding/state.js';

test('onboarding custom ids parse seed and compact ids', () => {
  assert.deepEqual(parseOnboardingId('onboarding:start'), {
    namespace: 'ob',
    action: ONBOARDING_ACTIONS.START,
    parts: [],
  });
  assert.deepEqual(parseOnboardingId('onboarding:status'), {
    namespace: 'ob',
    action: ONBOARDING_ACTIONS.STATUS,
    parts: [],
  });
  assert.deepEqual(parseOnboardingId(onboardingId(ONBOARDING_ACTIONS.SPACES)), {
    namespace: 'ob',
    action: ONBOARDING_ACTIONS.SPACES,
    parts: [],
  });

  const customId = onboardingId(ONBOARDING_ACTIONS.APPROVE, '123');
  assert.equal(customId, 'ob:app:123');
  assert.deepEqual(parseOnboardingId(customId), {
    namespace: 'ob',
    action: ONBOARDING_ACTIONS.APPROVE,
    parts: ['123'],
  });
  assert.equal(isOnboardingCustomId(customId), true);
  assert.equal(isOnboardingCustomId('project:close:123'), false);
  assert.ok(customId.length < 100);
});

test('division ids are normalized and unique', () => {
  assert.deepEqual(normalizeSelectedDivisionIds(['3', 2, '2', '', null, '1']), ['1', '2', '3']);
});

test('pagination respects the 25 option component limit', () => {
  const items = Array.from({ length: 51 }, (_, index) => ({ id: index + 1 }));
  const first = pageItems(items, 0);
  const last = pageItems(items, 2);

  assert.equal(first.items.length, 25);
  assert.equal(first.hasNext, true);
  assert.equal(last.items.length, 1);
  assert.equal(last.hasNext, false);
  assert.equal(last.totalPages, 3);
});

test('alumni drafts skip divisions while researchers require exactly one division and a name', () => {
  const alumni = nextDraftState(
    { member_type: MEMBER_TYPES.RESEARCHER, division_ids: ['10'], full_name: 'Paolo Auletta' },
    { member_type: MEMBER_TYPES.ALUMNI, university_id: '1' },
  );
  const researcher = {
    member_type: MEMBER_TYPES.RESEARCHER,
    university_id: '1',
    division_ids: ['20'],
    full_name: 'Ada Lovelace',
  };

  assert.deepEqual(alumni.division_ids, []);
  assert.equal(canSubmitOnboardingRequest(alumni), true);
  assert.equal(canSubmitOnboardingRequest({ ...alumni, full_name: '' }), false);
  assert.equal(canSubmitOnboardingRequest(alumni), true);
  assert.equal(canSubmitOnboardingRequest({ ...researcher, division_ids: [] }), false);
  assert.equal(canSubmitOnboardingRequest({ ...researcher, division_ids: ['20', '21'] }), false);
  assert.equal(canSubmitOnboardingRequest(researcher), true);
});

test('full names are normalized and must be between 2 and 120 characters', () => {
  assert.equal(normalizeFullName('  Ada   Lovelace  '), 'Ada Lovelace');
  assert.equal(hasValidFullName('A'), false);
  assert.equal(hasValidFullName('Ada Lovelace'), true);
  assert.equal(hasValidFullName('A'.repeat(121)), false);
});
