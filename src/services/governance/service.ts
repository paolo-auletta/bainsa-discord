import { ChannelType } from 'discord.js';

import * as defaultDb from '../../db.js';
import { writeAudit } from '../../audit.js';
import {
  assertDivisionAuthority,
  assertUniversityAuthority,
  hasRole,
  isGlobalPresident,
} from '../../authorization.js';
import {
  BOARD_ROLES,
  divisionColorDetails,
  DIVISION_COLORS,
  MEMBER_TYPES,
  PROJECT_PERSON_ROLES,
  PROJECT_STATUSES,
  ROLE_NAMES,
  universityRoleColor,
} from '../../constants.js';
import { assertUser, UserFacingError } from '../../errors.js';
import { logger } from '../../logger.js';
import {
  divisionHeadRoleName,
  divisionRoleName,
  normalizeDisplayName,
  slugify,
  universityBoardRoleName,
} from '../../naming.js';
import {
  assertCanAssignBoardRole,
  assertCanManageMember,
  assertCanRemoveBoardRole,
  assertCanRemoveMember,
  assertMemberType,
  assertNoDivisionRolesForAlumni,
  assertBoardAssignDivisionShape,
  assertBoardRemoveDivisionShape,
  boardRoleLabel,
  parseDivisionList,
} from './policy.js';
import {
  assertMemberProjectAssignmentEligibility,
  lockDivisionHeadEligibilityRows,
  lockMemberEligibilityRows,
} from '../projects/eligibility.js';
import {
  findDivisions,
  findUniversities,
  invalidateGovernanceAutocompleteCache,
  warmGovernanceAutocompleteCache,
} from './autocomplete.js';
import {
  createDivisionChannel,
  divisionChannelName,
  divisionChannelOverwrites,
  divisionOverwriteRoles,
  persistedUniversityCategory,
  removeProjectPermissionOverwrites,
  renameChannelByIdWithPreviousName,
  targetGuildMember,
} from './gateway.js';
import {
  formatBoardInfo,
  formatMemberInfo,
  memberRemovalCleanupPlan,
  projectChannelCleanupTargets,
  resolveDivisionTextForMemberUpdate,
  roleNamesForDivisionHead,
} from './formatters.js';
import {
  addMemberDivisionRow,
  getActiveProjectAssignments,
  getBoardRoles,
  getDivisionByName,
  getDivisionRecords,
  getMemberDivisions,
  getMemberRecord,
  getProjectAssignmentsForRemoval,
  getUniversityDivisionDiscordRoleIds,
  getUniversityByName,
  removeMemberDivisionRow,
  replaceMemberDivisionRows,
  upsertMemberRecord,
} from './repository.js';

type GovernanceDependencies = { db?: typeof defaultDb };

const ACTIVE_PROJECT_STATUSES = [PROJECT_STATUSES.ACTIVE, PROJECT_STATUSES.PAUSED];

function dbFrom(deps: GovernanceDependencies = {}) {
  return deps?.db ?? defaultDb;
}

function actorMember(interaction) {
  assertUser(interaction.guild, 'This command can only be used inside the BAINSA server.');
  assertUser(interaction.member, 'Could not resolve your server member profile.');
  return interaction.member;
}

function universityAccessRoleName(universityName) {
  return normalizeDisplayName(universityName);
}

function roleByName(guild, roleName) {
  return guild.roles.cache.find((role) => role.name === roleName) ?? null;
}

function isDivisionScopedRoleName(roleName) {
  if (roleName.includes(' - Head of ')) return true;
  const parts = roleName.split(' - ');
  if (parts.length !== 2) return false;
  return !['President', 'Vice President'].includes(parts[1]);
}

async function ensureRole(
  guild,
  roleName,
  reason,
  { colorOverride = null, updateExistingColor = false, requireExisting = false } = {},
) {
  const existing = roleByName(guild, roleName);
  if (existing) {
    if (
      updateExistingColor &&
      colorOverride &&
      existing.editable &&
      existing.hexColor?.toLowerCase() !== colorOverride.toLowerCase()
    ) {
      await existing.edit({ colors: { primaryColor: colorOverride }, reason });
    }
    return { role: existing, created: false };
  }
  if (requireExisting) {
    throw new UserFacingError(`Required division role is missing: ${roleName}. Run provisioning before assigning it.`);
  }
  const color = colorOverride ?? colorForRoleName(roleName);
  const role = await guild.roles.create({
    name: roleName,
    ...(color ? { colors: { primaryColor: color } } : {}),
    reason,
  });
  return { role, created: true };
}

function colorForRoleName(roleName) {
  if (roleName === ROLE_NAMES.RESEARCHER) return '#7A7A7A';
  if (roleName === ROLE_NAMES.ALUMNI) return '#27AE60';
  if (roleName === ROLE_NAMES.GLOBAL_PRESIDENT) return '#F2994A';
  const universityName = roleName.split(' - ')[0];
  return universityRoleColor(universityName);
}

async function ensureRoles(guild, roleNames, reason) {
  const results = [];
  for (const roleName of roleNames) {
    results.push(await ensureRole(guild, roleName, reason, {
      requireExisting: isDivisionScopedRoleName(roleName),
    }));
  }
  return results;
}

async function addRoles(member, roles, reason) {
  const missing = roles.filter((role) => !member.roles.cache.has(role.id));
  if (missing.length) await member.roles.add(missing, reason);
  return missing;
}

async function removeRolesByName(member, guild, roleNames, reason) {
  const roles = roleNames
    .map((name) => roleByName(guild, name))
    .filter((role) => role && member.roles.cache.has(role.id));
  if (roles.length) await member.roles.remove(roles, reason);
  return roles;
}

async function removeSpecificRoles(member, roles, reason) {
  const uniqueRoles = [...new Map(
    roles
      .filter((role) => role && member.roles.cache.has(role.id))
      .map((role) => [String(role.id), role]),
  ).values()];
  if (uniqueRoles.length) await member.roles.remove(uniqueRoles, reason);
  return uniqueRoles;
}

async function replaceMemberRoles(
  member,
  guild,
  desiredRoleNames,
  removableRoleNames,
  reason,
  removableRoles = [],
) {
  const roleResults = await ensureRoles(guild, desiredRoleNames, reason);
  const desiredRoles = roleResults.map(({ role }) => role);
  const removedByName = await removeRolesByName(
    member,
    guild,
    removableRoleNames.filter((roleName) => !desiredRoleNames.includes(roleName)),
    reason,
  );
  const desiredRoleIds = new Set(desiredRoles.map((role) => String(role.id)));
  const removedById = await removeSpecificRoles(
    member,
    removableRoles.filter((role) => !desiredRoleIds.has(String(role.id))),
    reason,
  );
  const addedRoles = await addRoles(member, desiredRoles, reason);
  return {
    addedRoles,
    removedRoles: [...new Map([...removedByName, ...removedById].map((role) => [String(role.id), role])).values()],
  };
}

function stableRoleNames(roleNames) {
  return [...new Set(roleNames.filter(Boolean))];
}

async function enforceResearcherRoles(
  member,
  guild,
  desiredRoleNames,
  reason,
  { removableRoleNames = [], removableRoles = [] } = {},
) {
  return replaceMemberRoles(
    member,
    guild,
    stableRoleNames([ROLE_NAMES.RESEARCHER, ...desiredRoleNames]),
    stableRoleNames([ROLE_NAMES.ALUMNI, ...removableRoleNames]),
    reason,
    removableRoles,
  );
}

async function compensateRoles(member, addedRoles, removedRoles, reason) {
  await Promise.allSettled([
    addedRoles?.length ? member.roles.remove(addedRoles, reason) : undefined,
    removedRoles?.length ? member.roles.add(removedRoles, reason) : undefined,
  ]);
}

function roleNamesForMember(universityName, memberType, divisions) {
  const baseRole = memberType === MEMBER_TYPES.ALUMNI ? ROLE_NAMES.ALUMNI : ROLE_NAMES.RESEARCHER;
  const divisionRoles =
    memberType === MEMBER_TYPES.RESEARCHER
      ? divisions.map((division) => divisionRoleName(universityName, division.name))
      : [];
  return [baseRole, universityAccessRoleName(universityName), ...divisionRoles];
}

function removableMembershipRoleNames(previousRecord, previousDivisions, nextUniversityName) {
  const names: string[] = [ROLE_NAMES.RESEARCHER, ROLE_NAMES.ALUMNI];
  if (previousRecord?.university_name) names.push(universityAccessRoleName(previousRecord.university_name));
  if (nextUniversityName) names.push(universityAccessRoleName(nextUniversityName));
  for (const division of previousDivisions) {
    names.push(divisionRoleName(division.university_name, division.name));
  }
  return [...new Set(names)];
}

function discordDivisionRolesForUniversity(member, guild, divisionRoleIds) {
  const roleIds = divisionRoleIds.flatMap((division) => [division.member_role_id, division.head_role_id]);
  return roleIds
    .filter(Boolean)
    .map((roleId) => guild.roles.cache.get(String(roleId)))
    .filter((role) => role && member.roles.cache.has(role.id));
}

function assertNoSilentUniversityMove(previousRecord, universityName, commandName) {
  if (!previousRecord?.university_name || previousRecord.university_name === universityName) return;
  assertUser(
    commandName === 'member.update',
    'Existing members must be moved between universities with /member-update by a Global President before using this command.',
  );
}

function assertBoardCompatibleMemberType(memberType, boardRoles) {
  assertUser(
    memberType !== MEMBER_TYPES.ALUMNI || boardRoles.length === 0,
    'Board members must remain Researchers. Remove board roles before changing a member to Alumni.',
  );
}

function assertCanPromoteResearcher(previousRecord, universityName) {
  assertUser(
    !previousRecord?.university_name || previousRecord.university_name === universityName,
    'Existing members must be moved between universities with /member-update by a Global President before using this command.',
  );
}

async function assertNoActiveProjectAccessLoss(db, userId, division) {
  const result = await db.query(
    `SELECT p.id, p.name
       FROM project_people pp
       JOIN projects p ON p.id = pp.project_id
      WHERE pp.discord_user_id = $1
        AND p.division_id = $2
        AND p.status = ANY($3::text[])
        AND NOT EXISTS (
          SELECT 1
            FROM board_assignments br
           WHERE br.discord_user_id = pp.discord_user_id
             AND br.university_id = $4
             AND br.active = true
             AND br.role IN ('head', 'vice_president', 'president')
        )
      ORDER BY p.name
      LIMIT 5`,
    [String(userId), division.id, ACTIVE_PROJECT_STATUSES, division.university_id],
  );
  assertUser(
    result.rowCount === 0,
    `Cannot remove this division role because the member still has active project access in ${division.name}: ${result.rows
      .map((row) => row.name)
      .join(', ')}.`,
  );
}

function projectEligibilityFailure(project, memberType, universityId, divisionIds, universityBoardMember) {
  const sameUniversity = String(project.university_id) === String(universityId);

  if (project.role === PROJECT_PERSON_ROLES.MEMBER) {
    if (sameUniversity && universityBoardMember) return false;
    return (
      memberType !== MEMBER_TYPES.RESEARCHER ||
      !sameUniversity ||
      !divisionIds.has(String(project.division_id))
    );
  }

  if (
    project.role === PROJECT_PERSON_ROLES.SUPERVISOR ||
    project.role === PROJECT_PERSON_ROLES.BOARD_LIAISON
  ) {
    return !sameUniversity;
  }

  return true;
}

async function assertActiveProjectUpdateEligibility(
  db,
  userId,
  memberType,
  university,
  divisions,
  { universityBoardMember = false } = {},
) {
  const result = await db.query(
    `SELECT p.id, p.name, p.university_id, p.division_id, pp.role
       FROM project_people pp
       JOIN projects p ON p.id = pp.project_id
      WHERE pp.discord_user_id = $1
        AND p.status = ANY($2::text[])
      ORDER BY p.name, p.id, pp.role`,
    [String(userId), ACTIVE_PROJECT_STATUSES],
  );
  const divisionIds = new Set(divisions.map((division) => String(division.id)));
  const incompatible = result.rows.filter((project) =>
    projectEligibilityFailure(project, memberType, university.id, divisionIds, universityBoardMember),
  );

  assertUser(
    incompatible.length === 0,
    `Cannot update this member because it would make them ineligible for active projects: ${incompatible
      .map((project) => `#${project.id} ${project.name}`)
      .join(', ')}. Remove or reassign their project participation first.`,
  );
}

async function applyMemberMembership(interaction, options, deps: GovernanceDependencies = {}) {
  const db = dbFrom(deps);
  const actor = actorMember(interaction);
  const target = await targetGuildMember(interaction, options.user);
  const memberType = options.memberType;
  assertMemberType(memberType);

  const divisionNames = parseDivisionList(options.divisionsText);
  assertNoDivisionRolesForAlumni(memberType, divisionNames);

  const university = await getUniversityByName(db, options.university);
  assertCanManageMember(actor, university.name, target);

  const previousRecord = await getMemberRecord(db, target.id);
  const previousDivisions = await getMemberDivisions(db, target.id);
  const boardRoles = await getBoardRoles(db, target.id);
  assertBoardCompatibleMemberType(memberType, boardRoles);
  if (previousRecord?.university_name && previousRecord.university_name !== university.name) {
    assertNoSilentUniversityMove(previousRecord, university.name, options.auditAction);
    assertUser(
      isGlobalPresident(actor) && options.auditAction === 'member.update',
      'Only a Global President can move a member between universities.',
    );
  }

  const divisions = await getDivisionRecords(db, university, divisionNames);
  const universityBoardMember = boardRoles.some((boardRole) =>
    boardRole.university_name === university.name &&
    [BOARD_ROLES.HEAD, BOARD_ROLES.VICE_PRESIDENT, BOARD_ROLES.PRESIDENT].includes(boardRole.role),
  );
  await assertActiveProjectUpdateEligibility(db, target.id, memberType, university, divisions, {
    universityBoardMember,
  });
  const desiredRoleNames = roleNamesForMember(university.name, memberType, divisions);
  const removableRoleNames = removableMembershipRoleNames(previousRecord, previousDivisions, university.name);
  const reason = `BAINSA governance: ${options.auditAction}`;
  const { addedRoles, removedRoles } = await replaceMemberRoles(
    target,
    interaction.guild,
    desiredRoleNames,
    removableRoleNames,
    reason,
  );

  try {
    await db.transaction(async (q) => {
      await lockMemberEligibilityRows(q, [target.id]);
      await assertMemberProjectAssignmentEligibility(q, {
        userId: target.id,
        memberType,
        universityId: university.id,
        divisionIds: divisions.map((division) => division.id),
      });
      await upsertMemberRecord(q, target.id, memberType, university.id, options.notes);
      await replaceMemberDivisionRows(q, target.id, divisions);
      await writeAudit(q, {
        actorId: interaction.user.id,
        action: options.auditAction,
        targetType: 'member',
        targetId: target.id,
        universityId: university.id,
        before: { member: previousRecord, divisions: previousDivisions },
        after: { memberType, university: university.name, divisions: divisions.map((d) => d.name) },
      });
    });
  } catch (error) {
    await compensateRoles(target, addedRoles, removedRoles, 'Compensating failed governance DB write');
    throw new UserFacingError(
      `Discord roles were restored because the database update failed: ${error.message}`,
      { cause: error },
    );
  }

  return {
    target,
    university,
    memberType,
    divisions,
    previousRecord,
    previousDivisions,
  };
}

export async function updateMember(interaction, options, deps: GovernanceDependencies = {}) {
  const db = dbFrom(deps);
  const previous = await getMemberRecord(db, options.user.id);
  assertUser(previous, 'That user does not have an active member record yet.');
  const previousDivisions = await getMemberDivisions(db, options.user.id);
  const memberType = options.memberType ?? previous.member_type;
  const university = options.university ?? previous.university_name;
  const divisionsText = resolveDivisionTextForMemberUpdate(
    memberType,
    previousDivisions,
    options.divisionsText,
  );

  return applyMemberMembership(
    interaction,
    {
      ...options,
      memberType,
      university,
      divisionsText,
      auditAction: 'member.update',
    },
    deps,
  );
}

export async function removeMember(interaction, options, deps: GovernanceDependencies = {}) {
  const db = dbFrom(deps);
  const actor = actorMember(interaction);
  const target = await targetGuildMember(interaction, options.user);
  assertUser(target.id !== interaction.user.id, 'You cannot remove yourself with this command.');

  const member = await getMemberRecord(db, target.id);
  assertUser(member?.university_name, 'That user does not have an active member record.');
  assertCanRemoveMember(actor, member.university_name, target);

  const divisions = await getMemberDivisions(db, target.id);
  const boardRoles = await getBoardRoles(db, target.id);
  const projects = await getProjectAssignmentsForRemoval(db, target.id);
  const removalPlan = memberRemovalCleanupPlan({ divisions, boardRoles, projects });
  const overwriteCleanup = await removeProjectPermissionOverwrites(interaction.guild, target.id, projects);

  await target.kick(options.reason ?? 'BAINSA member removal');

  try {
    await db.transaction(async (q) => {
      await lockDivisionHeadEligibilityRows(
        q,
        boardRoles
          .filter((boardRole) => boardRole.role === BOARD_ROLES.HEAD && boardRole.division_id != null)
          .map((boardRole) => boardRole.division_id),
      );
      await lockMemberEligibilityRows(q, [target.id]);
      const boardUpdate = await q.query(
        `UPDATE board_assignments
            SET active = false,
                updated_at = now()
          WHERE discord_user_id = $1
            AND active = true`,
        [String(target.id)],
      );
      const divisionDelete = await q.query(
        'DELETE FROM member_divisions WHERE discord_user_id = $1',
        [String(target.id)],
      );
      const projectDelete = await q.query(
        'DELETE FROM project_people WHERE discord_user_id = $1',
        [String(target.id)],
      );
      await assertMemberProjectAssignmentEligibility(q, {
        userId: target.id,
        memberType: member.member_type,
        universityId: member.university_id,
        divisionIds: [],
      });
      await q.query(
        `UPDATE members
            SET status = 'removed',
                removed_at = now(),
                updated_at = now()
          WHERE discord_user_id = $1`,
        [String(target.id)],
      );
      await writeAudit(q, {
        actorId: interaction.user.id,
        action: 'member.remove',
        targetType: 'member',
        targetId: target.id,
        universityId: member.university_id,
        before: { member, divisions, boardRoles, projects, removalPlan },
        after: {
          status: 'removed',
          boardAssignmentsDeactivated: boardUpdate.rowCount,
          divisionsCleared: divisionDelete.rowCount,
          projectAssignmentsDeleted: projectDelete.rowCount,
          projectOverwriteCleanup: overwriteCleanup,
        },
        reason: options.reason ?? null,
      });
    });
  } catch (error) {
    throw new UserFacingError(
      `The member was kicked, but the database/audit update failed and needs manual repair: ${error.message}`,
      { cause: error },
    );
  }

  return { target, universityName: member.university_name, overwriteCleanup };
}

export async function getMemberInfo(interaction, options, deps: GovernanceDependencies = {}) {
  const db = dbFrom(deps);
  const actor = actorMember(interaction);
  const targetUser = options.user ?? interaction.user;
  const target = await targetGuildMember(interaction, targetUser);
  const member = await getMemberRecord(db, target.id);
  assertUser(member, 'No member record exists for that user.');

  if (target.id !== interaction.user.id) {
    if (isGlobalPresident(actor)) {
      // Global can inspect all.
    } else if (member.university_name) {
      assertUser(
        hasRole(actor, universityBoardRoleName(member.university_name, 'President')) ||
          hasRole(actor, universityBoardRoleName(member.university_name, 'Vice President')) ||
          (await getBoardRoles(db, interaction.user.id)).some(
            (role) => role.university_name === member.university_name,
          ),
        `You can only inspect members in your university scope.`,
      );
    }
  }

  const [divisions, boardRoles, projects] = await Promise.all([
    getMemberDivisions(db, target.id),
    getBoardRoles(db, target.id),
    getActiveProjectAssignments(db, target.id),
  ]);

  return { target, member, divisions, boardRoles, projects };
}

export async function createDivision(interaction, options, deps: GovernanceDependencies = {}) {
  const db = dbFrom(deps);
  const actor = actorMember(interaction);
  const divisionName = normalizeDisplayName(options.divisionName, 'division_name');
  const divisionColor = divisionColorDetails(options.color);
  assertUser(
    divisionColor,
    `Choose one of the supported division colors: ${Object.values(DIVISION_COLORS).map(({ key }) => key).join(', ')}.`,
  );
  const university = await getUniversityByName(db, options.university);
  assertUniversityAuthority(actor, university.name, [BOARD_ROLES.PRESIDENT]);
  const head = await targetGuildMember(interaction, options.head);
  assertUser(!hasRole(head, ROLE_NAMES.BOT), 'The Bot member cannot head a division.');

  const existing = await db.query(
    'SELECT id FROM divisions WHERE university_id = $1 AND lower(name) = lower($2) AND active = true LIMIT 1',
    [university.id, divisionName],
  );
  assertUser(existing.rowCount === 0, `${divisionName} already exists at ${university.name}.`);
  const previousHeadRecord = await getMemberRecord(db, head.id);
  assertCanPromoteResearcher(previousHeadRecord, university.name);

  const reason = `BAINSA governance: division.create ${university.name}/${divisionName}`;
  const createdResources = [];
  const { role: accessRole, created: accessRoleCreated } = await ensureRole(
    interaction.guild,
    divisionRoleName(university.name, divisionName),
    reason,
    { colorOverride: divisionColor.hex, updateExistingColor: true },
  );
  if (accessRoleCreated) createdResources.push(accessRole);
  const { role: headRole, created: headRoleCreated } = await ensureRole(
    interaction.guild,
    divisionHeadRoleName(university.name, divisionName),
    reason,
    { colorOverride: divisionColor.hex, updateExistingColor: true },
  );
  if (headRoleCreated) createdResources.push(headRole);

  const { addedRoles, removedRoles } = await enforceResearcherRoles(
    head,
    interaction.guild,
    roleNamesForDivisionHead(university.name, divisionName),
    reason,
    { removableRoleNames: [divisionRoleName(university.name, divisionName)] },
  );
  const overwriteRoles = divisionOverwriteRoles(
    interaction.guild,
    university.name,
    divisionName,
    accessRole,
    headRole,
  );

  let category;
  let textChannel = null;
  let voiceChannel = null;
  try {
    category = await persistedUniversityCategory(interaction.guild, university);
    if (options.createTextChannel) {
      const result = await createDivisionChannel(
        interaction.guild,
        divisionName,
        divisionColor.key,
        ChannelType.GuildText,
        category,
        overwriteRoles,
        reason,
      );
      textChannel = result.channel;
      if (result.created) createdResources.push(textChannel);
    }
    if (options.createVoiceChannel) {
      const result = await createDivisionChannel(
        interaction.guild,
        divisionName,
        divisionColor.key,
        ChannelType.GuildVoice,
        category,
        overwriteRoles,
        reason,
      );
      voiceChannel = result.channel;
      if (result.created) createdResources.push(voiceChannel);
    }

    await db.transaction(async (q) => {
      const inserted = await q.query(
        `INSERT INTO divisions
          (university_id, name, slug, color, member_role_id, head_role_id, text_channel_id, voice_channel_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING id`,
        [
          university.id,
          divisionName,
          slugify(divisionName),
          divisionColor.key,
          accessRole.id,
          headRole.id,
          textChannel?.id ?? null,
          voiceChannel?.id ?? null,
        ],
      );
      const divisionId = inserted.rows[0].id;
      await upsertMemberRecord(q, head.id, MEMBER_TYPES.RESEARCHER, university.id, null);
      await addMemberDivisionRow(q, head.id, divisionId);
      await q.query(
        `INSERT INTO board_assignments (discord_user_id, university_id, role, division_id, active)
         VALUES ($1, $2, $3, $4, true)
         ON CONFLICT DO NOTHING`,
        [String(head.id), university.id, BOARD_ROLES.HEAD, divisionId],
      );
      await writeAudit(q, {
        actorId: interaction.user.id,
        action: 'division.create',
        targetType: 'division',
        targetId: divisionId,
        universityId: university.id,
        after: {
          name: divisionName,
          color: divisionColor.key,
          icon: divisionColor.icon,
          headId: head.id,
          accessRoleId: accessRole.id,
          headRoleId: headRole.id,
          textChannelId: textChannel?.id ?? null,
          voiceChannelId: voiceChannel?.id ?? null,
        },
      });
    });
    if (!deps.db) invalidateGovernanceAutocompleteCache();
  } catch (error) {
    await compensateRoles(head, addedRoles, removedRoles, 'Compensating failed division create');
    await Promise.allSettled(
      createdResources
        .filter((resource) => typeof resource.delete === 'function')
        .map((resource) => resource.delete('Compensating failed division create')),
    );
    throw new UserFacingError(
      `Division creation was rolled back because a later step failed: ${error.message}`,
      { cause: error },
    );
  }

  return { university, divisionName, divisionColor, head, textChannel, voiceChannel };
}

export async function updateDivision(interaction, options, deps: GovernanceDependencies = {}) {
  const db = dbFrom(deps);
  const actor = actorMember(interaction);
  const university = await getUniversityByName(db, options.university);
  assertUniversityAuthority(actor, university.name, [BOARD_ROLES.PRESIDENT]);
  const division = await getDivisionByName(db, university.id, university.name, options.currentName);
  const newName = options.newName == null ? division.name : normalizeDisplayName(options.newName, 'new_name');
  const divisionColor = divisionColorDetails(options.color ?? division.color);
  assertUser(
    divisionColor,
    `Choose one of the supported division colors: ${Object.values(DIVISION_COLORS).map(({ key }) => key).join(', ')}.`,
  );
  const nameChanged = division.name.toLowerCase() !== newName.toLowerCase();
  const colorChanged = division.color.toLowerCase() !== divisionColor.key;
  assertUser(nameChanged || colorChanged, 'Specify a new division name or color different from the current value.');

  if (nameChanged) {
    const conflict = await db.query(
      `SELECT id
         FROM divisions
        WHERE university_id = $1
          AND lower(name) = lower($2)
          AND id <> $3
          AND active = true
        LIMIT 1`,
      [university.id, newName, division.id],
    );
    assertUser(conflict.rowCount === 0, `${newName} already exists at ${university.name}.`);
  }

  const reason = `BAINSA governance: division.update ${university.name}/${division.name} to ${newName} (${divisionColor.key})`;
  const oldAccessName = divisionRoleName(university.name, division.name);
  const oldHeadName = divisionHeadRoleName(university.name, division.name);
  const newAccessName = divisionRoleName(university.name, newName);
  const newHeadName = divisionHeadRoleName(university.name, newName);
  const accessRole = roleByName(interaction.guild, oldAccessName);
  const headRole = roleByName(interaction.guild, oldHeadName);
  assertUser(accessRole, `Could not find role "${oldAccessName}".`);
  assertUser(headRole, `Could not find role "${oldHeadName}".`);
  const updatedRoles = [
    { role: accessRole, oldName: oldAccessName, oldColor: accessRole.hexColor },
    { role: headRole, oldName: oldHeadName, oldColor: headRole.hexColor },
  ];
  const updatedChannels = [];

  try {
    if (nameChanged) {
      await accessRole.setName(newAccessName, reason);
      await headRole.setName(newHeadName, reason);
    }
    if (colorChanged) {
      await accessRole.edit({ colors: { primaryColor: divisionColor.hex }, reason });
      await headRole.edit({ colors: { primaryColor: divisionColor.hex }, reason });
    }
    if (nameChanged || colorChanged) {
      const renamedTextChannel = await renameChannelByIdWithPreviousName(
        interaction.guild,
        division.text_channel_id,
        divisionChannelName(newName, ChannelType.GuildText, divisionColor.key).slice(0, 100),
        reason,
      );
      if (renamedTextChannel?.previousName != null) updatedChannels.push(renamedTextChannel);
      const renamedVoiceChannel = await renameChannelByIdWithPreviousName(
        interaction.guild,
        division.voice_channel_id,
        divisionChannelName(newName, ChannelType.GuildVoice, divisionColor.key).slice(0, 100),
        reason,
      );
      if (renamedVoiceChannel?.previousName != null) updatedChannels.push(renamedVoiceChannel);
    }

    await db.transaction(async (q) => {
      await q.query(
        `UPDATE divisions
            SET name = $1,
                slug = $2,
                color = $3,
                member_role_id = $4,
                head_role_id = $5,
                updated_at = now()
          WHERE id = $6`,
        [newName, slugify(newName), divisionColor.key, accessRole.id, headRole.id, division.id],
      );
      await writeAudit(q, {
        actorId: interaction.user.id,
        action: 'division.update',
        targetType: 'division',
        targetId: division.id,
        universityId: university.id,
        before: { name: division.name, color: division.color },
        after: { name: newName, color: divisionColor.key },
      });
    });
    if (!deps.db) invalidateGovernanceAutocompleteCache();
  } catch (error) {
    const compensationResults = await Promise.allSettled([
      ...updatedRoles.map(async ({ role, oldName, oldColor }) => {
        if (role.name !== oldName) await role.setName(oldName, 'Compensating failed division update');
        if (oldColor && role.hexColor?.toLowerCase() !== oldColor.toLowerCase()) {
          await role.edit({ colors: { primaryColor: oldColor }, reason: 'Compensating failed division update' });
        }
      }),
      ...[...updatedChannels].reverse().map(({ channel, previousName }) =>
        channel.setName(previousName, 'Compensating failed division update'),
      ),
    ]);
    const compensationFailures = compensationResults.filter((result) => result.status === 'rejected');
    if (compensationFailures.length > 0) {
      logger.error('Division update compensation partially failed', {
        divisionId: String(division.id),
        failures: compensationFailures.map((failure) =>
          failure.reason instanceof Error ? failure.reason.message : String(failure.reason),
        ),
      });
    }
    throw new UserFacingError(
      `Division update failed. Discord roles and channels were restored where possible: ${error.message}`,
      { cause: error },
    );
  }

  return {
    university,
    oldName: division.name,
    newName,
    oldColor: division.color,
    newColor: divisionColor.key,
  };
}

export async function addDivisionMember(interaction, options, deps: GovernanceDependencies = {}) {
  const db = dbFrom(deps);
  const actor = actorMember(interaction);
  const target = await targetGuildMember(interaction, options.user);
  const university = await getUniversityByName(db, options.university);
  const division = await getDivisionByName(db, university.id, university.name, options.division);
  assertDivisionAuthority(actor, university.name, division.name, [
    BOARD_ROLES.HEAD,
    BOARD_ROLES.VICE_PRESIDENT,
    BOARD_ROLES.PRESIDENT,
  ]);
  const previousRecord = await getMemberRecord(db, target.id);
  assertCanPromoteResearcher(previousRecord, university.name);

  const reason = `BAINSA governance: division.add_member ${university.name}/${division.name}`;
  const { addedRoles, removedRoles } = await enforceResearcherRoles(
    target,
    interaction.guild,
    [
      universityAccessRoleName(university.name),
      divisionRoleName(university.name, division.name),
    ],
    reason,
  );

  try {
    await db.transaction(async (q) => {
      await lockMemberEligibilityRows(q, [target.id]);
      const currentDivisions = await getMemberDivisions(q, target.id);
      await assertMemberProjectAssignmentEligibility(q, {
        userId: target.id,
        memberType: MEMBER_TYPES.RESEARCHER,
        universityId: university.id,
        divisionIds: [...currentDivisions.map((entry) => entry.id), division.id],
      });
      await upsertMemberRecord(q, target.id, MEMBER_TYPES.RESEARCHER, university.id, null);
      await addMemberDivisionRow(q, target.id, division.id);
      await writeAudit(q, {
        actorId: interaction.user.id,
        action: 'division.member.add',
        targetType: 'member',
        targetId: target.id,
        universityId: university.id,
        after: { division: division.name },
      });
    });
  } catch (error) {
    await compensateRoles(target, addedRoles, removedRoles, 'Compensating failed division add member');
    throw new UserFacingError(
      `Discord roles were restored because the database update failed: ${error.message}`,
      { cause: error },
    );
  }

  return { target, university, division };
}

export async function removeDivisionMember(interaction, options, deps: GovernanceDependencies = {}) {
  const db = dbFrom(deps);
  const actor = actorMember(interaction);
  const target = await targetGuildMember(interaction, options.user);
  const university = await getUniversityByName(db, options.university);
  const division = await getDivisionByName(db, university.id, university.name, options.division);
  assertDivisionAuthority(actor, university.name, division.name, [
    BOARD_ROLES.HEAD,
    BOARD_ROLES.VICE_PRESIDENT,
    BOARD_ROLES.PRESIDENT,
  ]);
  await assertNoActiveProjectAccessLoss(db, target.id, division);

  const reason = options.reason ?? `BAINSA governance: division.remove_member ${university.name}/${division.name}`;
  const removedRoles = await removeRolesByName(
    target,
    interaction.guild,
    [divisionRoleName(university.name, division.name)],
    reason,
  );

  try {
    await db.transaction(async (q) => {
      await lockMemberEligibilityRows(q, [target.id]);
      const currentMember = await getMemberRecord(q, target.id);
      const currentDivisions = await getMemberDivisions(q, target.id);
      await assertMemberProjectAssignmentEligibility(q, {
        userId: target.id,
        memberType: currentMember?.member_type ?? MEMBER_TYPES.RESEARCHER,
        universityId: currentMember?.university_id ?? university.id,
        divisionIds: currentDivisions
          .filter((entry) => String(entry.id) !== String(division.id))
          .map((entry) => entry.id),
      });
      await removeMemberDivisionRow(q, target.id, division.id);
      await writeAudit(q, {
        actorId: interaction.user.id,
        action: 'division.member.remove',
        targetType: 'member',
        targetId: target.id,
        universityId: university.id,
        before: { division: division.name },
        reason: options.reason ?? null,
      });
    });
  } catch (error) {
    await compensateRoles(target, [], removedRoles, 'Compensating failed division remove member');
    throw new UserFacingError(
      `Discord roles were restored because the database update failed: ${error.message}`,
      { cause: error },
    );
  }

  return { target, university, division };
}

export async function assignBoardRole(interaction, options, deps: GovernanceDependencies = {}) {
  const db = dbFrom(deps);
  const actor = actorMember(interaction);
  const target = await targetGuildMember(interaction, options.user);
  const role = options.role;
  const university = await getUniversityByName(db, options.university);
  const divisionName = options.division ? normalizeDisplayName(options.division, 'division') : null;
  assertCanAssignBoardRole(actor, university.name, role);
  assertBoardAssignDivisionShape(role, divisionName);
  const previousRecord = await getMemberRecord(db, target.id);
  assertCanPromoteResearcher(previousRecord, university.name);

  const division =
    role === BOARD_ROLES.HEAD
      ? await getDivisionByName(db, university.id, university.name, divisionName)
      : null;

  const currentBoardRoles =
    role === BOARD_ROLES.HEAD ? [] : await getBoardRoles(db, target.id);
  const universityDivisionRoleIds = role === BOARD_ROLES.HEAD
    ? []
    : await getUniversityDivisionDiscordRoleIds(db, university.id);
  const headEligibilityDivisionIds = role === BOARD_ROLES.HEAD
    ? [division.id]
    : currentBoardRoles
        .filter((boardRole) => boardRole.role === BOARD_ROLES.HEAD && boardRole.division_id != null)
        .map((boardRole) => boardRole.division_id);
  if (role !== BOARD_ROLES.HEAD) {
    await assertActiveProjectUpdateEligibility(
      db,
      target.id,
      MEMBER_TYPES.RESEARCHER,
      university,
      [],
      { universityBoardMember: true },
    );
  }
  const removableRoles = role === BOARD_ROLES.HEAD
    ? []
    : discordDivisionRolesForUniversity(target, interaction.guild, universityDivisionRoleIds);

  const roleNames = [universityAccessRoleName(university.name)];
  if (role === BOARD_ROLES.HEAD) {
    roleNames.push(...roleNamesForDivisionHead(university.name, division.name));
  } else {
    roleNames.push(universityBoardRoleName(university.name, boardRoleLabel(role)));
  }

  const reason = `BAINSA governance: board.assign ${university.name}/${role}`;
  const { addedRoles, removedRoles } = await enforceResearcherRoles(
    target,
    interaction.guild,
    roleNames,
    reason,
    { removableRoles },
  );

  try {
    await db.transaction(async (q) => {
      await lockDivisionHeadEligibilityRows(q, headEligibilityDivisionIds);
      await lockMemberEligibilityRows(q, [target.id]);
      await assertMemberProjectAssignmentEligibility(q, {
        userId: target.id,
        memberType: MEMBER_TYPES.RESEARCHER,
        universityId: university.id,
        divisionIds: [],
        additionalBoardUniversityIds: [university.id],
      });
      await upsertMemberRecord(q, target.id, MEMBER_TYPES.RESEARCHER, university.id, null);
      if (division) await addMemberDivisionRow(q, target.id, division.id);
      await q.query(
        `INSERT INTO board_assignments (discord_user_id, university_id, role, division_id, active)
         VALUES ($1, $2, $3, $4, true)
         ON CONFLICT DO NOTHING`,
        [String(target.id), university.id, role, division?.id ?? null],
      );
      await writeAudit(q, {
        actorId: interaction.user.id,
        action: 'board.assign',
        targetType: 'member',
        targetId: target.id,
        universityId: university.id,
        after: { role, division: division?.name ?? null },
      });
    });
  } catch (error) {
    await compensateRoles(target, addedRoles, removedRoles, 'Compensating failed board assign');
    throw new UserFacingError(
      `Discord roles were restored because the database update failed: ${error.message}`,
      { cause: error },
    );
  }

  return { target, university, role, division };
}

export async function removeBoardRole(interaction, options, deps: GovernanceDependencies = {}) {
  const db = dbFrom(deps);
  const actor = actorMember(interaction);
  const target = await targetGuildMember(interaction, options.user);
  const role = options.role;
  const university = await getUniversityByName(db, options.university);
  const divisionName = options.division ? normalizeDisplayName(options.division, 'division') : null;
  assertCanRemoveBoardRole(actor, university.name, role);
  assertBoardRemoveDivisionShape(role, divisionName);

  const division =
    role === BOARD_ROLES.HEAD && divisionName
      ? await getDivisionByName(db, university.id, university.name, divisionName)
      : null;
  const headAssignments = role !== BOARD_ROLES.HEAD
    ? []
    : division
      ? [division]
      : (
          await db.query(
            `SELECT d.id, d.name
               FROM board_assignments br
               JOIN divisions d ON d.id = br.division_id
              WHERE br.discord_user_id = $1
                AND br.university_id = $2
                AND br.role = $3
                AND br.active = true
                AND d.active = true
              ORDER BY d.id`,
            [String(target.id), university.id, BOARD_ROLES.HEAD],
          )
        ).rows;
  const rolesToRemove = role === BOARD_ROLES.HEAD
    ? headAssignments.map((assignment) => divisionHeadRoleName(university.name, assignment.name))
    : [universityBoardRoleName(university.name, boardRoleLabel(role))];

  const removedRoles = await removeRolesByName(
    target,
    interaction.guild,
    rolesToRemove,
    options.reason ?? `BAINSA governance: board.remove ${university.name}/${role}`,
  );

  try {
    await db.transaction(async (q) => {
      await lockDivisionHeadEligibilityRows(q, headAssignments.map((assignment) => assignment.id));
      await lockMemberEligibilityRows(q, [target.id]);
      await q.query(
        `UPDATE board_assignments
            SET active = false,
                updated_at = now()
          WHERE discord_user_id = $1
            AND university_id = $2
            AND role = $3
            AND active = true
            AND ($4::bigint IS NULL OR division_id = $4)`,
        [String(target.id), university.id, role, division?.id ?? null],
      );
      const member = await getMemberRecord(q, target.id);
      const memberDivisions = await getMemberDivisions(q, target.id);
      if (member) {
        await assertMemberProjectAssignmentEligibility(q, {
          userId: target.id,
          memberType: member.member_type,
          universityId: member.university_id,
          divisionIds: memberDivisions.map((entry) => entry.id),
        });
      }
      await writeAudit(q, {
        actorId: interaction.user.id,
        action: 'board.remove',
        targetType: 'member',
        targetId: target.id,
        universityId: university.id,
        before: { role, division: division?.name ?? null },
        reason: options.reason ?? null,
      });
    });
  } catch (error) {
    await compensateRoles(target, [], removedRoles, 'Compensating failed board remove');
    throw new UserFacingError(
      `Discord roles were restored because the database update failed: ${error.message}`,
      { cause: error },
    );
  }

  return { target, university, role, division };
}

export async function getBoardInfo(interaction, options, deps: GovernanceDependencies = {}) {
  const db = dbFrom(deps);
  const actor = actorMember(interaction);
  const university = await getUniversityByName(db, options.university);
  const actorBoardRows = isGlobalPresident(actor)
    ? { rowCount: 0 }
    : await db.query(
        `SELECT 1
           FROM board_assignments
          WHERE discord_user_id = $1
            AND university_id = $2
            AND active = true
          LIMIT 1`,
        [String(interaction.user.id), university.id],
      );
  assertUser(
    isGlobalPresident(actor) ||
      hasRole(actor, universityBoardRoleName(university.name, 'President')) ||
      hasRole(actor, universityBoardRoleName(university.name, 'Vice President')) ||
      actorBoardRows.rowCount > 0,
    `Only ${university.name} board members can view board info.`,
  );

  const result = await db.query(
    `SELECT br.discord_user_id, br.role, d.name AS division_name, d.color AS division_color
       FROM board_assignments br
       LEFT JOIN divisions d ON d.id = br.division_id AND d.active = true
      WHERE br.university_id = $1
        AND br.active = true
        AND (br.division_id IS NULL OR d.id IS NOT NULL)
      ORDER BY br.role, d.name, br.discord_user_id`,
    [university.id],
  );

  const rows = [];
  for (const row of result.rows) {
    const member = await interaction.guild.members.fetch(row.discord_user_id).catch(() => null);
    const expectedRoles = [ROLE_NAMES.RESEARCHER, universityAccessRoleName(university.name)];
    if (row.role === BOARD_ROLES.HEAD && row.division_name) {
      expectedRoles.push(divisionHeadRoleName(university.name, row.division_name));
    } else {
      expectedRoles.push(universityBoardRoleName(university.name, boardRoleLabel(row.role)));
    }
    const missingRoles = member
      ? expectedRoles.filter((roleName) => !hasRole(member, roleName))
      : ['member not in server'];
    rows.push({ ...row, missingRoles });
  }

  return { university, rows };
}

export {
  divisionChannelName,
  divisionChannelOverwrites,
  findDivisions,
  findUniversities,
  formatBoardInfo,
  formatMemberInfo,
  invalidateGovernanceAutocompleteCache,
  memberRemovalCleanupPlan,
  projectChannelCleanupTargets,
  resolveDivisionTextForMemberUpdate,
  roleNamesForDivisionHead,
  warmGovernanceAutocompleteCache,
};
