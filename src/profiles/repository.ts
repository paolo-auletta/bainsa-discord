import { assertUser } from '../errors.js';
import { assertPublishableProfile, type ProfileInput } from './state.js';

const PROFILE_COLUMNS = `
  p.discord_user_id,
  p.headline,
  p.about,
  p."current_role",
  p.goals,
  p.selected_tags,
  p.current_organization,
  p.location,
  p.email,
  p.linkedin_url,
  p.research_profile_url,
  p.visibility,
  p.forum_thread_id,
  p.forum_message_id,
  p.published_at,
  p.forum_refreshed_at,
  p.created_at,
  p.updated_at`;

const CANONICAL_MEMBER_COLUMNS = `
  m.discord_user_id,
  coalesce(nullif(btrim(m.full_name), ''), 'BAINSA member') AS full_name,
  m.member_type,
  m.status AS member_status,
  coalesce(u.active, true) AS university_active,
  u.name AS university_name,
  d.name AS division_name`;

/**
 * Loads the membership facts that are authoritative for a directory post.
 * The lateral join makes a legacy duplicate division assignment deterministic
 * while ordinary researcher records continue to yield their active division.
 */
export async function loadCanonicalActiveMember(db, discordUserId) {
  const result = await db.query(
    `SELECT ${CANONICAL_MEMBER_COLUMNS}
       FROM members m
       JOIN universities u ON u.id = m.university_id
       LEFT JOIN LATERAL (
         SELECT d.name
           FROM member_divisions md
           JOIN divisions d ON d.id = md.division_id
          WHERE md.discord_user_id = m.discord_user_id
            AND coalesce(d.active, true) = true
          ORDER BY d.name, d.id
          LIMIT 1
       ) d ON true
      WHERE m.discord_user_id = $1
        AND m.status = 'active'
        AND coalesce(u.active, true) = true
      LIMIT 1`,
    [String(discordUserId)],
  );
  return result.rows[0] ?? null;
}

export async function loadActiveMemberProfile(db, discordUserId) {
  const result = await db.query(
    `SELECT ${CANONICAL_MEMBER_COLUMNS}, ${PROFILE_COLUMNS}
       FROM members m
       JOIN universities u ON u.id = m.university_id
       LEFT JOIN LATERAL (
         SELECT d.name
           FROM member_divisions md
           JOIN divisions d ON d.id = md.division_id
          WHERE md.discord_user_id = m.discord_user_id
            AND coalesce(d.active, true) = true
          ORDER BY d.name, d.id
          LIMIT 1
       ) d ON true
       LEFT JOIN member_profiles p ON p.discord_user_id = m.discord_user_id
      WHERE m.discord_user_id = $1
        AND m.status = 'active'
        AND coalesce(u.active, true) = true
      LIMIT 1`,
    [String(discordUserId)],
  );
  return result.rows[0] ?? null;
}

/** Checks publication state without loading the member's private profile fields. */
export async function hasPublishedProfile(db, discordUserId) {
  const result = await db.query(
    `SELECT 1
       FROM member_profiles
      WHERE discord_user_id = $1
        AND visibility = 'published'
      LIMIT 1`,
    [String(discordUserId)],
  );
  return result.rows.length > 0;
}

/** Loads a profile with canonical membership facts, including removed members. */
export async function loadProfileForReconciliation(db, discordUserId) {
  const result = await db.query(
    `SELECT ${PROFILE_COLUMNS}, ${CANONICAL_MEMBER_COLUMNS}
       FROM member_profiles p
       JOIN members m ON m.discord_user_id = p.discord_user_id
       JOIN universities u ON u.id = m.university_id
       LEFT JOIN LATERAL (
         SELECT d.name
           FROM member_divisions md
           JOIN divisions d ON d.id = md.division_id
          WHERE md.discord_user_id = m.discord_user_id
            AND coalesce(d.active, true) = true
          ORDER BY d.name, d.id
          LIMIT 1
       ) d ON true
      WHERE p.discord_user_id = $1
      LIMIT 1`,
    [String(discordUserId)],
  );
  return result.rows[0] ?? null;
}

export async function requestProfileReconciliation(client, discordUserId) {
  const result = await client.query(
    `INSERT INTO member_profile_reconciliation (discord_user_id, desired_generation, status, requested_at, last_error)
     VALUES ($1, 1, 'pending', now(), NULL)
     ON CONFLICT (discord_user_id) DO UPDATE
       SET desired_generation = member_profile_reconciliation.desired_generation + 1,
           status = 'pending', requested_at = now(), last_error = NULL
     RETURNING desired_generation`,
    [String(discordUserId)],
  );
  return result.rows[0].desired_generation;
}

/**
 * The public write boundary. Call this inside the caller's transaction; it
 * locks and re-checks active membership before replacing the profile payload.
 */
export async function publishProfileAndEnqueue(client, discordUserId, input: ProfileInput) {
  const ownerId = String(discordUserId);
  const profile = assertPublishableProfile(input);
  const member = await loadCanonicalActiveMemberForUpdate(client, ownerId);
  assertUser(member, 'Only active members can publish a directory profile.');

  const result = await client.query(
    `INSERT INTO member_profiles (
       discord_user_id, headline, about, "current_role", goals, selected_tags,
       current_organization, location, email, linkedin_url, research_profile_url, visibility
     ) VALUES ($1, $2, $3, $4, $5, $6::text[], $7, $8, $9, $10, $11, 'published')
     ON CONFLICT (discord_user_id) DO UPDATE SET
       headline = EXCLUDED.headline,
       about = EXCLUDED.about,
       "current_role" = EXCLUDED."current_role",
       goals = EXCLUDED.goals,
       selected_tags = EXCLUDED.selected_tags,
       current_organization = EXCLUDED.current_organization,
       location = EXCLUDED.location,
       email = EXCLUDED.email,
       linkedin_url = EXCLUDED.linkedin_url,
       research_profile_url = EXCLUDED.research_profile_url,
       visibility = 'published',
       published_at = CASE WHEN member_profiles.visibility = 'hidden' THEN now() ELSE member_profiles.published_at END
     RETURNING *`,
    [
      ownerId,
      profile.headline,
      profile.about,
      profile.current_role,
      profile.goals,
      profile.selected_tags,
      profile.current_organization,
      profile.location,
      profile.email,
      profile.linkedin_url,
      profile.research_profile_url,
    ],
  );
  const desiredGeneration = await requestProfileReconciliation(client, ownerId);
  return { profile: result.rows[0], member, desiredGeneration };
}

/** Hides a profile and queues deletion only while Discord state may still exist. */
export async function hideProfileAndEnqueue(client, discordUserId) {
  const ownerId = String(discordUserId);
  const result = await client.query(
    `UPDATE member_profiles
        SET visibility = 'hidden'
      WHERE discord_user_id = $1
        AND (visibility <> 'hidden' OR forum_thread_id IS NOT NULL OR forum_message_id IS NOT NULL)
      RETURNING discord_user_id, visibility, forum_thread_id, forum_message_id`,
    [ownerId],
  );
  if (result.rowCount !== 1) return null;
  const desiredGeneration = await requestProfileReconciliation(client, ownerId);
  return { profile: result.rows[0], desiredGeneration };
}

export async function persistProfileForumIdentity(client, { discordUserId, generation, forumThreadId, forumMessageId }) {
  const result = await client.query(
    `UPDATE member_profiles p
        SET forum_thread_id = $3,
            forum_message_id = $4,
            forum_refreshed_at = now()
      WHERE p.discord_user_id = $1
        AND EXISTS (
          SELECT 1
            FROM member_profile_reconciliation r
           WHERE r.discord_user_id = p.discord_user_id
             AND r.desired_generation = $2
        )
      RETURNING p.discord_user_id`,
    [String(discordUserId), generation, forumThreadId == null ? null : String(forumThreadId), forumMessageId == null ? null : String(forumMessageId)],
  );
  return result.rowCount === 1;
}

export async function clearProfileForumIdentity(client, { discordUserId, generation }) {
  const result = await client.query(
    `UPDATE member_profiles p
        SET forum_thread_id = NULL,
            forum_message_id = NULL,
            forum_refreshed_at = now()
      WHERE p.discord_user_id = $1
        AND EXISTS (
          SELECT 1
            FROM member_profile_reconciliation r
           WHERE r.discord_user_id = p.discord_user_id
             AND r.desired_generation = $2
        )
      RETURNING p.discord_user_id`,
    [String(discordUserId), generation],
  );
  return result.rowCount === 1;
}

export async function markProfileReconciliationFailure(client, { discordUserId, generation, error }) {
  const message = error instanceof Error ? error.message : String(error);
  await client.query(
    `UPDATE member_profile_reconciliation
        SET status = 'failed', failed_at = now(), last_error = left($3, 2000)
      WHERE discord_user_id = $1 AND desired_generation = $2`,
    [String(discordUserId), generation, message],
  );
}

export async function listProfileReconciliationCandidates(db, limit) {
  const boundedLimit = Math.min(Math.max(Number(limit) || 10, 1), 10);
  const result = await db.query(
    `SELECT discord_user_id
       FROM member_profile_reconciliation
      WHERE status IN ('pending', 'failed')
         OR (status = 'processing' AND started_at < now() - interval '5 minutes')
      ORDER BY requested_at, discord_user_id
      LIMIT $1`,
    [boundedLimit],
  );
  return result.rows.map((row) => String(row.discord_user_id));
}

export async function listProfilesDueForRefresh(db, limit) {
  const boundedLimit = Math.min(Math.max(Number(limit) || 10, 1), 10);
  const result = await db.query(
    `SELECT discord_user_id, forum_thread_id
       FROM member_profiles
      WHERE visibility = 'published'
        AND forum_thread_id IS NOT NULL
        AND (forum_refreshed_at IS NULL OR forum_refreshed_at < now() - interval '1 day')
      ORDER BY forum_refreshed_at NULLS FIRST, discord_user_id
      LIMIT $1`,
    [boundedLimit],
  );
  return result.rows;
}

export async function markProfileRefreshed(db, discordUserId) {
  await db.query(
    `UPDATE member_profiles SET forum_refreshed_at = now() WHERE discord_user_id = $1`,
    [String(discordUserId)],
  );
}

export async function loadDirectoryGuideThreadId(db, guildId) {
  const result = await db.query(
    `SELECT channel_id
       FROM provisioned_messages
      WHERE guild_id = $1 AND content_key = 'global:people-directory'
      ORDER BY updated_at DESC
      LIMIT 1`,
    [String(guildId)],
  );
  return result.rows[0]?.channel_id == null ? null : String(result.rows[0].channel_id);
}

async function loadCanonicalActiveMemberForUpdate(client, discordUserId) {
  const result = await client.query(
    `SELECT ${CANONICAL_MEMBER_COLUMNS}
       FROM members m
       JOIN universities u ON u.id = m.university_id
       LEFT JOIN LATERAL (
         SELECT d.name
           FROM member_divisions md
           JOIN divisions d ON d.id = md.division_id
          WHERE md.discord_user_id = m.discord_user_id
            AND coalesce(d.active, true) = true
          ORDER BY d.name, d.id
          LIMIT 1
       ) d ON true
      WHERE m.discord_user_id = $1
        AND m.status = 'active'
        AND coalesce(u.active, true) = true
      FOR UPDATE OF m
      LIMIT 1`,
    [discordUserId],
  );
  return result.rows[0] ?? null;
}
