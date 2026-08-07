import assert from 'node:assert/strict';
import test from 'node:test';

import { UserFacingError } from '../src/errors.js';
import { ONBOARDING_ACTIONS, onboardingId } from '../src/onboarding/custom-ids.js';
import {
  createDraft,
  getUniversity,
  listDivisionsByIds,
  listUniversities,
  markReviewed,
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

test('createDraft rejects already-active members', async () => {
  const db = fakeDb([{ rows: [{ discord_user_id: '100' }] }]);

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

test('getUniversity filters inactive legacy universities', async () => {
  const db = fakeDb([{ rows: [] }]);

  await getUniversity(db, '99');

  assert.match(db.calls[0].sql, /WHERE id::text = \$1\s+AND active = true/);
});

test('START on an existing pending request replies with status and no editable controls', async () => {
  process.env.DISCORD_TOKEN ??= 'test-token';
  process.env.DISCORD_CLIENT_ID ??= 'test-client';
  process.env.DISCORD_GUILD_ID ??= 'test-guild';
  process.env.DATABASE_URL ??= 'postgres://localhost/test';
  const { createOnboardingService } = await import('../src/onboarding/service.js');
  const db = fakeDb([
    { rows: [] },
    { rows: [{ id: '10', status: 'pending', discord_user_id: '100' }] },
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

  assert.match(replyPayload.content, /already pending/i);
  assert.equal(replyPayload.components, undefined);
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
    { rows: [] },
  ]);
  const service = createOnboardingService({
    db,
    runTransaction: async (work) => work(db),
  });
  const interaction = {
    customId: onboardingId(ONBOARDING_ACTIONS.SUBMIT, '10'),
    user: { id: '100' },
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

  await assert.rejects(() => service.handleButton(interaction), /Discord send failed/);
  assert.equal(db.calls.some((call) => /SET .*status/.test(call.sql)), false);
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

  await assert.rejects(
    () => service.handleButton({
      customId: onboardingId(ONBOARDING_ACTIONS.APPROVE, '10'),
      user: { id: 'reviewer' },
      guild,
      deferReply: async () => undefined,
    }),
    /db write failed/,
  );

  assert.deepEqual([...targetRoleIds].sort(), ['alumni-role', 'guild', 'sapienza-projects-role', 'sapienza-role']);
  assert.equal(target.nickname, 'Previous nickname');
  assert.deepEqual(target.nicknameHistory, ['Ada Lovelace', 'Previous nickname']);
});

test('onboarding approval succeeds without a nickname change for an unmanageable member', async () => {
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
  let reviewEdited = false;
  let reply;
  const service = createOnboardingService({ db, runTransaction: async (work) => work(db) });

  await service.handleButton({
    customId: onboardingId(ONBOARDING_ACTIONS.APPROVE, '10'),
    user: { id: 'reviewer' },
    guild,
    message: { editable: true, edit: async () => { reviewEdited = true; } },
    deferReply: async () => undefined,
    editReply: async (content) => { reply = content; },
  });

  assert.deepEqual([...targetRoleIds].sort(), ['bocconi-projects-role', 'bocconi-role', 'guild', 'researcher-role']);
  assert.equal(reviewEdited, true);
  assert.equal(reply, 'Onboarding request approved.');
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
