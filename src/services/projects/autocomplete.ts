import { divisionLabel, MEMBER_TYPES, PROJECT_PERSON_ROLES } from '../../constants.js';
import { query } from '../../db.js';
import { canViewProject } from './policy.js';

const DEFAULT_DB = { query };
type ProjectDependencies = { db?: typeof DEFAULT_DB };

const PROJECT_AUTOCOMPLETE_CACHE_TTL_MS = 30_000;
const projectAutocompleteCache = {
  loadedAt: 0,
  universities: [],
  divisions: [],
  people: [],
};

function dbClient(db) {
  return db ?? DEFAULT_DB;
}

export async function searchVisibleProjects(input, deps: ProjectDependencies = {}) {
  const db = dbClient(deps.db);
  const term = `%${String(input.query ?? '').trim()}%`;
  const result = await db.query(
    `SELECT
       p.id,
       p.name,
       p.status,
       u.name AS university_name,
       d.name AS division_name,
       d.color AS division_color,
       bool_or(pp.discord_user_id IS NOT NULL) AS actor_is_project_person
     FROM projects p
     JOIN universities u ON u.id = p.university_id
     JOIN divisions d ON d.id = p.division_id
     LEFT JOIN project_people pp
       ON pp.project_id = p.id
      AND pp.discord_user_id = $2
     WHERE ($1 = '%%' OR p.name ILIKE $1 OR u.name ILIKE $1 OR d.name ILIKE $1 OR p.id::text ILIKE $1)
     GROUP BY p.id, p.name, p.status, u.name, d.name, d.color
     ORDER BY p.updated_at DESC NULLS LAST, p.id DESC`,
    [term, input.interaction.user.id],
  );
  return result.rows
    .filter((project) =>
      canViewProject(
        input.interaction.member,
        project,
        project.actor_is_project_person ? [{ discord_user_id: input.interaction.user.id }] : [],
      ),
    )
    .slice(0, 25)
    .map((project) => ({
      name: `#${project.id} ${project.name} (${project.university_name} / ${divisionLabel(project.division_name, project.division_color)}, ${project.status})`.slice(0, 100),
      value: String(project.id),
    }));
}

export async function findProjectUniversities(term = '', deps: ProjectDependencies = {}) {
  if (projectAutocompleteCache.loadedAt) {
    refreshProjectAutocompleteCacheInBackground(deps);
    const normalizedTerm = String(term).trim().toLowerCase();
    return projectAutocompleteCache.universities
      .filter((row) => !normalizedTerm || row.name.toLowerCase().includes(normalizedTerm))
      .slice(0, 25);
  }
  const db = dbClient(deps.db);
  const normalizedTerm = String(term).trim();
  const result = await db.query(
    `SELECT name
       FROM universities
      WHERE active = true
        AND ($1 = '' OR name ILIKE $2)
      ORDER BY name
      LIMIT 25`,
    [normalizedTerm, `%${normalizedTerm}%`],
  );
  return result.rows;
}

export async function findProjectDivisions(universityName, term = '', deps: ProjectDependencies = {}) {
  if (!universityName?.trim()) return [];
  if (projectAutocompleteCache.loadedAt) {
    refreshProjectAutocompleteCacheInBackground(deps);
    const normalizedUniversity = universityName.trim().toLowerCase();
    const normalizedTerm = String(term).trim().toLowerCase();
    return projectAutocompleteCache.divisions
      .filter((row) =>
        row.university_name.toLowerCase() === normalizedUniversity &&
        (!normalizedTerm || row.name.toLowerCase().includes(normalizedTerm)),
      )
      .map(({ name, color }) => ({ name, color }))
      .slice(0, 25);
  }
  const db = dbClient(deps.db);
  const normalizedTerm = String(term).trim();
  const result = await db.query(
    `SELECT d.name, d.color
       FROM divisions d
       JOIN universities u ON u.id = d.university_id
      WHERE u.active = true
        AND d.active = true
        AND lower(u.name) = lower($1)
        AND ($2 = '' OR d.name ILIKE $3)
      ORDER BY d.name
      LIMIT 25`,
    [universityName.trim(), normalizedTerm, `%${normalizedTerm}%`],
  );
  return result.rows;
}

export async function findProjectPeople({ universityName, divisionName, role, term = '' }, deps: ProjectDependencies = {}) {
  if (!universityName?.trim()) return [];
  if (role === PROJECT_PERSON_ROLES.MEMBER && !divisionName?.trim()) return [];
  if (projectAutocompleteCache.loadedAt) {
    refreshProjectAutocompleteCacheInBackground(deps);
    const normalizedUniversity = universityName.trim().toLowerCase();
    const normalizedDivision = divisionName?.trim().toLowerCase() ?? '';
    const normalizedTerm = String(term).trim().toLowerCase();
    const matches = projectAutocompleteCache.people
      .filter((row) =>
        row.university_name.toLowerCase() === normalizedUniversity &&
        (
          role !== PROJECT_PERSON_ROLES.MEMBER ||
          row.is_university_board_member === true ||
          (
            row.division_name?.toLowerCase() === normalizedDivision &&
            row.member_type === MEMBER_TYPES.RESEARCHER
          )
        ) &&
        (!normalizedTerm || row.full_name?.toLowerCase().includes(normalizedTerm) || row.discord_user_id.includes(normalizedTerm)),
      )
      .map(({ discord_user_id, full_name }) => ({ discord_user_id, full_name }));
    return [...new Map(matches.map((person) => [person.discord_user_id, person])).values()].slice(0, 25);
  }
  const db = dbClient(deps.db);
  const normalizedTerm = String(term).trim();
  const result = await db.query(
    `SELECT DISTINCT m.discord_user_id, m.full_name
       FROM members m
       JOIN universities u ON u.id = m.university_id
       LEFT JOIN member_divisions md ON md.discord_user_id = m.discord_user_id
       LEFT JOIN divisions d ON d.id = md.division_id
      WHERE m.status = 'active'
        AND u.active = true
        AND lower(u.name) = lower($1)
        AND (
          $2::text IS NULL
          OR (d.active = true AND lower(d.name) = lower($2) AND m.member_type = $3)
          OR EXISTS (
            SELECT 1
              FROM board_assignments br
             WHERE br.discord_user_id = m.discord_user_id
               AND br.university_id = m.university_id
               AND br.active = true
               AND br.role IN ('head', 'vice_president', 'president')
          )
        )
        AND ($4 = '' OR coalesce(m.full_name, '') ILIKE $5 OR m.discord_user_id ILIKE $5)
      ORDER BY coalesce(m.full_name, ''), m.discord_user_id
      LIMIT 25`,
    [
      universityName.trim(),
      role === PROJECT_PERSON_ROLES.MEMBER ? divisionName.trim() : null,
      role === PROJECT_PERSON_ROLES.MEMBER ? MEMBER_TYPES.RESEARCHER : null,
      normalizedTerm,
      `%${normalizedTerm}%`,
    ],
  );
  return result.rows;
}

export async function warmProjectAutocompleteCache(deps: ProjectDependencies = {}) {
  const db = dbClient(deps.db);
  const [universities, divisions, people] = await Promise.all([
    db.query(
      `SELECT name
         FROM universities
        WHERE active = true
        ORDER BY name`,
    ),
    db.query(
      `SELECT u.name AS university_name, d.name, d.color
         FROM divisions d
         JOIN universities u ON u.id = d.university_id
        WHERE u.active = true
          AND d.active = true
        ORDER BY u.name, d.name`,
    ),
    db.query(
      `SELECT m.discord_user_id, m.full_name, m.member_type,
              u.name AS university_name, d.name AS division_name,
              EXISTS (
                SELECT 1
                  FROM board_assignments br
                 WHERE br.discord_user_id = m.discord_user_id
                   AND br.university_id = m.university_id
                   AND br.active = true
                   AND br.role IN ('head', 'vice_president', 'president')
              ) AS is_university_board_member
         FROM members m
         JOIN universities u ON u.id = m.university_id
         LEFT JOIN member_divisions md ON md.discord_user_id = m.discord_user_id
         LEFT JOIN divisions d ON d.id = md.division_id AND d.active = true
        WHERE m.status = 'active'
          AND u.active = true
        ORDER BY coalesce(m.full_name, ''), m.discord_user_id`,
    ),
  ]);

  projectAutocompleteCache.universities = universities.rows;
  projectAutocompleteCache.divisions = divisions.rows;
  projectAutocompleteCache.people = people.rows;
  projectAutocompleteCache.loadedAt = Date.now();
  return projectAutocompleteCache;
}

function refreshProjectAutocompleteCacheInBackground(deps) {
  if (Date.now() - projectAutocompleteCache.loadedAt <= PROJECT_AUTOCOMPLETE_CACHE_TTL_MS) return;
  projectAutocompleteCache.loadedAt = Date.now();
  void warmProjectAutocompleteCache(deps).catch(() => {
    projectAutocompleteCache.loadedAt = 0;
  });
}
