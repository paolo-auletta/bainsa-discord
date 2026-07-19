import { divisionLabel, MEMBER_TYPES, PROJECT_PERSON_ROLES } from '../../constants.mjs';
import { query } from '../../db.mjs';
import { canViewProject } from './policy.mjs';

const PROJECT_AUTOCOMPLETE_CACHE_TTL_MS = 30_000;
const projectAutocompleteCache = {
  loadedAt: 0,
  universities: [],
  divisions: [],
  people: [],
};

function dbClient(db) {
  return db ?? { query };
}

export async function searchVisibleProjects(input, deps = {}) {
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
     ORDER BY p.updated_at DESC NULLS LAST, p.id DESC
     LIMIT 100`,
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

export async function findProjectUniversities(term = '', deps = {}) {
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

export async function findProjectDivisions(universityName, term = '', deps = {}) {
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

export async function findProjectPeople({ universityName, divisionName, role, term = '' }, deps = {}) {
  if (!universityName?.trim()) return [];
  if (!divisionName?.trim()) return [];
  if (projectAutocompleteCache.loadedAt) {
    refreshProjectAutocompleteCacheInBackground(deps);
    const normalizedUniversity = universityName.trim().toLowerCase();
    const normalizedDivision = divisionName?.trim().toLowerCase() ?? '';
    const normalizedTerm = String(term).trim().toLowerCase();
    return projectAutocompleteCache.people
      .filter((row) =>
        row.university_name.toLowerCase() === normalizedUniversity &&
        row.division_name?.toLowerCase() === normalizedDivision &&
        (role !== PROJECT_PERSON_ROLES.MEMBER || row.member_type === MEMBER_TYPES.RESEARCHER) &&
        (!normalizedTerm || row.full_name?.toLowerCase().includes(normalizedTerm) || row.discord_user_id.includes(normalizedTerm)),
      )
      .map(({ discord_user_id, full_name }) => ({ discord_user_id, full_name }))
      .slice(0, 25);
  }
  const db = dbClient(deps.db);
  const normalizedTerm = String(term).trim();
  const result = await db.query(
    `SELECT m.discord_user_id, m.full_name
       FROM members m
       JOIN universities u ON u.id = m.university_id
       LEFT JOIN member_divisions md ON md.discord_user_id = m.discord_user_id
       LEFT JOIN divisions d ON d.id = md.division_id
      WHERE m.status = 'active'
        AND u.active = true
        AND lower(u.name) = lower($1)
        AND ($2::text IS NULL OR (d.active = true AND lower(d.name) = lower($2)))
        AND ($3::text IS NULL OR m.member_type = $3)
        AND ($4 = '' OR coalesce(m.full_name, '') ILIKE $5 OR m.discord_user_id ILIKE $5)
      ORDER BY coalesce(m.full_name, ''), m.discord_user_id
      LIMIT 25`,
    [
      universityName.trim(),
      divisionName.trim(),
      role === PROJECT_PERSON_ROLES.MEMBER ? MEMBER_TYPES.RESEARCHER : null,
      normalizedTerm,
      `%${normalizedTerm}%`,
    ],
  );
  return result.rows;
}

export async function warmProjectAutocompleteCache(deps = {}) {
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
              u.name AS university_name, d.name AS division_name
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
