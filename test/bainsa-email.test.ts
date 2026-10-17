import assert from 'node:assert/strict';
import test from 'node:test';

import {
  bainsaEmailCreatedHandoff,
  bainsaEmailPromptPayload,
  bainsaEmailRequestModal,
  bainsaEmailReviewPayload,
} from '../src/bainsa-email/components.js';
import { BAINSA_EMAIL_ACTIONS, bainsaEmailId, parseBainsaEmailId } from '../src/bainsa-email/custom-ids.js';
import { createBainsaEmailService, enqueueBainsaEmailPrompt } from '../src/bainsa-email/service.js';
import { normalizeBainsaEmailRequest, splitFullName } from '../src/bainsa-email/state.js';
import { UserFacingError } from '../src/errors.js';

function buttonLabels(payload) {
  return payload.components.flatMap((row) => row.toJSON().components.map((button) => button.label));
}

/** A small in-memory stand-in for the queries the BAINSA email service issues. */
type EmailRow = Record<string, unknown>;

function emailDb({
  activeMembers = ['member'],
  rows = {},
  fullName = 'Ada King Lovelace',
}: { activeMembers?: string[]; rows?: Record<string, EmailRow>; fullName?: string } = {}) {
  const state = { rows: { ...rows }, audits: [], notifications: [] };
  return {
    state,
    async query(sql, values = []) {
      if (sql.includes('FROM members')) {
        return {
          rows: activeMembers.includes(values[0])
            ? [{
              discord_user_id: values[0],
              university_id: '1',
              university_name: 'Bocconi',
              onboarding_review_channel_id: 'bocconi-review',
            }]
            : [],
        };
      }
      if (sql.includes('FROM onboarding_requests')) return { rows: [{ full_name: fullName }] };
      if (sql.includes('FROM bainsa_email_requests r')) {
        const row = state.rows[values[0]];
        return { rows: row ? [{ ...row, university_name: row.university_id ? 'Bocconi' : null }] : [] };
      }
      if (sql.includes('INSERT INTO bainsa_email_requests') && sql.includes('first_name')) {
        const [userId, status, firstName, lastName, contactEmail, , universityId] = values;
        const existing = state.rows[userId];
        if (existing && existing.status !== 'has_account') return { rows: [] };
        state.rows[userId] = {
          discord_user_id: userId,
          status,
          first_name: firstName,
          last_name: lastName,
          contact_email: contactEmail,
          university_id: universityId,
          review_message_id: null,
          handled_by: null,
        };
        return { rows: [state.rows[userId]] };
      }
      if (sql.includes('INSERT INTO bainsa_email_requests')) {
        const [userId, status] = values;
        const existing = state.rows[userId];
        if (existing && existing.status !== status) return { rows: [] };
        state.rows[userId] = { discord_user_id: userId, status };
        return { rows: [state.rows[userId]] };
      }
      if (sql.includes('SET review_message_id')) {
        const row = state.rows[values[0]];
        if (row?.status !== 'requested') return { rows: [] };
        row.review_message_id = values[1];
        return { rows: [row] };
      }
      if (sql.includes('handled_by = $3')) {
        const row = state.rows[values[0]];
        if (row?.status !== 'requested') return { rows: [] };
        Object.assign(row, { status: values[1], handled_by: values[2] });
        return { rows: [row] };
      }
      if (sql.includes('INSERT INTO audit_log')) {
        state.audits.push(values[1]);
        return { rows: [{ id: state.audits.length }] };
      }
      if (sql.includes('INSERT INTO transition_notifications')) {
        state.notifications.push({ recipient: values[1], kind: values[2], payload: JSON.parse(values[6]) });
        return { rows: [{ id: state.notifications.length }] };
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
  };
}

function requestsChannel() {
  const sent = [];
  return {
    sent,
    id: 'bocconi-review',
    isTextBased: () => true,
    async send(payload) {
      sent.push(payload);
      return { id: 'review-message', delete: async () => undefined };
    },
  };
}

function guildWith(channel) {
  return { channels: { fetch: async (id) => (id === channel.id ? channel : null) } };
}

/** A guild whose fetched reviewer holds the given role names. */
function reviewerGuild(roleNames: string[]) {
  return {
    members: {
      fetch: async (id) => {
        if (id !== 'reviewer') throw new Error('offline');
        return { roles: { cache: { some: (predicate) => roleNames.some((name) => predicate({ name })) } } };
      },
    },
  };
}

function markCreatedClick(guild) {
  const updates = [];
  return {
    updates,
    customId: bainsaEmailId(BAINSA_EMAIL_ACTIONS.MARK_CREATED, 'member'),
    user: { id: 'reviewer' },
    guild,
    update: async (payload) => { updates.push(payload); },
  };
}

const openRequest = Object.freeze({
  discord_user_id: 'member',
  status: 'requested',
  university_id: '1',
  first_name: 'Ada',
  last_name: 'Lovelace',
  contact_email: 'ada@example.com',
});

function service(db, guild = null) {
  return createBainsaEmailService({
    db,
    runTransaction: async (work) => work(db),
    resolveGuild: () => guild,
  });
}

function modalSubmit({ firstName = 'Ada', lastName = 'Lovelace', email = 'Ada@Example.com', userId = 'member' } = {}) {
  const values = { first_name: firstName, last_name: lastName, contact_email: email };
  const updates = [];
  return {
    updates,
    customId: bainsaEmailId(BAINSA_EMAIL_ACTIONS.REQUEST_MODAL),
    user: { id: userId },
    message: { id: 'dm-prompt' },
    fields: { getTextInputValue: (id) => values[id] },
    update: async (payload) => { updates.push(payload); },
  };
}

test('custom IDs round-trip and reject other namespaces', () => {
  assert.deepEqual(parseBainsaEmailId(bainsaEmailId(BAINSA_EMAIL_ACTIONS.MARK_CREATED, '42')), {
    namespace: 'be',
    action: 'done',
    parts: ['42'],
  });
  assert.equal(parseBainsaEmailId('ob:start'), null);
  assert.equal(parseBainsaEmailId('be:unknown'), null);
});

test('request details are normalized and the credentials address must be a personal one', () => {
  assert.deepEqual(
    normalizeBainsaEmailRequest({ firstName: '  Ada ', lastName: 'Lovelace  King', contactEmail: ' Ada@Example.COM ' }),
    { firstName: 'Ada', lastName: 'Lovelace King', contactEmail: 'ada@example.com' },
  );
  assert.throws(
    () => normalizeBainsaEmailRequest({ firstName: 'Ada', lastName: 'L', contactEmail: 'not-an-email' }),
    UserFacingError,
  );
  assert.throws(
    () => normalizeBainsaEmailRequest({ firstName: 'Ada', lastName: 'L', contactEmail: 'ada@bainsa.ai' }),
    /not an @bainsa\.ai address/,
  );
  assert.throws(() => normalizeBainsaEmailRequest({ firstName: ' ', lastName: 'L', contactEmail: 'a@b.co' }), /first name/);
  assert.deepEqual(splitFullName('Ada King Lovelace'), { firstName: 'Ada', lastName: 'King Lovelace' });
  assert.deepEqual(splitFullName('Ada'), { firstName: 'Ada', lastName: '' });
});

test('the open prompt is signed by Alberto, offers both answers, and survives outbox serialization', () => {
  const payload = bainsaEmailPromptPayload();
  assert.match(payload.content, /A message from Alberto/);
  assert.match(payload.content, /Do you already have an @bainsa\.ai email\?/);
  assert.deepEqual(buttonLabels(payload), ['Request an @bainsa.ai email', 'I already have one']);
  const stored = JSON.parse(JSON.stringify(payload));
  assert.equal(stored.components[0].components[0].custom_id, 'be:req');
});

test('answered prompts show the outcome without buttons', () => {
  const requested = bainsaEmailPromptPayload({
    status: 'requested',
    contact_email: 'ada@example.com',
    university_name: 'Bocconi',
  });
  assert.match(requested.content, /the Bocconi board will create your account and send the login credentials to \*\*ada@example\.com\*\*/);
  assert.deepEqual(requested.components, []);
  const existing = bainsaEmailPromptPayload({ status: 'has_account' });
  assert.match(existing.content, /already have an @bainsa\.ai email/);
});

test('the request form pre-fills names from onboarding and asks where to send credentials', () => {
  const modal = bainsaEmailRequestModal({ fullName: 'Ada King Lovelace' }).toJSON() as unknown as {
    components: Array<{ components: Array<{ custom_id: string; label: string; value?: string }> }>;
  };
  const inputs = modal.components.map((row) => row.components[0]);
  assert.deepEqual(inputs.map((input) => input.custom_id), ['first_name', 'last_name', 'contact_email']);
  assert.equal(inputs[0].value, 'Ada');
  assert.equal(inputs[1].value, 'King Lovelace');
  assert.match(inputs[2].label, /credentials/i);
});

test('a submitted request is posted to the member university review queue and the DM shows its status', async () => {
  const db = emailDb();
  const channel = requestsChannel();
  const interaction = modalSubmit();

  await service(db, guildWith(channel)).handleModalSubmit(interaction);

  assert.equal(db.state.rows.member.status, 'requested');
  assert.equal(db.state.rows.member.contact_email, 'ada@example.com');
  assert.equal(db.state.rows.member.review_message_id, 'review-message');
  assert.equal(db.state.rows.member.university_id, '1');
  assert.deepEqual(db.state.audits, ['bainsa_email.request']);
  const card = channel.sent[0].embeds[0].data;
  assert.equal(card.title, 'New @bainsa.ai email request');
  assert.deepEqual(card.fields.map((field) => field.value).slice(0, 4), ['Ada', 'Lovelace', 'Bocconi', 'ada@example.com']);
  assert.equal(card.description, '**<@member>** needs an @bainsa.ai account.');
  assert.match(interaction.updates[0].content, /Request sent\. Someone from the Bocconi board/);
  assert.deepEqual(interaction.updates[0].components, []);
});

test('a second submission does not post a duplicate request', async () => {
  const db = emailDb({ rows: { member: { ...openRequest } } });
  const channel = requestsChannel();
  const interaction = modalSubmit();

  await service(db, guildWith(channel)).handleModalSubmit(interaction);

  assert.equal(channel.sent.length, 0);
  assert.match(interaction.updates[0].content, /Request sent/);
});

test('only approved members can request an account', async () => {
  const db = emailDb({ activeMembers: [] });
  await assert.rejects(
    () => service(db, guildWith(requestsChannel())).handleModalSubmit(modalSubmit()),
    /approved members/,
  );
  assert.deepEqual(db.state.rows, {});
});

test('"I already have one" is recorded and closes the prompt', async () => {
  const db = emailDb();
  const updates = [];
  await service(db).handleButton({
    customId: bainsaEmailId(BAINSA_EMAIL_ACTIONS.HAS_ACCOUNT),
    user: { id: 'member' },
    message: { id: 'dm-prompt' },
    update: async (payload) => { updates.push(payload); },
  });
  assert.equal(db.state.rows.member.status, 'has_account');
  assert.match(updates[0].content, /Nothing else to do/);
});

test('board members from another university cannot complete the request', async () => {
  const db = emailDb({ rows: { member: { ...openRequest } } });
  await assert.rejects(
    () => service(db).handleButton(markCreatedClick(reviewerGuild(['Sapienza - President', 'Researcher']))),
    /permission to manage Bocconi/,
  );
  assert.equal(db.state.rows.member.status, 'requested');
});

for (const role of ['Bocconi - President', 'Bocconi - Vice President', 'Bocconi - Head of Analysis', 'Global President']) {
  test(`${role} can complete a Bocconi request and the member is told by DM`, async () => {
    const db = emailDb({ rows: { member: { ...openRequest } } });
    const click = markCreatedClick(reviewerGuild([role]));

    await service(db).handleButton(click);

    assert.equal(db.state.rows.member.status, 'created');
    assert.equal(db.state.rows.member.handled_by, 'reviewer');
    assert.deepEqual(db.state.audits, ['bainsa_email.created']);
    assert.equal(db.state.notifications[0].kind, 'bainsa_email.created');
    assert.match(db.state.notifications[0].payload.content, /credentials were sent to ada@example\.com/);
    assert.match(db.state.notifications[0].payload.content, /contact the Bocconi board/);
    assert.equal(click.updates[0].embeds[0].data.title, '@bainsa.ai account created');
    assert.deepEqual(click.updates[0].components, []);
  });
}

test('approval queues the question only for members who have not answered yet', async () => {
  const db = emailDb();
  assert.equal(await enqueueBainsaEmailPrompt(db, { auditId: 7, recipientId: 'member' }), 1);
  assert.equal(db.state.notifications[0].kind, 'bainsa_email.prompt');

  const answered = emailDb({ rows: { member: { discord_user_id: 'member', status: 'has_account' } } });
  assert.equal(await enqueueBainsaEmailPrompt(answered, { auditId: 7, recipientId: 'member' }), null);
  assert.equal(await enqueueBainsaEmailPrompt(db, { auditId: null, recipientId: 'member' }), null);
});

test('review and created handoff copy keep personal details escaped', () => {
  const request = {
    discord_user_id: 'member',
    status: 'created',
    first_name: 'A_d_a',
    last_name: 'L*',
    contact_email: 'a_b@example.com',
    handled_by: 'alberto',
  };
  const card = bainsaEmailReviewPayload(request).embeds[0].data;
  assert.equal(card.fields[0].value, 'A\\_d\\_a');
  assert.match(card.fields[4].value, /Created by <@alberto>/);
  assert.match(bainsaEmailCreatedHandoff(request).content, /a\\_b@example\.com/);
});
