import { PROJECT_STATUSES } from '../../constants.js';
import { assertUser } from '../../errors.js';
import { normalizeDisplayName } from '../../naming.js';

const ACTIVE_PROJECT_STATUSES = [PROJECT_STATUSES.ACTIVE, PROJECT_STATUSES.PAUSED];

async function queryOne(db, text, values, missingMessage) {
  const result = await db.query(text, values);
  const row = result.rows[0];
  assertUser(row, missingMessage);
  return row;
}

export async function getUniversityByName(db, universityName) {
  return queryOne(
    db,
    `SELECT id, name, category_id, board_channel_id
       FROM universities
      WHERE lower(name) = lower($1)
        AND active = true
      LIMIT 1`,
    [normalizeDisplayName(universityName, 'university')],
    `Unknown university: ${universityName}.`,
  );
}

export async function getDivisionByName(db, universityId, universityName, divisionName) {
  return queryOne(
    db,
    `SELECT id,
            university_id,
            name,
            color,
            member_role_id AS access_role_id,
            head_role_id,
            text_channel_id,
            voice_channel_id
       FROM divisions
      WHERE university_id = $1
        AND lower(name) = lower($2)
        AND active = true
      LIMIT 1`,
    [universityId, normalizeDisplayName(divisionName, 'division')],
    `Unknown division: ${divisionName} at ${universityName}.`,
  );
}

export async function getMemberRecord(db, userId) {
  const result = await db.query(
    `SELECT m.discord_user_id, m.full_name, m.member_type, m.university_id, m.status, m.notes, u.name AS university_name
       FROM members m
       LEFT JOIN universities u ON u.id = m.university_id
      WHERE m.discord_user_id = $1
      LIMIT 1`,
    [String(userId)],
  );
  return result.rows[0] ?? null;
}

export async function getMemberDivisions(db, userId) {
  const result = await db.query(
    `SELECT d.id, d.name, d.color, d.university_id, d.text_channel_id, d.voice_channel_id,
            u.name AS university_name
       FROM member_divisions md
       JOIN divisions d ON d.id = md.division_id
       JOIN universities u ON u.id = d.university_id
      WHERE md.discord_user_id = $1
        AND d.active = true
        AND u.active = true
      ORDER BY d.name`,
    [String(userId)],
  );
  return result.rows;
}

export async function getBoardRoles(db, userId) {
  const result = await db.query(
    `SELECT br.role, br.university_id, br.division_id, u.name AS university_name, d.name AS division_name
       FROM board_assignments br
       LEFT JOIN universities u ON u.id = br.university_id AND u.active = true
       LEFT JOIN divisions d ON d.id = br.division_id AND d.active = true
      WHERE br.discord_user_id = $1
        AND br.active = true
        AND (br.university_id IS NULL OR u.id IS NOT NULL)
        AND (br.division_id IS NULL OR d.id IS NOT NULL)
      ORDER BY u.name NULLS FIRST, br.role, d.name`,
    [String(userId)],
  );
  return result.rows;
}

export async function getUniversityDivisionDiscordRoleIds(db, universityId) {
  const result = await db.query(
    `SELECT id, member_role_id, head_role_id
       FROM divisions
      WHERE university_id = $1
      ORDER BY id`,
    [universityId],
  );
  return result.rows;
}

export async function getActiveProjectAssignments(db, userId) {
  const result = await db.query(
    `SELECT p.id, p.name, p.status, p.channel_id, p.university_id, p.division_id, pp.role,
            u.name AS university_name, d.name AS division_name
       FROM project_people pp
       JOIN projects p ON p.id = pp.project_id
       JOIN universities u ON u.id = p.university_id
       LEFT JOIN divisions d ON d.id = p.division_id
      WHERE pp.discord_user_id = $1
        AND p.status = ANY($2::text[])
      ORDER BY p.name, pp.role`,
    [String(userId), ACTIVE_PROJECT_STATUSES],
  );
  return result.rows;
}

export async function getProjectAssignmentsForRemoval(db, userId) {
  const result = await db.query(
    `SELECT p.id, p.name, p.status, p.channel_id, pp.role, u.name AS university_name, d.name AS division_name
       FROM project_people pp
       JOIN projects p ON p.id = pp.project_id
       JOIN universities u ON u.id = p.university_id
       LEFT JOIN divisions d ON d.id = p.division_id
      WHERE pp.discord_user_id = $1
      ORDER BY p.name, pp.role`,
    [String(userId)],
  );
  return result.rows;
}

export async function getActiveProjectsBlockingDivisionRemoval(db, userId, division) {
  const result = await db.query(
    `SELECT p.id, p.name
       FROM project_people pp
       JOIN projects p ON p.id = pp.project_id
      WHERE pp.discord_user_id = $1
        AND p.division_id = $2
        AND p.status = ANY($3::text[])
        AND pp.role = 'member'
        AND NOT EXISTS (
          SELECT 1
            FROM board_assignments br
           WHERE br.discord_user_id = pp.discord_user_id
             AND br.university_id = $4
             AND br.active = true
             AND br.role IN ('head', 'vice_president', 'president')
        )
      ORDER BY p.name
      LIMIT 5`,
    [String(userId), division.id, ACTIVE_PROJECT_STATUSES, division.university_id],
  );
  return result.rows;
}

export async function getActiveProjectEligibilityAssignments(db, userId) {
  const result = await db.query(
    `SELECT p.id, p.name, p.university_id, p.division_id, pp.role
       FROM project_people pp
       JOIN projects p ON p.id = pp.project_id
      WHERE pp.discord_user_id = $1
        AND p.status = ANY($2::text[])
      ORDER BY p.name, p.id, pp.role`,
    [String(userId), ACTIVE_PROJECT_STATUSES],
  );
  return result.rows;
}

export async function activeDivisionExists(db, universityId, divisionName) {
  const result = await db.query(
    'SELECT id FROM divisions WHERE university_id = $1 AND lower(name) = lower($2) AND active = true LIMIT 1',
    [universityId, divisionName],
  );
  return result.rowCount > 0;
}

export async function activeDivisionConflictExists(db, universityId, divisionName, divisionId) {
  const result = await db.query(
    `SELECT id FROM divisions WHERE university_id = $1 AND lower(name) = lower($2)
      AND id <> $3 AND active = true LIMIT 1`,
    [universityId, divisionName, divisionId],
  );
  return result.rowCount > 0;
}

export async function createDivisionRecord(q, values) {
  const result = await q.query(
    `INSERT INTO divisions
      (university_id, name, slug, color, member_role_id, head_role_id, text_channel_id, voice_channel_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id`,
    [
      values.universityId, values.name, values.slug, values.color, values.accessRoleId,
      values.headRoleId, values.textChannelId, values.voiceChannelId,
    ],
  );
  return result.rows[0].id;
}

export async function updateDivisionRecord(q, values) {
  await q.query(
    `UPDATE divisions SET name = $1, slug = $2, color = $3, member_role_id = $4,
        head_role_id = $5, updated_at = now() WHERE id = $6`,
    [values.name, values.slug, values.color, values.accessRoleId, values.headRoleId, values.divisionId],
  );
}

export async function lockUniversityForUpdate(q, universityId) {
  await q.query('SELECT id FROM universities WHERE id = $1 FOR UPDATE', [universityId]);
}

export async function getExclusiveBoardAssignment(db, universityId, role, divisionId = null) {
  if (role === 'president') return null;
  const result = role === 'head'
    ? await db.query(
      `SELECT discord_user_id FROM board_assignments
        WHERE university_id = $1 AND role = $2 AND division_id = $3 AND active = true LIMIT 1`,
      [universityId, role, divisionId],
    )
    : await db.query(
      `SELECT discord_user_id FROM board_assignments
        WHERE university_id = $1 AND role = $2 AND active = true LIMIT 1`,
      [universityId, role],
    );
  return result.rows[0] ?? null;
}

export async function insertBoardAssignment(q, assignment) {
  const result = await q.query(
    `INSERT INTO board_assignments (discord_user_id, university_id, role, division_id, active)
     VALUES ($1, $2, $3, $4, true)
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [String(assignment.userId), assignment.universityId, assignment.role, assignment.divisionId ?? null],
  );
  return result.rowCount;
}

export async function ensureBoardAssignment(q, assignment) {
  await q.query(
    `INSERT INTO board_assignments (discord_user_id, university_id, role, division_id, active)
     VALUES ($1, $2, $3, $4, true) ON CONFLICT DO NOTHING`,
    [String(assignment.userId), assignment.universityId, assignment.role, assignment.divisionId ?? null],
  );
}

export async function deactivateOtherHeadAssignments(q, userId, universityId, divisionId) {
  await q.query(
    `UPDATE board_assignments SET active = false, updated_at = now()
      WHERE discord_user_id = $1 AND university_id = $2 AND role = $3
        AND active = true AND division_id IS DISTINCT FROM $4`,
    [String(userId), universityId, 'head', divisionId],
  );
}

export async function getActiveHeadDivisions(db, userId, universityId) {
  const result = await db.query(
    `SELECT d.id, d.name FROM board_assignments br JOIN divisions d ON d.id = br.division_id
      WHERE br.discord_user_id = $1 AND br.university_id = $2 AND br.role = 'head'
        AND br.active = true AND d.active = true ORDER BY d.id`,
    [String(userId), universityId],
  );
  return result.rows;
}

export async function deactivateBoardAssignments(q, userId, universityId, role, divisionId = null) {
  await q.query(
    `UPDATE board_assignments SET active = false, updated_at = now()
      WHERE discord_user_id = $1 AND university_id = $2 AND role = $3 AND active = true
        AND ($4::bigint IS NULL OR division_id = $4)`,
    [String(userId), universityId, role, divisionId],
  );
}

export async function deactivateExactBoardAssignment(q, userId, universityId, role, divisionId) {
  await q.query(
    `UPDATE board_assignments SET active = false, updated_at = now()
      WHERE discord_user_id = $1 AND university_id = $2 AND role = $3
        AND division_id IS NOT DISTINCT FROM $4 AND active = true`,
    [String(userId), universityId, role, divisionId],
  );
}

export async function getBoardAuthorityRoles(db, userId, universityId) {
  const result = await db.query(
    `SELECT role FROM board_assignments WHERE discord_user_id = $1 AND university_id = $2
      AND role IN ('president', 'vice_president') AND active = true`,
    [String(userId), universityId],
  );
  return result.rows;
}

export async function listActiveDivisionsForBoard(db, universityId) {
  const result = await db.query(
    `SELECT id, university_id, name, color, member_role_id, head_role_id,
            text_channel_id, voice_channel_id
       FROM divisions
      WHERE university_id = $1 AND active = true ORDER BY name`,
    [universityId],
  );
  return result.rows;
}

export async function listActiveBoardAssignments(db, universityId, { forUpdate = false } = {}) {
  const result = await db.query(
    `SELECT br.discord_user_id, br.university_id, br.role, br.division_id, d.name AS division_name
       FROM board_assignments br LEFT JOIN divisions d ON d.id = br.division_id
      WHERE br.university_id = $1 AND br.active = true
      ORDER BY br.role, br.division_id NULLS FIRST, br.discord_user_id${forUpdate ? ' FOR UPDATE OF br' : ''}`,
    [universityId],
  );
  return result.rows;
}

export async function hasActiveBoardAssignment(db, userId, universityId) {
  const result = await db.query(
    `SELECT 1 FROM board_assignments WHERE discord_user_id = $1 AND university_id = $2
      AND active = true LIMIT 1`,
    [String(userId), universityId],
  );
  return result.rowCount > 0;
}

export async function listBoardInfoAssignments(db, universityId) {
  const result = await db.query(
    `SELECT br.discord_user_id, m.full_name, br.role, br.division_id,
            d.name AS division_name, d.color AS division_color
       FROM board_assignments br
       LEFT JOIN members m ON m.discord_user_id = br.discord_user_id
       LEFT JOIN divisions d ON d.id = br.division_id AND d.active = true
      WHERE br.university_id = $1 AND br.active = true
        AND (br.division_id IS NULL OR d.id IS NOT NULL)
      ORDER BY br.role, d.name, br.discord_user_id`,
    [universityId],
  );
  return result.rows;
}

export async function hasPublishedMemberProfileForUpdate(q, userId) {
  const result = await q.query(
    `SELECT 1
       FROM member_profiles
      WHERE discord_user_id = $1 AND visibility = 'published'
      FOR UPDATE`,
    [String(userId)],
  );
  return result.rowCount === 1;
}

export async function getMemberProfileVisibilityForUpdate(q, userId) {
  const result = await q.query(
    `SELECT visibility
       FROM member_profiles
      WHERE discord_user_id = $1
      FOR UPDATE`,
    [String(userId)],
  );
  return result.rows[0]?.visibility ?? null;
}

/**
 * Applies the canonical half of a member removal while the caller holds the
 * eligibility locks.  Keeping this here makes the service an orchestrator and
 * keeps all SQL that changes the removal state at the repository boundary.
 */
export async function removeMemberCanonicalState(q, userId) {
  // The member row is already locked by the caller. Claim the one allowed
  // active-to-removed transition first so retries can perform Discord repair
  // without duplicating canonical side effects or audit history.
  const member = await q.query(
    `UPDATE members
        SET status = 'removed', removed_at = now(), updated_at = now()
      WHERE discord_user_id = $1 AND status = 'active'
      RETURNING discord_user_id`,
    [String(userId)],
  );
  if (member.rowCount !== 1) return null;
  const boardUpdate = await q.query(
    `UPDATE board_assignments
        SET active = false,
            updated_at = now()
      WHERE discord_user_id = $1
        AND active = true`,
    [String(userId)],
  );
  const divisionDelete = await q.query(
    'DELETE FROM member_divisions WHERE discord_user_id = $1',
    [String(userId)],
  );
  const projects = await q.query(
    `DELETE FROM project_people
      WHERE discord_user_id = $1
      RETURNING project_id`,
    [String(userId)],
  );
  return {
    boardAssignmentsDeactivated: boardUpdate.rowCount,
    divisionsCleared: divisionDelete.rowCount,
    projectAssignmentsDeleted: projects.rowCount,
    projectIds: [...new Set(projects.rows.map((row) => String(row.project_id)))],
  };
}

export async function upsertMemberRecord(q, userId, memberType, universityId, notes) {
  await q.query(
    `INSERT INTO members (discord_user_id, member_type, university_id, status, notes)
     VALUES ($1, $2, $3, 'active', $4)
     ON CONFLICT (discord_user_id)
     DO UPDATE SET
       member_type = EXCLUDED.member_type,
       university_id = EXCLUDED.university_id,
       status = 'active',
       notes = COALESCE(EXCLUDED.notes, members.notes),
       removed_at = NULL,
       updated_at = now()`,
    [String(userId), memberType, universityId, notes ?? null],
  );
}

export async function replaceMemberDivisionRows(q, userId, divisions) {
  await q.query('DELETE FROM member_divisions WHERE discord_user_id = $1', [String(userId)]);
  for (const division of divisions) {
    await q.query(
      `INSERT INTO member_divisions (discord_user_id, division_id)
       VALUES ($1, $2)
       ON CONFLICT DO NOTHING`,
      [String(userId), division.id],
    );
  }
}

export async function addMemberDivisionRow(q, userId, divisionId) {
  await q.query(
    `INSERT INTO member_divisions (discord_user_id, division_id)
     VALUES ($1, $2)
     ON CONFLICT DO NOTHING`,
    [String(userId), divisionId],
  );
}

export async function removeMemberDivisionRow(q, userId, divisionId) {
  await q.query('DELETE FROM member_divisions WHERE discord_user_id = $1 AND division_id = $2', [
    String(userId),
    divisionId,
  ]);
}

export async function getDivisionRecords(db, university, divisionNames) {
  const divisions = [];
  for (const divisionName of divisionNames) {
    divisions.push(await getDivisionByName(db, university.id, university.name, divisionName));
  }
  return divisions;
}
