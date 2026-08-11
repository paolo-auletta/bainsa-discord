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
    `SELECT id, name, category_id
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
    `SELECT d.id, d.name, d.color, d.university_id, u.name AS university_name
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
