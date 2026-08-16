import { logger } from '../logger.js';
import {
  claimTransitionNotification,
  getTransitionNotificationStatus,
  listTransitionNotificationCandidates,
  markStaleTransitionNotificationsUncertain,
  markTransitionNotificationDelivered,
  markTransitionNotificationFailed,
} from './repository.js';

const PERMANENT_DISCORD_ERROR_CODES = new Set(['10007', '50007', '50013']);
const DELIVERY_CONCURRENCY = 5;

function deliveryErrorCode(error) {
  const code = error?.code ?? error?.rawError?.code;
  return code == null ? 'unknown' : String(code);
}

function isRetryableDeliveryError(error) {
  return !PERMANENT_DISCORD_ERROR_CODES.has(deliveryErrorCode(error));
}

async function resolveNotificationRecipient(guild, recipientId) {
  try {
    return await guild.members.fetch(String(recipientId));
  } catch (error) {
    // A full member removal closes the guild-member route before a later
    // explicit retry. Discord User DMs remain valid, so use the client cache/
    // fetch path without restoring or assuming guild membership.
    if (deliveryErrorCode(error) === '10007' && guild.client?.users?.fetch) {
      return guild.client.users.fetch(String(recipientId));
    }
    throw error;
  }
}

export async function deliverTransitionNotification({ db, guild, notificationId, recipient = null }) {
  if (notificationId == null) return null;
  let claimed;
  try {
    claimed = await claimTransitionNotification(db, notificationId);
  } catch (error) {
    logger.warn('Transition notification remains queued because its delivery claim failed', {
      notificationId: String(notificationId),
      error: error instanceof Error ? error.message : String(error),
    });
    return { id: notificationId, status: 'pending' as const, retryable: true };
  }
  if (!claimed) {
    const existing = await getTransitionNotificationStatus(db, notificationId).catch(() => null);
    return {
      id: notificationId,
      status: existing?.status ?? 'missing',
      retryable: existing?.retryable ?? false,
      errorCode: existing?.last_error_code ?? null,
    };
  }

  let target;
  try {
    target = recipient ?? await resolveNotificationRecipient(guild, claimed.recipient_discord_user_id);
    await target.send(claimed.payload);
  } catch (error) {
    const retryable = isRetryableDeliveryError(error) && Number(claimed.attempt_count) < 5;
    const errorCode = deliveryErrorCode(error);
    try {
      await markTransitionNotificationFailed(db, claimed.id, {
        errorCode,
        retryable,
        attemptCount: claimed.attempt_count,
      });
    } catch (recordingError) {
      // The send failed but its durable row is still `sending`. The worker
      // will move it to `uncertain`, never replay it blindly.
      logger.error('Transition notification failure outcome could not be recorded', {
        notificationId: String(claimed.id),
        error: recordingError instanceof Error ? recordingError.message : String(recordingError),
      });
      return { id: claimed.id, status: 'uncertain' as const, retryable: false, errorCode };
    }
    logger.warn('Transition notification could not be delivered', {
      notificationId: String(claimed.id),
      kind: claimed.kind,
      recipientId: String(claimed.recipient_discord_user_id),
      errorCode,
      retryable,
    });
    return { id: claimed.id, status: 'failed' as const, retryable, errorCode };
  }

  try {
    await markTransitionNotificationDelivered(db, claimed.id);
    return { id: claimed.id, status: 'delivered' as const };
  } catch (error) {
    // Discord accepted the message, so retrying could duplicate a human
    // handoff. Leave the row claimed; stale-claim recovery will mark it
    // uncertain and expose it in board health.
    logger.error('Transition notification was sent but delivery confirmation could not be recorded', {
      notificationId: String(claimed.id),
      error: error instanceof Error ? error.message : String(error),
    });
    return { id: claimed.id, status: 'uncertain' as const, retryable: false };
  }
}

export async function deliverTransitionNotifications({ db, guild, notificationIds, recipients = new Map() }) {
  const ids = notificationIds.filter((id) => id != null);
  const results = new Array(ids.length);
  let nextIndex = 0;
  const workerCount = Math.min(DELIVERY_CONCURRENCY, ids.length);
  async function worker() {
    while (nextIndex < ids.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await deliverTransitionNotification({
        db,
        guild,
        notificationId: ids[index],
        recipient: recipients.get(String(ids[index])) ?? null,
      });
    }
  }
  await Promise.all(Array.from({ length: workerCount }, worker));
  return results;
}

export async function retryTransitionNotifications({ guild, db, limit = 50 }) {
  const uncertainIds = await markStaleTransitionNotificationsUncertain(db);
  if (uncertainIds.length) {
    logger.warn('Transition notifications need manual delivery review', {
      notificationIds: uncertainIds.map(String),
      reason: 'delivery outcome was not recorded after a send was claimed',
    });
  }
  const candidates = await listTransitionNotificationCandidates(db, limit);
  return deliverTransitionNotifications({ db, guild, notificationIds: candidates });
}

export function createTransitionNotificationWorker({ guild, db, intervalMs = 60_000, limit = 50 }) {
  let running = false;
  let stopped = false;
  let activeRun = null;
  const run = async () => {
    if (running || stopped) return [];
    running = true;
    try {
      return await retryTransitionNotifications({ guild, db, limit });
    } catch (error) {
      logger.error('Transition notification worker failed', {
        error: error instanceof Error ? error.message : String(error),
      });
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
