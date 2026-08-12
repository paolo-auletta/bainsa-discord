import assert from 'node:assert/strict';
import test from 'node:test';

import { ChannelType } from 'discord.js';

import { ONBOARDING_ACTIONS, onboardingId } from '../../src/onboarding/custom-ids.js';
import { createOnboardingService } from '../../src/onboarding/service.js';
import { MAX_PROJECT_PARTICIPANTS, ROLE_NAMES } from '../../src/constants.js';
import { removeMember, updateMember } from '../../src/services/governance/service.js';
import {
  lockDivisionHeadEligibilityRows,
  lockMemberEligibilityRows,
} from '../../src/services/projects/eligibility.js';
import { addProjectMember, closeProject, createProject, updateProject } from '../../src/services/projects/index.js';
import { runMigrations } from '../../src/migrations/runner.js';
import {
  assertDisposableTestDatabaseUrl,
  createDisposableTestDatabase,
  failTransactionQuery,
} from '../helpers/disposable-postgres.js';

const databaseUrl = assertDisposableTestDatabaseUrl(process.env.TEST_DATABASE_URL);
const database = createDisposableTestDatabase(databaseUrl);

function role(id, name) {
  return { id: String(id), name, editable: true, hexColor: '#000000' };
}

function roleCache(roles = []) {
  const values = new Map(roles.map((entry) => [String(entry.id), entry]));
  return {
    get: (id) => values.get(String(id)),
    has: (id) => values.has(String(id)),
    keys: () => values.keys(),
    find: (predicate) => [...values.values()].find(predicate),
    some: (predicate) => [...values.values()].some(predicate),
    set: (id, value) => values.set(String(id), value),
    delete: (id) => values.delete(String(id)),
  };
}

function managedMember(id, guild, initialRoles = []) {
  const cache = roleCache(initialRoles);
  let roleMutationCount = 0;
  return {
    id: String(id),
    user: { id: String(id), bot: false },
    guild,
    nickname: null,
    nicknameHistory: [],
    roles: {
      cache,
      async add(entries) {
        roleMutationCount += 1;
        for (const entry of entries) {
          const resolved = typeof entry === 'string' ? guild.roles.cache.get(entry) : entry;
          cache.set(resolved.id, resolved);
        }
      },
      async remove(entries) {
        roleMutationCount += 1;
        for (const entry of entries) cache.delete(typeof entry === 'string' ? entry : entry.id);
      },
    },
    roleMutationCount() {
      return roleMutationCount;
    },
    async setNickname(nickname) {
      this.nickname = nickname;
      this.nicknameHistory.push(nickname);
      return this;
    },
  };
}

function globalPresident(id = 'reviewer') {
  return {
    id,
    roles: { cache: roleCache([role('global-president', ROLE_NAMES.GLOBAL_PRESIDENT)]) },
  };
}

async function resetAndMigrate() {
  await database.resetPublicSchema();
  await runMigrations({ databaseUrl });
}

async function seedUniversityAndDivision() {
  const university = await database.query(
    `INSERT INTO universities (name, discord_role_id)
     VALUES ('Bocconi', 'bocconi-role') RETURNING id`,
  );
  const division = await database.query(
    `INSERT INTO divisions (university_id, name, member_role_id)
     VALUES ($1, 'Analysis', 'analysis-role') RETURNING id`,
    [university.rows[0].id],
  );
  return { universityId: university.rows[0].id, divisionId: division.rows[0].id };
}

function deferred() {
  let resolve;
  const promise = new Promise((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

async function seedOnboardingRaceDraft() {
  await resetAndMigrate();
  const { universityId, divisionId } = await seedUniversityAndDivision();
  await database.query(
    'UPDATE universities SET onboarding_review_channel_id = $2 WHERE id = $1',
    [universityId, 'review-channel'],
  );
  const created = await database.query(
    `INSERT INTO onboarding_requests
      (discord_user_id, member_type, university_id, division_ids, status, full_name, full_name_required)
     VALUES ($1, 'researcher', $2, ARRAY[$3]::bigint[], 'draft', 'Ada Lovelace', true)
     RETURNING id`,
    ['onboarding-race-user', universityId, divisionId],
  );
  const requestId = created.rows[0].id;
  return { divisionId, requestId };
}

function reviewFields(payload) {
  return payload.embeds[0].data.fields.map(({ name, value }) => ({ name, value }));
}

const expectedInitialReviewFields = [
  { name: 'Applicant', value: 'Ada Lovelace' },
  { name: 'Path', value: '🔬 Researcher' },
  { name: 'University', value: 'Bocconi' },
  { name: 'Division', value: '🟦 Analysis' },
  { name: 'Review status', value: '🟡 Pending review' },
];

async function assertSubmitRaceLosesDraftMutation(action) {
  const { divisionId, requestId } = await seedOnboardingRaceDraft();
  const reviewSendEntered = deferred();
  const releaseReviewSend = deferred();
  const mutationStarted = deferred();
  let reviewPayload;
  let reviewMessageDeleted = false;

  const guild = {
    channels: {
      async fetch(channelId) {
        assert.equal(channelId, 'review-channel');
        return {
          isTextBased: () => true,
          async send(payload) {
            reviewPayload = payload;
            reviewSendEntered.resolve();
            await releaseReviewSend.promise;
            return {
              id: 'review-message',
              async delete() {
                reviewMessageDeleted = true;
              },
            };
          },
        };
      },
    },
  };
  const submitService = createOnboardingService({
    db: database,
    runTransaction: database.transaction.bind(database),
  });
  const racingDb = {
    query(text, values) {
      if (text.includes('UPDATE onboarding_requests')) mutationStarted.resolve();
      return database.query(text, values);
    },
  };
  const racingService = createOnboardingService({ db: racingDb });
  const submitInteraction = {
    customId: onboardingId(ONBOARDING_ACTIONS.SUBMIT, requestId),
    user: { id: 'onboarding-race-user' },
    guild,
    async update() {},
    async editReply() {},
  };
  const racingInteraction = action === 'edit'
    ? {
      customId: onboardingId(ONBOARDING_ACTIONS.NAME_MODAL, requestId),
      user: { id: 'onboarding-race-user' },
      fields: { getTextInputValue: () => 'Grace Hopper' },
    }
    : {
      customId: onboardingId(ONBOARDING_ACTIONS.CANCEL, requestId),
      user: { id: 'onboarding-race-user' },
      async update() {},
    };

  const submitting = submitService.handleButton(submitInteraction);
  await reviewSendEntered.promise;
  const racing = action === 'edit'
    ? racingService.handleModalSubmit(racingInteraction)
    : racingService.handleButton(racingInteraction);
  await mutationStarted.promise;
  releaseReviewSend.resolve();

  await submitting;
  await assert.rejects(racing, /onboarding request is no longer editable/i);

  const persisted = await database.query(
    `SELECT status, full_name, review_message_id, division_ids
     FROM onboarding_requests WHERE id = $1`,
    [requestId],
  );
  assert.deepEqual(persisted.rows[0], {
    status: 'pending',
    full_name: 'Ada Lovelace',
    review_message_id: 'review-message',
    division_ids: [String(divisionId)],
  });
  assert.equal(reviewMessageDeleted, false);
  assert.deepEqual(reviewFields(reviewPayload), expectedInitialReviewFields);
}

async function assertDraftMutationWinsBeforeSubmit(action) {
  const { divisionId, requestId } = await seedOnboardingRaceDraft();
  let reviewPayload;
  let reviewSendCount = 0;
  const guild = {
    channels: {
      async fetch(channelId) {
        assert.equal(channelId, 'review-channel');
        return {
          isTextBased: () => true,
          async send(payload) {
            reviewSendCount += 1;
            reviewPayload = payload;
            return { id: 'review-message', async delete() {} };
          },
        };
      },
    },
  };
  const service = createOnboardingService({
    db: database,
    runTransaction: database.transaction.bind(database),
  });
  const mutationInteraction = action === 'edit'
    ? {
      customId: onboardingId(ONBOARDING_ACTIONS.NAME_MODAL, requestId),
      user: { id: 'onboarding-race-user' },
      fields: { getTextInputValue: () => 'Grace Hopper' },
      async reply() {},
    }
    : {
      customId: onboardingId(ONBOARDING_ACTIONS.CANCEL, requestId),
      user: { id: 'onboarding-race-user' },
      async update() {},
    };
  const submitInteraction = {
    customId: onboardingId(ONBOARDING_ACTIONS.SUBMIT, requestId),
    user: { id: 'onboarding-race-user' },
    guild,
    async update() {},
    async editReply() {},
  };

  if (action === 'edit') {
    await service.handleModalSubmit(mutationInteraction);
  } else {
    await service.handleButton(mutationInteraction);
  }

  if (action === 'cancel') {
    await service.handleButton(submitInteraction);
    assert.equal(reviewSendCount, 0);
    assert.equal(
      (await database.query('SELECT status FROM onboarding_requests WHERE id = $1', [requestId])).rows[0].status,
      'cancelled',
    );
    return;
  }

  await service.handleButton(submitInteraction);
  const persisted = await database.query(
    `SELECT status, full_name, review_message_id, division_ids
     FROM onboarding_requests WHERE id = $1`,
    [requestId],
  );
  assert.deepEqual(persisted.rows[0], {
    status: 'pending',
    full_name: 'Grace Hopper',
    review_message_id: 'review-message',
    division_ids: [String(divisionId)],
  });
  assert.equal(reviewSendCount, 1);
  assert.deepEqual(reviewFields(reviewPayload), [
    { ...expectedInitialReviewFields[0], value: 'Grace Hopper' },
    ...expectedInitialReviewFields.slice(1),
  ]);
}

test.after(async () => {
  await database.resetPublicSchema();
  await database.close();
});

test('PostgreSQL submit wins over an interleaved draft edit without diverging from the review payload', async () => {
  await assertSubmitRaceLosesDraftMutation('edit');
});

test('PostgreSQL submit wins over an interleaved cancellation without leaving a cancelled pending request', async () => {
  await assertSubmitRaceLosesDraftMutation('cancel');
});

test('PostgreSQL edit commits before submit, which reviews and persists the edited draft', async () => {
  await assertDraftMutationWinsBeforeSubmit('edit');
});

test('PostgreSQL cancellation commits before submit, which sends no review message', async () => {
  await assertDraftMutationWinsBeforeSubmit('cancel');
});

test('onboarding approval rolls back its PostgreSQL transaction and Discord role changes when auditing fails', async () => {
  await resetAndMigrate();
  const { universityId, divisionId } = await seedUniversityAndDivision();
  const request = await database.query(
    `INSERT INTO onboarding_requests
      (discord_user_id, member_type, university_id, division_ids, status, full_name, full_name_required)
     VALUES ($1, 'researcher', $2, ARRAY[$3]::bigint[], 'pending', 'Ada Lovelace', true)
     RETURNING id`,
    ['onboarding-user', universityId, divisionId],
  );

  const guild = { id: 'guild' };
  guild.roles = {
    cache: roleCache([
      role('guild', '@everyone'),
      role('researcher-role', ROLE_NAMES.RESEARCHER),
      role('bocconi-role', 'Bocconi'),
      role('analysis-role', 'Bocconi - Analysis'),
      role('global-president', ROLE_NAMES.GLOBAL_PRESIDENT),
    ]),
  };
  const target = managedMember('onboarding-user', guild, [role('guild', '@everyone')]);
  target.nickname = 'Previous nickname';
  const reviewer = globalPresident();
  guild.members = {
    async fetch(id) {
      if (String(id) === target.id) return target;
      if (String(id) === reviewer.id) return reviewer;
      throw new Error('Unknown mock member');
    },
  };

  const service = createOnboardingService({
    db: database,
    runTransaction: failTransactionQuery(database, (text) => text.includes('INSERT INTO audit_log')).transaction,
  });
  const interaction = {
    customId: onboardingId(ONBOARDING_ACTIONS.APPROVE, request.rows[0].id),
    user: { id: reviewer.id },
    guild,
    member: reviewer,
    async update() {},
    async editReply() {},
  };

  await service.handleButton(interaction);
  assert.equal(target.roles.cache.has('researcher-role'), false);
  assert.equal(target.roles.cache.has('bocconi-role'), false);
  assert.equal(target.roles.cache.has('analysis-role'), false);
  assert.equal(target.nickname, 'Previous nickname');
  assert.deepEqual(target.nicknameHistory, ['Ada Lovelace', 'Previous nickname']);
  assert.equal((await database.query('SELECT count(*)::int AS count FROM members')).rows[0].count, 0);
  assert.equal(
    (await database.query('SELECT status FROM onboarding_requests WHERE id = $1', [request.rows[0].id])).rows[0].status,
    'pending',
  );
});

test('member-update restores mocked Discord roles when its PostgreSQL transaction fails', async () => {
  await resetAndMigrate();
  const { universityId } = await seedUniversityAndDivision();
  await database.query(
    `INSERT INTO members (discord_user_id, university_id, member_type, status)
     VALUES ($1, $2, 'researcher', 'active')`,
    ['governance-user', universityId],
  );

  const guild = { id: 'guild' };
  guild.roles = {
    cache: roleCache([
      role('researcher-role', ROLE_NAMES.RESEARCHER),
      role('bocconi-role', 'Bocconi'),
      role('analysis-role', 'Bocconi - Analysis'),
      role('global-president', ROLE_NAMES.GLOBAL_PRESIDENT),
    ]),
  };
  const target = managedMember('governance-user', guild);
  const actor = globalPresident('actor');
  guild.members = { async fetch(id) { return String(id) === target.id ? target : null; } };
  const failingDatabase = failTransactionQuery(database, (text) => text.includes('INSERT INTO audit_log'));

  await assert.rejects(
    updateMember(
      { guild, user: { id: actor.id }, member: actor },
      { user: { id: target.id }, university: 'Bocconi', memberType: 'researcher', divisionsText: 'Analysis' },
      { db: failingDatabase },
    ),
    /Discord roles were restored because the membership update could not be saved/i,
  );
  assert.equal(target.roles.cache.has('researcher-role'), false);
  assert.equal(target.roles.cache.has('bocconi-role'), false);
  assert.equal(target.roles.cache.has('analysis-role'), false);
  assert.equal((await database.query('SELECT count(*)::int AS count FROM members')).rows[0].count, 1);
});

test('member updates enqueue published profiles only when canonical directory facts change', async () => {
  await resetAndMigrate();
  const { universityId, divisionId } = await seedUniversityAndDivision();
  await database.query(
    `INSERT INTO divisions (university_id, name, member_role_id)
     VALUES ($1, 'Culture', 'culture-role') RETURNING id`,
    [universityId],
  );
  await database.query(
    `INSERT INTO members (discord_user_id, university_id, member_type, status)
     VALUES ($1, $2, 'researcher', 'active')`,
    ['directory-member', universityId],
  );
  await database.query(
    'INSERT INTO member_divisions (discord_user_id, division_id) VALUES ($1, $2)',
    ['directory-member', divisionId],
  );
  await database.query(
    `INSERT INTO member_profiles (
       discord_user_id, headline, about, "current_role", goals, selected_tags, visibility
     ) VALUES ($1, $2, $3, $4, $5, $6::text[], 'published')`,
    [
      'directory-member',
      'Applied AI researcher',
      'I enjoy machine learning and collaborative research projects.',
      'MSc student',
      'Explore research and internship collaborations.',
      ['ai_data'],
    ],
  );

  const guild = { id: 'guild' };
  guild.roles = {
    cache: roleCache([
      role('researcher-role', ROLE_NAMES.RESEARCHER),
      role('alumni-role', ROLE_NAMES.ALUMNI),
      role('bocconi-role', 'Bocconi'),
      role('analysis-role', 'Bocconi - Analysis'),
      role('culture-role', 'Bocconi - Culture'),
      role('global-president', ROLE_NAMES.GLOBAL_PRESIDENT),
    ]),
  };
  const target = managedMember('directory-member', guild, [
    role('researcher-role', ROLE_NAMES.RESEARCHER),
    role('bocconi-role', 'Bocconi'),
    role('analysis-role', 'Bocconi - Analysis'),
  ]);
  const actor = globalPresident('directory-actor');
  guild.members = { async fetch(id) { return String(id) === target.id ? target : actor; } };
  const interaction = { guild, user: { id: actor.id }, member: actor };

  await updateMember(
    interaction,
    { user: { id: target.id }, divisionsText: 'Culture' },
    { db: database },
  );
  let reconciliation = await database.query(
    'SELECT desired_generation, status FROM member_profile_reconciliation WHERE discord_user_id = $1',
    [target.id],
  );
  assert.deepEqual(reconciliation.rows[0], { desired_generation: '1', status: 'pending' });

  await updateMember(
    interaction,
    { user: { id: target.id }, notes: 'Updated administrative note only' },
    { db: database },
  );
  reconciliation = await database.query(
    'SELECT desired_generation FROM member_profile_reconciliation WHERE discord_user_id = $1',
    [target.id],
  );
  assert.equal(reconciliation.rows[0].desired_generation, '1');
  const divisions = await database.query(
    'SELECT d.name FROM member_divisions md JOIN divisions d ON d.id = md.division_id WHERE md.discord_user_id = $1',
    [target.id],
  );
  assert.deepEqual(divisions.rows, [{ name: 'Culture' }]);
  const accessHandoff = await database.query(
    `SELECT tn.kind, tn.status
       FROM transition_notifications tn
       JOIN audit_log a ON a.id = tn.audit_id
      WHERE a.action = 'member.update' AND a.target_id = $1`,
    [target.id],
  );
  assert.deepEqual(accessHandoff.rows.map((row) => row.kind), ['member.access_updated']);
});

test('member removal rolls profile visibility and reconciliation back when its transaction fails before Discord side effects', async () => {
  await resetAndMigrate();
  const { universityId, divisionId } = await seedUniversityAndDivision();
  await database.query(
    `INSERT INTO members (discord_user_id, university_id, member_type, status)
     VALUES ($1, $2, 'researcher', 'active')`,
    ['removal-profile-member', universityId],
  );
  await database.query(
    'INSERT INTO member_divisions (discord_user_id, division_id) VALUES ($1, $2)',
    ['removal-profile-member', divisionId],
  );
  await database.query(
    `INSERT INTO member_profiles (
       discord_user_id, headline, about, "current_role", goals, selected_tags, visibility,
       forum_thread_id, forum_message_id
     ) VALUES ($1, $2, $3, $4, $5, $6::text[], 'published', $7, $8)`,
    [
      'removal-profile-member',
      'Applied AI researcher',
      'I enjoy machine learning and collaborative research projects.',
      'MSc student',
      'Explore research and internship collaborations.',
      ['ai_data'],
      'removal-directory-thread',
      'removal-directory-message',
    ],
  );

  const guild = { id: 'guild' };
  guild.roles = {
    cache: roleCache([
      role('researcher-role', ROLE_NAMES.RESEARCHER),
      role('alumni-role', ROLE_NAMES.ALUMNI),
      role('bocconi-role', 'Bocconi'),
      role('analysis-role', 'Bocconi - Analysis'),
      role('global-president', ROLE_NAMES.GLOBAL_PRESIDENT),
    ]),
  };
  guild.channels = { cache: { has: () => false }, async fetch() { return null; } };
  const target = managedMember('removal-profile-member', guild, [
    role('researcher-role', ROLE_NAMES.RESEARCHER),
    role('bocconi-role', 'Bocconi'),
    role('analysis-role', 'Bocconi - Analysis'),
  ]);
  let kickCount = 0;
  target.kick = async () => { kickCount += 1; };
  const actor = globalPresident('removal-profile-actor');
  guild.members = { async fetch(id) { return String(id) === target.id ? target : actor; } };
  const failingDatabase = failTransactionQuery(database, (text) => text.includes('INSERT INTO audit_log'));

  await assert.rejects(
    removeMember(
      { guild, user: { id: actor.id }, member: actor },
      { user: { id: target.id }, reason: 'test rollback' },
      { db: failingDatabase },
    ),
    /membership record could not be saved/i,
  );
  assert.equal(kickCount, 0);
  const member = await database.query('SELECT status FROM members WHERE discord_user_id = $1', [target.id]);
  const profile = await database.query(
    `SELECT visibility, forum_thread_id, forum_message_id
       FROM member_profiles WHERE discord_user_id = $1`,
    [target.id],
  );
  const reconciliation = await database.query(
    'SELECT count(*)::int AS count FROM member_profile_reconciliation WHERE discord_user_id = $1',
    [target.id],
  );
  assert.equal(member.rows[0].status, 'active');
  assert.deepEqual(profile.rows[0], {
    visibility: 'published',
    forum_thread_id: 'removal-directory-thread',
    forum_message_id: 'removal-directory-message',
  });
  assert.equal(reconciliation.rows[0].count, 0);
});

test('member removal keeps canonical departure and project reconciliation intent when the Discord kick fails', async () => {
  await resetAndMigrate();
  const { universityId, divisionId } = await seedUniversityAndDivision();
  const project = await database.query(
    `INSERT INTO projects (name, university_id, division_id, start_date, expected_end, status)
     VALUES ('Removal access repair', $1, $2, '2026-07-01', '2026-08-01', 'active') RETURNING id`,
    [universityId, divisionId],
  );
  await database.query(
    `INSERT INTO members (discord_user_id, university_id, member_type, status)
     VALUES ('kick-failure-member', $1, 'researcher', 'active')`,
    [universityId],
  );
  await database.query(
    'INSERT INTO member_divisions (discord_user_id, division_id) VALUES ($1, $2)',
    ['kick-failure-member', divisionId],
  );
  await database.query(
    "INSERT INTO project_people (project_id, discord_user_id, role) VALUES ($1, $2, 'member')",
    [String((project.rows[0] as unknown as { id: string | number }).id), 'kick-failure-member'],
  );

  const guild: Record<string, unknown> & { id: string } = { id: 'guild' };
  guild.roles = {
    cache: roleCache([
      role('global-president', ROLE_NAMES.GLOBAL_PRESIDENT),
      role('researcher-role', ROLE_NAMES.RESEARCHER),
      role('bocconi-role', 'Bocconi'),
      role('analysis-role', 'Bocconi - Analysis'),
    ]),
  };
  guild.channels = { cache: { has: () => false, find: () => null }, async fetch() { return null; } };
  const target = Object.assign(
    managedMember('kick-failure-member', guild, [
      role('researcher-role', ROLE_NAMES.RESEARCHER),
      role('bocconi-role', 'Bocconi'),
      role('analysis-role', 'Bocconi - Analysis'),
    ]),
    { async kick() { throw new Error('Discord REST internal details'); } },
  );
  const actor = globalPresident('kick-failure-actor');
  guild.members = { async fetch(id) { return String(id) === target.id ? target : actor; } };

  const firstRemoval = await removeMember(
    { guild, user: { id: actor.id }, member: actor },
    { user: { id: target.id } },
    { db: database as never },
  );
  assert.equal(firstRemoval.discordRemoval.status, 'pending_recovery');
  assert.equal(firstRemoval.discordRemoval.managedRolesRemoved, true);
  assert.equal(target.roles.cache.has('researcher-role'), false);
  assert.equal(target.roles.cache.has('bocconi-role'), false);
  assert.equal(target.roles.cache.has('analysis-role'), false);
  assert.equal(((await database.query(
    'SELECT status FROM members WHERE discord_user_id = $1', ['kick-failure-member'],
  )).rows[0] as unknown as { status: string }).status, 'removed');
  assert.equal(((await database.query(
    'SELECT count(*)::int AS count FROM project_people WHERE discord_user_id = $1', ['kick-failure-member'],
  )).rows[0] as unknown as { count: number }).count, 0);
  const projectId = String((project.rows[0] as unknown as { id: string | number }).id);
  assert.equal(((await database.query(
    'SELECT status FROM project_reconciliation WHERE project_id = $1', [projectId],
  )).rows[0] as unknown as { status: string }).status, 'failed');
  const removalHandoff = await database.query(
    `SELECT kind, status, payload->>'content' AS content
       FROM transition_notifications
      WHERE recipient_discord_user_id = $1`,
    [target.id],
  );
  assert.equal(removalHandoff.rows.length, 1);
  assert.equal(removalHandoff.rows[0].kind, 'member.removed');
  assert.match(removalHandoff.rows[0].content, /Server membership removed/);
  assert.doesNotMatch(removalHandoff.rows[0].content, /Discord REST internal details/);

  const repairAttempt = await removeMember(
    { guild, user: { id: actor.id }, member: actor },
    { user: { id: target.id } },
    { db: database as never },
  );
  assert.equal(repairAttempt.discordRemoval.status, 'pending_recovery');
  assert.equal(((await database.query(
    "SELECT count(*)::int AS count FROM audit_log WHERE action = 'member.remove' AND target_id = $1",
    [target.id],
  )).rows[0] as unknown as { count: number }).count, 1);
  assert.equal(((await database.query(
    'SELECT desired_generation FROM project_reconciliation WHERE project_id = $1', [projectId],
  )).rows[0] as unknown as { desired_generation: string }).desired_generation, '1');
});

test('member-update rejects an ineligible active PostgreSQL project assignment before Discord or transaction side effects', async () => {
  await resetAndMigrate();
  const { universityId, divisionId } = await seedUniversityAndDivision();
  await database.query(
    `INSERT INTO members (discord_user_id, university_id, member_type, status)
     VALUES ($1, $2, 'researcher', 'active')`,
    ['project-member', universityId],
  );
  await database.query(
    'INSERT INTO member_divisions (discord_user_id, division_id) VALUES ($1, $2)',
    ['project-member', divisionId],
  );
  const project = await database.query(
    `INSERT INTO projects (name, university_id, division_id, start_date, expected_end, status)
     VALUES ('Signals', $1, $2, '2026-07-01', '2026-08-01', 'active')
     RETURNING id`,
    [universityId, divisionId],
  );
  await database.query(
    `INSERT INTO project_people (project_id, discord_user_id, role)
     VALUES ($1, $2, 'member')`,
    [project.rows[0].id, 'project-member'],
  );

  const guild = { id: 'guild' };
  guild.roles = {
    cache: roleCache([
      role('researcher-role', ROLE_NAMES.RESEARCHER),
      role('alumni-role', ROLE_NAMES.ALUMNI),
      role('bocconi-role', 'Bocconi'),
      role('analysis-role', 'Bocconi - Analysis'),
      role('global-president', ROLE_NAMES.GLOBAL_PRESIDENT),
    ]),
  };
  const target = managedMember('project-member', guild, [
    role('researcher-role', ROLE_NAMES.RESEARCHER),
    role('bocconi-role', 'Bocconi'),
    role('analysis-role', 'Bocconi - Analysis'),
  ]);
  const actor = globalPresident('actor');
  guild.members = { async fetch(id) { return String(id) === target.id ? target : null; } };
  let transactionCalls = 0;
  const trackedDatabase = {
    query: database.query.bind(database),
    async transaction(work) {
      transactionCalls += 1;
      return database.transaction(work);
    },
  };

  await assert.rejects(
    updateMember(
      { guild, user: { id: actor.id }, member: actor },
      { user: { id: target.id }, memberType: 'alumni' },
      { db: trackedDatabase },
    ),
    new RegExp(`#${project.rows[0].id} Signals.*Remove or reassign their project participation first`, 'i'),
  );
  assert.equal(target.roleMutationCount(), 0);
  assert.equal(transactionCalls, 0);
  const member = await database.query(
    'SELECT member_type FROM members WHERE discord_user_id = $1',
    ['project-member'],
  );
  assert.equal(member.rows[0].member_type, 'researcher');
});

test('project creation retains its committed record and records a pending reconciliation when Discord fails', async () => {
  await resetAndMigrate();
  const { universityId, divisionId } = await seedUniversityAndDivision();
  await database.query(
    `INSERT INTO members (discord_user_id, university_id, member_type, status)
     VALUES ($1, $2, 'researcher', 'active'),
            ($3, $2, 'alumni', 'active'),
            ($4, $2, 'researcher', 'active')`,
    ['111111111111111111', universityId, '222222222222222222', '333333333333333333'],
  );
  await database.query(
    'INSERT INTO member_divisions (discord_user_id, division_id) VALUES ($1, $2)',
    ['111111111111111111', divisionId],
  );
  await database.query(
    `INSERT INTO board_assignments (discord_user_id, university_id, division_id, role, active)
     VALUES ($1, $2, $3, 'head', true)`,
    ['333333333333333333', universityId, divisionId],
  );

  const guild = { id: 'guild' };
  guild.roles = { cache: roleCache([role('head-role', 'Bocconi - Head of Analysis')]) };
  const actor = {
    id: 'actor',
    roles: { cache: roleCache([role('head-role', 'Bocconi - Head of Analysis')]) },
  };
  const member = managedMember('111111111111111111', guild);
  const supervisor = managedMember('222222222222222222', guild);
  guild.members = {
    async fetch(id) {
      if (String(id) === member.id) return member;
      if (String(id) === supervisor.id) return supervisor;
      throw new Error('Unknown mock member');
    },
  };
  guild.channels = {
    cache: { has: () => false, find: () => null },
    async create() {
      throw new Error('Controlled Discord channel failure');
    },
  };

  const created = await createProject({
    interaction: { guild, member: actor, user: { id: actor.id } },
    name: 'Signals',
    university: 'Bocconi',
    division: 'Analysis',
    startDate: '2026-07-01',
    expectedEnd: '2026-08-01',
    summary: 'Public Signals summary',
    notes: null,
    members: member.id,
    supervisors: supervisor.id,
  }, { db: database });
  assert.equal(created.reconciliation_pending, true);
  const project = await database.query('SELECT status, notes FROM projects');
  assert.equal(project.rows[0].status, 'active');
  assert.equal(project.rows[0].notes, null);
  const reconciliation = await database.query('SELECT status, last_error FROM project_reconciliation');
  assert.equal(reconciliation.rows[0].status, 'failed');
  assert.match(reconciliation.rows[0].last_error, /Controlled Discord channel failure/);
});

test('project creation excludes a Head removal that commits before the locked Head snapshot', async () => {
  await resetAndMigrate();
  const { universityId, divisionId } = await seedUniversityAndDivision();
  const memberId = '111111111111111111';
  const headId = '222222222222222222';
  const supervisorId = '333333333333333333';
  await database.query(
    `INSERT INTO members (discord_user_id, university_id, member_type, status)
     VALUES ($1, $4, 'researcher', 'active'),
            ($2, $4, 'researcher', 'active'),
            ($3, $4, 'alumni', 'active')`,
    [memberId, headId, supervisorId, universityId],
  );
  await database.query(
    'INSERT INTO member_divisions (discord_user_id, division_id) VALUES ($1, $2)',
    [memberId, divisionId],
  );
  await database.query(
    `INSERT INTO board_assignments (discord_user_id, university_id, division_id, role, active)
     VALUES ($1, $2, $3, 'head', true)`,
    [headId, universityId, divisionId],
  );

  const locked = deferred();
  const release = deferred();
  const removingHead = database.transaction(async (q) => {
    await lockDivisionHeadEligibilityRows(q, [divisionId]);
    await q.query(
      `UPDATE board_assignments
          SET active = false, updated_at = now()
        WHERE discord_user_id = $1 AND division_id = $2 AND role = 'head'`,
      [headId, divisionId],
    );
    locked.resolve();
    await release.promise;
  });
  await locked.promise;

  const guild = { id: 'guild' };
  guild.roles = { cache: roleCache([role('global-president', ROLE_NAMES.GLOBAL_PRESIDENT)]) };
  const member = managedMember(memberId, guild);
  const supervisor = managedMember(supervisorId, guild);
  guild.members = {
    async fetch(id) {
      if (String(id) === memberId) return member;
      if (String(id) === supervisorId) return supervisor;
      throw new Error(`Unexpected guild member fetch: ${id}`);
    },
  };
  const creating = createProject({
    interaction: {
      guild,
      user: { id: 'actor' },
      member: globalPresident('actor'),
    },
    name: 'Locked Head snapshot',
    university: 'Bocconi',
    division: 'Analysis',
    startDate: '2026-07-01',
    expectedEnd: '2026-08-01',
    summary: 'Public locked-head summary',
    members: memberId,
    supervisors: supervisorId,
  }, { db: database });
  const creationRejected = assert.rejects(creating, /No active Head is assigned to Analysis/);
  await new Promise((resolve) => setImmediate(resolve));
  release.resolve();
  await removingHead;

  await creationRejected;
  assert.equal(
    (await database.query("SELECT count(*)::int AS count FROM projects WHERE name = 'Locked Head snapshot'"))
      .rows[0].count,
    0,
  );
});

test('successful project create, update, and close maintain canonical Discord records', async () => {
  await resetAndMigrate();
  const { universityId, divisionId } = await seedUniversityAndDivision();
  await database.query('UPDATE universities SET showcase_channel_id = $1 WHERE id = $2', ['showcase', universityId]);
  await database.query(
    `INSERT INTO members (discord_user_id, university_id, member_type, status)
     VALUES ($1, $2, 'researcher', 'active'),
            ($3, $2, 'alumni', 'active'),
            ($4, $2, 'researcher', 'active')`,
    ['111111111111111111', universityId, '222222222222222222', '333333333333333333'],
  );
  await database.query('INSERT INTO member_divisions (discord_user_id, division_id) VALUES ($1, $2)', ['111111111111111111', divisionId]);
  await database.query(
    `INSERT INTO board_assignments (discord_user_id, university_id, division_id, role, active)
     VALUES ($1, $2, $3, 'head', true)`,
    ['333333333333333333', universityId, divisionId],
  );

  const channels = new Map();
  const workspaceMessages = [];
  const workspaceEdits = [];
  const workspaceGuides = [];
  const workspaceGuideEdits = [];
  const workspaceTransitions = [];
  const starterEdits = [];
  let appliedTags = [];
  const starter = { async edit(payload) { starterEdits.push(payload); } };
  const thread = {
    id: 'thread', name: 'Signals', archived: false, locked: false,
    async fetchStarterMessage() { return starter; },
    async setName(name) { thread.name = name; },
    async setAppliedTags(tags) { appliedTags = tags; },
  };
  const forum = {
    id: 'showcase', type: ChannelType.GuildForum, availableTags: [],
    async setAvailableTags(tags) { forum.availableTags = tags.map((tag, index) => ({ ...tag, id: tag.id ?? `tag-${index}` })); return forum; },
    threads: { async create(payload) { forum.created = payload; channels.set(thread.id, thread); return thread; } },
  };
  channels.set(forum.id, forum);
  const guild = { id: 'guild' };
  guild.roles = { cache: roleCache([role('head-role', 'Bocconi - Head of Analysis')]) };
  const actor = { id: 'actor', roles: { cache: roleCache([role('head-role', 'Bocconi - Head of Analysis')]) } };
  const member = managedMember('111111111111111111', guild);
  const supervisor = managedMember('222222222222222222', guild);
  guild.members = { async fetch(id) { if (String(id) === member.id) return member; if (String(id) === supervisor.id) return supervisor; throw new Error('Unknown member'); } };
  guild.channels = {
    cache: { has: (id) => channels.has(id), find: (predicate) => [...channels.values()].find(predicate) },
    async fetch(id) { return id == null ? channels : channels.get(id) ?? null; },
    async create(options) {
      const projectMessages = new Map();
      const homeMessage = {
        id: 'home-message', pinned: false,
        async edit(payload) { workspaceEdits.push(payload); },
        async pin() { homeMessage.pinned = true; },
      };
      const workspaceGuide = {
        id: 'workspace-guide', pinned: false,
        async edit(payload) { workspaceGuideEdits.push(payload); },
        async pin() { workspaceGuide.pinned = true; },
      };
      const workspace = {
        id: 'workspace', name: options.name, topic: options.topic, parentId: null,
        permissionOverwrites: { async set() {} }, async setName() {}, async setParent() {}, async setTopic() {},
        messages: {
          async fetch(id) {
            if (typeof id === 'string') return projectMessages.get(id) ?? null;
            return projectMessages;
          },
          async fetchPins() {
            return { items: [...projectMessages.values()].filter((message) => message.pinned).map((message) => ({ message })) };
          },
        },
        async send(payload) {
          if (payload.content?.endsWith('Pinned project record · Updates automatically')) {
            workspaceMessages.push(payload);
            projectMessages.set(homeMessage.id, homeMessage);
            return homeMessage;
          }
          if (payload.content?.endsWith('Pinned workspace guide')) {
            workspaceGuides.push(payload);
            projectMessages.set(workspaceGuide.id, workspaceGuide);
            return workspaceGuide;
          }
          workspaceTransitions.push(payload);
          return { id: `transition-${workspaceTransitions.length}` };
        },
      };
      channels.set(workspace.id, workspace);
      return workspace;
    },
  };
  const interaction = { guild, member: actor, user: { id: actor.id } };
  const created = await createProject({
    interaction, name: 'Signals', university: 'Bocconi', division: 'Analysis',
    startDate: '2026-07-01', expectedEnd: '2026-08-01', summary: 'Public Signals summary', notes: null,
    members: member.id, supervisors: supervisor.id,
  }, { db: database });
  await updateProject({ interaction, project: String(created.id), notes: 'Updated notes' }, { db: database });
  await closeProject({ interaction, project: String(created.id), outcome: 'Done', finalNotes: 'Handed over' }, { db: database });
  assert.equal(workspaceMessages.length, 1);
  assert.equal(workspaceEdits.length, 2);
  assert.equal(workspaceGuides.length, 1);
  assert.equal(workspaceGuideEdits.length, 2);
  assert.match(workspaceGuides[0].content, /^## How to use this space/);
  assert.equal(workspaceTransitions.length, 2);
  assert.match(workspaceEdits.at(-1).content, /\*\*Conclusion\*\*\nDone/);
  assert.match(workspaceEdits.at(-1).content, /\*\*Internal handover notes\*\*\nHanded over/);
  assert.equal(JSON.stringify(workspaceTransitions.at(-1)).includes('Handed over'), false);
  assert.equal(forum.created.name, 'Signals');
  assert.deepEqual(forum.created.appliedTags.map((tag) => forum.availableTags.find((candidate) => candidate.id === tag).name), ['Analysis', 'Active']);
  assert.equal(starterEdits.length, 2);
  assert.equal(JSON.stringify(starterEdits.at(-1)).includes('Handed over'), false);
  assert.deepEqual(appliedTags.map((tag) => forum.availableTags.find((candidate) => candidate.id === tag).name), ['Analysis', 'Completed']);
});

function lockedTransactionDatabase() {
  const locked = deferred();
  const release = deferred();
  let didLock = false;
  return {
    query: database.query.bind(database),
    locked: locked.promise,
    release: release.resolve,
    async transaction(work) {
      return database.transaction(async (client) => work({
        ...client,
        async query(text, values = []) {
          const result = await client.query(text, values);
          if (!didLock && text.includes('FROM members') && text.includes('FOR UPDATE')) {
            didLock = true;
            locked.resolve();
            await release.promise;
          }
          return result;
        },
      }));
    },
  };
}

function lockedProjectTransactionDatabase() {
  const locked = deferred();
  const release = deferred();
  let didLock = false;
  return {
    query: database.query.bind(database),
    locked: locked.promise,
    release: release.resolve,
    async transaction(work) {
      return database.transaction(async (client) => work({
        ...client,
        async query(text, values = []) {
          const result = await client.query(text, values);
          if (!didLock && text.includes('FROM projects p') && text.includes('FOR UPDATE OF p')) {
            didLock = true;
            locked.resolve();
            await release.promise;
          }
          return result;
        },
      }));
    },
  };
}

async function seedEligibilityRace() {
  await resetAndMigrate();
  const { universityId, divisionId } = await seedUniversityAndDivision();
  const culture = await database.query(
    `INSERT INTO divisions (university_id, name, member_role_id)
     VALUES ($1, 'Culture', 'culture-role') RETURNING id`,
    [universityId],
  );
  const sapienza = await database.query(
    `INSERT INTO universities (name, discord_role_id)
     VALUES ('Sapienza', 'sapienza-role') RETURNING id`,
  );
  const sapienzaDivision = await database.query(
    `INSERT INTO divisions (university_id, name, member_role_id)
     VALUES ($1, 'Analysis', 'sapienza-analysis-role') RETURNING id`,
    [sapienza.rows[0].id],
  );
  const userId = '333333333333333333';
  const supervisorId = '444444444444444444';
  const headId = '555555555555555555';
  await database.query(
    `INSERT INTO members (discord_user_id, university_id, member_type, status)
     VALUES ($1, $2, 'researcher', 'active'),
            ($3, $2, 'alumni', 'active'),
            ($4, $2, 'researcher', 'active')`,
    [userId, universityId, supervisorId, headId],
  );
  await database.query(
    'INSERT INTO member_divisions (discord_user_id, division_id) VALUES ($1, $2)',
    [userId, divisionId],
  );
  await database.query(
    `INSERT INTO board_assignments (discord_user_id, university_id, division_id, role, active)
     VALUES ($1, $2, $3, 'head', true)`,
    [headId, universityId, divisionId],
  );
  const project = await database.query(
    `INSERT INTO projects (name, university_id, division_id, start_date, expected_end, status)
     VALUES ('Existing Signals', $1, $2, '2026-07-01', '2026-08-01', 'active') RETURNING id`,
    [universityId, divisionId],
  );

  const guild = { id: 'guild' };
  guild.roles = {
    cache: roleCache([
      role('researcher-role', ROLE_NAMES.RESEARCHER),
      role('alumni-role', ROLE_NAMES.ALUMNI),
      role('bocconi-role', 'Bocconi'),
      role('analysis-role', 'Bocconi - Analysis'),
      role('culture-role', 'Bocconi - Culture'),
      role('sapienza-role', 'Sapienza'),
      role('sapienza-analysis-role', 'Sapienza - Analysis'),
      role('head-role', 'Bocconi - Head of Analysis'),
      role('global-president', ROLE_NAMES.GLOBAL_PRESIDENT),
    ]),
  };
  const target = managedMember(userId, guild, [
    role('researcher-role', ROLE_NAMES.RESEARCHER),
    role('bocconi-role', 'Bocconi'),
    role('analysis-role', 'Bocconi - Analysis'),
  ]);
  const supervisor = managedMember(supervisorId, guild, [
    role('alumni-role', ROLE_NAMES.ALUMNI),
    role('bocconi-role', 'Bocconi'),
  ]);
  target.kick = async () => {};
  const head = { id: 'head', roles: { cache: roleCache([role('head-role', 'Bocconi - Head of Analysis')]) } };
  const president = globalPresident('president');
  guild.members = {
    async fetch(id) {
      if (String(id) === target.id) return target;
      if (String(id) === supervisor.id) return supervisor;
      throw new Error(`Unknown mock member ${id}`);
    },
  };
  guild.channels = {
    cache: { has: () => false, find: () => null },
    async fetch() { return null; },
    async create(options) {
      return {
        id: `channel-${options.name}`,
        guild,
        name: options.name,
        parentId: null,
        permissionOverwrites: { async set() {} },
        async setName() {},
        async setParent() {},
      };
    },
  };
  return {
    userId,
    supervisorId,
    universityId,
    divisionId,
    cultureId: culture.rows[0].id,
    sapienzaId: sapienza.rows[0].id,
    sapienzaDivisionId: sapienzaDivision.rows[0].id,
    projectId: project.rows[0].id,
    guild,
    target,
    head,
    president,
  };
}

function projectAddInput(fixture) {
  return {
    interaction: { guild: fixture.guild, user: { id: fixture.head.id }, member: fixture.head },
    project: String(fixture.projectId),
    user: { id: fixture.userId },
    role: 'member',
  };
}

async function seedProjectParticipantCapacity(participantCount) {
  await resetAndMigrate();
  const { universityId, divisionId } = await seedUniversityAndDivision();
  const participantIds = Array.from(
    { length: participantCount },
    (_, index) => String(100000000000000 + index),
  );
  const additionalIds = ['999999999999990', '999999999999991', '999999999999992'];
  const allIds = [...participantIds, ...additionalIds];
  await database.query(
    `INSERT INTO members (discord_user_id, university_id, member_type, status)
     SELECT user_ids.discord_user_id, $2, 'researcher', 'active'
     FROM unnest($1::text[]) AS user_ids(discord_user_id)`,
    [allIds, universityId],
  );
  await database.query(
    `INSERT INTO member_divisions (discord_user_id, division_id)
     SELECT user_ids.discord_user_id, $2
     FROM unnest($1::text[]) AS user_ids(discord_user_id)`,
    [allIds, divisionId],
  );
  const project = await database.query(
    `INSERT INTO projects (name, university_id, division_id, start_date, expected_end, status)
     VALUES ('Capacity Signals', $1, $2, '2026-07-01', '2026-08-01', 'active')
     RETURNING id`,
    [universityId, divisionId],
  );
  await database.query(
    `INSERT INTO project_people (project_id, discord_user_id, role)
     SELECT $1, user_ids.discord_user_id, 'member'
     FROM unnest($2::text[]) AS user_ids(discord_user_id)`,
    [project.rows[0].id, participantIds],
  );

  const channels = new Map();
  let channelCreates = 0;
  const guild = { id: 'guild' };
  const headRole = role('head-role', 'Bocconi - Head of Analysis');
  guild.roles = { cache: roleCache([headRole]) };
  guild.members = {
    async fetch(id) {
      if (allIds.includes(String(id))) return { id: String(id) };
      throw new Error(`Unknown mock member ${id}`);
    },
  };
  guild.channels = {
    cache: { has: () => false, find: () => null },
    async fetch(id) {
      return id == null ? channels : channels.get(String(id)) ?? null;
    },
    async create(options) {
      channelCreates += 1;
      const channel = {
        id: `capacity-channel-${channelCreates}`,
        guild,
        name: options.name,
        parentId: null,
        permissionOverwrites: { async set() {} },
        async setName() {},
        async setParent() {},
        async send() {},
      };
      channels.set(channel.id, channel);
      return channel;
    },
  };
  const head = { id: 'head', roles: { cache: roleCache([headRole]) } };
  return {
    additionalIds,
    guild,
    head,
    participantIds,
    projectId: project.rows[0].id,
    channelCreates: () => channelCreates,
  };
}

function projectCapacityAddInput(fixture, userId, role = 'member') {
  return {
    interaction: { guild: fixture.guild, user: { id: fixture.head.id }, member: fixture.head },
    project: String(fixture.projectId),
    user: { id: userId },
    role,
  };
}

async function assertProjectWriteWinsMembershipRace(fixture, membershipWrite) {
  const blockingDb = lockedTransactionDatabase();
  const membershipPreflight = deferred();
  const membershipDb = {
    query: async (text, values) => {
      const result = await database.query(text, values);
      if (text.includes('FROM project_people pp')) membershipPreflight.resolve();
      return result;
    },
    transaction: database.transaction.bind(database),
  };
  const projectWrite = addProjectMember(projectAddInput(fixture), { db: blockingDb });
  await blockingDb.locked;
  const governanceWrite = membershipWrite(membershipDb);
  await membershipPreflight.promise;
  const governanceRejected = assert.rejects(governanceWrite, /ineligible for active projects/i);
  blockingDb.release();
  await projectWrite;
  await governanceRejected;
  const joined = await database.query(
    'SELECT role FROM project_people WHERE project_id = $1 AND discord_user_id = $2',
    [fixture.projectId, fixture.userId],
  );
  assert.equal(joined.rowCount, 1);
}

async function assertMembershipWriteWinsProjectRace(fixture, membershipWrite, projectWrite) {
  const blockingDb = lockedTransactionDatabase();
  const projectPreflight = deferred();
  const projectDb = {
    query: async (text, values) => {
      const result = await database.query(text, values);
      if (text.includes('FROM members')) projectPreflight.resolve();
      return result;
    },
    transaction: database.transaction.bind(database),
  };
  const governanceWrite = membershipWrite(blockingDb);
  await blockingDb.locked;
  const projectWritePromise = projectWrite(projectDb);
  await projectPreflight.promise;
  const projectRejected = assert.rejects(
    projectWritePromise,
    /(not (active researchers|accepted active members)|neither active researchers)/i,
  );
  blockingDb.release();
  await governanceWrite;
  await projectRejected;
  assert.equal(
    (await database.query(
      'SELECT count(*)::int AS count FROM project_people WHERE project_id = $1 AND discord_user_id = $2',
      [fixture.projectId, fixture.userId],
    )).rows[0].count,
    0,
  );
}

test('project eligibility boundary serializes real PostgreSQL add/create races with membership changes', async () => {
  for (const change of ['type', 'university', 'division']) {
    const fixture = await seedEligibilityRace();
    await assertProjectWriteWinsMembershipRace(fixture, (db) => updateMember(
      { guild: fixture.guild, user: { id: fixture.president.id }, member: fixture.president },
      {
        user: { id: fixture.userId },
        ...(change === 'type' ? { memberType: 'alumni' } : {}),
        ...(change === 'university' ? { university: 'Sapienza', divisionsText: 'Analysis' } : {}),
        ...(change === 'division' ? { divisionsText: 'Culture' } : {}),
      },
      { db },
    ));
  }

  const removal = await seedEligibilityRace();
  const blockingDb = lockedTransactionDatabase();
  const projectWrite = addProjectMember(projectAddInput(removal), { db: blockingDb });
  await blockingDb.locked;
  const removalWrite = removeMember(
    { guild: removal.guild, user: { id: removal.president.id }, member: removal.president },
    { user: { id: removal.userId }, reason: 'race test' },
    { db: database },
  );
  blockingDb.release();
  await projectWrite;
  await removalWrite;
  assert.equal(
    (await database.query('SELECT status FROM members WHERE discord_user_id = $1', [removal.userId])).rows[0].status,
    'removed',
  );
  assert.equal(
    (await database.query('SELECT count(*)::int AS count FROM project_people WHERE discord_user_id = $1', [removal.userId]))
      .rows[0].count,
    0,
  );

  const createRace = await seedEligibilityRace();
  const blockingDbForCreate = lockedTransactionDatabase();
  const creating = createProject({
    interaction: { guild: createRace.guild, user: { id: createRace.head.id }, member: createRace.head },
    name: 'Created Signals',
    university: 'Bocconi',
    division: 'Analysis',
    startDate: '2026-07-01',
    expectedEnd: '2026-08-01',
    summary: 'Public created-signals summary',
    members: createRace.userId,
    supervisors: createRace.supervisorId,
  }, { db: blockingDbForCreate });
  await blockingDbForCreate.locked;
  const change = updateMember(
    { guild: createRace.guild, user: { id: createRace.president.id }, member: createRace.president },
    { user: { id: createRace.userId }, divisionsText: 'Culture' },
    { db: database },
  );
  const changeRejected = assert.rejects(change, /ineligible for active projects/i);
  blockingDbForCreate.release();
  await creating;
  await changeRejected;
});

test('membership-first transactions make concurrent project writes fail their locked revalidation', async () => {
  for (const change of ['type', 'university', 'division']) {
    const fixture = await seedEligibilityRace();
    await assertMembershipWriteWinsProjectRace(
      fixture,
      (db) => updateMember(
        { guild: fixture.guild, user: { id: fixture.president.id }, member: fixture.president },
        {
          user: { id: fixture.userId },
          ...(change === 'type' ? { memberType: 'alumni' } : {}),
          ...(change === 'university' ? { university: 'Sapienza', divisionsText: 'Analysis' } : {}),
          ...(change === 'division' ? { divisionsText: 'Culture' } : {}),
        },
        { db },
      ),
      (db) => addProjectMember(projectAddInput(fixture), { db }),
    );
  }

  const removal = await seedEligibilityRace();
  await assertMembershipWriteWinsProjectRace(
    removal,
    (db) => removeMember(
      { guild: removal.guild, user: { id: removal.president.id }, member: removal.president },
      { user: { id: removal.userId }, reason: 'race test' },
      { db },
    ),
    (db) => addProjectMember(projectAddInput(removal), { db }),
  );
  assert.equal(
    (await database.query('SELECT status FROM members WHERE discord_user_id = $1', [removal.userId])).rows[0].status,
    'removed',
  );

  const createRace = await seedEligibilityRace();
  await assertMembershipWriteWinsProjectRace(
    createRace,
    (db) => updateMember(
      { guild: createRace.guild, user: { id: createRace.president.id }, member: createRace.president },
      { user: { id: createRace.userId }, memberType: 'alumni' },
      { db },
    ),
    (db) => createProject({
      interaction: { guild: createRace.guild, user: { id: createRace.head.id }, member: createRace.head },
      name: 'Membership First Signals',
      university: 'Bocconi',
      division: 'Analysis',
      startDate: '2026-07-01',
      expectedEnd: '2026-08-01',
      summary: 'Public membership-first summary',
      members: createRace.userId,
      supervisors: createRace.supervisorId,
    }, { db }),
  );
  assert.equal((await database.query("SELECT count(*)::int AS count FROM projects WHERE name = 'Membership First Signals'"))
    .rows[0].count, 0);
});

test('project add-member enforces the participant cap while allowing role updates at capacity', async () => {
  const fixture = await seedProjectParticipantCapacity(MAX_PROJECT_PARTICIPANTS);
  const newUserId = fixture.additionalIds[0];

  await assert.rejects(
    () => addProjectMember(projectCapacityAddInput(fixture, newUserId), { db: database }),
    new RegExp(`at most ${MAX_PROJECT_PARTICIPANTS} unique participants`, 'i'),
  );
  assert.equal(
    (await database.query('SELECT count(*)::int AS count FROM project_people WHERE project_id = $1', [fixture.projectId]))
      .rows[0].count,
    MAX_PROJECT_PARTICIPANTS,
  );
  assert.equal(
    (await database.query(
      'SELECT count(*)::int AS count FROM project_people WHERE project_id = $1 AND discord_user_id = $2',
      [fixture.projectId, newUserId],
    )).rows[0].count,
    0,
  );
  assert.equal(
    (await database.query('SELECT count(*)::int AS count FROM project_reconciliation WHERE project_id = $1', [fixture.projectId]))
      .rows[0].count,
    0,
  );
  assert.equal(fixture.channelCreates(), 0);

  const existingUserId = fixture.participantIds[0];
  await addProjectMember(projectCapacityAddInput(fixture, existingUserId, 'supervisor'), { db: database });
  assert.equal(
    (await database.query('SELECT role FROM project_people WHERE project_id = $1 AND discord_user_id = $2', [
      fixture.projectId,
      existingUserId,
    ])).rows[0].role,
    'supervisor',
  );
  assert.equal(
    (await database.query('SELECT count(*)::int AS count FROM project_people WHERE project_id = $1', [fixture.projectId]))
      .rows[0].count,
    MAX_PROJECT_PARTICIPANTS,
  );
  assert.equal(fixture.channelCreates(), 1);
});

test('concurrent project add-member requests serialize at the participant cap', async () => {
  const fixture = await seedProjectParticipantCapacity(MAX_PROJECT_PARTICIPANTS - 1);
  const results = await Promise.allSettled([
    addProjectMember(projectCapacityAddInput(fixture, fixture.additionalIds[0]), { db: database }),
    addProjectMember(projectCapacityAddInput(fixture, fixture.additionalIds[1]), { db: database }),
  ]);

  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  const rejected = results.find((result) => result.status === 'rejected');
  assert.match(rejected.reason.message, new RegExp(`at most ${MAX_PROJECT_PARTICIPANTS} unique participants`, 'i'));
  assert.equal(
    (await database.query('SELECT count(*)::int AS count FROM project_people WHERE project_id = $1', [fixture.projectId]))
      .rows[0].count,
    MAX_PROJECT_PARTICIPANTS,
  );
});

test('project lifecycle mutations revalidate the locked project and preserve concurrent field updates', async () => {
  const closing = await seedEligibilityRace();
  const closeDb = lockedProjectTransactionDatabase();
  const close = closeProject({
    interaction: { guild: closing.guild, user: { id: closing.head.id }, member: closing.head },
    project: String(closing.projectId),
    outcome: 'Delivered',
    finalNotes: 'Ready for handover',
  }, { db: closeDb as never });
  await closeDb.locked;

  const add = addProjectMember(projectAddInput(closing), { db: database as never });
  const addRejected = assert.rejects(add, /Completed or archived projects cannot be changed/);
  closeDb.release();
  await close;
  await addRejected;
  assert.equal(
    ((await database.query('SELECT status FROM projects WHERE id = $1', [closing.projectId])) as unknown as {
      rows: Array<{ status: string }>;
    }).rows[0].status,
    'completed',
  );
  assert.equal(
    (await database.query(
      'SELECT count(*)::int AS count FROM project_people WHERE project_id = $1 AND discord_user_id = $2',
      [closing.projectId, closing.userId],
    ) as unknown as { rows: Array<{ count: number }> }).rows[0].count,
    0,
  );

  const updating = await seedEligibilityRace();
  const firstUpdateDb = lockedProjectTransactionDatabase();
  const firstUpdate = updateProject({
    interaction: { guild: updating.guild, user: { id: updating.head.id }, member: updating.head },
    project: String(updating.projectId),
    notes: 'First update notes',
  }, { db: firstUpdateDb as never });
  await firstUpdateDb.locked;
  const secondUpdate = updateProject({
    interaction: { guild: updating.guild, user: { id: updating.head.id }, member: updating.head },
    project: String(updating.projectId),
    expectedEnd: '2026-09-01',
  }, { db: database as never });
  firstUpdateDb.release();
  await Promise.all([firstUpdate, secondUpdate]);
  assert.deepEqual(
    ((await database.query(
      'SELECT notes, expected_end::text AS expected_end FROM projects WHERE id = $1',
      [updating.projectId],
    )) as unknown as { rows: Array<{ notes: string | null; expected_end: string }> }).rows[0],
    { notes: 'First update notes', expected_end: '2026-09-01' },
  );
});

test('reversed multi-person project lock inputs serialize without a PostgreSQL deadlock', async () => {
  const fixture = await seedEligibilityRace();
  const firstLocked = deferred();
  const releaseFirst = deferred();
  const secondAttempted = deferred();
  let firstLockSeen = false;
  let secondLockSeen = false;

  const first = database.transaction(async (client) => lockMemberEligibilityRows({
    ...client,
    async query(text, values = []) {
      const result = await client.query(text, values);
      if (!firstLockSeen && text.includes('FOR UPDATE')) {
        firstLockSeen = true;
        firstLocked.resolve();
        await releaseFirst.promise;
      }
      return result;
    },
  }, [fixture.supervisorId, fixture.userId]));
  await firstLocked.promise;

  const second = database.transaction(async (client) => lockMemberEligibilityRows({
    ...client,
    async query(text, values = []) {
      if (!secondLockSeen && text.includes('FOR UPDATE')) {
        secondLockSeen = true;
        secondAttempted.resolve();
      }
      return client.query(text, values);
    },
  }, [fixture.userId, fixture.supervisorId]));
  await secondAttempted.promise;
  releaseFirst.resolve();

  let timeout;
  try {
    await Promise.race([
      Promise.all([first, second]),
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error('reversed participant locks did not finish')), 3_000);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
});
