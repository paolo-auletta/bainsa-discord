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
  p.updated_at::text AS updated_at,
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

const PROJECT_RECONCILIATION_REPAIR_LIMIT = 10;

export function projectPeopleEqual(left, right) {
  const snapshot = (people) => [...people]
    .map((person) => `${String(person.discord_user_id)}:${String(person.role)}`)
    .sort();
  const leftSnapshot = snapshot(left);
  const rightSnapshot = snapshot(right);
  return leftSnapshot.length === rightSnapshot.length
    && leftSnapshot.every((value, index) => value === rightSnapshot[index]);
}

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

export async function createProjectRecord(db, project) {
  const result = await db.query(
    `INSERT INTO projects
      (name, university_id, division_id, start_date, expected_end, summary, notes, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id, name, university_id, division_id, start_date::text, expected_end::text, summary, notes, status,
       outcome, final_notes, closed_at, channel_id AS discord_channel_id, home_message_id, workspace_guide_message_id, showcase_thread_id`,
    [
      project.name,
      project.universityId,
      project.divisionId,
      project.startDate,
      project.expectedEnd,
      project.summary,
      project.notes,
      project.status,
    ],
  );
  return result.rows[0];
}

export async function updateProjectRecord(db, projectId, patch) {
  await db.query(
    `UPDATE projects
     SET name = $1, expected_end = $2, summary = $3, notes = $4, status = $5, updated_at = now()
     WHERE id = $6`,
    [patch.name, patch.expected_end, patch.summary, patch.notes, patch.status, projectId],
  );
}

export async function completeProjectRecord(db, projectId, outcome, finalNotes, status) {
  await db.query(
    `UPDATE projects
     SET status = $1, outcome = $2, final_notes = $3,
         closed_at = now(), updated_at = now()
     WHERE id = $4`,
    [status, outcome, finalNotes, projectId],
  );
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

export async function removeProjectPerson(db, projectId, userId) {
  await db.query('DELETE FROM project_people WHERE project_id = $1 AND discord_user_id = $2', [projectId, userId]);
}

export async function replaceProjectPeople(db, projectId, people) {
  await db.query('DELETE FROM project_people WHERE project_id = $1', [projectId]);
  await insertProjectPeople(db, projectId, people);
}

export async function lockProjectAndCountPeople(db, projectId) {
  const project = await getProjectForUpdate(db, projectId);
  const result = await db.query(
    'SELECT count(*)::int AS count FROM project_people WHERE project_id = $1',
    [projectId],
  );
  return { project, count: Number(result.rows[0].count) };
}

export async function projectReconciliationStatus(db, projectId) {
  const result = await db.query(
    'SELECT status FROM project_reconciliation WHERE project_id = $1',
    [projectId],
  );
  return result.rows[0]?.status ?? null;
}

export async function enqueueProjectReconciliation(db, projectId) {
  const result = await db.query(
    `INSERT INTO project_reconciliation (project_id, desired_generation, status, requested_at, last_error)
     VALUES ($1, 1, 'pending', now(), NULL)
     ON CONFLICT (project_id) DO UPDATE
       SET desired_generation = project_reconciliation.desired_generation + 1,
           status = 'pending', requested_at = now(), last_error = NULL
     RETURNING desired_generation`,
    [projectId],
  );
  return result.rows[0].desired_generation;
}

export async function loadProjectReconciliationState(db, projectId, { forUpdate = false } = {}) {
  const result = await db.query(
    `SELECT ${PROJECT_SELECT}
       FROM projects p
       JOIN universities u ON u.id = p.university_id
       JOIN divisions d ON d.id = p.division_id
      WHERE p.id = $1
      ${forUpdate ? 'FOR UPDATE OF p' : ''}`,
    [projectId],
  );
  if (result.rowCount !== 1) return { project: null, people: [] };
  return { project: result.rows[0], people: await getProjectPeople(db, projectId) };
}

export async function persistProjectChannelId(db, projectId, channelId) {
  await db.query('UPDATE projects SET channel_id = $1, updated_at = now() WHERE id = $2', [channelId, projectId]);
}

export async function persistProjectShowcaseThreadId(db, projectId, threadId) {
  await db.query('UPDATE projects SET showcase_thread_id = $1, updated_at = now() WHERE id = $2', [threadId, projectId]);
}

export async function persistProjectHomeMessageId(db, projectId, messageId) {
  await db.query('UPDATE projects SET home_message_id = $1, updated_at = now() WHERE id = $2', [messageId, projectId]);
}

export async function persistProjectWorkspaceGuideMessageId(db, projectId, messageId) {
  await db.query('UPDATE projects SET workspace_guide_message_id = $1, updated_at = now() WHERE id = $2', [messageId, projectId]);
}

export async function claimProjectReconciliation(db, projectId, allowStaleProcessing) {
  const result = await db.query(
    `SELECT desired_generation
       FROM project_reconciliation
      WHERE project_id = $1
        AND (status IN ('pending', 'failed')
          OR ($2::boolean AND status = 'processing' AND started_at < now() - interval '5 minutes'))
      FOR UPDATE SKIP LOCKED`,
    [projectId, allowStaleProcessing],
  );
  return result.rows[0]?.desired_generation ?? null;
}

export async function markProjectReconciliationProcessing(db, projectId, generation) {
  await db.query(
    `UPDATE project_reconciliation
        SET status = 'processing', attempts = attempts + 1, started_at = now(), last_error = NULL
      WHERE project_id = $1 AND desired_generation = $2`,
    [projectId, generation],
  );
}

export async function completeProjectReconciliation(db, projectId, generation) {
  const result = await db.query(
    `UPDATE project_reconciliation
        SET status = 'succeeded', succeeded_at = now(), last_error = NULL
      WHERE project_id = $1 AND desired_generation = $2
      RETURNING desired_generation`,
    [projectId, generation],
  );
  return result.rowCount === 1;
}

export async function failProjectReconciliation(db, projectId, generation, error) {
  const message = error instanceof Error ? error.message : String(error);
  await db.query(
    `UPDATE project_reconciliation
        SET status = 'failed', failed_at = now(), last_error = left($3, 2000)
      WHERE project_id = $1 AND desired_generation = $2`,
    [projectId, generation, message],
  );
}

export async function listProjectReconciliationCandidates(db, limit) {
  const boundedLimit = Math.min(Math.max(Number(limit) || PROJECT_RECONCILIATION_REPAIR_LIMIT, 1), PROJECT_RECONCILIATION_REPAIR_LIMIT);
  const result = await db.query(
    `SELECT project_id FROM project_reconciliation
      WHERE status IN ('pending', 'failed')
         OR (status = 'processing' AND started_at < now() - interval '5 minutes')
      ORDER BY requested_at, project_id LIMIT $1`,
    [boundedLimit],
  );
  return result.rows.map((row) => row.project_id);
}

export async function findVisibleProjectCandidates(db, { term, actorId, statuses, roleNames }) {
  const statusFilter = statuses ? ' AND p.status = ANY($3::text[])' : '';
  const values = statuses
    ? [term, actorId, statuses, roleNames]
    : [term, actorId, roleNames];
  const roleParameter = statuses ? '$4' : '$3';
  const result = await db.query(
    `SELECT p.id, p.name, p.status, u.name AS university_name, d.name AS division_name, d.color AS division_color,
            pp.discord_user_id IS NOT NULL AS actor_is_project_person
       FROM projects p
       JOIN universities u ON u.id = p.university_id
       JOIN divisions d ON d.id = p.division_id
       LEFT JOIN project_people pp ON pp.project_id = p.id AND pp.discord_user_id = $2
      WHERE ($1 = '%%' OR p.name ILIKE $1 OR u.name ILIKE $1 OR d.name ILIKE $1 OR p.id::text ILIKE $1)
        ${statusFilter}
        AND (
          pp.discord_user_id IS NOT NULL
          OR 'Global President' = ANY(${roleParameter}::text[])
          OR concat(u.name, ' - President') = ANY(${roleParameter}::text[])
          OR concat(u.name, ' - Vice President') = ANY(${roleParameter}::text[])
          OR concat(u.name, ' - Head of ', d.name) = ANY(${roleParameter}::text[])
        )
      ORDER BY p.updated_at DESC NULLS LAST, p.id DESC
      LIMIT 25`,
    values,
  );
  return result.rows;
}

export async function findActiveProjectUniversities(db, term) {
  const result = await db.query(
    `SELECT name FROM universities
      WHERE active = true AND ($1 = '' OR name ILIKE $2)
      ORDER BY name LIMIT 25`,
    [term, `%${term}%`],
  );
  return result.rows;
}

export async function findActiveProjectDivisions(db, universityName, term) {
  const result = await db.query(
    `SELECT d.name, d.color FROM divisions d
       JOIN universities u ON u.id = d.university_id
      WHERE u.active = true AND d.active = true AND lower(u.name) = lower($1)
        AND ($2 = '' OR d.name ILIKE $3)
      ORDER BY d.name LIMIT 25`,
    [universityName, term, `%${term}%`],
  );
  return result.rows;
}

export async function listActiveProjectUniversities(db) {
  const result = await db.query('SELECT name FROM universities WHERE active = true ORDER BY name');
  return result.rows;
}

export async function listActiveProjectDivisions(db, universityName) {
  const result = await db.query(
    `SELECT d.name, d.color FROM divisions d
       JOIN universities u ON u.id = d.university_id
      WHERE u.active = true AND d.active = true AND lower(u.name) = lower($1)
      ORDER BY d.name`,
    [universityName],
  );
  return result.rows;
}

export async function loadActiveProjectAutocompleteCache(db) {
  const [universities, divisions] = await Promise.all([
    db.query('SELECT name FROM universities WHERE active = true ORDER BY name'),
    db.query(
      `SELECT u.name AS university_name, d.name, d.color FROM divisions d
         JOIN universities u ON u.id = d.university_id
        WHERE u.active = true AND d.active = true
        ORDER BY u.name, d.name`,
    ),
  ]);
  return { universities: universities.rows, divisions: divisions.rows };
}

export async function lockProjectMemberEligibilityRows(db, userIds) {
  if (userIds.length === 0) return;
  await db.query(
    `SELECT discord_user_id FROM members
      WHERE discord_user_id = ANY($1::text[])
      ORDER BY discord_user_id FOR UPDATE`,
    [userIds],
  );
}

export async function lockProjectDivisionEligibilityRows(db, divisionIds) {
  if (divisionIds.length === 0) return;
  await db.query(
    `SELECT id FROM divisions WHERE id = ANY($1::bigint[])
      ORDER BY id FOR UPDATE`,
    [divisionIds],
  );
}

export async function loadProjectMembershipRows(db, userIds) {
  const result = await db.query(
    `SELECT m.discord_user_id, m.member_type, m.university_id, m.status, md.division_id,
            EXISTS (
              SELECT 1 FROM board_assignments br
               WHERE br.discord_user_id = m.discord_user_id AND br.university_id = m.university_id
                 AND br.active = true AND br.role IN ('head', 'vice_president', 'president')
            ) AS is_university_board_member
       FROM members m LEFT JOIN member_divisions md ON md.discord_user_id = m.discord_user_id
      WHERE m.discord_user_id = ANY($1::text[])`,
    [userIds],
  );
  return result.rows;
}

export async function loadActiveProjectAssignmentsForMember(db, userId, statuses) {
  const result = await db.query(
    `SELECT p.id, p.name, p.university_id, p.division_id, pp.role,
            EXISTS (
              SELECT 1 FROM board_assignments br
               WHERE br.discord_user_id = pp.discord_user_id AND br.university_id = p.university_id
                 AND br.active = true AND br.role IN ('head', 'vice_president', 'president')
            ) AS is_university_board_member
       FROM project_people pp JOIN projects p ON p.id = pp.project_id
      WHERE pp.discord_user_id = $1 AND p.status = ANY($2::text[])
      ORDER BY p.name, p.id, pp.role`,
    [String(userId), statuses],
  );
  return result.rows;
}
