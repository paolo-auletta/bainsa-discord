import assert from 'node:assert/strict';
import test from 'node:test';

import { MEMBER_TYPES } from '../src/constants.js';
import {
  PROFILE_CUSTOM_IDS,
  PROFILE_ACTIONS,
  isProfileCustomId,
  parseProfileId,
  profilePersistentId,
  profileSessionId,
} from '../src/profiles/custom-ids.js';
import {
  PROFILE_TAGS,
  appliedProfileTagKeys,
  assertPublishableProfile,
  canPublishProfile,
  normalizeLinkedinUrl,
  normalizeProfileEmail,
  normalizeProfileText,
  normalizeResearchProfileUrl,
  normalizeSelectedProfileTags,
  selectableProfileTags,
} from '../src/profiles/state.js';

const validProfile = Object.freeze({
  headline: 'Researcher building practical AI systems',
  about: 'I enjoy turning difficult research questions into useful tools for people.',
  current_role: 'MSc student',
  goals: 'Explore applied machine learning research collaborations.',
  selected_tags: ['ai_data', 'academia'],
});

test('profile taxonomy is the exact managed fourteen-tag contract', () => {
  assert.equal(PROFILE_TAGS.length, 14);
  assert.deepEqual(PROFILE_TAGS.map((tag) => tag.key), [
    'researcher', 'alumni', 'ai_data', 'econ_finance', 'neuroscience', 'biology', 'eng_robotics',
    'life_health', 'social_sciences', 'math_physics', 'humanities_design', 'academia', 'industry',
    'entrepreneurship',
  ]);
  assert.equal(selectableProfileTags().length, 12);
  assert.equal(PROFILE_TAGS.filter((tag) => !tag.selectable).length, 2);
  assert.equal(new Set(PROFILE_TAGS.map((tag) => tag.label)).size, 14);
  assert.ok(PROFILE_TAGS.every((tag) => tag.label.length <= 20));
});

test('profile normalization collapses text and makes blank optional values null', () => {
  const normalized = assertPublishableProfile({
    ...validProfile,
    headline: '  Researcher\n building   practical AI systems ',
    current_organization: '  Independent  ',
    location: '   ',
    email: '  ADA@EXAMPLE.COM ',
    linkedin_url: ' https://www.linkedin.com/in/ada ',
    research_profile_url: ' http://orcid.org/0000-0001 ',
    selected_tags: [' AI_DATA ', 'academia'],
  });
  assert.equal(normalizeProfileText('  a\n  b  '), 'a b');
  assert.equal(normalized.headline, 'Researcher building practical AI systems');
  assert.equal(normalized.current_organization, 'Independent');
  assert.equal(normalized.location, null);
  assert.equal(normalized.email, 'ada@example.com');
  assert.equal(normalized.linkedin_url, 'https://www.linkedin.com/in/ada');
  assert.equal(normalized.research_profile_url, 'http://orcid.org/0000-0001');
  assert.deepEqual(normalized.selected_tags, ['ai_data', 'academia']);
});

test('required and optional profile fields obey their publication boundaries', () => {
  assert.doesNotThrow(() => assertPublishableProfile({
    ...validProfile,
    headline: 'h'.repeat(10),
    about: 'a'.repeat(20),
    current_role: 'r'.repeat(2),
    goals: 'g'.repeat(10),
    current_organization: 'o'.repeat(2),
    location: 'l'.repeat(2),
  }));
  assert.equal(canPublishProfile({ ...validProfile, headline: 'short' }), false);
  assert.equal(canPublishProfile({ ...validProfile, about: 'a'.repeat(301) }), false);
  assert.equal(canPublishProfile({ ...validProfile, current_role: 'x' }), false);
  assert.equal(canPublishProfile({ ...validProfile, goals: 'x'.repeat(9) }), false);
  assert.equal(canPublishProfile({ ...validProfile, current_organization: 'x' }), false);
  assert.equal(canPublishProfile({ ...validProfile, location: 'x'.repeat(61) }), false);
  assert.equal(canPublishProfile({ ...validProfile, email: 'a'.repeat(255) }), false);
});

test('selected tags reject unknown, duplicate, identity, and out-of-range values', () => {
  assert.deepEqual(normalizeSelectedProfileTags(['AI_DATA']), ['ai_data']);
  for (const tags of [
    [],
    ['ai_data', 'ai_data'],
    ['researcher'],
    ['unknown'],
    ['ai_data', 'academia', 'industry', 'biology', 'neuroscience'],
  ]) {
    assert.throws(() => normalizeSelectedProfileTags(tags));
  }
  assert.deepEqual(appliedProfileTagKeys(MEMBER_TYPES.RESEARCHER, ['ai_data', 'academia']), [
    'researcher', 'ai_data', 'academia',
  ]);
  assert.deepEqual(appliedProfileTagKeys(MEMBER_TYPES.ALUMNI, ['industry']), ['alumni', 'industry']);
  assert.throws(() => appliedProfileTagKeys('pending', ['industry']));
});

test('email and URLs are normalized and reject unsafe shapes', () => {
  assert.equal(normalizeProfileEmail('  A.DA+research@EXAMPLE.co.uk '), 'a.da+research@example.co.uk');
  assert.equal(normalizeProfileEmail('  '), null);
  assert.throws(() => normalizeProfileEmail('not an email'));
  assert.equal(normalizeLinkedinUrl('https://jobs.linkedin.com/jobs/view/1'), 'https://jobs.linkedin.com/jobs/view/1');
  assert.equal(normalizeResearchProfileUrl('https://example.test/profile?q=1'), 'https://example.test/profile?q=1');
  for (const value of [
    'http://linkedin.com/in/ada',
    'https://linkedin.com.evil.test/in/ada',
    'https://notlinkedin.com/in/ada',
    'https://ada:secret@linkedin.com/in/ada',
    'javascript:alert(1)',
  ]) {
    assert.throws(() => normalizeLinkedinUrl(value), value);
  }
  assert.throws(() => normalizeResearchProfileUrl('ftp://example.test/profile'));
  assert.throws(() => normalizeResearchProfileUrl('https://ada:secret@example.test/profile'));
});

test('profile custom IDs distinguish persistent guide controls from owner-bound session controls', () => {
  assert.equal(profilePersistentId(PROFILE_ACTIONS.START), PROFILE_CUSTOM_IDS.START);
  assert.equal(profilePersistentId(PROFILE_ACTIONS.UNPUBLISH), PROFILE_CUSTOM_IDS.UNPUBLISH);
  const customId = profileSessionId(PROFILE_ACTIONS.PUBLISH, '17cfa3fd-1d69-4c9f-aac3', '123456789012345678');
  assert.ok(customId.length <= 100);
  assert.deepEqual(parseProfileId(customId), {
    namespace: 'pf', kind: 'session', action: PROFILE_ACTIONS.PUBLISH,
    sessionId: '17cfa3fd-1d69-4c9f-aac3', ownerId: '123456789012345678',
  });
  assert.deepEqual(parseProfileId(PROFILE_CUSTOM_IDS.START), {
    namespace: 'pf', kind: 'persistent', action: PROFILE_ACTIONS.START,
  });
  assert.equal(isProfileCustomId('pf:publish:session'), false);
  assert.equal(isProfileCustomId('onboarding:start'), false);
  assert.throws(() => profileSessionId(PROFILE_ACTIONS.PUBLISH, 'bad:session', '123'));
});
