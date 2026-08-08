import { logger } from '../logger.js';
import { formatProfilePost } from './formatters.js';
import {
  deleteProfileForumPosts,
  refreshProfileForumThread,
  unarchiveDirectoryGuideThread,
  upsertProfileForumPost,
} from './gateway.js';
import {
  clearProfileForumIdentity,
  listProfileReconciliationCandidates,
  listProfilesDueForRefresh,
  loadDirectoryGuideThreadId,
  loadProfileForReconciliation,
  markProfileReconciliationFailure,
  markProfileRefreshed,
  persistProfileForumIdentity,
  requestProfileReconciliation,
} from './repository.js';

const REPAIR_LIMIT = 10;

function safeErrorMessage(error) {
  const code = Number(error?.code ?? error?.status);
  if (Number.isFinite(code)) return `Discord API error ${code}.`;
  const message = error instanceof Error ? error.message : '';
  // The gateway's deterministic configuration errors contain no member data;
  // arbitrary Discord/server messages may, so never copy those into logs or
  // reconciliation metadata.
  if (message === 'The people-directory forum is unavailable.') return message;
  if (message.startsWith('People-directory forum is missing the managed tag ')) return message;
  return 'Discord operation failed.';
}

function isPublishableMember(profile) {
  return profile?.visibility === 'published'
    && profile.member_status === 'active'
    && profile.university_active !== false;
}

async function claimProfileReconciliation(client, discordUserId, allowStaleProcessing) {
  const claim = await client.query(
    `SELECT desired_generation
       FROM member_profile_reconciliation
      WHERE discord_user_id = $1
        AND (status IN ('pending', 'failed')
          OR ($2::boolean AND status = 'processing' AND started_at < now() - interval '5 minutes'))
      FOR UPDATE SKIP LOCKED`,
    [String(discordUserId), allowStaleProcessing],
  );
  if (claim.rowCount !== 1) return null;
  const generation = claim.rows[0].desired_generation;
  await client.query(
    `UPDATE member_profile_reconciliation
        SET status = 'processing', attempts = attempts + 1, started_at = now(), last_error = NULL
      WHERE discord_user_id = $1 AND desired_generation = $2`,
    [String(discordUserId), generation],
  );
  return generation;
}

async function completeProfileReconciliation(client, discordUserId, generation) {
  const completed = await client.query(
    `UPDATE member_profile_reconciliation
        SET status = 'succeeded', succeeded_at = now(), last_error = NULL
      WHERE discord_user_id = $1 AND desired_generation = $2
      RETURNING desired_generation`,
    [String(discordUserId), generation],
  );
  return completed.rowCount === 1;
}

/** Reconciles exactly one durable profile generation. */
export async function reconcileProfile({ discordUserId, guild, db, allowStaleProcessing = false }) {
  if (!guild) return { status: 'failed', discordUserId: String(discordUserId), error: new Error('Guild is unavailable for reconciliation.') };
  return db.transaction(async (client) => {
    const ownerId = String(discordUserId);
    const generation = await claimProfileReconciliation(client, ownerId, allowStaleProcessing);
    if (generation == null) return { status: 'skipped', discordUserId: ownerId };
    try {
      const profile = await loadProfileForReconciliation(client, ownerId);
      if (!profile || !isPublishableMember(profile)) {
        await deleteProfileForumPosts({
          guild,
          ownerId,
          forumThreadId: profile?.forum_thread_id ?? null,
        });
        if (profile) await clearProfileForumIdentity(client, { discordUserId: ownerId, generation });
      } else {
        const post = formatProfilePost({
          ...profile,
          member: {
            discord_user_id: ownerId,
            full_name: profile.full_name,
            member_type: profile.member_type,
            university_name: profile.university_name,
            division_name: profile.division_name,
          },
          updated_at: profile.updated_at,
        });
        const identity = await upsertProfileForumPost({
          guild,
          ownerId,
          post,
          forumThreadId: profile.forum_thread_id,
          forumMessageId: profile.forum_message_id,
        });
        const persisted = await persistProfileForumIdentity(client, {
          discordUserId: ownerId,
          generation,
          ...identity,
        });
        if (!persisted) return { status: 'superseded', discordUserId: ownerId, generation };
      }
      if (!await completeProfileReconciliation(client, ownerId, generation)) {
        return { status: 'superseded', discordUserId: ownerId, generation };
      }
      logger.info('Profile reconciliation succeeded', { discordUserId: ownerId, generation: String(generation) });
      return { status: 'succeeded', discordUserId: ownerId, generation };
    } catch (error) {
      await markProfileReconciliationFailure(client, { discordUserId: ownerId, generation, error: safeErrorMessage(error) });
      logger.warn('Profile reconciliation failed', {
        discordUserId: ownerId,
        generation: String(generation),
        error: safeErrorMessage(error),
      });
      return { status: 'failed', discordUserId: ownerId, generation, error };
    }
  });
}

export async function retryProfileReconciliations({ guild, db, limit = REPAIR_LIMIT }) {
  const candidates = await listProfileReconciliationCandidates(db, limit);
  const results = [];
  for (const discordUserId of candidates) {
    results.push(await reconcileProfile({ discordUserId, guild, db, allowStaleProcessing: true }));
  }
  return results;
}

/**
 * Reopens old forum threads at a bounded rate. It deliberately performs no
 * message writes, so Discord does not show maintenance chatter to members.
 */
export async function refreshProfileDirectory({ guild, db, limit = REPAIR_LIMIT }) {
  const refreshed = [];
  const profiles = await listProfilesDueForRefresh(db, limit);
  for (const profile of profiles) {
    try {
      const result = await refreshProfileForumThread({ guild, forumThreadId: profile.forum_thread_id });
      if (result.missing) await requestProfileReconciliation(db, profile.discord_user_id);
      else await markProfileRefreshed(db, profile.discord_user_id);
      refreshed.push({ discordUserId: String(profile.discord_user_id), ...result });
    } catch (error) {
      logger.warn('Profile directory refresh failed', {
        discordUserId: String(profile.discord_user_id),
        error: safeErrorMessage(error),
      });
      refreshed.push({ discordUserId: String(profile.discord_user_id), refreshed: false, error });
    }
  }
  try {
    const guideThreadId = await loadDirectoryGuideThreadId(db, guild?.id);
    if (guideThreadId) await unarchiveDirectoryGuideThread({ guild, guideThreadId });
  } catch (error) {
    logger.warn('People-directory guide refresh failed', { error: safeErrorMessage(error) });
  }
  return refreshed;
}

export function createProfileReconciliationWorker({ guild, db, intervalMs = 60_000, limit = REPAIR_LIMIT }) {
  let running = false;
  let stopped = false;
  let activeRun = null;
  const run = async () => {
    if (running || stopped) return [];
    running = true;
    try {
      const results = await retryProfileReconciliations({ guild, db, limit });
      await refreshProfileDirectory({ guild, db, limit });
      return results;
    } catch (error) {
      logger.error('Profile reconciliation worker failed', { error: safeErrorMessage(error) });
      return [];
    } finally {
      running = false;
    }
  };
  const scheduleRun = () => {
    if (running) return activeRun ?? Promise.resolve([]);
    activeRun = run().finally(() => { activeRun = null; });
    return activeRun;
  };
  const timer = setInterval(() => void scheduleRun(), intervalMs);
  timer.unref?.();
  void scheduleRun();
  return {
    run: scheduleRun,
    async stop() {
      stopped = true;
      clearInterval(timer);
      await activeRun;
    },
  };
}

export { REPAIR_LIMIT as PROFILE_REPAIR_LIMIT };
