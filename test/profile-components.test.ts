import assert from 'node:assert/strict';
import test from 'node:test';

import { ComponentType, MessageFlags } from 'discord.js';

import {
  profileContactModal,
  profileContactPayload,
  profileCurrentModal,
  profileDirectionModal,
  profileDirectionPayload,
  profilePublishingPayload,
  profileReviewPayload,
  profileTagsPayload,
  profileUnpublishConfirmationPayload,
  profileUnpublishingPayload,
} from '../src/profiles/components.js';
import { PROFILE_ACTIONS, parseProfileId } from '../src/profiles/custom-ids.js';

const session = Object.freeze({
  id: 'session', actorId: 'owner', guildId: 'guild',
  profile: {
    headline: 'Applied researcher building useful tools',
    about: 'I enjoy collaborative work on research that helps people solve hard problems.',
    current_role: 'MSc student',
    goals: 'Explore practical machine learning research collaborations.',
    selected_tags: ['ai_data', 'academia'],
    current_organization: 'BAINSA', location: 'Milan', email: 'ada@example.test',
    linkedin_url: 'https://www.linkedin.com/in/ada', research_profile_url: '',
  },
});

function json(value) {
  return value.toJSON?.() ?? value;
}

function nestedComponents(payload) {
  const queue = [...payload.components.map(json)];
  const found = [];
  while (queue.length) {
    const next = queue.shift();
    found.push(next);
    if (next.components) queue.push(...next.components);
  }
  return found;
}

test('profile modals split authored fields within Discord component limits and prefill editing', () => {
  const current = profileCurrentModal(session).toJSON();
  const direction = profileDirectionModal(session).toJSON();
  const contact = profileContactModal(session).toJSON();
  assert.equal(current.components.length, 4);
  assert.equal(direction.components.length, 2);
  assert.equal(contact.components.length, 3);
  assert.equal(current.components[0].components[0].value, session.profile.headline);
  assert.equal(current.components[2].components[0].value, session.profile.current_organization);
  assert.equal(direction.components[0].components[0].value, session.profile.goals);
  assert.equal(direction.components[1].components[0].value, session.profile.about);
  assert.equal(contact.components[0].components[0].value, session.profile.email);
  assert.equal(parseProfileId(current.custom_id)?.action, PROFILE_ACTIONS.CURRENT_MODAL);
  assert.equal(direction.title, 'Profile · What you want to explore');
  assert.equal(contact.title, 'Profile · How members can reach you');
});

test('every profile screen keeps a complete grouped summary and the same three navigation actions', () => {
  const screens = [
    { payload: profileDirectionPayload(session), labels: ['Continue to tags', 'Back to current', 'Cancel'] },
    { payload: profileTagsPayload(session), labels: ['Continue to contact', 'Back to exploration', 'Cancel'] },
    { payload: profileContactPayload(session), labels: ['Continue to review', 'Back to tags', 'Cancel'] },
    { payload: profileReviewPayload(session), labels: ['Publish profile', 'Back to contact', 'Cancel'] },
  ];
  for (const { payload, labels } of screens) {
    assert.equal(payload.flags, MessageFlags.Ephemeral | MessageFlags.IsComponentsV2);
    const all = nestedComponents(payload);
    const summary = all.find((item) => item.content?.includes('## Your BAINSA people database profile'))?.content ?? '';
    for (const expected of [
      'Where you are now', 'Headline', 'What are you doing now?', 'Organisation', 'Location',
      'What you want to explore', 'What would you like to explore next?', 'You and your interests',
      'How members can reach you', 'Discord', 'Email', 'LinkedIn', 'Research profile', 'Tags',
    ]) assert.match(summary, new RegExp(expected));
    assert.doesNotMatch(summary, /Discoverability/);
    assert.equal((summary.match(/🪪|🧭|💬/gu) ?? []).length, 3);
    assert.doesNotMatch(summary, /💼|🏢|📍|💡|✉️|🔗|🔬|🏷️/u);
    assert.ok(summary.lastIndexOf('**Tags**') > summary.lastIndexOf('**Research profile**'));
    const rows = all.filter((item) => Array.isArray(item.components));
    const navigation = rows.map((row) => row.components).find((items) => (
      items.length === 3 && items.some((item) => item.label === 'Cancel')
    ));
    assert.deepEqual(navigation?.map((item) => item.label), labels);
  }
});

test('publish and unpublish progress payloads remove every clickable control', () => {
  for (const payload of [profilePublishingPayload(), profileUnpublishingPayload()]) {
    assert.equal(payload.flags, MessageFlags.Ephemeral | MessageFlags.IsComponentsV2);
    assert.equal(nestedComponents(payload).some((item) => item.custom_id), false);
    assert.match(nestedComponents(payload).find((item) => item.content)?.content ?? '', /Please wait/);
  }
});

test('tags stay private, expose only selectable tags, and review has one clear route back', () => {
  const tags = profileTagsPayload(session);
  assert.equal(tags.flags, MessageFlags.Ephemeral | MessageFlags.IsComponentsV2);
  const select = nestedComponents(tags).find((item) => item.type === ComponentType.StringSelect);
  assert.equal(select.options.length, 12);
  assert.equal(select.min_values, 1);
  assert.equal(select.max_values, 4);
  assert.equal(select.options.some((option) => option.value === 'researcher'), false);

  const review = profileReviewPayload(session);
  const actions = nestedComponents(review)
    .filter((item) => item.custom_id)
    .map((item) => parseProfileId(item.custom_id)?.action);
  for (const action of [PROFILE_ACTIONS.PUBLISH, PROFILE_ACTIONS.CONTACT, PROFILE_ACTIONS.CANCEL]) {
    assert.ok(actions.includes(action));
  }
  assert.equal(actions.length, 3);
  assert.match(nestedComponents(review).filter((item) => item.content).map((item) => item.content).join('\n'), /visible to every approved BAINSA member/);
});

test('unpublish confirmation is private and owner-bound', () => {
  const payload = profileUnpublishConfirmationPayload(session);
  assert.equal(payload.flags, MessageFlags.Ephemeral | MessageFlags.IsComponentsV2);
  const confirmation = nestedComponents(payload).find((item) => parseProfileId(item.custom_id)?.action === PROFILE_ACTIONS.UNPUBLISH_CONFIRM);
  assert.equal(parseProfileId(confirmation.custom_id)?.ownerId, 'owner');
});
