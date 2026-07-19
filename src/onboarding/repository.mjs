import { MEMBER_TYPES } from '../constants.mjs';
import { ONBOARDING_STATUSES, normalizeSelectedDivisionIds } from './state.mjs';
import { UserFacingError } from '../errors.mjs';

export async function createDraft(db, discordUserId) {
  const activeMember = await getActiveMember(db, discordUserId);
  if (activeMember) {
    throw new UserFacingError('You are already an active BAINSA member.');
  }

  const existing = await getOpenRequestForUser(db, discordUserId);
  if (existing) return existing;

  const defaultUniversity = await getDefaultUniversity(db);
  if (!defaultUniversity) {
    throw new UserFacingError('No universities are available for onboarding yet.');
  }

  try {
    const { rows } = await db.query(
      `INSERT INTO onboarding_requests
        (discord_user_id, member_type, university_id, status, division_ids, full_name, full_name_required)
       VALUES ($1, $2, $3, $4, ARRAY[]::bigint[], NULL, true)
       RETURNING *`,
      [discordUserId, MEMBER_TYPES.RESEARCHER, defaultUniversity.id, ONBOARDING_STATUSES.DRAFT],
    );
    return rows[0];
  } catch (error) {
    if (error?.code === '23505') {
      const racedRequest = await getOpenRequestForUser(db, discordUserId);
      if (racedRequest) return racedRequest;
    }
    throw error;
  }
}

export async function getActiveMember(db, discordUserId) {
  const { rows } = await db.query(
    `SELECT discord_user_id
     FROM members
     WHERE discord_user_id = $1 AND status = 'active'
     LIMIT 1`,
    [discordUserId],
  );
  return rows[0] ?? null;
}

export async function getOpenRequestForUser(db, discordUserId) {
  const { rows } = await db.query(
    `SELECT *
     FROM onboarding_requests
     WHERE discord_user_id = $1
       AND status IN ($2, $3)
     ORDER BY created_at DESC
     LIMIT 1`,
    [discordUserId, ONBOARDING_STATUSES.DRAFT, ONBOARDING_STATUSES.PENDING],
  );
  return rows[0] ?? null;
}

export async function getDefaultUniversity(db) {
  const { rows } = await db.query(
    `SELECT id::text AS id, name
     FROM universities
     WHERE active = true
     ORDER BY name ASC
     LIMIT 1`,
  );
  return rows[0] ?? null;
}

export async function getRequestForUser(db, requestId, discordUserId) {
  const { rows } = await db.query(
    `SELECT * FROM onboarding_requests
     WHERE id::text = $1 AND discord_user_id = $2`,
    [String(requestId), discordUserId],
  );
  return rows[0] ?? null;
}

export async function getRequest(db, requestId) {
  const { rows } = await db.query(
    `SELECT * FROM onboarding_requests WHERE id::text = $1`,
    [String(requestId)],
  );
  return rows[0] ?? null;
}

export async function lockRequest(db, requestId) {
  const { rows } = await db.query(
    `SELECT * FROM onboarding_requests
     WHERE id::text = $1
     FOR UPDATE`,
    [String(requestId)],
  );
  return rows[0] ?? null;
}

export async function updateDraft(db, requestId, discordUserId, patch) {
  const allowed = new Map([
    ['member_type', patch.member_type],
    ['university_id', patch.university_id],
    ['division_ids', patch.division_ids == null ? undefined : normalizeSelectedDivisionIds(patch.division_ids)],
    ['full_name', patch.full_name],
    ['status', patch.status],
    ['review_message_id', patch.review_message_id],
  ]);
  const sets = [];
  const values = [];

  for (const [column, value] of allowed) {
    if (value === undefined) continue;
    values.push(value);
    sets.push(`${column} = $${values.length}${column === 'division_ids' ? '::bigint[]' : ''}`);
  }

  if (sets.length === 0) return getRequestForUser(db, requestId, discordUserId);

  values.push(String(requestId), discordUserId);
  const { rows } = await db.query(
    `UPDATE onboarding_requests
     SET ${sets.join(', ')}, updated_at = NOW()
     WHERE id::text = $${values.length - 1} AND discord_user_id = $${values.length}
     RETURNING *`,
    values,
  );
  return rows[0] ?? null;
}

export async function markReviewed(db, requestId, status, reviewerId, reason = null) {
  const { rows } = await db.query(
    `UPDATE onboarding_requests
     SET status = $2,
         reviewed_by = $3,
         reviewed_at = NOW(),
         review_reason = $4,
         updated_at = NOW()
     WHERE id::text = $1
     RETURNING *`,
    [String(requestId), status, reviewerId, reason],
  );
  return rows[0] ?? null;
}

export async function listUniversities(db) {
  const { rows } = await db.query(
    `SELECT id::text AS id, name, discord_role_id, onboarding_review_channel_id
     FROM universities
     WHERE active = true
     ORDER BY name ASC`,
  );
  return rows;
}

export async function listAllUniversities(db) {
  const { rows } = await db.query(
    `SELECT id::text AS id, name, discord_role_id, onboarding_review_channel_id
     FROM universities
     ORDER BY name ASC`,
  );
  return rows;
}

export async function getUniversity(db, universityId) {
  const { rows } = await db.query(
    `SELECT id::text AS id, name, discord_role_id, onboarding_review_channel_id
     FROM universities
     WHERE id::text = $1
       AND active = true`,
    [String(universityId)],
  );
  return rows[0] ?? null;
}

export async function listDivisionsForUniversity(db, universityId) {
  const { rows } = await db.query(
    `SELECT id::text AS id, university_id::text AS university_id, name, color, member_role_id
     FROM divisions
     WHERE university_id::text = $1
       AND active = true
     ORDER BY name ASC`,
    [String(universityId)],
  );
  return rows;
}

export async function listDivisionsByIds(db, universityId, divisionIds) {
  const ids = normalizeSelectedDivisionIds(divisionIds);
  if (ids.length === 0) return [];
  const { rows } = await db.query(
    `SELECT id::text AS id, university_id::text AS university_id, name, color, member_role_id
     FROM divisions
     WHERE university_id::text = $1
       AND active = true
       AND id = ANY($2::bigint[])
     ORDER BY name ASC`,
    [String(universityId), ids],
  );
  return rows;
}

export async function listAllDivisions(db) {
  const { rows } = await db.query(
    `SELECT d.id::text AS id,
            d.university_id::text AS university_id,
            d.name,
            d.color,
            d.member_role_id,
            u.name AS university_name
     FROM divisions d
     JOIN universities u ON u.id = d.university_id
     ORDER BY u.name ASC, d.name ASC`,
  );
  return rows;
}

export async function upsertActiveMember(db, request) {
  await db.query(
    `INSERT INTO members
      (discord_user_id, university_id, member_type, status, full_name, joined_at, updated_at)
     VALUES ($1, $2, $3, 'active', $4, NOW(), NOW())
     ON CONFLICT (discord_user_id)
     DO UPDATE SET
       university_id = EXCLUDED.university_id,
       member_type = EXCLUDED.member_type,
       full_name = EXCLUDED.full_name,
       status = 'active',
       updated_at = NOW()`,
    [request.discord_user_id, request.university_id, request.member_type, request.full_name],
  );

  await db.query('DELETE FROM member_divisions WHERE discord_user_id = $1', [request.discord_user_id]);

  const divisionIds = request.member_type === MEMBER_TYPES.RESEARCHER
    ? normalizeSelectedDivisionIds(request.division_ids)
    : [];

  for (const divisionId of divisionIds) {
    await db.query(
      `INSERT INTO member_divisions (discord_user_id, division_id)
       VALUES ($1, $2)
       ON CONFLICT DO NOTHING`,
      [request.discord_user_id, divisionId],
    );
  }
}
