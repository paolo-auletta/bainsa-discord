import { MEMBER_TYPES } from '../../constants.js';
import { assertUser } from '../../errors.js';
import { formatDiscordUserReferences } from './validation.js';

const PROJECT_SELECT = `
  p.id,
  p.name,
  p.university_id,
  p.division_id,
  p.start_date::text AS start_date,
  p.expected_end::text AS expected_end,
  p.summary,
  p.notes,
  p.status,
  p.outcome,
  p.final_notes,
  p.closed_at,
  p.channel_id AS discord_channel_id,
  p.home_message_id,
  p.workspace_guide_message_id,
  p.showcase_thread_id,
  u.name AS university_name,
  u.category_id,
  u.showcase_channel_id,
  d.name AS division_name,
  d.color AS division_color,
  d.member_role_id AS division_role_id,
  d.head_role_id AS division_head_role_id
`;

export async function findActiveDivision(db, universityName, divisionName) {
  const result = await db.query(
    `SELECT
       u.id AS university_id,
       u.name AS university_name,
       u.category_id,
       u.showcase_channel_id,
       d.id AS division_id,
       d.name AS division_name,
       d.color AS division_color,
       d.member_role_id AS division_role_id,
       d.head_role_id AS division_head_role_id
     FROM universities u
     JOIN divisions d ON d.university_id = u.id
     WHERE lower(u.name) = lower($1)
       AND lower(d.name) = lower($2)
       AND coalesce(u.active, true) = true
       AND coalesce(d.active, true) = true
     LIMIT 1`,
    [universityName, divisionName],
  );
  assertUser(result.rowCount === 1, `${divisionName} is not an active division at ${universityName}.`);
  return result.rows[0];
}

export async function findActiveDivisionHeadIds(db, divisionId) {
  const result = await db.query(
    `SELECT discord_user_id
       FROM board_assignments
      WHERE division_id = $1
        AND role = 'head'
        AND active = true
      ORDER BY discord_user_id`,
    [divisionId],
  );
  return result.rows.map((row) => String(row.discord_user_id));
}

export async function assertActiveUniversityMembers(db, universityId, userIds, fieldName) {
  const result = await db.query(
    `SELECT discord_user_id
     FROM members
     WHERE university_id = $1
       AND discord_user_id = ANY($2::text[])
       AND status = 'active'`,
    [universityId, userIds],
  );
  const accepted = new Set(result.rows.map((row) => String(row.discord_user_id)));
  const rejected = userIds.filter((id) => !accepted.has(String(id)));
  assertUser(
    rejected.length === 0,
    `These ${fieldName} are not accepted active members in this university: ${formatDiscordUserReferences(rejected)}.`,
  );
}

export async function assertActiveProjectMembers(db, universityId, divisionId, userIds, fieldName) {
  const result = await db.query(
    `SELECT m.discord_user_id
     FROM members m
     WHERE m.university_id = $1
       AND m.discord_user_id = ANY($3::text[])
       AND m.status = 'active'
       AND (
         (
           m.member_type = $4
           AND EXISTS (
             SELECT 1
               FROM member_divisions md
              WHERE md.discord_user_id = m.discord_user_id
                AND md.division_id = $2
           )
         )
         OR EXISTS (
           SELECT 1
             FROM board_assignments br
            WHERE br.discord_user_id = m.discord_user_id
              AND br.university_id = $1
              AND br.active = true
              AND br.role IN ('head', 'vice_president', 'president')
         )
       )`,
    [universityId, divisionId, userIds, MEMBER_TYPES.RESEARCHER],
  );
  const accepted = new Set(result.rows.map((row) => String(row.discord_user_id)));
  const rejected = userIds.filter((id) => !accepted.has(String(id)));
  assertUser(
    rejected.length === 0,
    `These ${fieldName} are neither active researchers in this division nor board members of this university: ${formatDiscordUserReferences(rejected)}.`,
  );
}

export async function getProject(db, projectId) {
  const result = await db.query(
    `SELECT ${PROJECT_SELECT}
     FROM projects p
     JOIN universities u ON u.id = p.university_id
     JOIN divisions d ON d.id = p.division_id
     WHERE p.id = $1
     LIMIT 1`,
    [projectId],
  );
  assertUser(result.rowCount === 1, 'Project not found.');
  return result.rows[0];
}

/**
 * Loads a project under its row lock so lifecycle checks and mutation payloads
 * are based on one transactionally current state.
 */
export async function getProjectForUpdate(db, projectId) {
  const result = await db.query(
    `SELECT ${PROJECT_SELECT}
     FROM projects p
     JOIN universities u ON u.id = p.university_id
     JOIN divisions d ON d.id = p.division_id
     WHERE p.id = $1
     FOR UPDATE OF p`,
    [projectId],
  );
  assertUser(result.rowCount === 1, 'Project not found.');
  return result.rows[0];
}

export async function getProjectPeople(db, projectId) {
  const result = await db.query(
    `SELECT discord_user_id, role
     FROM project_people
     WHERE project_id = $1
     ORDER BY role, discord_user_id`,
    [projectId],
  );
  return result.rows;
}

export async function projectPersonExists(db, projectId, userId) {
  return Boolean(await getProjectPerson(db, projectId, userId));
}

export async function getProjectPerson(db, projectId, userId) {
  const result = await db.query(
    'SELECT discord_user_id, role FROM project_people WHERE project_id = $1 AND discord_user_id = $2',
    [projectId, userId],
  );
  return result.rows[0] ?? null;
}

export async function insertProjectPeople(db, projectId, people) {
  if (people.length === 0) return;

  await db.query(
    `INSERT INTO project_people (project_id, discord_user_id, role)
     SELECT $1, people.discord_user_id, people.role
     FROM unnest($2::text[], $3::text[]) AS people(discord_user_id, role)
     ON CONFLICT (project_id, discord_user_id)
     DO UPDATE SET role = EXCLUDED.role`,
    [
      projectId,
      people.map((person) => String(person.discord_user_id)),
      people.map((person) => person.role),
    ],
  );
}

export async function lockProjectAndCountPeople(db, projectId) {
  const project = await getProjectForUpdate(db, projectId);
  const result = await db.query(
    'SELECT count(*)::int AS count FROM project_people WHERE project_id = $1',
    [projectId],
  );
  return { project, count: Number(result.rows[0].count) };
}
