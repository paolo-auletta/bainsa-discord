import assert from 'node:assert/strict';
import test from 'node:test';

import { ComponentType, MessageFlags } from 'discord.js';

import {
  profileContactModal,
  profileCurrentModal,
  profileIdentityModal,
  profileReviewPayload,
  profileTagsPayload,
  profileUnpublishConfirmationPayload,
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
  const identity = profileIdentityModal(session).toJSON();
  const current = profileCurrentModal(session).toJSON();
  const contact = profileContactModal(session).toJSON();
  assert.equal(identity.components.length, 2);
  assert.equal(current.components.length, 4);
  assert.equal(contact.components.length, 3);
  assert.equal(identity.components[0].components[0].value, session.profile.headline);
  assert.equal(current.components[1].components[0].value, session.profile.current_organization);
  assert.equal(contact.components[0].components[0].value, session.profile.email);
  assert.equal(parseProfileId(identity.custom_id)?.action, PROFILE_ACTIONS.IDENTITY_MODAL);
});

test('tags and review stay private, expose only selectable tags, and offer all edit paths', () => {
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
  for (const action of [PROFILE_ACTIONS.PUBLISH, PROFILE_ACTIONS.IDENTITY, PROFILE_ACTIONS.CURRENT, PROFILE_ACTIONS.TAGS, PROFILE_ACTIONS.CONTACT, PROFILE_ACTIONS.CANCEL]) {
    assert.ok(actions.includes(action));
  }
  assert.match(nestedComponents(review).filter((item) => item.content).map((item) => item.content).join('\n'), /visible to every approved BAINSA member/);
});

test('unpublish confirmation is private and owner-bound', () => {
  const payload = profileUnpublishConfirmationPayload(session);
  assert.equal(payload.flags, MessageFlags.Ephemeral | MessageFlags.IsComponentsV2);
  const confirmation = nestedComponents(payload).find((item) => parseProfileId(item.custom_id)?.action === PROFILE_ACTIONS.UNPUBLISH_CONFIRM);
  assert.equal(parseProfileId(confirmation.custom_id)?.ownerId, 'owner');
});
