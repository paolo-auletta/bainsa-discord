import { query } from '../../db.js';
import { canViewProject } from './policy.js';
import { projectAutocompleteChoice } from './formatters.js';
import {
  findActiveProjectDivisions,
  findActiveProjectUniversities,
  findVisibleProjectCandidates,
  loadActiveProjectAutocompleteCache,
  listActiveProjectDivisions,
  listActiveProjectUniversities,
} from './repository.js';

const DEFAULT_DB = { query };
type ProjectDependencies = { db?: typeof DEFAULT_DB };
const PROJECT_AUTOCOMPLETE_LIMIT = 25;

const PROJECT_AUTOCOMPLETE_CACHE_TTL_MS = 30_000;
const projectAutocompleteCache = {
  loadedAt: 0,
  universities: [],
  divisions: [],
};

function dbClient(db) {
  return db ?? DEFAULT_DB;
}

function roleNames(member) {
  const roles = member?.roles?.cache;
  if (!roles?.values) return [];
  return [...roles.values()].map((role) => String(role.name));
}

export async function searchVisibleProjects(input, deps: ProjectDependencies = {}) {
  const db = dbClient(deps.db);
  const term = `%${String(input.query ?? '').trim()}%`;
  const statuses = input.statuses?.map((status) => String(status)) ?? null;
  if (statuses?.length === 0) return [];
  const statusSet = statuses ? new Set(statuses) : null;
  const candidates = await findVisibleProjectCandidates(db, {
    term,
    actorId: input.interaction.user.id,
    statuses,
    roleNames: roleNames(input.interaction.member),
  });
  // Retain the policy check as defense in depth against role-name convention
  // changes; SQL already applies the same visibility boundary before LIMIT 25.
  return candidates
    .filter((project) => !statusSet || statusSet.has(String(project.status)))
    .filter((project) =>
      canViewProject(
        input.interaction.member,
        project,
        project.actor_is_project_person ? [{ discord_user_id: input.interaction.user.id }] : [],
      ),
    )
    .slice(0, PROJECT_AUTOCOMPLETE_LIMIT)
    .map(projectAutocompleteChoice);
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
  return findActiveProjectUniversities(db, normalizedTerm);
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
  return findActiveProjectDivisions(db, universityName.trim(), normalizedTerm);
}

export async function listProjectUniversities(deps: ProjectDependencies = {}) {
  if (projectAutocompleteCache.loadedAt) {
    refreshProjectAutocompleteCacheInBackground(deps);
    return [...projectAutocompleteCache.universities];
  }
  const db = dbClient(deps.db);
  return listActiveProjectUniversities(db);
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
  return listActiveProjectDivisions(db, universityName.trim());
}

export async function warmProjectAutocompleteCache(deps: ProjectDependencies = {}) {
  const db = dbClient(deps.db);
  const cache = await loadActiveProjectAutocompleteCache(db);
  projectAutocompleteCache.universities = cache.universities;
  projectAutocompleteCache.divisions = cache.divisions;
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
