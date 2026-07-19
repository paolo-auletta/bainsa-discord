import { BOARD_ROLES, MEMBER_TYPES, ROLE_NAMES } from '../constants.mjs';
import { divisionHeadRoleName, divisionRoleName } from '../naming.mjs';

export async function reconcileExistingMembers({
  guild,
  rolesByName,
  plan,
  db,
  resources,
  dryRun = false,
}) {
  const members = await guild.members.fetch();
  const resourceIndex = buildResourceIndex(resources);
  const summaries = [];

  for (const member of members.values()) {
    if (member.user?.bot) continue;
    const recognition = recognizeMemberFromRoles(member, plan);
    if (!recognition) continue;

    const memberType = recognition.alumni ? MEMBER_TYPES.ALUMNI : MEMBER_TYPES.RESEARCHER;
    const desiredTypeRole = rolesByName.get(
      memberType === MEMBER_TYPES.ALUMNI ? ROLE_NAMES.ALUMNI : ROLE_NAMES.RESEARCHER,
    );
    const otherTypeRole = rolesByName.get(
      memberType === MEMBER_TYPES.ALUMNI ? ROLE_NAMES.RESEARCHER : ROLE_NAMES.ALUMNI,
    );
    const roleChanges = plannedMemberTypeRoleChanges(member, desiredTypeRole, otherTypeRole);
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
      roleChanges,
    };
    summaries.push(summary);

    if (!dryRun) {
      await applyMemberTypeRoleChanges(member, desiredTypeRole, otherTypeRole);
      if (db && primaryUniversity) {
        await upsertRecognizedMember(db, {
          discordUserId: member.id,
          memberType,
          primaryUniversity,
          recognition,
          resourceIndex,
        });
      }
    }
  }

  return {
    planned: summaries.length,
    changedRoleCount: summaries.filter((summary) => summary.roleChanges.length > 0).length,
    members: summaries,
    skippedDatabase: dryRun || !db,
  };
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

async function upsertRecognizedMember(db, {
  discordUserId,
  memberType,
  primaryUniversity,
  recognition,
  resourceIndex,
}) {
  const universityRecord = resourceIndex.universities.get(primaryUniversity.slug);
  if (!universityRecord?.id) return;

  await db.query(
    `INSERT INTO members
      (discord_user_id, university_id, member_type, status, joined_at, updated_at)
     VALUES ($1, $2, $3, 'active', NOW(), NOW())
     ON CONFLICT (discord_user_id)
     DO UPDATE SET
       university_id = EXCLUDED.university_id,
       member_type = EXCLUDED.member_type,
       status = 'active',
       removed_at = NULL,
       updated_at = NOW()`,
    [String(discordUserId), universityRecord.id, memberType],
  );

  await db.query(
    'DELETE FROM member_divisions WHERE discord_user_id = $1',
    [String(discordUserId)],
  );
  await db.query(
    `UPDATE board_assignments
        SET active = false,
            updated_at = NOW()
      WHERE discord_user_id = $1
        AND active = true`,
    [String(discordUserId)],
  );

  for (const { university, division } of recognition.divisions) {
    const divisionRecord = resourceIndex.divisions.get(`${university.slug}:${division.slug}`);
    if (!divisionRecord?.id) continue;
    await db.query(
      `INSERT INTO member_divisions (discord_user_id, division_id)
       VALUES ($1, $2)
       ON CONFLICT DO NOTHING`,
      [String(discordUserId), divisionRecord.id],
    );
  }

  for (const assignment of recognition.boardAssignments) {
    const assignmentUniversity = assignment.university
      ? resourceIndex.universities.get(assignment.university.slug)
      : null;
    const assignmentDivision = assignment.division
      ? resourceIndex.divisions.get(`${assignment.university.slug}:${assignment.division.slug}`)
      : null;
    await db.query(
      `INSERT INTO board_assignments (discord_user_id, university_id, role, division_id, active)
       VALUES ($1, $2, $3, $4, true)
       ON CONFLICT DO NOTHING`,
      [
        String(discordUserId),
        assignmentUniversity?.id ?? null,
        assignment.role,
        assignmentDivision?.id ?? null,
      ],
    );
  }
}
