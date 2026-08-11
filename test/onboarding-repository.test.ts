import assert from 'node:assert/strict';
import test from 'node:test';

import { UserFacingError } from '../src/errors.js';
import { ONBOARDING_ACTIONS, onboardingId } from '../src/onboarding/custom-ids.js';
import {
  createDraft,
  getRequest,
  getRequestForUser,
  getLatestRequestForUser,
  getUniversity,
  listDivisionsByIds,
  listRequestDivisionsByIds,
  lockRequest,
  listUniversities,
  markReviewed,
  upsertActiveMember,
  updateDraft,
} from '../src/onboarding/repository.js';

function fakeDb(responses = []) {
  const calls = [];
  return {
    calls,
    async query(sql, values = []) {
      calls.push({ sql, values });
      const response = responses.shift();
      if (response instanceof Error) throw response;
      if (typeof response === 'function') return response(sql, values, calls);
      return response ?? { rows: [] };
    },
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

test('createDraft rejects already-active members', async () => {
  const db = fakeDb([{ rows: [{ discord_user_id: '100', status: 'active' }] }]);

  await assert.rejects(() => createDraft(db, '100'), UserFacingError);
  assert.equal(db.calls.length, 1);
  assert.match(db.calls[0].sql, /FROM members/);
});

test('createDraft reuses an open draft or pending request', async () => {
  const existing = { id: '7', status: 'pending', discord_user_id: '100' };
  const db = fakeDb([{ rows: [] }, { rows: [existing] }]);

  assert.equal(await createDraft(db, '100'), existing);
  assert.equal(db.calls.length, 2);
  assert.match(db.calls[1].sql, /status IN/);
});

test('createDraft inserts bigint-array draft with canonical required fields', async () => {
  const inserted = { id: '8', status: 'draft', member_type: 'researcher', university_id: '1', division_ids: [] };
  const db = fakeDb([{ rows: [] }, { rows: [] }, { rows: [{ id: '1', name: 'Bocconi' }] }, { rows: [inserted] }]);

  assert.equal(await createDraft(db, '100'), inserted);
  const insert = db.calls.at(-1);
  assert.match(insert.sql, /member_type, university_id, status, division_ids, full_name, full_name_required/);
  assert.match(insert.sql, /ARRAY\[\]::bigint\[\]/);
  assert.doesNotMatch(insert.sql, /jsonb/);
});

test('createDraft records reapplications from members previously removed from the server', async () => {
  const inserted = { id: '8', status: 'draft', previously_removed: true };
  const db = fakeDb([
    { rows: [{ discord_user_id: '100', status: 'removed' }] },
    { rows: [] },
    { rows: [{ id: '1', name: 'Bocconi' }] },
    { rows: [inserted] },
  ]);

  assert.equal(await createDraft(db, '100'), inserted);
  const insert = db.calls.at(-1);
  assert.match(insert.sql, /previously_removed/);
  assert.equal(insert.values.at(-1), true);
});

test('createDraft recovers from concurrent open-request unique races', async () => {
  const uniqueError = new Error('duplicate key');
  uniqueError.code = '23505';
  const raced = { id: '9', status: 'draft', discord_user_id: '100' };
  const db = fakeDb([
    { rows: [] },
    { rows: [] },
    { rows: [{ id: '1', name: 'Bocconi' }] },
    uniqueError,
    { rows: [raced] },
  ]);

  assert.equal(await createDraft(db, '100'), raced);
});

test('repository uses canonical onboarding and resource columns', async () => {
  const db = fakeDb([
    { rows: [{ id: '1', name: 'Bocconi', discord_role_id: 'role-u' }] },
    { rows: [{ id: '4', member_role_id: 'role-d' }] },
    { rows: [{ id: '10' }] },
    { rows: [{ id: '10' }] },
  ]);

  await listUniversities(db);
  await listDivisionsByIds(db, '1', ['4']);
  await updateDraft(db, '10', '100', { division_ids: ['4'], full_name: 'Ada Lovelace', review_message_id: 'msg-1' });
  await markReviewed(db, '10', 'approved', '200', 'ok');

  assert.match(db.calls[0].sql, /discord_role_id/);
  assert.match(db.calls[1].sql, /member_role_id/);
  assert.match(db.calls[1].sql, /ANY\(\$2::bigint\[\]\)/);
  assert.match(db.calls[1].sql, /active = true/);
  assert.match(db.calls[2].sql, /division_ids = \$1::bigint\[\]/);
  assert.match(db.calls[2].sql, /full_name = \$2/);
  assert.match(db.calls[2].sql, /review_message_id/);
  assert.match(db.calls[2].sql, /AND status = \$\d+/);
  assert.equal(db.calls[2].values.at(-1), 'draft');
  assert.doesNotMatch(db.calls[2].sql, /review_channel_id|jsonb/);
  assert.match(db.calls[3].sql, /reviewed_by = \$3/);
  assert.match(db.calls[3].sql, /review_reason = \$4/);
  assert.doesNotMatch(db.calls[3].sql, /reviewed_by_discord_user_id|rejection_reason/);
});

test('onboarding request ID predicates use bigint parameters without casting indexed columns', async () => {
  const db = fakeDb(Array.from({ length: 6 }, () => ({ rows: [] })));

  await getRequestForUser(db, '10', '100');
  await getRequest(db, '10');
  await lockRequest(db, '10');
  await updateDraft(db, '10', '100', {});
  await updateDraft(db, '10', '100', { full_name: 'Ada Lovelace' });
  await markReviewed(db, '10', 'approved', '200');

  for (const call of db.calls) {
    assert.doesNotMatch(call.sql, /onboarding_requests[\s\S]*?id::text/);
    assert.match(call.sql, /id = \$\d+::bigint/);
    assert.equal(typeof call.values.find((value) => typeof value === 'bigint'), 'bigint');
  }
});

test('malformed onboarding request IDs remain non-matches', async () => {
  const db = fakeDb();

  assert.equal(await getRequest(db, 'not-an-id'), null);
  assert.equal(await updateDraft(db, 'not-an-id', '100', { full_name: 'Ada Lovelace' }), null);
  assert.equal(await markReviewed(db, 'not-an-id', 'approved', '200'), null);
  assert.equal(db.calls.length, 0);
});

test('getUniversity filters inactive legacy universities', async () => {
  const db = fakeDb([{ rows: [] }]);

  await getUniversity(db, '99');

  assert.match(db.calls[0].sql, /WHERE id::text = \$1\s+AND active = true/);
});

test('application status reads the latest decision and historical scope without active filters', async () => {
  const latest = { id: '12', status: 'rejected', university_name: 'Former chapter' };
  const db = fakeDb([
    { rows: [latest] },
    { rows: [{ id: '4', name: 'Analysis' }] },
  ]);

  assert.equal(await getLatestRequestForUser(db, '100'), latest);
  await listRequestDivisionsByIds(db, '1', ['4']);

  assert.match(db.calls[0].sql, /ORDER BY r\.created_at DESC, r\.id DESC/);
  assert.match(db.calls[0].sql, /LEFT JOIN universities/);
  assert.doesNotMatch(db.calls[1].sql, /active = true/);
});

test('rejection controls require a reason explicitly shared with the applicant', async () => {
  process.env.DISCORD_TOKEN ??= 'test-token';
  process.env.DISCORD_CLIENT_ID ??= 'test-client';
  process.env.DISCORD_GUILD_ID ??= 'test-guild';
  process.env.DATABASE_URL ??= 'postgres://localhost/test';
  const { createOnboardingService, notifyRejectedApplicant } = await import('../src/onboarding/service.js');
  const service = createOnboardingService({ db: fakeDb() });
  let modal;
  await service.handleButton({
    customId: onboardingId(ONBOARDING_ACTIONS.REJECT, '10'),
    showModal: async (payload) => { modal = payload.toJSON(); },
  });
  const input = modal.components[0].components[0];
  assert.equal(input.required, true);
  assert.match(input.label, /shared with the applicant/i);

  let dm;
  const channelValues = [{ id: 'onboarding-channel', name: 'onboarding' }];
  const cache = {
    find: (predicate) => channelValues.find(predicate),
  };
  await notifyRejectedApplicant({
    guild: {
      id: 'guild',
      channels: { cache },
      members: { fetch: async () => ({ send: async (message) => { dm = message; } }) },
    },
    userId: '100',
    request: {
      member_type: 'alumni',
      review_reason: 'Please clarify your university connection.',
    },
    university: { name: 'Bocconi' },
    divisions: [],
  });
  assert.deepEqual(dm.allowedMentions, { parse: [] });
  assert.match(dm.content, /Please clarify your university connection/);
  assert.doesNotMatch(dm.content, /start a new application|reapply/i);
  assert.match(dm.content, /onboarding-channel/);
});

test('approval handoff leads with access, native channel links, and a profile call to action', async () => {
  process.env.DISCORD_TOKEN ??= 'test-token';
  process.env.DISCORD_CLIENT_ID ??= 'test-client';
  process.env.DISCORD_GUILD_ID ??= 'test-guild';
  process.env.DATABASE_URL ??= 'postgres://localhost/test';
  const { notifyApprovedMemberAboutDirectory } = await import('../src/onboarding/service.js');
  let dm;
  const channels = [
    { id: 'global-general', name: 'bainsa-general' },
    { id: 'bocconi-category', name: 'BAINSA BOCCONI' },
    { id: 'bocconi-general', name: 'general', parentId: 'bocconi-category' },
    { id: 'analysis-channel', name: '🟧-analysis', parentId: 'bocconi-category' },
    { id: 'database', name: 'people-database' },
  ];
  const cache = {
    find: (predicate) => channels.find(predicate),
    get: (id) => channels.find((channel) => channel.id === id),
  };

  await notifyApprovedMemberAboutDirectory({
    guild: {
      id: 'guild',
      channels: { cache },
      members: { fetch: async () => ({ send: async (message) => { dm = message; } }) },
    },
    userId: '100',
    request: { member_type: 'researcher' },
    university: { name: 'Bocconi' },
    divisions: [{ name: 'Analysis', color: 'orange', text_channel_id: 'analysis-channel' }],
  });

  assert.deepEqual(dm.allowedMentions, { parse: [] });
  assert.match(dm.content, /application was approved/i);
  assert.match(dm.content, /approved\*\*\n\n\*\*Your access\*\*/);
  assert.match(dm.content, /Your access.*Researcher.*Bocconi.*Analysis/s);
  assert.match(dm.content, /Global general/);
  assert.match(dm.content, /Bocconi general/);
  assert.match(dm.content, /Your division: <#analysis-channel>/);
  assert.match(dm.content, /Create your profile in <#database>/);
  assert.ok(dm.content.indexOf('**Start here**') < dm.content.indexOf('Create your profile'));
  assert.doesNotMatch(dm.content, /optional|Check application status/i);
});

test('Find my spaces opens a channel guide and only prompts members without a profile', async () => {
  process.env.DISCORD_TOKEN ??= 'test-token';
  process.env.DISCORD_CLIENT_ID ??= 'test-client';
  process.env.DISCORD_GUILD_ID ??= 'test-guild';
  process.env.DATABASE_URL ??= 'postgres://localhost/test';
  const { createOnboardingService } = await import('../src/onboarding/service.js');
  const db = fakeDb([
    { rows: [{
      id: '10',
      status: 'approved',
      discord_user_id: '100',
      member_type: 'researcher',
      university_id: '1',
      division_ids: ['2'],
    }] },
    { rows: [{ id: '1', name: 'Bocconi' }] },
    { rows: [{ id: '2', name: 'Analysis', color: 'orange', text_channel_id: 'division' }] },
  ]);
  const service = createOnboardingService({
    db,
    hasPublishedDirectoryProfile: async () => false,
  });
  const channels = [
    { id: 'global', name: 'GLOBAL BAINSA' },
    { id: 'bocconi', name: 'BAINSA BOCCONI' },
    { id: 'global-general', name: 'bainsa-general', parentId: 'global' },
    { id: 'university-general', name: 'general', parentId: 'bocconi' },
    { id: 'division', name: '🟧-analysis', parentId: 'bocconi' },
    { id: 'resources', name: 'resources', parentId: 'global' },
    { id: 'showcase', name: 'projects-showcase', parentId: 'global' },
    { id: 'database', name: 'people-database', parentId: 'global' },
  ];
  let replyPayload;

  await service.handleButton({
    customId: onboardingId(ONBOARDING_ACTIONS.SPACES),
    user: { id: '100' },
    guild: { channels: { cache: { find: (predicate) => channels.find(predicate), get: (id) => channels.find((channel) => channel.id === id) } } },
    reply: async (payload) => { replyPayload = payload; },
  });

  assert.equal(replyPayload.embeds[0].data.title, 'Find your place in BAINSA');
  assert.match(replyPayload.embeds[0].data.fields.find((field) => field.name === 'Resources').value, /<#resources>/);
  assert.doesNotMatch(replyPayload.embeds[0].data.description, /Application approved|Applicant|Path/i);
  assert.equal(replyPayload.components[0].toJSON().components[0].custom_id, 'pf:start');
});

test('START on an existing pending request replies with status and no editable controls', async () => {
  process.env.DISCORD_TOKEN ??= 'test-token';
  process.env.DISCORD_CLIENT_ID ??= 'test-client';
  process.env.DISCORD_GUILD_ID ??= 'test-guild';
  process.env.DATABASE_URL ??= 'postgres://localhost/test';
  const { createOnboardingService } = await import('../src/onboarding/service.js');
  const db = fakeDb([
    { rows: [] },
    { rows: [{
      id: '10',
      status: 'pending',
      discord_user_id: '100',
      member_type: 'alumni',
      full_name: 'Ada Lovelace',
      university_id: '1',
      division_ids: [],
    }] },
    { rows: [{ id: '1', name: 'Bocconi' }] },
  ]);
  const service = createOnboardingService({ db });
  let replyPayload;

  await service.handleButton({
    customId: 'onboarding:start',
    user: { id: '100' },
    reply: async (payload) => {
      replyPayload = payload;
    },
  });

  assert.equal(replyPayload.embeds[0].data.title, 'Application pending review');
  assert.match(replyPayload.embeds[0].data.description, /Check application status/);
  assert.deepEqual(replyPayload.components, []);
});

test('START modal omits blank full name value so Discord accepts the text input', async () => {
  process.env.DISCORD_TOKEN ??= 'test-token';
  process.env.DISCORD_CLIENT_ID ??= 'test-client';
  process.env.DISCORD_GUILD_ID ??= 'test-guild';
  process.env.DATABASE_URL ??= 'postgres://localhost/test';
  const { createOnboardingService } = await import('../src/onboarding/service.js');
  const db = fakeDb([
    { rows: [] },
    { rows: [] },
    { rows: [{ id: '1', name: 'Bocconi' }] },
    { rows: [{ id: '10', status: 'draft', discord_user_id: '100', full_name: null }] },
  ]);
  const service = createOnboardingService({ db });
  let modalPayload;

  await service.handleButton({
    customId: 'onboarding:start',
    user: { id: '100' },
    showModal: async (modal) => {
      modalPayload = modal.toJSON();
    },
  });

  const input = modalPayload.components[0].components[0];
  assert.equal(input.custom_id, 'full_name');
  assert.equal(input.min_length, 2);
  assert.equal(input.value, undefined);
});

test('member path selection uses the native select value and updates the same private message', async () => {
  process.env.DISCORD_TOKEN ??= 'test-token';
  process.env.DISCORD_CLIENT_ID ??= 'test-client';
  process.env.DISCORD_GUILD_ID ??= 'test-guild';
  process.env.DATABASE_URL ??= 'postgres://localhost/test';
  const { createOnboardingService } = await import('../src/onboarding/service.js');
  const selected = {
    id: '10',
    status: 'draft',
    discord_user_id: '100',
    member_type: 'alumni',
    university_id: '1',
    division_ids: [],
  };
  const db = fakeDb([{ rows: [selected] }]);
  const service = createOnboardingService({ db });
  let updated;

  await service.handleStringSelect({
    customId: onboardingId(ONBOARDING_ACTIONS.MEMBER_TYPE, '10'),
    user: { id: '100' },
    values: ['alumni'],
    update: async (payload) => { updated = payload; },
  });

  assert.match(db.calls[0].sql, /UPDATE onboarding_requests/);
  assert.equal(db.calls[0].values[0], 'alumni');
  const menu = updated.components[0].toJSON().components[0];
  assert.equal(menu.options[1].default, true);
});

test('submit sends review message before marking request pending', async () => {
  process.env.DISCORD_TOKEN ??= 'test-token';
  process.env.DISCORD_CLIENT_ID ??= 'test-client';
  process.env.DISCORD_GUILD_ID ??= 'test-guild';
  process.env.DATABASE_URL ??= 'postgres://localhost/test';
  const { createOnboardingService } = await import('../src/onboarding/service.js');
  const db = fakeDb([
    {
      rows: [{
        id: '10',
        discord_user_id: '100',
        member_type: 'alumni',
        full_name: 'Ada Lovelace',
        university_id: '1',
        division_ids: [],
        status: 'draft',
      }],
    },
    {
      rows: [{
        id: '10',
        discord_user_id: '100',
        member_type: 'alumni',
        full_name: 'Ada Lovelace',
        university_id: '1',
        division_ids: [],
        status: 'draft',
      }],
    },
    { rows: [{ id: '1', name: 'Bocconi', discord_role_id: 'role-u', onboarding_review_channel_id: 'review-channel' }] },
    { rows: [
      {
        id: '10',
        discord_user_id: '100',
        member_type: 'alumni',
        full_name: 'Ada Lovelace',
        university_id: '1',
        division_ids: [],
        status: 'draft',
      },
    ] },
    { rows: [{ id: '1', name: 'Bocconi' }] },
  ]);
  const service = createOnboardingService({
    db,
    runTransaction: async (work) => work(db),
  });
  let recovery;
  const interaction = {
    customId: onboardingId(ONBOARDING_ACTIONS.SUBMIT, '10'),
    user: { id: '100' },
    update: async () => undefined,
    editReply: async (payload) => { recovery = payload; },
    guild: {
      channels: {
        fetch: async () => ({
          isTextBased: () => true,
          send: async () => {
            throw new Error('Discord send failed');
          },
        }),
      },
    },
  };

  await service.handleButton(interaction);
  assert.equal(db.calls.some((call) => /SET .*status/.test(call.sql)), false);
  assert.equal(recovery.embeds[0].data.title, 'Application not submitted');
  assert.match(recovery.embeds[0].data.description, /could not deliver/i);
  assert.deepEqual(
    recovery.components[0].toJSON().components.map((button) => button.label),
    ['Submit application', 'Back to university', 'Cancel'],
  );
});

test('submit acknowledges before a slow review delivery and edits the original response', async () => {
  process.env.DISCORD_TOKEN ??= 'test-token';
  process.env.DISCORD_CLIENT_ID ??= 'test-client';
  process.env.DISCORD_GUILD_ID ??= 'test-guild';
  process.env.DATABASE_URL ??= 'postgres://localhost/test';
  const { createOnboardingService } = await import('../src/onboarding/service.js');
  const request = {
    id: '10',
    discord_user_id: '100',
    member_type: 'alumni',
    full_name: 'Ada Lovelace',
    university_id: '1',
    division_ids: [],
    status: 'draft',
  };
  const db = fakeDb([
    { rows: [request] },
    { rows: [request] },
    { rows: [{ id: '1', name: 'Bocconi', discord_role_id: 'role-u', onboarding_review_channel_id: 'review-channel' }] },
    { rows: [{ ...request, status: 'pending', review_message_id: 'review-message' }] },
  ]);
  const reviewSendStarted = deferred();
  const releaseReviewSend = deferred();
  const service = createOnboardingService({
    db,
    runTransaction: async (work) => work(db),
  });
  let waitingPayload;
  let finalPayload;
  const interaction = {
    customId: onboardingId(ONBOARDING_ACTIONS.SUBMIT, '10'),
    user: { id: '100' },
    update: async (payload) => { waitingPayload = payload; },
    editReply: async (payload) => { finalPayload = payload; },
    guild: {
      channels: {
        fetch: async () => ({
          isTextBased: () => true,
          send: async () => {
            reviewSendStarted.resolve();
            await releaseReviewSend.promise;
            return { id: 'review-message', async delete() {} };
          },
        }),
      },
    },
  };

  const submitting = service.handleButton(interaction);
  await reviewSendStarted.promise;
  assert.equal(waitingPayload.embeds[0].data.title, 'Submitting your application');
  assert.deepEqual(waitingPayload.components, []);
  releaseReviewSend.resolve();
  await submitting;

  assert.equal(finalPayload.embeds[0].data.title, 'Application sent');
  assert.match(finalPayload.embeds[0].data.description, /university board has received/i);
  assert.deepEqual(finalPayload.components, []);
});

test('draft updates report a conditional status miss without disclosing another user request', async () => {
  process.env.DISCORD_TOKEN ??= 'test-token';
  process.env.DISCORD_CLIENT_ID ??= 'test-client';
  process.env.DISCORD_GUILD_ID ??= 'test-guild';
  process.env.DATABASE_URL ??= 'postgres://localhost/test';
  const { createOnboardingService } = await import('../src/onboarding/service.js');
  const pendingDb = fakeDb([
    { rows: [] },
    { rows: [{ id: '10', discord_user_id: '100', status: 'pending' }] },
  ]);
  const pendingService = createOnboardingService({ db: pendingDb });
  const interaction = {
    customId: onboardingId(ONBOARDING_ACTIONS.NAME_MODAL, '10'),
    user: { id: '100' },
    fields: { getTextInputValue: () => 'Ada Lovelace' },
  };

  await assert.rejects(
    pendingService.handleModalSubmit(interaction),
    /onboarding request is no longer editable/i,
  );
  assert.match(pendingDb.calls[0].sql, /UPDATE onboarding_requests/);
  assert.match(pendingDb.calls[0].sql, /AND status = \$\d+/);

  const missingDb = fakeDb([{ rows: [] }, { rows: [] }]);
  const missingService = createOnboardingService({ db: missingDb });
  await assert.rejects(
    missingService.handleModalSubmit(interaction),
    /onboarding request was not found/i,
  );
});

test('onboarding nickname and role compensation respect Discord limits and previous state', async () => {
  process.env.DISCORD_TOKEN ??= 'test-token';
  process.env.DISCORD_CLIENT_ID ??= 'test-client';
  process.env.DISCORD_GUILD_ID ??= 'test-guild';
  process.env.DATABASE_URL ??= 'postgres://localhost/test';
  const { discordNicknameFromFullName, roleRestorePlan } = await import('../src/onboarding/service.js');

  assert.equal(discordNicknameFromFullName('  Ada   Lovelace  '), 'Ada Lovelace');
  assert.equal(discordNicknameFromFullName('A'.repeat(40)), 'A'.repeat(32));
  assert.equal(discordNicknameFromFullName(`${'A'.repeat(31)}😀B`), `${'A'.repeat(31)}😀`);

  assert.deepEqual(
    roleRestorePlan(
      new Set(['guild', 'alumni-role', 'sapienza-role']),
      new Set(['guild', 'researcher-role', 'bocconi-role']),
      'guild',
    ),
    {
      remove: ['researcher-role', 'bocconi-role'],
      add: ['alumni-role', 'sapienza-role'],
    },
  );
});

test('onboarding approval reactivates a removed member and clears their removal timestamp', async () => {
  const request = {
    discord_user_id: '100',
    member_type: 'alumni',
    university_id: '1',
    division_ids: [],
    full_name: 'Ada Lovelace',
  };
  const db = fakeDb([
    { rows: [] },
    { rows: [] },
    { rows: [] },
  ]);

  await upsertActiveMember(db, request);

  const upsert = db.calls.find((call) => /INSERT INTO members/.test(call.sql));
  assert.match(upsert.sql, /status = 'active'/);
  assert.match(upsert.sql, /removed_at = NULL/);
});

test('a Division Head can approve, and Discord roles roll back when a later DB write fails', async () => {
  process.env.DISCORD_TOKEN ??= 'test-token';
  process.env.DISCORD_CLIENT_ID ??= 'test-client';
  process.env.DISCORD_GUILD_ID ??= 'test-guild';
  process.env.DATABASE_URL ??= 'postgres://localhost/test';
  const { createOnboardingService } = await import('../src/onboarding/service.js');
  const dbFailure = new Error('db write failed');
  const db = fakeDb([
    {
      rows: [{
        id: '10',
        discord_user_id: 'target',
        member_type: 'researcher',
        full_name: 'Ada Lovelace',
        university_id: '1',
        division_ids: ['11'],
        status: 'pending',
      }],
    },
    { rows: [{ id: '1', name: 'Bocconi', discord_role_id: 'bocconi-role', onboarding_review_channel_id: 'review' }] },
    { rows: [{ id: '11', university_id: '1', name: 'Projects', member_role_id: 'bocconi-projects-role' }] },
    {
      rows: [
        { id: '11', university_id: '1', university_name: 'Bocconi', name: 'Projects', member_role_id: 'bocconi-projects-role' },
        { id: '21', university_id: '2', university_name: 'Sapienza', name: 'Projects', member_role_id: 'sapienza-projects-role' },
      ],
    },
    {
      rows: [
        { id: '1', name: 'Bocconi', discord_role_id: 'bocconi-role' },
        { id: '2', name: 'Sapienza', discord_role_id: 'sapienza-role' },
      ],
    },
    dbFailure,
  ]);
  const roles = roleCache([
    ['guild', '@everyone'],
    ['researcher-role', 'Researcher'],
    ['alumni-role', 'Alumni'],
    ['bocconi-role', 'Bocconi'],
    ['sapienza-role', 'Sapienza'],
    ['bocconi-head-role', 'Bocconi - Head of Projects'],
    ['bocconi-projects-role', 'Bocconi - Projects'],
    ['sapienza-projects-role', 'Sapienza - Projects'],
  ]);
  const targetRoleIds = new Set(['guild', 'alumni-role', 'sapienza-role', 'sapienza-projects-role']);
  const target = memberWithMutableRoles('target', targetRoleIds, roles);
  target.nickname = 'Previous nickname';
  const reviewer = {
    roles: {
      cache: {
        some: (predicate) => predicate({ id: 'bocconi-head-role', name: 'Bocconi - Head of Projects' }),
      },
    },
  };
  const guild = {
    id: 'guild',
    roles: { cache: roles },
    members: {
      fetch: async (userId) => (userId === 'reviewer' ? reviewer : target),
    },
  };
  const service = createOnboardingService({
    db,
    runTransaction: async (work) => work(db),
  });

  const replies = [];
  await service.handleButton({
    customId: onboardingId(ONBOARDING_ACTIONS.APPROVE, '10'),
    user: { id: 'reviewer' },
    guild,
    update: async () => undefined,
    editReply: async (payload) => { replies.push(payload); },
  });

  assert.deepEqual([...targetRoleIds].sort(), ['alumni-role', 'guild', 'sapienza-projects-role', 'sapienza-role']);
  assert.equal(target.nickname, 'Previous nickname');
  assert.deepEqual(target.nicknameHistory, ['Ada Lovelace', 'Previous nickname']);
  assert.equal(replies.at(-1).embeds[0].data.title, 'Approval could not be completed');
});

test('onboarding approval survives a directory DM failure without creating a profile', async () => {
  process.env.DISCORD_TOKEN ??= 'test-token';
  process.env.DISCORD_CLIENT_ID ??= 'test-client';
  process.env.DISCORD_GUILD_ID ??= 'test-guild';
  process.env.DATABASE_URL ??= 'postgres://localhost/test';
  const { createOnboardingService } = await import('../src/onboarding/service.js');
  const pendingRequest = {
    id: '10',
    discord_user_id: 'target',
    member_type: 'researcher',
    full_name: 'Ada Lovelace',
    university_id: '1',
    division_ids: ['11'],
    status: 'pending',
  };
  const approvedRequest = { ...pendingRequest, status: 'approved', reviewed_by: 'reviewer' };
  const db = fakeDb([
    { rows: [pendingRequest] },
    { rows: [{ id: '1', name: 'Bocconi', discord_role_id: 'bocconi-role', onboarding_review_channel_id: 'review' }] },
    { rows: [{ id: '11', university_id: '1', name: 'Projects', member_role_id: 'bocconi-projects-role' }] },
    { rows: [{ id: '11', university_id: '1', university_name: 'Bocconi', name: 'Projects', member_role_id: 'bocconi-projects-role' }] },
    { rows: [{ id: '1', name: 'Bocconi', discord_role_id: 'bocconi-role' }] },
    { rows: [{ discord_user_id: 'target' }] },
    { rows: [] },
    { rows: [] },
    { rows: [] },
    { rows: [] },
    { rows: [approvedRequest] },
    { rows: [] },
  ]);
  const roles = roleCache([
    ['guild', '@everyone'],
    ['researcher-role', 'Researcher'],
    ['alumni-role', 'Alumni'],
    ['bocconi-role', 'Bocconi'],
    ['bocconi-projects-role', 'Bocconi - Projects'],
    ['bocconi-head-role', 'Bocconi - Head of Projects'],
  ]);
  const targetRoleIds = new Set(['guild']);
  const target = memberWithMutableRoles('target', targetRoleIds, roles);
  target.manageable = false;
  target.setNickname = async () => assert.fail('nickname must not be attempted for an unmanageable member');
  const reviewer = {
    roles: {
      cache: {
        some: (predicate) => predicate({ id: 'bocconi-head-role', name: 'Bocconi - Head of Projects' }),
      },
    },
  };
  const guild = {
    id: 'guild',
    roles: { cache: roles },
    members: { fetch: async (userId) => (userId === 'reviewer' ? reviewer : target) },
  };
  const updates = [];
  const replies = [];
  let directoryNotificationAttempts = 0;
  const service = createOnboardingService({
    db,
    runTransaction: async (work) => work(db),
    notifyApprovedMember: async ({ guild: notifiedGuild, userId }) => {
      directoryNotificationAttempts += 1;
      assert.equal(notifiedGuild, guild);
      assert.equal(userId, 'target');
      throw new Error('DMs disabled');
    },
  });

  await service.handleButton({
    customId: onboardingId(ONBOARDING_ACTIONS.APPROVE, '10'),
    user: { id: 'reviewer' },
    guild,
    update: async (payload) => { updates.push(payload); },
    editReply: async (payload) => { replies.push(payload); },
  });

  assert.deepEqual([...targetRoleIds].sort(), ['bocconi-projects-role', 'bocconi-role', 'guild', 'researcher-role']);
  assert.equal(updates[0].embeds[0].data.title, 'Approving access');
  assert.equal(replies[0].embeds[0].data.title, 'Access request approved');
  assert.equal(directoryNotificationAttempts, 1);
  assert.equal(db.calls.some(({ sql }) => /member_profiles/i.test(sql)), false);
});

function roleCache(entries) {
  const map = new Map(entries.map(([id, name]) => [id, { id, name }]));
  map.find = function find(predicate) {
    return [...this.values()].find(predicate);
  };
  return map;
}

function memberWithMutableRoles(userId, roleIds, roles) {
  const member = {
    id: userId,
    nickname: null,
    nicknameHistory: [],
    guild: { id: 'guild', roles: { cache: roles } },
    roles: {
      cache: {
        keys: () => roleIds.keys(),
      },
      remove: async (ids) => {
        for (const id of ids) roleIds.delete(id);
      },
      add: async (ids) => {
        for (const id of ids) roleIds.add(id);
      },
    },
    async setNickname(nickname) {
      this.nickname = nickname;
      this.nicknameHistory.push(nickname);
      return this;
    },
  };
  return member;
}
