import { divisionLabel } from '../../constants.js';
import { query } from '../../db.js';
import { canViewProject } from './policy.js';

const DEFAULT_DB = { query };
type ProjectDependencies = { db?: typeof DEFAULT_DB };

const PROJECT_AUTOCOMPLETE_CACHE_TTL_MS = 30_000;
const projectAutocompleteCache = {
  loadedAt: 0,
  universities: [],
  divisions: [],
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

export async function listProjectUniversities(deps: ProjectDependencies = {}) {
  if (projectAutocompleteCache.loadedAt) {
    refreshProjectAutocompleteCacheInBackground(deps);
    return [...projectAutocompleteCache.universities];
  }
  const db = dbClient(deps.db);
  const result = await db.query(
    `SELECT name
       FROM universities
      WHERE active = true
      ORDER BY name`,
  );
  return result.rows;
}

export async function listProjectDivisions(universityName, deps: ProjectDependencies = {}) {
  if (!universityName?.trim()) return [];
  if (projectAutocompleteCache.loadedAt) {
    refreshProjectAutocompleteCacheInBackground(deps);
    const normalizedUniversity = universityName.trim().toLowerCase();
    return projectAutocompleteCache.divisions
      .filter((row) => row.university_name.toLowerCase() === normalizedUniversity)
      .map(({ name, color }) => ({ name, color }));
  }
  const db = dbClient(deps.db);
  const result = await db.query(
    `SELECT d.name, d.color
       FROM divisions d
       JOIN universities u ON u.id = d.university_id
      WHERE u.active = true
        AND d.active = true
        AND lower(u.name) = lower($1)
      ORDER BY d.name`,
    [universityName.trim()],
  );
  return result.rows;
}

export async function warmProjectAutocompleteCache(deps: ProjectDependencies = {}) {
  const db = dbClient(deps.db);
  const [universities, divisions] = await Promise.all([
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
  ]);

  projectAutocompleteCache.universities = universities.rows;
  projectAutocompleteCache.divisions = divisions.rows;
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
