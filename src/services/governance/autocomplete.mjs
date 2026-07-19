import * as defaultDb from '../../db.mjs';
import { logger } from '../../logger.mjs';
import { getUniversityByName } from './repository.mjs';

const GOVERNANCE_AUTOCOMPLETE_CACHE_TTL_MS = 30_000;
const governanceAutocompleteCache = {
  loadedAt: 0,
  generation: 0,
  refreshPromise: null,
  universities: [],
  divisions: [],
};

function dbFrom(deps) {
  return deps?.db ?? defaultDb;
}

async function loadGovernanceAutocompleteCache(db) {
  const [universities, divisions] = await Promise.all([
    db.query(
      `SELECT id, name
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

  return {
    universities: universities.rows,
    divisions: divisions.rows,
  };
}

function saveGovernanceAutocompleteCache(snapshot, generation) {
  if (generation !== governanceAutocompleteCache.generation) return;
  governanceAutocompleteCache.universities = snapshot.universities;
  governanceAutocompleteCache.divisions = snapshot.divisions;
  governanceAutocompleteCache.loadedAt = Date.now();
}

function refreshGovernanceAutocompleteCacheInBackground() {
  if (
    governanceAutocompleteCache.refreshPromise ||
    Date.now() - governanceAutocompleteCache.loadedAt <= GOVERNANCE_AUTOCOMPLETE_CACHE_TTL_MS
  ) {
    return;
  }

  const generation = governanceAutocompleteCache.generation;
  const promise = loadGovernanceAutocompleteCache(dbFrom())
    .then((snapshot) => saveGovernanceAutocompleteCache(snapshot, generation))
    .catch((error) => {
      logger.warn('Could not refresh governance autocomplete cache', {
        error: error instanceof Error ? error.message : String(error),
      });
    })
    .finally(() => {
      if (governanceAutocompleteCache.refreshPromise === promise) {
        governanceAutocompleteCache.refreshPromise = null;
      }
    });
  governanceAutocompleteCache.refreshPromise = promise;
}

export async function warmGovernanceAutocompleteCache(deps = {}) {
  const snapshot = await loadGovernanceAutocompleteCache(dbFrom(deps));
  if (!deps.db) saveGovernanceAutocompleteCache(snapshot, governanceAutocompleteCache.generation);
  return snapshot;
}

export function invalidateGovernanceAutocompleteCache() {
  governanceAutocompleteCache.generation += 1;
  governanceAutocompleteCache.loadedAt = 0;
}

export async function findUniversities(term = '', deps = {}) {
  if (!deps.db && governanceAutocompleteCache.loadedAt) {
    refreshGovernanceAutocompleteCacheInBackground();
    const normalizedTerm = String(term).trim().toLowerCase();
    return governanceAutocompleteCache.universities
      .filter((row) => !normalizedTerm || row.name.toLowerCase().includes(normalizedTerm))
      .slice(0, 25);
  }

  const db = dbFrom(deps);
  const normalizedTerm = String(term).trim();
  const result = await db.query(
    `SELECT id, name
       FROM universities
      WHERE active = true
        AND ($1 = '' OR name ILIKE $2)
      ORDER BY name
      LIMIT 25`,
    [normalizedTerm, `%${normalizedTerm}%`],
  );
  return result.rows;
}

export async function findDivisions(universityName, term = '', deps = {}) {
  const db = dbFrom(deps);
  if (!universityName) return [];

  if (!deps.db && governanceAutocompleteCache.loadedAt) {
    refreshGovernanceAutocompleteCacheInBackground();
    const normalizedUniversity = String(universityName).trim().toLowerCase();
    const normalizedTerm = String(term).trim().toLowerCase();
    return governanceAutocompleteCache.divisions
      .filter((row) =>
        row.university_name.toLowerCase() === normalizedUniversity &&
        (!normalizedTerm || row.name.toLowerCase().includes(normalizedTerm)),
      )
      .map(({ name, color }) => ({ name, color }))
      .slice(0, 25);
  }

  const university = await getUniversityByName(db, universityName);
  const normalizedTerm = String(term).trim();
  const result = await db.query(
    `SELECT id, name, color
       FROM divisions
      WHERE university_id = $1
        AND active = true
        AND ($2 = '' OR name ILIKE $3)
      ORDER BY name
      LIMIT 25`,
    [university.id, normalizedTerm, `%${normalizedTerm}%`],
  );
  return result.rows;
}
