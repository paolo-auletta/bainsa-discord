import {
  ChannelType,
  PermissionFlagsBits,
} from 'discord.js';

import * as defaultDb from '../../db.mjs';
import { writeAudit } from '../../audit.mjs';
import { logger } from '../../logger.mjs';
import {
  assertDivisionAuthority,
  assertNotBotUser,
  assertUniversityAuthority,
  hasRole,
  isGlobalPresident,
} from '../../authorization.mjs';
import {
  BOARD_ROLES,
  divisionColorDetails,
  divisionLabel,
  DIVISION_COLORS,
  MEMBER_TYPES,
  PROJECT_PERSON_ROLES,
  PROJECT_STATUSES,
  ROLE_NAMES,
  universityRoleColor,
} from '../../constants.mjs';
import { assertUser, UserFacingError } from '../../errors.mjs';
import {
  divisionHeadRoleName,
  divisionRoleName,
  divisionTextChannelName,
  divisionVoiceChannelName,
  normalizeDisplayName,
  slugify,
  universityBoardRoleName,
} from '../../naming.mjs';
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
  memberTypeLabel,
  parseDivisionList,
} from './policy.mjs';
import {
  assertMemberProjectAssignmentEligibility,
  lockMemberEligibilityRows,
} from '../projects/eligibility.mjs';

const ACTIVE_PROJECT_STATUSES = [PROJECT_STATUSES.ACTIVE, PROJECT_STATUSES.PAUSED];
const GOVERNANCE_AUTOCOMPLETE_CACHE_TTL_MS = 30_000;
const governanceAutocompleteCache = {
  loadedAt: 0,
  generation: 0,
  refreshPromise: null,
  universities: [],
  divisions: [],
};
const TEXT_WRITE = Object.freeze([
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.ReadMessageHistory,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.SendMessagesInThreads,
  PermissionFlagsBits.CreatePublicThreads,
  PermissionFlagsBits.AttachFiles,
  PermissionFlagsBits.EmbedLinks,
  PermissionFlagsBits.AddReactions,
]);
const VOICE_ACCESS = Object.freeze([
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.Connect,
  PermissionFlagsBits.Speak,
]);
const BOT_CHANNEL_ACCESS = Object.freeze([
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.ReadMessageHistory,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.SendMessagesInThreads,
  PermissionFlagsBits.CreatePublicThreads,
  PermissionFlagsBits.CreatePrivateThreads,
  PermissionFlagsBits.AttachFiles,
  PermissionFlagsBits.EmbedLinks,
  PermissionFlagsBits.AddReactions,
  PermissionFlagsBits.UseApplicationCommands,
  PermissionFlagsBits.ManageMessages,
  PermissionFlagsBits.ManageThreads,
  PermissionFlagsBits.ManageChannels,
  PermissionFlagsBits.Connect,
  PermissionFlagsBits.Speak,
]);

function dbFrom(deps) {
  return deps?.db ?? defaultDb;
}

function actorMember(interaction) {
  assertUser(interaction.guild, 'This command can only be used inside the BAINSA server.');
  assertUser(interaction.member, 'Could not resolve your server member profile.');
  return interaction.member;
}

async function targetGuildMember(interaction, user) {
  assertUser(interaction.guild, 'This command can only be used inside the BAINSA server.');
  assertNotBotUser(interaction, user.id);
  try {
    return await interaction.guild.members.fetch(user.id);
  } catch {
    throw new UserFacingError('That user is not currently in this server.');
  }
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

async function renameRole(guild, oldName, newName, reason) {
  const role = roleByName(guild, oldName);
  assertUser(role, `Could not find role "${oldName}".`);
  if (role.name === newName) return role;
  return role.setName(newName, reason);
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

async function replaceMemberRoles(member, guild, desiredRoleNames, removableRoleNames, reason) {
  const roleResults = await ensureRoles(guild, desiredRoleNames, reason);
  const desiredRoles = roleResults.map(({ role }) => role);
  const removedRoles = await removeRolesByName(
    member,
    guild,
    removableRoleNames.filter((roleName) => !desiredRoleNames.includes(roleName)),
    reason,
  );
  const addedRoles = await addRoles(member, desiredRoles, reason);
  return { addedRoles, removedRoles };
}

function stableRoleNames(roleNames) {
  return [...new Set(roleNames.filter(Boolean))];
}

async function enforceResearcherRoles(
  member,
  guild,
  desiredRoleNames,
  reason,
  { removableRoleNames = [] } = {},
) {
  return replaceMemberRoles(
    member,
    guild,
    stableRoleNames([ROLE_NAMES.RESEARCHER, ...desiredRoleNames]),
    stableRoleNames([ROLE_NAMES.ALUMNI, ...removableRoleNames]),
    reason,
  );
}

async function compensateRoles(member, addedRoles, removedRoles, reason) {
  await Promise.allSettled([
    addedRoles?.length ? member.roles.remove(addedRoles, reason) : undefined,
    removedRoles?.length ? member.roles.add(removedRoles, reason) : undefined,
  ]);
}

async function queryOne(db, text, values, missingMessage) {
  const result = await db.query(text, values);
  const row = result.rows[0];
  assertUser(row, missingMessage);
  return row;
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

async function getUniversityByName(db, universityName) {
  return queryOne(
    db,
    `SELECT id, name, category_id
       FROM universities
      WHERE lower(name) = lower($1)
        AND active = true
      LIMIT 1`,
    [normalizeDisplayName(universityName, 'university')],
    `Unknown university: ${universityName}.`,
  );
}

async function getDivisionByName(db, universityId, universityName, divisionName) {
  return queryOne(
    db,
    `SELECT id,
            university_id,
            name,
            color,
            member_role_id AS access_role_id,
            head_role_id,
            text_channel_id,
            voice_channel_id
       FROM divisions
      WHERE university_id = $1
        AND lower(name) = lower($2)
        AND active = true
      LIMIT 1`,
    [universityId, normalizeDisplayName(divisionName, 'division')],
    `Unknown division: ${divisionName} at ${universityName}.`,
  );
}

async function getMemberRecord(db, userId) {
  const result = await db.query(
    `SELECT m.discord_user_id, m.full_name, m.member_type, m.university_id, m.status, m.notes, u.name AS university_name
       FROM members m
       LEFT JOIN universities u ON u.id = m.university_id
      WHERE m.discord_user_id = $1
      LIMIT 1`,
    [String(userId)],
  );
  return result.rows[0] ?? null;
}

async function getMemberDivisions(db, userId) {
  const result = await db.query(
    `SELECT d.id, d.name, d.color, d.university_id, u.name AS university_name
       FROM member_divisions md
       JOIN divisions d ON d.id = md.division_id
       JOIN universities u ON u.id = d.university_id
      WHERE md.discord_user_id = $1
        AND d.active = true
        AND u.active = true
      ORDER BY d.name`,
    [String(userId)],
  );
  return result.rows;
}

async function getBoardRoles(db, userId) {
  const result = await db.query(
    `SELECT br.role, br.division_id, u.name AS university_name, d.name AS division_name
       FROM board_assignments br
       LEFT JOIN universities u ON u.id = br.university_id AND u.active = true
       LEFT JOIN divisions d ON d.id = br.division_id AND d.active = true
      WHERE br.discord_user_id = $1
        AND br.active = true
        AND (br.university_id IS NULL OR u.id IS NOT NULL)
        AND (br.division_id IS NULL OR d.id IS NOT NULL)
      ORDER BY u.name NULLS FIRST, br.role, d.name`,
    [String(userId)],
  );
  return result.rows;
}

async function getActiveProjectAssignments(db, userId) {
  const result = await db.query(
    `SELECT p.id, p.name, p.status, p.channel_id, pp.role, u.name AS university_name, d.name AS division_name
       FROM project_people pp
       JOIN projects p ON p.id = pp.project_id
       JOIN universities u ON u.id = p.university_id
       LEFT JOIN divisions d ON d.id = p.division_id
      WHERE pp.discord_user_id = $1
        AND p.status = ANY($2::text[])
      ORDER BY p.name, pp.role`,
    [String(userId), ACTIVE_PROJECT_STATUSES],
  );
  return result.rows;
}

async function getProjectAssignmentsForRemoval(db, userId) {
  const result = await db.query(
    `SELECT p.id, p.name, p.status, p.channel_id, pp.role, u.name AS university_name, d.name AS division_name
       FROM project_people pp
       JOIN projects p ON p.id = pp.project_id
       JOIN universities u ON u.id = p.university_id
       LEFT JOIN divisions d ON d.id = p.division_id
      WHERE pp.discord_user_id = $1
      ORDER BY p.name, pp.role`,
    [String(userId)],
  );
  return result.rows;
}

async function upsertMemberRecord(q, userId, memberType, universityId, notes) {
  await q.query(
    `INSERT INTO members (discord_user_id, member_type, university_id, status, notes)
     VALUES ($1, $2, $3, 'active', $4)
     ON CONFLICT (discord_user_id)
     DO UPDATE SET
       member_type = EXCLUDED.member_type,
       university_id = EXCLUDED.university_id,
       status = 'active',
       notes = COALESCE(EXCLUDED.notes, members.notes),
       removed_at = NULL,
       updated_at = now()`,
    [String(userId), memberType, universityId, notes ?? null],
  );
}

async function replaceMemberDivisionRows(q, userId, divisions) {
  await q.query('DELETE FROM member_divisions WHERE discord_user_id = $1', [String(userId)]);
  for (const division of divisions) {
    await q.query(
      `INSERT INTO member_divisions (discord_user_id, division_id)
       VALUES ($1, $2)
       ON CONFLICT DO NOTHING`,
      [String(userId), division.id],
    );
  }
}

async function addMemberDivisionRow(q, userId, divisionId) {
  await q.query(
    `INSERT INTO member_divisions (discord_user_id, division_id)
     VALUES ($1, $2)
     ON CONFLICT DO NOTHING`,
    [String(userId), divisionId],
  );
}

async function removeMemberDivisionRow(q, userId, divisionId) {
  await q.query('DELETE FROM member_divisions WHERE discord_user_id = $1 AND division_id = $2', [
    String(userId),
    divisionId,
  ]);
}

async function getDivisionRecords(db, university, divisionNames) {
  const divisions = [];
  for (const divisionName of divisionNames) {
    divisions.push(await getDivisionByName(db, university.id, university.name, divisionName));
  }
  return divisions;
}

function roleNamesForMember(universityName, memberType, divisions) {
  const baseRole = memberType === MEMBER_TYPES.ALUMNI ? ROLE_NAMES.ALUMNI : ROLE_NAMES.RESEARCHER;
  const divisionRoles =
    memberType === MEMBER_TYPES.RESEARCHER
      ? divisions.map((division) => divisionRoleName(universityName, division.name))
      : [];
  return [baseRole, universityAccessRoleName(universityName), ...divisionRoles];
}

export function roleNamesForDivisionHead(universityName, divisionName) {
  return [
    universityAccessRoleName(universityName),
    divisionHeadRoleName(universityName, divisionName),
  ];
}

function removableMembershipRoleNames(previousRecord, previousDivisions, nextUniversityName) {
  const names = [ROLE_NAMES.RESEARCHER, ROLE_NAMES.ALUMNI];
  if (previousRecord?.university_name) names.push(universityAccessRoleName(previousRecord.university_name));
  if (nextUniversityName) names.push(universityAccessRoleName(nextUniversityName));
  for (const division of previousDivisions) {
    names.push(divisionRoleName(division.university_name, division.name));
  }
  return [...new Set(names)];
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

export function divisionChannelName(divisionName, type, color) {
  return type === ChannelType.GuildVoice
    ? divisionVoiceChannelName(divisionName, color)
    : divisionTextChannelName(divisionName, color);
}

function requireRole(guild, roleName) {
  const role = roleByName(guild, roleName);
  assertUser(role, `Required role is missing: ${roleName}. Run provisioning first.`);
  return role;
}

function channelOverwrite(id, { allow = [], deny = [] }) {
  return { id, allow, deny };
}

export function divisionChannelOverwrites(guild, roles, type) {
  const memberPermissions =
    type === ChannelType.GuildVoice
      ? VOICE_ACCESS
      : TEXT_WRITE;
  const boardPermissions =
    type === ChannelType.GuildVoice
      ? [...VOICE_ACCESS, PermissionFlagsBits.CreateEvents]
      : TEXT_WRITE;

  return [
    channelOverwrite(guild.roles.everyone.id, { deny: [PermissionFlagsBits.ViewChannel] }),
    channelOverwrite(roles.accessRole.id, { allow: memberPermissions }),
    channelOverwrite(roles.headRole.id, { allow: boardPermissions }),
    channelOverwrite(roles.presidentRole.id, { allow: boardPermissions }),
    channelOverwrite(roles.vicePresidentRole.id, { allow: boardPermissions }),
    channelOverwrite(roles.globalPresidentRole.id, { allow: boardPermissions }),
    channelOverwrite(roles.botRole.id, { allow: BOT_CHANNEL_ACCESS }),
  ];
}

function divisionOverwriteRoles(guild, universityName, divisionName, accessRole, headRole) {
  return {
    accessRole,
    headRole,
    presidentRole: requireRole(guild, universityBoardRoleName(universityName, 'President')),
    vicePresidentRole: requireRole(guild, universityBoardRoleName(universityName, 'Vice President')),
    globalPresidentRole: requireRole(guild, ROLE_NAMES.GLOBAL_PRESIDENT),
    botRole: requireRole(guild, ROLE_NAMES.BOT),
  };
}

async function persistedUniversityCategory(guild, university) {
  assertUser(
    university.category_id,
    `No persisted category is recorded for ${university.name}. Run provisioning before creating divisions.`,
  );
  const category = await guild.channels.fetch(university.category_id).catch(() => null);
  assertUser(
    category?.type === ChannelType.GuildCategory,
    `The persisted category for ${university.name} could not be found. Run provisioning again.`,
  );
  return category;
}

export function projectChannelCleanupTargets(projects) {
  return [...new Set(projects.map((project) => project.channel_id).filter(Boolean))];
}

export function memberRemovalCleanupPlan({ divisions = [], boardRoles = [], projects = [] }) {
  return {
    divisionIds: divisions.map((division) => String(division.id)),
    boardAssignments: boardRoles.map((role) => ({
      role: role.role,
      university: role.university_name ?? null,
      division: role.division_name ?? null,
    })),
    projectAssignments: projects.map((project) => ({
      id: String(project.id),
      role: project.role,
      channelId: project.channel_id ?? null,
    })),
    projectChannelIds: projectChannelCleanupTargets(projects),
  };
}

export function resolveDivisionTextForMemberUpdate(memberType, previousDivisions, providedDivisionsText) {
  if (providedDivisionsText !== undefined) return providedDivisionsText;
  if (memberType === MEMBER_TYPES.ALUMNI) return '';
  return previousDivisions.map((division) => division.name).join(', ');
}

async function removeProjectPermissionOverwrites(guild, userId, projects) {
  const failures = [];
  const cleanedChannelIds = [];

  for (const channelId of projectChannelCleanupTargets(projects)) {
    try {
      const channel = await guild.channels.fetch(channelId);
      if (!channel?.permissionOverwrites) {
        throw new Error('channel not found or does not support permission overwrites');
      }
      if (channel.permissionOverwrites.cache?.has(String(userId))) {
        await channel.permissionOverwrites.delete(
          String(userId),
          'BAINSA member removal: clearing direct project access',
        );
      }
      cleanedChannelIds.push(channelId);
    } catch (error) {
      failures.push({
        channelId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (failures.length > 0) {
    logger.warn('Member removal project overwrite cleanup partially failed', {
      userId: String(userId),
      failures,
    });
  }

  return { cleanedChannelIds, failures };
}

async function assertNoActiveProjectAccessLoss(db, userId, division) {
  const result = await db.query(
    `SELECT p.id, p.name
       FROM project_people pp
       JOIN projects p ON p.id = pp.project_id
      WHERE pp.discord_user_id = $1
        AND p.division_id = $2
        AND p.status = ANY($3::text[])
      ORDER BY p.name
      LIMIT 5`,
    [String(userId), division.id, ACTIVE_PROJECT_STATUSES],
  );
  assertUser(
    result.rowCount === 0,
    `Cannot remove this division role because the member still has active project access in ${division.name}: ${result.rows
      .map((row) => row.name)
      .join(', ')}.`,
  );
}

function projectEligibilityFailure(project, memberType, universityId, divisionIds) {
  const sameUniversity = String(project.university_id) === String(universityId);

  if (project.role === PROJECT_PERSON_ROLES.MEMBER) {
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

async function assertActiveProjectUpdateEligibility(db, userId, memberType, university, divisions) {
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
    projectEligibilityFailure(project, memberType, university.id, divisionIds),
  );

  assertUser(
    incompatible.length === 0,
    `Cannot update this member because it would make them ineligible for active projects: ${incompatible
      .map((project) => `#${project.id} ${project.name}`)
      .join(', ')}. Remove or reassign their project participation first.`,
  );
}

async function applyMemberMembership(interaction, options, deps = {}) {
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
  await assertActiveProjectUpdateEligibility(db, target.id, memberType, university, divisions);
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
  };
}

export async function addMember(interaction, options, deps = {}) {
  return applyMemberMembership(interaction, { ...options, auditAction: 'member.add' }, deps);
}

export async function updateMember(interaction, options, deps = {}) {
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

export async function removeMember(interaction, options, deps = {}) {
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

export async function getMemberInfo(interaction, options, deps = {}) {
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

async function createDivisionChannel(guild, divisionName, color, type, parent, overwriteRoles, reason) {
  const name = divisionChannelName(divisionName, type, color).slice(0, 100);
  const parentId = String(parent.id);
  const existing = guild.channels.cache.find(
    (channel) =>
      channel.name === name &&
      channel.type === type &&
      String(channel.parentId ?? channel.parent?.id ?? '') === parentId,
  );
  if (existing) return { channel: existing, created: false };
  const channel = await guild.channels.create({
    name,
    type,
    parent: parent.id,
    permissionOverwrites: divisionChannelOverwrites(guild, overwriteRoles, type),
    reason,
  });
  return { channel, created: true };
}

export async function createDivision(interaction, options, deps = {}) {
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

async function renameChannelById(guild, channelId, newName, reason) {
  if (!channelId) return null;
  const channel = await guild.channels.fetch(channelId).catch(() => null);
  if (!channel) return null;
  if (channel.name === newName) return channel;
  return channel.setName(newName, reason);
}

export async function renameDivision(interaction, options, deps = {}) {
  const db = dbFrom(deps);
  const actor = actorMember(interaction);
  const university = await getUniversityByName(db, options.university);
  assertUniversityAuthority(actor, university.name, [BOARD_ROLES.PRESIDENT]);
  const division = await getDivisionByName(db, university.id, university.name, options.currentName);
  const newName = normalizeDisplayName(options.newName, 'new_name');
  assertUser(division.name.toLowerCase() !== newName.toLowerCase(), 'The new name is the same as the current name.');

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

  const reason = `BAINSA governance: division.rename ${university.name}/${division.name} to ${newName}`;
  const oldAccessName = divisionRoleName(university.name, division.name);
  const oldHeadName = divisionHeadRoleName(university.name, division.name);
  const newAccessName = divisionRoleName(university.name, newName);
  const newHeadName = divisionHeadRoleName(university.name, newName);
  const renamed = [];

  try {
    const accessRole = await renameRole(interaction.guild, oldAccessName, newAccessName, reason);
    renamed.push({ resource: accessRole, oldName: oldAccessName });
    const headRole = await renameRole(interaction.guild, oldHeadName, newHeadName, reason);
    renamed.push({ resource: headRole, oldName: oldHeadName });
    await renameChannelById(
      interaction.guild,
      division.text_channel_id,
      divisionChannelName(newName, ChannelType.GuildText, division.color).slice(0, 100),
      reason,
    );
    await renameChannelById(
      interaction.guild,
      division.voice_channel_id,
      divisionChannelName(newName, ChannelType.GuildVoice, division.color).slice(0, 100),
      reason,
    );

    await db.transaction(async (q) => {
      await q.query(
        `UPDATE divisions
            SET name = $1,
                slug = $2,
                member_role_id = $3,
                head_role_id = $4,
                updated_at = now()
          WHERE id = $5`,
        [newName, slugify(newName), accessRole.id, headRole.id, division.id],
      );
      await writeAudit(q, {
        actorId: interaction.user.id,
        action: 'division.rename',
        targetType: 'division',
        targetId: division.id,
        universityId: university.id,
        before: { name: division.name },
        after: { name: newName },
      });
    });
    if (!deps.db) invalidateGovernanceAutocompleteCache();
  } catch (error) {
    await Promise.allSettled(
      renamed.map(({ resource, oldName }) => resource.setName(oldName, 'Compensating failed division rename')),
    );
    throw new UserFacingError(
      `Division rename failed. Discord role names were restored where possible; channel names may need review: ${error.message}`,
      { cause: error },
    );
  }

  return { university, oldName: division.name, newName };
}

export async function addDivisionMember(interaction, options, deps = {}) {
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

export async function removeDivisionMember(interaction, options, deps = {}) {
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

export async function assignBoardRole(interaction, options, deps = {}) {
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
    {
      removableRoleNames:
        role === BOARD_ROLES.HEAD ? [divisionRoleName(university.name, division.name)] : [],
    },
  );

  try {
    await db.transaction(async (q) => {
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

export async function removeBoardRole(interaction, options, deps = {}) {
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
  const rolesToRemove =
    role === BOARD_ROLES.HEAD
      ? division
        ? [divisionHeadRoleName(university.name, division.name)]
        : (
            await db.query(
              `SELECT d.name
                 FROM board_assignments br
                 JOIN divisions d ON d.id = br.division_id
                WHERE br.discord_user_id = $1
                  AND br.university_id = $2
                  AND br.role = $3
                  AND br.active = true
                  AND d.active = true`,
              [String(target.id), university.id, BOARD_ROLES.HEAD],
            )
          ).rows.map((row) => divisionHeadRoleName(university.name, row.name))
      : [universityBoardRoleName(university.name, boardRoleLabel(role))];

  const removedRoles = await removeRolesByName(
    target,
    interaction.guild,
    rolesToRemove,
    options.reason ?? `BAINSA governance: board.remove ${university.name}/${role}`,
  );

  try {
    await db.transaction(async (q) => {
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

export async function getBoardInfo(interaction, options, deps = {}) {
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
      expectedRoles.push(divisionRoleName(university.name, row.division_name));
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

export function formatMemberInfo(info) {
  const divisions = info.divisions.map((division) => divisionLabel(division.name, division.color)).join(', ') || 'None';
  const board = info.boardRoles
    .map((role) =>
      role.role === BOARD_ROLES.HEAD
        ? `Head of ${role.division_name}`
        : boardRoleLabel(role.role),
    )
    .join(', ') || 'None';
  const projects = info.projects
    .map((project) => `${project.name} (${project.role}, ${project.status})`)
    .join('\n') || 'None';

  return [
    `**${info.target.user.tag ?? info.target.displayName ?? info.target.id}**`,
    `Name: ${info.member.full_name ?? 'Not recorded'}`,
    `Type: ${memberTypeLabel(info.member.member_type)}`,
    `University: ${info.member.university_name ?? 'None'}`,
    `Divisions: ${divisions}`,
    `Board roles: ${board}`,
    `Projects:\n${projects}`,
  ].join('\n');
}

export function formatBoardInfo(info) {
  if (!info.rows.length) return `No board roles are recorded for ${info.university.name}.`;
  return info.rows
    .map((row) => {
      const role =
        row.role === BOARD_ROLES.HEAD
          ? `Head of ${row.division_name ? divisionLabel(row.division_name, row.division_color) : 'unknown division'}`
          : boardRoleLabel(row.role);
      const missing = row.missingRoles.length ? ` Missing: ${row.missingRoles.join(', ')}` : '';
      return `<@${row.discord_user_id}> - ${role}.${missing}`;
    })
    .join('\n');
}
