import assert from 'node:assert/strict';
import test from 'node:test';

import { ComponentType, MessageFlags } from 'discord.js';

import { createProfileService, PROFILE_SESSION_TTL_MS } from '../src/profiles/service.js';
import { parseProfileId, PROFILE_ACTIONS } from '../src/profiles/custom-ids.js';

const owner = '111111111111111111';
const valid = Object.freeze({
  headline: 'Applied researcher building useful tools',
  about: 'I enjoy collaborative work on research that helps people solve hard problems.',
  current_role: 'MSc student',
  goals: 'Explore practical machine learning research collaborations.',
  selected_tags: ['ai_data'],
});

function components(payload) {
  const queue = [...payload.components.map((component) => component.toJSON?.() ?? component)];
  const found = [];
  while (queue.length) {
    const next = queue.shift();
    found.push(next);
    if (next.components) queue.push(...next.components);
  }
  return found;
}

function actionId(payload, action) {
  const component = components(payload).find((item) => parseProfileId(item.custom_id)?.action === action);
  assert.ok(component, `Missing action ${action}`);
  return component.custom_id;
}

function payloadText(payload) {
  return components(payload)
    .map((item) => item.content)
    .filter(Boolean)
    .join('\n');
}

function fieldValues(values) {
  return { getTextInputValue: (name) => values[name] ?? '' };
}

function interaction(customId, overrides = {}) {
  return {
    customId,
    user: { id: owner },
    guildId: 'guild',
    guild: { id: 'guild' },
    ...overrides,
  };
}

function service(overrides = {}) {
  return createProfileService({
    db: {},
    loadProfile: async () => ({ ...valid, member_type: 'researcher', visibility: 'published', forum_thread_id: 'thread' }),
    loadActiveMember: async () => ({ discord_user_id: owner, member_type: 'researcher' }),
    runTransaction: async (work) => work({}),
    publish: async () => ({ profile: { forum_thread_id: 'thread' }, desiredGeneration: 4 }),
    hide: async () => ({ profile: {}, desiredGeneration: 5 }),
    audit: async () => undefined,
    reconcile: async () => ({ status: 'succeeded' }),
    ...overrides,
  });
}

async function begin(serviceInstance) {
  let modal;
  await serviceInstance.start(interaction(null, { showModal: async (next) => { modal = next.toJSON(); } }));
  return modal;
}

async function completeToReview(wizard) {
  const modal = await begin(wizard);
  let payload;
  await wizard.handleModalSubmit(interaction(modal.custom_id, {
    fields: fieldValues({ headline: valid.headline, current_role: valid.current_role }),
    isFromMessage: () => false, reply: async (next) => { payload = next; },
  }));
  let direction;
  await wizard.handleButton(interaction(actionId(payload, PROFILE_ACTIONS.DIRECTION_OPEN), { showModal: async (next) => { direction = next.toJSON(); } }));
  await wizard.handleModalSubmit(interaction(direction.custom_id, {
    fields: fieldValues({ goals: valid.goals, about: valid.about }),
    isFromMessage: () => true, update: async (next) => { payload = next; },
  }));
  await wizard.handleButton(interaction(actionId(payload, PROFILE_ACTIONS.TAGS), { update: async (next) => { payload = next; } }));
  const menu = components(payload).find((item) => item.type === ComponentType.StringSelect);
  await wizard.handleStringSelect(interaction(menu.custom_id, { values: ['ai_data'], update: async (next) => { payload = next; } }));
  await wizard.handleButton(interaction(actionId(payload, PROFILE_ACTIONS.CONTACT), { update: async (next) => { payload = next; } }));
  let contact;
  await wizard.handleButton(interaction(actionId(payload, PROFILE_ACTIONS.CONTACT_OPEN), { showModal: async (next) => { contact = next.toJSON(); } }));
  await wizard.handleModalSubmit(interaction(contact.custom_id, {
    fields: fieldValues({}), isFromMessage: () => true, update: async (next) => { payload = next; },
  }));
  await wizard.handleButton(interaction(actionId(payload, PROFILE_ACTIONS.REVIEW), { update: async (next) => { payload = next; } }));
  return actionId(payload, PROFILE_ACTIONS.PUBLISH);
}

test('private wizard visits current, interests, tags, contact, and review with project-style back navigation', async () => {
  const wizard = service();
  const current = await begin(wizard);
  assert.equal(current.title, 'Profile · Where you are now');
  let payload;
  await wizard.handleModalSubmit(interaction(current.custom_id, {
    fields: fieldValues({ headline: valid.headline, current_role: valid.current_role, current_organization: 'BAINSA', location: 'Milan' }),
    isFromMessage: () => false, reply: async (next) => { payload = next; },
  }));
  assert.match(payloadText(payload), /BAINSA/);
  let directionModal;
  await wizard.handleButton(interaction(actionId(payload, PROFILE_ACTIONS.DIRECTION_OPEN), { showModal: async (next) => { directionModal = next.toJSON(); } }));
  await wizard.handleModalSubmit(interaction(directionModal.custom_id, {
    fields: fieldValues({ goals: valid.goals, about: valid.about }),
    isFromMessage: () => true, update: async (next) => { payload = next; },
  }));
  await wizard.handleButton(interaction(actionId(payload, PROFILE_ACTIONS.TAGS), { update: async (next) => { payload = next; } }));
  assert.equal(payload.flags, MessageFlags.IsComponentsV2);
  const tagMenu = components(payload).find((item) => item.type === ComponentType.StringSelect);
  await wizard.handleStringSelect(interaction(tagMenu.custom_id, { values: ['ai_data', 'academia'], update: async (next) => { payload = next; } }));
  await wizard.handleButton(interaction(actionId(payload, PROFILE_ACTIONS.CONTACT), { update: async (next) => { payload = next; } }));
  let contactModal;
  await wizard.handleButton(interaction(actionId(payload, PROFILE_ACTIONS.CONTACT_OPEN), { showModal: async (next) => { contactModal = next.toJSON(); } }));
  await wizard.handleModalSubmit(interaction(contactModal.custom_id, {
    fields: fieldValues({ email: 'ada@example.test', linkedin_url: 'https://www.linkedin.com/in/ada', research_profile_url: '' }),
    isFromMessage: () => true, update: async (next) => { payload = next; },
  }));
  assert.ok(actionId(payload, PROFILE_ACTIONS.REVIEW));
  await wizard.handleButton(interaction(actionId(payload, PROFILE_ACTIONS.TAGS), { update: async (next) => { payload = next; } }));
  assert.ok(actionId(payload, PROFILE_ACTIONS.DIRECTION));
});

test('the first modal replies privately instead of replacing the public directory guide', async () => {
  const wizard = service();
  const current = await begin(wizard);
  let reply;
  let updateCalls = 0;
  await wizard.handleModalSubmit(interaction(current.custom_id, {
    fields: fieldValues({ headline: valid.headline, current_role: valid.current_role }),
    isFromMessage: () => true,
    message: { flags: { has: () => false } },
    reply: async (next) => { reply = next; },
    update: async () => { updateCalls += 1; },
  }));
  assert.equal(updateCalls, 0);
  assert.equal(reply.flags, MessageFlags.Ephemeral | MessageFlags.IsComponentsV2);
  assert.ok(actionId(reply, PROFILE_ACTIONS.DIRECTION_OPEN));
});

test('wizard rejects replay, inactive members, expiry, invalid review, and cancel never writes', async () => {
  let clock = 1_000;
  let published = 0;
  const wizard = service({ now: () => clock, publish: async () => { published += 1; return { profile: {}, desiredGeneration: 1 }; } });
  const current = await begin(wizard);
  await assert.rejects(() => wizard.handleModalSubmit(interaction(current.custom_id, { user: { id: 'other' }, fields: fieldValues({}), reply: async () => undefined })), /Only the person/);
  clock += PROFILE_SESSION_TTL_MS + 1;
  await assert.rejects(() => wizard.handleModalSubmit(interaction(current.custom_id, { fields: fieldValues({}), reply: async () => undefined })), /expired/);

  const invalid = await begin(wizard);
  let payload;
  await wizard.handleModalSubmit(interaction(invalid.custom_id, { fields: fieldValues({ headline: 'short', current_role: 'x' }), isFromMessage: () => false, reply: async (next) => { payload = next; } }));
  let invalidDirection;
  await wizard.handleButton(interaction(actionId(payload, PROFILE_ACTIONS.DIRECTION_OPEN), { showModal: async (next) => { invalidDirection = next.toJSON(); } }));
  await wizard.handleModalSubmit(interaction(invalidDirection.custom_id, { fields: fieldValues({ goals: 'short', about: 'too short' }), isFromMessage: () => true, update: async (next) => { payload = next; } }));
  await wizard.handleButton(interaction(actionId(payload, PROFILE_ACTIONS.TAGS), { update: async (next) => { payload = next; } }));
  const invalidMenu = components(payload).find((item) => item.type === ComponentType.StringSelect);
  await wizard.handleStringSelect(interaction(invalidMenu.custom_id, { values: ['ai_data'], update: async (next) => { payload = next; } }));
  await wizard.handleButton(interaction(actionId(payload, PROFILE_ACTIONS.CONTACT), { update: async (next) => { payload = next; } }));
  await assert.rejects(() => wizard.handleButton(interaction(actionId(payload, PROFILE_ACTIONS.REVIEW), {
    update: async () => undefined,
  })), /must be between/);

  const cancelModal = await begin(wizard);
  let cancelled;
  await wizard.handleModalSubmit(interaction(cancelModal.custom_id, { fields: fieldValues({ headline: valid.headline, current_role: valid.current_role }), isFromMessage: () => false, reply: async (next) => { payload = next; } }));
  await wizard.handleButton(interaction(actionId(payload, PROFILE_ACTIONS.CANCEL), { update: async (next) => { cancelled = next; } }));
  assert.equal(payloadText(cancelled), 'Profile editing cancelled. Nothing was changed.');
  assert.equal(cancelled.flags, MessageFlags.IsComponentsV2);
  assert.equal(published, 0);

  const inactive = service({ loadActiveMember: async () => null });
  const inactiveModal = await begin(inactive);
  await assert.rejects(() => inactive.handleModalSubmit(interaction(inactiveModal.custom_id, { fields: fieldValues({}), reply: async () => undefined })), /Only active members/);
});

test('publish serializes duplicate submissions, writes privacy-safe audit data, and reports pending sync', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const audits = [];
  const wizard = service({
    publish: async () => { await gate; return { profile: {}, desiredGeneration: 7 }; },
    audit: async (_client, entry) => { audits.push(entry); },
    reconcile: async () => ({ status: 'failed' }),
  });
  const publishId = await completeToReview(wizard);
  let reply;
  let progress;
  const first = wizard.handleButton(interaction(publishId, {
    update: async (next) => { progress = next; },
    editReply: async (next) => { reply = next; },
  }));
  assert.match(payloadText(progress), /Publishing your profile.*Please wait/is);
  assert.equal(components(progress).some((item) => item.custom_id), false);
  await assert.rejects(() => wizard.handleButton(interaction(publishId)), /already being published/);
  release();
  await first;
  assert.match(payloadText(reply), /saved.*retry automatically/i);
  assert.equal(reply.flags, MessageFlags.IsComponentsV2);
  assert.deepEqual(audits[0].after, { visibility: 'published', selectedTagKeys: ['ai_data'], desiredGeneration: '7' });
  assert.doesNotMatch(JSON.stringify(audits[0]), /collaborative work|machine learning|example/);
});

test('unpublish confirmation is transactional and idempotent for hidden or missing profiles', async () => {
  const calls = [];
  const wizard = service({ hide: async () => null, audit: async (...args) => { calls.push(args); } });
  let confirmation;
  await wizard.handleButton(interaction('pf:unpub', { reply: async (next) => { confirmation = next; } }));
  const confirmId = actionId(confirmation, PROFILE_ACTIONS.UNPUBLISH_CONFIRM);
  let reply;
  let progress;
  await wizard.handleButton(interaction(confirmId, {
    update: async (next) => { progress = next; },
    editReply: async (next) => { reply = next; },
  }));
  assert.match(payloadText(progress), /Unpublishing your profile.*Please wait/is);
  assert.equal(components(progress).some((item) => item.custom_id), false);
  assert.equal(payloadText(reply), 'Your profile is already unpublished.');
  assert.equal(reply.flags, MessageFlags.IsComponentsV2);
  assert.equal(calls.length, 0);
});

test('unpublish removes its controls immediately and keeps duplicate clicks in the busy state', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const wizard = service({
    hide: async () => { await gate; return { profile: {}, desiredGeneration: 5 }; },
  });
  let confirmation;
  await wizard.handleButton(interaction('pf:unpub', { reply: async (next) => { confirmation = next; } }));
  const confirmId = actionId(confirmation, PROFILE_ACTIONS.UNPUBLISH_CONFIRM);
  let progress;
  const first = wizard.handleButton(interaction(confirmId, {
    update: async (next) => { progress = next; },
    editReply: async () => undefined,
  }));

  assert.match(payloadText(progress), /Unpublishing your profile.*Please wait/is);
  assert.equal(components(progress).some((item) => item.custom_id), false);
  await assert.rejects(() => wizard.handleButton(interaction(confirmId)), /already being unpublished/);
  release();
  await first;
});

test('successful immediate reconciliation returns the private directory post link', async () => {
  let reads = 0;
  const wizard = service({
    loadProfile: async () => ({ ...valid, member_type: 'researcher', visibility: 'published', forum_thread_id: reads++ ? 'synced-thread' : null }),
  });
  const publishId = await completeToReview(wizard);
  let reply;
  await wizard.handleButton(interaction(publishId, {
    update: async () => undefined,
    editReply: async (next) => { reply = next; },
  }));
  assert.match(payloadText(reply), /<#synced-thread>/);
  assert.equal(reply.flags, MessageFlags.IsComponentsV2);
});

test('a transaction failure leaves a profile session retryable and does not reconcile', async () => {
  let reconciliationCalls = 0;
  const wizard = service({
    runTransaction: async () => { throw new Error('database rolled back'); },
    reconcile: async () => { reconciliationCalls += 1; return { status: 'succeeded' }; },
  });
  const publishId = await completeToReview(wizard);
  let failure;
  await wizard.handleButton(interaction(publishId, {
    update: async () => undefined, editReply: async (next) => { failure = next; },
  }));
  assert.equal(reconciliationCalls, 0);
  assert.match(payloadText(failure), /not changed.*try again/i);
  assert.equal(failure.flags, MessageFlags.IsComponentsV2);
  assert.equal(actionId(failure, PROFILE_ACTIONS.PUBLISH), publishId);
  // A failure releases the reservation; a corrected retry is not permanently locked out.
  await wizard.handleButton(interaction(publishId, {
    update: async () => undefined, editReply: async (next) => { failure = next; },
  }));
  assert.match(payloadText(failure), /try again/i);
});

test('unpublish is guild-only and invalid optional contact values cannot reach review', async () => {
  const wizard = service();
  await assert.rejects(() => wizard.handleButton(interaction('pf:unpub', { guildId: null, reply: async () => undefined })), /inside the BAINSA server/);

  const modal = await begin(wizard);
  let payload;
  await wizard.handleModalSubmit(interaction(modal.custom_id, { fields: fieldValues({ headline: valid.headline, current_role: valid.current_role }), isFromMessage: () => false, reply: async (next) => { payload = next; } }));
  let direction;
  await wizard.handleButton(interaction(actionId(payload, PROFILE_ACTIONS.DIRECTION_OPEN), { showModal: async (next) => { direction = next.toJSON(); } }));
  await wizard.handleModalSubmit(interaction(direction.custom_id, { fields: fieldValues({ goals: valid.goals, about: valid.about }), isFromMessage: () => true, update: async (next) => { payload = next; } }));
  await wizard.handleButton(interaction(actionId(payload, PROFILE_ACTIONS.TAGS), { update: async (next) => { payload = next; } }));
  const menu = components(payload).find((item) => item.type === ComponentType.StringSelect);
  await wizard.handleStringSelect(interaction(menu.custom_id, { values: ['ai_data'], update: async (next) => { payload = next; } }));
  await wizard.handleButton(interaction(actionId(payload, PROFILE_ACTIONS.CONTACT), { update: async (next) => { payload = next; } }));
  let contact;
  await wizard.handleButton(interaction(actionId(payload, PROFILE_ACTIONS.CONTACT_OPEN), { showModal: async (next) => { contact = next.toJSON(); } }));
  await assert.rejects(() => wizard.handleModalSubmit(interaction(contact.custom_id, {
    fields: fieldValues({ email: 'not an email' }), isFromMessage: () => true, update: async () => undefined,
  })), /email must be a valid/);
});
