import type { BotMessagePayload } from '../messages/types.js';

export type TransitionNotificationStatus =
  | 'pending'
  | 'sending'
  | 'delivered'
  | 'failed'
  | 'uncertain';

export interface TransitionNotificationInput {
  auditId: unknown;
  recipientId: string;
  kind: string;
  universityId?: unknown;
  relatedEntityType: string;
  relatedEntityId?: unknown;
  payload: BotMessagePayload;
  metadata?: Record<string, unknown>;
  ready?: boolean;
}

export async function enqueueTransitionNotification(db, input: TransitionNotificationInput) {
  if (input.auditId == null) return null;
  const result = await db.query(
    `INSERT INTO transition_notifications (
       audit_id, recipient_discord_user_id, kind, university_id,
       related_entity_type, related_entity_id, payload, metadata, ready
     ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9)
     ON CONFLICT (audit_id, recipient_discord_user_id, kind)
     DO UPDATE SET
       payload = EXCLUDED.payload,
       metadata = EXCLUDED.metadata,
       ready = transition_notifications.ready OR EXCLUDED.ready,
       updated_at = now()
     RETURNING id`,
    [
      input.auditId,
      String(input.recipientId),
      input.kind,
      input.universityId ?? null,
      input.relatedEntityType,
      input.relatedEntityId == null ? null : String(input.relatedEntityId),
      JSON.stringify(input.payload),
      JSON.stringify(input.metadata ?? {}),
      input.ready ?? true,
    ],
  );
  return result.rows[0]?.id ?? null;
}

export async function claimTransitionNotification(db, notificationId) {
  const result = await db.query(
    `UPDATE transition_notifications
        SET status = 'sending',
            attempt_count = attempt_count + 1,
            claimed_at = now(),
            updated_at = now()
      WHERE id = $1
        AND ready = true
        AND retryable = true
        AND next_attempt_at <= now()
        AND status IN ('pending', 'failed')
      RETURNING id, recipient_discord_user_id, kind, payload, attempt_count`,
    [notificationId],
  );
  return result.rows[0] ?? null;
}

export async function getTransitionNotificationStatus(db, notificationId) {
  const result = await db.query(
    'SELECT status, retryable, last_error_code FROM transition_notifications WHERE id = $1',
    [notificationId],
  );
  return result.rows[0] ?? null;
}

export async function markTransitionNotificationDelivered(db, notificationId) {
  await db.query(
    `UPDATE transition_notifications
        SET status = 'delivered', retryable = false, delivered_at = now(),
            last_error_code = NULL, last_error_at = NULL, updated_at = now()
      WHERE id = $1 AND status = 'sending'`,
    [notificationId],
  );
}

export async function markTransitionNotificationFailed(
  db,
  notificationId,
  { errorCode, retryable, attemptCount },
) {
  const retryDelaySeconds = Math.min(900, 30 * (2 ** Math.max(0, Number(attemptCount ?? 1) - 1)));
  await db.query(
    `UPDATE transition_notifications
        SET status = 'failed',
            retryable = $2,
            next_attempt_at = CASE WHEN $2 THEN now() + ($3 * interval '1 second') ELSE next_attempt_at END,
            last_error_code = $4,
            last_error_at = now(),
            updated_at = now()
      WHERE id = $1 AND status = 'sending'`,
    [notificationId, retryable, retryDelaySeconds, errorCode],
  );
}

export async function markStaleTransitionNotificationsUncertain(db, staleMinutes = 5) {
  const result = await db.query(
    `UPDATE transition_notifications
        SET status = 'uncertain', retryable = false, updated_at = now()
      WHERE status = 'sending'
        AND claimed_at < now() - ($1 * interval '1 minute')
      RETURNING id`,
    [Math.max(1, Number(staleMinutes) || 5)],
  );
  return result.rows.map((row) => row.id);
}

export async function listTransitionNotificationCandidates(db, limit = 50) {
  const result = await db.query(
    `SELECT id
       FROM transition_notifications
      WHERE ready = true
        AND retryable = true
        AND next_attempt_at <= now()
        AND status IN ('pending', 'failed')
      ORDER BY next_attempt_at, id
      LIMIT $1`,
    [Math.min(100, Math.max(1, Number(limit) || 50))],
  );
  return result.rows.map((row) => row.id);
}

export async function listTargetTransitionNotifications(db, relatedEntityType, relatedEntityId) {
  const result = await db.query(
    `SELECT id, kind, recipient_discord_user_id, metadata
       FROM transition_notifications
      WHERE related_entity_type = $1
        AND related_entity_id = $2
        AND status IN ('pending', 'failed')
      ORDER BY id`,
    [relatedEntityType, String(relatedEntityId)],
  );
  return result.rows;
}

export async function listReconciledProjectsWithUnreadyNotifications(db, limit = 25) {
  const result = await db.query(
    `SELECT DISTINCT tn.related_entity_id AS project_id
       FROM transition_notifications tn
       JOIN project_reconciliation pr ON pr.project_id::text = tn.related_entity_id
      WHERE tn.related_entity_type = 'project'
        AND tn.ready = false
        AND tn.status IN ('pending', 'failed')
        AND pr.status = 'succeeded'
      ORDER BY tn.related_entity_id
      LIMIT $1`,
    [Math.min(50, Math.max(1, Number(limit) || 25))],
  );
  return result.rows.map((row) => row.project_id);
}

export async function prepareTransitionNotification(db, notificationId, payload: BotMessagePayload) {
  await db.query(
    `UPDATE transition_notifications
        SET payload = $2::jsonb, ready = true, updated_at = now()
      WHERE id = $1 AND status IN ('pending', 'failed')`,
    [notificationId, JSON.stringify(payload)],
  );
}

export async function transitionNotificationHealth(db, universityId) {
  const result = await db.query(
    `SELECT status, count(*)::integer AS count
       FROM transition_notifications
      WHERE university_id = $1
        AND status IN ('pending', 'failed', 'uncertain')
      GROUP BY status`,
    [universityId],
  );
  const counts = { pending: 0, failed: 0, uncertain: 0 };
  for (const row of result.rows) {
    if (row.status in counts) counts[row.status] = Number(row.count);
  }
  return counts;
}
