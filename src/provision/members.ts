import {
  BOARD_ROLES,
  MEMBER_TYPES,
  ROLE_NAMES,
} from '../constants.js';
import { assertUser } from '../errors.js';
import { divisionHeadRoleName, divisionRoleName } from '../naming.js';
import {
  ACTIVE_PROJECT_STATUSES,
  isEligibleForProjectPerson,
  lockMemberEligibilityRows,
} from '../services/projects/eligibility.js';

// Discord rate limits role mutations independently from the database work. Keep
// this deliberately small; callers can lower it for constrained guilds/tests.
export const MEMBER_RECONCILIATION_DISCORD_CONCURRENCY = 3;
const DATABASE_WRITE_BATCH_SIZE = 1_000;
const UNIVERSITY_BOARD_PROJECT_ROLES = new Set([
  BOARD_ROLES.HEAD,
  BOARD_ROLES.VICE_PRESIDENT,
  BOARD_ROLES.PRESIDENT,
]);

export async function reconcileExistingMembers({
  guild,
  rolesByName,
  plan,
  db,
  resources,
  dryRun = false,
  discordConcurrency = MEMBER_RECONCILIATION_DISCORD_CONCURRENCY,
}) {
  const members = await guild.members.fetch();
  const reconciliations = planMemberReconciliation({ members, rolesByName, plan, resources });
  const summaries = reconciliations.map(({ summary }) => summary);

  const result = {
    planned: summaries.length,
    changedRoleCount: summaries.filter((summary) => summary.roleChanges.length > 0).length,
    members: summaries,
    skippedDatabase: dryRun || !db,
  };

  if (dryRun) return result;

  const roleResults = await applyRoleChangesBounded(reconciliations, discordConcurrency);
  const roleFailures = roleResults.filter((outcome) => outcome.error);
  const databaseRecords = roleResults
    .filter((outcome) => !outcome.error)
    .map((outcome) => outcome.reconciliation.databaseRecord)
    .filter(Boolean);

  let databaseError = null;
  if (db && databaseRecords.length > 0) {
    try {
      await reconcileRecognizedMembers(db, databaseRecords);
    } catch (error) {
      databaseError = error;
    }
  }

  if (roleFailures.length > 0 || databaseError) {
    const errors = [
      ...roleFailures.map((outcome) => outcome.error),
      ...(databaseError ? [databaseError] : []),
    ];
    const error = new AggregateError(errors, 'Existing member reconciliation completed with failures.') as AggregateError & {
      reconciliation?: unknown;
    };
    // The public success summary stays unchanged. On failure, callers can
    // inspect exactly which Discord mutations succeeded and retry only errors.
    error.reconciliation = {
      ...result,
      roleResults: roleResults.map(({ reconciliation, error: roleError }) => ({
        discordUserId: reconciliation.summary.discordUserId,
        status: roleError ? 'failed' : 'applied',
        error: roleError ?? null,
      })),
      databaseError,
    };
    throw error;
  }

  return result;
}

export function planMemberReconciliation({ members, rolesByName, plan, resources }) {
  const resourceIndex = buildResourceIndex(resources);
  return [...members.values()]
    .filter((member) => !member.user?.bot)
    .sort((left, right) => String(left.id).localeCompare(String(right.id)))
    .flatMap((member) => {
      const recognition = recognizeMemberFromRoles(member, plan);
      if (!recognition) return [];

      const memberType = recognition.alumni ? MEMBER_TYPES.ALUMNI : MEMBER_TYPES.RESEARCHER;
      const desiredTypeRole = rolesByName.get(
        memberType === MEMBER_TYPES.ALUMNI ? ROLE_NAMES.ALUMNI : ROLE_NAMES.RESEARCHER,
      );
      const otherTypeRole = rolesByName.get(
        memberType === MEMBER_TYPES.ALUMNI ? ROLE_NAMES.RESEARCHER : ROLE_NAMES.ALUMNI,
      );
      const primaryUniversity = recognition.universities[0];
      const summary = {
        discordUserId: member.id,
        memberType,
        university: primaryUniversity?.name ?? null,
        divisions: recognition.divisions.map((division) => division.name),
        boardAssignments: recognition.boardAssignments.map((assignment) => ({
          role: assignment.role,
          university: assignment.university?.name ?? null,
          division: assignment.division?.name ?? null,
        })),
        roleChanges: plannedMemberTypeRoleChanges(member, desiredTypeRole, otherTypeRole),
      };
      const databaseRecord = primaryUniversity
        ? recognizedMemberDatabaseRecord({
          discordUserId: member.id,
          memberType,
          primaryUniversity,
          recognition,
          resourceIndex,
        })
        : null;
      return [{ member, desiredTypeRole, otherTypeRole, summary, databaseRecord }];
    });
}

export function recognizeMemberFromRoles(member, plan) {
  const roleNames = new Set(member.roles.cache.map((role) => role.name));
  const universities = [];
  const divisions = [];
  const boardAssignments = [];
  let alumni = roleNames.has(ROLE_NAMES.ALUMNI);
  let recognized = roleNames.has(ROLE_NAMES.RESEARCHER) || alumni || roleNames.has(ROLE_NAMES.GLOBAL_PRESIDENT);

  for (const university of plan.universities) {
    const hasUniversityMemberRole = hasAnyRole(roleNames, [
      university.universityRole,
      `${university.name} | Member`,
      `${university.name} | Alumni`,
    ]);
    const hasLegacyAlumniRole = roleNames.has(`${university.name} | Alumni`);

    let universityRecognized = hasUniversityMemberRole;
    if (hasLegacyAlumniRole) alumni = true;

    if (hasAnyRole(roleNames, [university.presidentRole, `${university.name} | President`, `${university.name} President`])) {
      boardAssignments.push({ role: BOARD_ROLES.PRESIDENT, university, division: null });
      universityRecognized = true;
    }
    if (
      hasAnyRole(roleNames, [
        university.vicePresidentRole,
        `${university.name} | Vice-President`,
        `${university.name} | Vice President`,
        `${university.name} Vice-President`,
        `${university.name} Vice President`,
      ])
    ) {
      boardAssignments.push({ role: BOARD_ROLES.VICE_PRESIDENT, university, division: null });
      universityRecognized = true;
    }

    for (const division of university.divisions) {
      const hasDivision = hasAnyRole(roleNames, [
        divisionRoleName(university.name, division.name),
        `${university.name} | ${division.name}`,
        `${university.name} ${division.name}`,
      ]);
      const hasHead = hasAnyRole(roleNames, [
        divisionHeadRoleName(university.name, division.name),
        `${university.name} | ${division.name} Head`,
        `${university.name} ${division.name} Head`,
        `${university.name} - ${division.name} Head`,
      ]);
      if (hasDivision || hasHead) {
        divisions.push({ university, division });
        universityRecognized = true;
      }
      if (hasHead) {
        boardAssignments.push({ role: BOARD_ROLES.HEAD, university, division });
      }
    }

    if (universityRecognized) {
      universities.push(university);
      recognized = true;
    }
  }

  if (roleNames.has(ROLE_NAMES.GLOBAL_PRESIDENT) || roleNames.has('Global Admin')) {
    boardAssignments.push({ role: BOARD_ROLES.GLOBAL_PRESIDENT, university: null, division: null });
    recognized = true;
  }

  if (!recognized) return null;
  return { alumni, universities, divisions, boardAssignments };
}

function hasAnyRole(roleNames, names) {
  return names.some((name) => roleNames.has(name));
}

function plannedMemberTypeRoleChanges(member, desiredTypeRole, otherTypeRole) {
  const changes = [];
  if (desiredTypeRole && !member.roles.cache.has(desiredTypeRole.id)) {
    changes.push({ action: 'add', roleId: desiredTypeRole.id, roleName: desiredTypeRole.name });
  }
  if (otherTypeRole && member.roles.cache.has(otherTypeRole.id)) {
    changes.push({ action: 'remove', roleId: otherTypeRole.id, roleName: otherTypeRole.name });
  }
  return changes;
}

async function applyMemberTypeRoleChanges(member, desiredTypeRole, otherTypeRole) {
  if (desiredTypeRole && !member.roles.cache.has(desiredTypeRole.id)) {
    await member.roles.add(desiredTypeRole, 'BAINSA existing member reconciliation');
  }
  if (otherTypeRole && member.roles.cache.has(otherTypeRole.id)) {
    await member.roles.remove(otherTypeRole, 'BAINSA existing member reconciliation');
  }
}

async function applyRoleChangesBounded(reconciliations, concurrency) {
  const results = new Array(reconciliations.length);
  const workerCount = Math.min(reconciliations.length, normalizedConcurrency(concurrency));
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < reconciliations.length) {
      const index = nextIndex;
      nextIndex += 1;
      const reconciliation = reconciliations[index];
      try {
        await applyMemberTypeRoleChanges(
          reconciliation.member,
          reconciliation.desiredTypeRole,
          reconciliation.otherTypeRole,
        );
        results[index] = { reconciliation, error: null };
      } catch (error) {
        results[index] = { reconciliation, error };
      }
    }
  }

  await Promise.all(Array.from({ length: workerCount }, worker));
  return results;
}

function normalizedConcurrency(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0
    ? parsed
    : MEMBER_RECONCILIATION_DISCORD_CONCURRENCY;
}

function buildResourceIndex(resources) {
  const universities = new Map();
  const divisions = new Map();
  for (const university of resources?.universities ?? []) {
    universities.set(university.slug, university);
    for (const division of university.divisions ?? []) {
      divisions.set(`${university.slug}:${division.slug}`, division);
    }
  }
  return { universities, divisions };
}

function recognizedMemberDatabaseRecord({
  discordUserId,
  memberType,
  primaryUniversity,
  recognition,
  resourceIndex,
}) {
  const universityRecord = resourceIndex.universities.get(primaryUniversity.slug);
  if (!universityRecord?.id) return null;
  const divisionIds = memberType === MEMBER_TYPES.RESEARCHER
    ? recognition.divisions
      .map(({ university, division }) => resourceIndex.divisions.get(`${university.slug}:${division.slug}`)?.id)
      .filter(Boolean)
    : [];

  return {
    discordUserId: String(discordUserId),
    memberType,
    universityId: universityRecord.id,
    divisionIds,
    boardAssignments: recognition.boardAssignments
      .map((assignment) => ({
        universityId: assignment.university
          ? resourceIndex.universities.get(assignment.university.slug)?.id ?? null
          : null,
        divisionId: assignment.division
          ? resourceIndex.divisions.get(`${assignment.university.slug}:${assignment.division.slug}`)?.id ?? null
          : null,
        role: assignment.role,
      })),
  };
}

async function reconcileRecognizedMembers(db, records) {
  await membershipTransaction(db, async (q) => {
    await lockMemberEligibilityRows(q, records.map((record) => record.discordUserId));
    await assertRecognizedMembersProjectEligibility(q, records);
    await insertMembers(q, records);
    await q.query(
      'DELETE FROM member_divisions WHERE discord_user_id = ANY($1::text[])',
      [records.map((record) => record.discordUserId)],
    );
    await q.query(
      `UPDATE board_assignments
         SET active = false,
             updated_at = NOW()
       WHERE discord_user_id = ANY($1::text[])
         AND active = true`,
      [records.map((record) => record.discordUserId)],
    );
    await insertRows(q, 'member_divisions', ['discord_user_id', 'division_id'], records.flatMap((record) =>
      record.divisionIds.map((divisionId) => [record.discordUserId, divisionId])),
    );
    await insertRows(
      q,
      'board_assignments',
      ['discord_user_id', 'university_id', 'role', 'division_id', 'active'],
      records.flatMap((record) => record.boardAssignments.map((assignment) => [
        record.discordUserId,
        assignment.universityId,
        assignment.role,
        assignment.divisionId,
        true,
      ])),
    );
  });
}

async function assertRecognizedMembersProjectEligibility(q, records) {
  const result = await q.query(
    `SELECT pp.discord_user_id, p.id, p.name, p.university_id, p.division_id, pp.role
       FROM project_people pp
       JOIN projects p ON p.id = pp.project_id
      WHERE pp.discord_user_id = ANY($1::text[])
        AND p.status = ANY($2::text[])
      ORDER BY pp.discord_user_id, p.name, p.id, pp.role`,
    [records.map((record) => record.discordUserId), ACTIVE_PROJECT_STATUSES],
  );
  const projectsByUser = new Map();
  for (const project of result.rows) {
    const userId = String(project.discord_user_id);
    const projects = projectsByUser.get(userId) ?? [];
    projects.push(project);
    projectsByUser.set(userId, projects);
  }

  for (const record of records) {
    const allowedDivisions = new Set(record.divisionIds.map((divisionId) => String(divisionId)));
    const boardUniversityIds = new Set(record.boardAssignments
      .filter((assignment) => UNIVERSITY_BOARD_PROJECT_ROLES.has(assignment.role))
      .map((assignment) => String(assignment.universityId)));
    const incompatible = (projectsByUser.get(record.discordUserId) ?? []).filter((project) => {
      const desiredMember = {
        member_type: record.memberType,
        university_id: record.universityId,
        status: 'active',
        divisionIds: allowedDivisions,
        isUniversityBoardMember: boardUniversityIds.has(String(project.university_id)),
      };
      return !isEligibleForProjectPerson(desiredMember, project, project.role);
    });
    assertUser(
      incompatible.length === 0,
      `Cannot update this member because it would make them ineligible for active projects: ${incompatible
        .map((project) => `#${project.id} ${project.name}`)
        .join(', ')}. Remove or reassign their project participation first.`,
    );
  }
}

async function insertMembers(q, records) {
  await insertRows(
    q,
    'members',
    ['discord_user_id', 'university_id', 'member_type', 'status', 'joined_at', 'updated_at'],
    records.map((record) => [record.discordUserId, record.universityId, record.memberType, 'active', 'NOW()', 'NOW()']),
    {
      literalColumns: new Set(['joined_at', 'updated_at']),
      conflictClause: ` ON CONFLICT (discord_user_id)
        DO UPDATE SET
          university_id = EXCLUDED.university_id,
          member_type = EXCLUDED.member_type,
          status = 'active',
          removed_at = NULL,
          updated_at = NOW()`,
    },
  );
}

async function insertRows(q, tableName, columns, rows, {
  literalColumns = new Set(),
  conflictClause = ' ON CONFLICT DO NOTHING',
} = {}) {
  for (const rowBatch of chunk(rows, DATABASE_WRITE_BATCH_SIZE)) {
    if (rowBatch.length === 0) continue;
    const values = [];
    const placeholders = rowBatch.map((row) => `(${row.map((value, index) => {
      if (literalColumns.has(columns[index])) return value;
      values.push(value);
      return `$${values.length}`;
    }).join(', ')})`);
    await q.query(
      `INSERT INTO ${tableName} (${columns.join(', ')}) VALUES ${placeholders.join(', ')}${conflictClause}`,
      values,
    );
  }
}

function* chunk(values, size) {
  for (let index = 0; index < values.length; index += size) {
    yield values.slice(index, index + size);
  }
}

async function membershipTransaction(db, work) {
  if (typeof db.transaction === 'function') return db.transaction(work);
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
