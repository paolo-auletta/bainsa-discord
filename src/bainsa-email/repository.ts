import { BAINSA_EMAIL_STATUSES } from './state.js';

export async function getBainsaEmailRequest(db, discordUserId) {
  const { rows } = await db.query(
    `SELECT r.*, u.name AS university_name
     FROM bainsa_email_requests r
     LEFT JOIN universities u ON u.id = r.university_id
     WHERE r.discord_user_id = $1
     LIMIT 1`,
    [String(discordUserId)],
  );
  return rows[0] ?? null;
}

/** The active member's university decides which board handles their request. */
export async function getActiveMembership(db, discordUserId) {
  const { rows } = await db.query(
    `SELECT m.discord_user_id,
            m.university_id,
            u.name AS university_name,
            u.onboarding_review_channel_id
     FROM members m
     JOIN universities u ON u.id = m.university_id
     WHERE m.discord_user_id = $1
       AND m.status = 'active'
     LIMIT 1`,
    [String(discordUserId)],
  );
  return rows[0] ?? null;
}

/** Records "I already have one" unless an account request is already open or done. */
export async function recordExistingAccount(db, discordUserId) {
  const { rows } = await db.query(
    `INSERT INTO bainsa_email_requests (discord_user_id, status)
     VALUES ($1, $2)
     ON CONFLICT (discord_user_id) DO UPDATE
       SET status = EXCLUDED.status,
           updated_at = now()
       WHERE bainsa_email_requests.status = $2
     RETURNING *`,
    [String(discordUserId), BAINSA_EMAIL_STATUSES.HAS_ACCOUNT],
  );
  return rows[0] ?? null;
}

/**
 * Opens an account request. Returns null when the member already has an open
 * or completed request, so concurrent submissions cannot post two cards.
 */
export async function openBainsaEmailRequest(db, { discordUserId, universityId, firstName, lastName, contactEmail }) {
  const { rows } = await db.query(
    `INSERT INTO bainsa_email_requests
       (discord_user_id, status, first_name, last_name, contact_email, university_id)
     VALUES ($1, $2, $3, $4, $5, $7)
     ON CONFLICT (discord_user_id) DO UPDATE
       SET status = EXCLUDED.status,
           university_id = EXCLUDED.university_id,
           first_name = EXCLUDED.first_name,
           last_name = EXCLUDED.last_name,
           contact_email = EXCLUDED.contact_email,
           review_message_id = NULL,
           handled_by = NULL,
           handled_at = NULL,
           created_at = now(),
           updated_at = now()
       WHERE bainsa_email_requests.status = $6
     RETURNING *`,
    [
      String(discordUserId),
      BAINSA_EMAIL_STATUSES.REQUESTED,
      firstName,
      lastName,
      contactEmail,
      BAINSA_EMAIL_STATUSES.HAS_ACCOUNT,
      universityId,
    ],
  );
  return rows[0] ?? null;
}

export async function setBainsaEmailReviewMessage(db, discordUserId, messageId) {
  const { rows } = await db.query(
    `UPDATE bainsa_email_requests
        SET review_message_id = $2,
            updated_at = now()
      WHERE discord_user_id = $1
        AND status = $3
      RETURNING *`,
    [String(discordUserId), String(messageId), BAINSA_EMAIL_STATUSES.REQUESTED],
  );
  return rows[0] ?? null;
}

export async function markBainsaEmailCreated(db, discordUserId, handledBy) {
  const { rows } = await db.query(
    `UPDATE bainsa_email_requests
        SET status = $2,
            handled_by = $3,
            handled_at = now(),
            updated_at = now()
      WHERE discord_user_id = $1
        AND status = $4
      RETURNING *`,
    [
      String(discordUserId),
      BAINSA_EMAIL_STATUSES.CREATED,
      String(handledBy),
      BAINSA_EMAIL_STATUSES.REQUESTED,
    ],
  );
  return rows[0] ?? null;
}

/** Active members who have never answered the @bainsa.ai email question. */
export async function listUnansweredActiveMemberIds(db) {
  const { rows } = await db.query(
    `SELECT m.discord_user_id
     FROM members m
     LEFT JOIN bainsa_email_requests r ON r.discord_user_id = m.discord_user_id
     WHERE m.status = 'active'
       AND r.discord_user_id IS NULL
     ORDER BY m.joined_at, m.discord_user_id`,
  );
  return rows.map((row) => String(row.discord_user_id));
}
