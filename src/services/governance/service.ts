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
  assertCanManageBoardMember,
  assertCanManageMember,
  assertCanRemoveBoardRole,
  assertCanRemoveMember,
  assertHeadDivisionMembership,
  assertMemberDivisionRequirement,
  assertMemberType,
  assertNoDivisionRolesForAlumni,
  assertBoardAssignDivisionShape,
  assertBoardRemoveDivisionShape,
  assertHeadAssignmentCompatible,
  boardRoleLabel,
  parseDivisionList,
} from './policy.js';
import {
  assertMemberProjectAssignmentEligibility,
  isEligibleForProjectPerson,
  lockDivisionHeadEligibilityRows,
  lockMemberEligibilityRows,
} from '../projects/eligibility.js';
import {
  findDivisions,
  findUniversities,
  invalidateGovernanceAutocompleteCache,
  listDivisions,
  listUniversities,
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
  formatBoardAssignmentHandoff,
  formatBoardRemovalHandoff,
  formatBoardUpdateHandoff,
  formatDivisionHeadHandoff,
  formatDivisionMemberHandoff,
  formatMemberAccessHandoff,
  formatMemberInfo,
  formatMemberRemovalHandoff,
  memberRemovalCleanupPlan,
  projectChannelCleanupTargets,
  resolveDivisionTextForMemberUpdate,
  roleNamesForDivisionHead,
} from './formatters.js';
import { enqueueTransitionNotification, transitionNotificationHealth } from '../../notifications/repository.js';
import {
  deliverTransitionNotification,
  deliverTransitionNotifications,
} from '../../notifications/service.js';
import {
  addMemberDivisionRow,
  activeDivisionExists,
  activeDivisionConflictExists,
  deactivateBoardAssignments,
  deactivateExactBoardAssignment,
  deactivateOtherHeadAssignments,
  ensureBoardAssignment,
  getActiveHeadDivisions,
  getActiveProjectEligibilityAssignments,
  getActiveProjectsBlockingDivisionRemoval,
  getBoardAuthorityRoles,
  getExclusiveBoardAssignment,
  getActiveProjectAssignments,
  getBoardRoles,
  getDivisionByName,
  getDivisionRecords,
  getMemberDivisions,
  getMemberRecord,
  getMemberProfileVisibilityForUpdate,
  getProjectAssignmentsForRemoval,
  getUniversityDivisionDiscordRoleIds,
  getUniversityByName,
  hasActiveBoardAssignment,
  removeMemberDivisionRow,
  removeMemberCanonicalState,
  replaceMemberDivisionRows,
  hasPublishedMemberProfileForUpdate,
  createDivisionRecord,
  insertBoardAssignment,
  listActiveBoardAssignments,
  listActiveDivisionsForBoard,
  listBoardInfoAssignments,
  lockUniversityForUpdate,
  updateDivisionRecord,
  upsertMemberRecord,
} from './repository.js';
import { hideProfileAndEnqueue, requestProfileReconciliation } from '../../profiles/repository.js';
import { enqueueProjectReconciliation, reconcileProject } from '../projects/reconciliation.js';

type GovernanceDependencies = { db?: Pick<typeof defaultDb, 'query' | 'transaction'> };

function dbFrom(deps: GovernanceDependencies = {}) {
  return deps?.db ?? defaultDb;
}

function recoveryError(error, message) {
  if (error instanceof UserFacingError) return error;
  return new UserFacingError(message, { cause: error });
}

async function enqueuePublishedProfileReconciliation(client, discordUserId) {
  if (!await hasPublishedMemberProfileForUpdate(client, discordUserId)) return null;
  return requestProfileReconciliation(client, discordUserId);
}

function hasCanonicalMembershipChange(previousRecord, previousDivisions, memberType, university, divisions) {
  if (!previousRecord) return false;
  if (previousRecord.member_type !== memberType) return true;
  if (String(previousRecord.university_id) !== String(university.id)) return true;
  const previousDivisionIds = previousDivisions.map((division) => String(division.id)).sort();
  const nextDivisionIds = divisions.map((division) => String(division.id)).sort();
  return previousDivisionIds.length !== nextDivisionIds.length
    || previousDivisionIds.some((divisionId, index) => divisionId !== nextDivisionIds[index]);
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

function removableBoardRoleNames(boardRoles) {
  return boardRoles.map((assignment) =>
    assignment.role === BOARD_ROLES.HEAD
      ? divisionHeadRoleName(assignment.university_name, assignment.division_name)
      : universityBoardRoleName(assignment.university_name, boardRoleLabel(assignment.role)),
  );
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
  const projects = await getActiveProjectsBlockingDivisionRemoval(db, userId, division);
  assertUser(
    projects.length === 0,
    `Cannot remove this division role because the member still has active project access in ${division.name}: ${projects
      .map((row) => row.name)
      .join(', ')}.`,
  );
}

function assertExclusiveBoardAssignmentAvailable(assignment, targetId, role, university, division) {
  if (!assignment || String(assignment.discord_user_id) === String(targetId)) return;
  assertUser(
    false,
    role === BOARD_ROLES.HEAD
      ? `Head of ${division.name} is already assigned to another member.`
      : `${boardRoleLabel(role)} at ${university.name} is already assigned to another member.`,
  );
}

function boardAssignmentKey(assignment) {
  return [
    String(assignment.discord_user_id ?? ''),
    assignment.role,
    String(assignment.university_id ?? assignment.university_name ?? '').toLowerCase(),
    String(assignment.division_id ?? assignment.division_name ?? '').toLowerCase(),
  ].join(':');
}

function sameBoardAssignments(left, right) {
  const leftKeys = left.map(boardAssignmentKey).sort();
  const rightKeys = right.map(boardAssignmentKey).sort();
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) => key === rightKeys[index]);
}

function boardAssignmentsForUser(assignments, userId) {
  return assignments.filter((assignment) => String(assignment.discord_user_id) === String(userId));
}

function localBoardAssignmentLabel(assignment) {
  return assignment.role === BOARD_ROLES.HEAD
    ? `Head of ${assignment.division_name ?? 'unknown division'}`
    : boardRoleLabel(assignment.role);
}

function boardPositionChanges(before, after, divisions) {
  const positions = [
    { role: BOARD_ROLES.PRESIDENT, division: null, label: 'President' },
    { role: BOARD_ROLES.VICE_PRESIDENT, division: null, label: 'Vice President' },
    ...divisions.map((division) => ({
      role: BOARD_ROLES.HEAD,
      division,
      label: `Head of ${division.name}`,
    })),
  ];
  return positions.flatMap((position) => {
    const matches = (assignments) => assignments
      .filter((assignment) =>
        assignment.role === position.role
        && (
          position.role !== BOARD_ROLES.HEAD
          || String(assignment.division_id) === String(position.division.id)
        ),
      )
      .map((assignment) => String(assignment.discord_user_id))
      .sort();
    const currentUserIds = matches(before);
    const nextUserIds = matches(after);
    return sameBoardAssignments(
      currentUserIds.map((discord_user_id) => ({ discord_user_id, role: position.role })),
      nextUserIds.map((discord_user_id) => ({ discord_user_id, role: position.role })),
    )
      ? []
      : [{
          role: position.role,
          division: position.division,
          label: position.label,
          currentUserIds,
          nextUserIds,
        }];
  });
}

function hasUniversityExecutiveAssignment(boardRoles, universityName) {
  return boardRoles.some((assignment) =>
    [BOARD_ROLES.PRESIDENT, BOARD_ROLES.VICE_PRESIDENT].includes(assignment.role)
    && String(assignment.university_name ?? '').toLowerCase() === String(universityName).toLowerCase(),
  );
}

function projectEligibilityFailure(project, memberType, universityId, divisionIds, universityBoardMember) {
  return !isEligibleForProjectPerson({
    member_type: memberType,
    university_id: universityId,
    status: 'active',
    divisionIds,
    isUniversityBoardMember: universityBoardMember,
  }, project, project.role);
}

async function assertActiveProjectUpdateEligibility(
  db,
  userId,
  memberType,
  university,
  divisions,
  { universityBoardMember = false } = {},
) {
  const result = await getActiveProjectEligibilityAssignments(db, userId);
  const divisionIds = new Set(divisions.map((division) => String(division.id)));
  const incompatible = result.filter((project) =>
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
    const scopedBoardRoles = boardRoles.filter((assignment) => assignment.university_name);
    assertUser(
      scopedBoardRoles.length === 0,
      `Cannot move this member while they hold board assignments at ${previousRecord.university_name}: ${scopedBoardRoles
        .map((assignment) => assignment.role === BOARD_ROLES.HEAD
          ? `Head of ${assignment.division_name ?? 'a division'}`
          : boardRoleLabel(assignment.role))
        .join(', ')}. Remove those assignments with /board-update, then try the member move again.`,
    );
  }

  const divisions = await getDivisionRecords(db, university, divisionNames);
  assertMemberDivisionRequirement(memberType, divisions, boardRoles, university.name);
  assertHeadDivisionMembership(boardRoles, divisions, university.name);
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
  const membershipChanged = hasCanonicalMembershipChange(
    previousRecord,
    previousDivisions,
    memberType,
    university,
    divisions,
  );
  const handoffResult = {
    target,
    university,
    memberType,
    divisions,
    previousRecord,
    previousDivisions,
    guildId: interaction.guild.id,
  };
  let notificationId = null;

  try {
    await db.transaction(async (q) => {
      await lockDivisionHeadEligibilityRows(
        q,
        boardRoles
          .filter((boardRole) => boardRole.role === BOARD_ROLES.HEAD && boardRole.division_id != null)
          .map((boardRole) => boardRole.division_id),
      );
      await lockMemberEligibilityRows(q, [target.id]);
      const lockedBoardRoles = await getBoardRoles(q, target.id);
      assertHeadDivisionMembership(lockedBoardRoles, divisions, university.name);
      await assertMemberProjectAssignmentEligibility(q, {
        userId: target.id,
        memberType,
        universityId: university.id,
        divisionIds: divisions.map((division) => division.id),
      });
      await upsertMemberRecord(q, target.id, memberType, university.id, options.notes);
      await replaceMemberDivisionRows(q, target.id, divisions);
      const profileDesiredGeneration = membershipChanged
        ? await enqueuePublishedProfileReconciliation(q, target.id)
        : null;
      const auditId = await writeAudit(q, {
        actorId: interaction.user.id,
        action: options.auditAction,
        targetType: 'member',
        targetId: target.id,
        universityId: university.id,
        before: { member: previousRecord, divisions: previousDivisions },
        after: {
          memberType,
          university: university.name,
          divisions: divisions.map((d) => d.name),
          profile: profileDesiredGeneration == null
            ? { reconciliationRequested: false }
            : { visibility: 'published', desiredGeneration: String(profileDesiredGeneration) },
        },
      });
      if (membershipChanged) {
        notificationId = await enqueueTransitionNotification(q, {
          auditId,
          recipientId: target.id,
          kind: 'member.access_updated',
          universityId: university.id,
          relatedEntityType: 'member',
          relatedEntityId: target.id,
          payload: formatMemberAccessHandoff(handoffResult),
          metadata: { action: options.auditAction },
        });
      }
    });
  } catch (error) {
    await compensateRoles(target, addedRoles, removedRoles, 'Compensating failed governance DB write');
    throw recoveryError(error, 'Discord roles were restored because the membership update could not be saved. Try again.');
  }

  const notificationDelivery = notificationId == null
    ? null
    : await deliverTransitionNotification({ db, guild: interaction.guild, notificationId, recipient: target });
  return { ...handoffResult, notificationDelivery };
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

export async function getMemberUpdateContext(
  interaction,
  options,
  deps: GovernanceDependencies = {},
) {
  const db = dbFrom(deps);
  const actor = actorMember(interaction);
  const target = await targetGuildMember(interaction, options.user);
  const member = await getMemberRecord(db, target.id);
  assertUser(member?.university_name && member.status === 'active', 'That user does not have an active member record.');
  assertCanManageMember(actor, member.university_name, target);
  const [divisions, boardRoles, projects] = await Promise.all([
    getMemberDivisions(db, target.id),
    getBoardRoles(db, target.id),
    getActiveProjectAssignments(db, target.id),
  ]);
  return { target, member, divisions, boardRoles, projects };
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
  let canonicalRemoval;
  let notificationId = null;
  const handoffResult = {
    target,
    universityName: member.university_name,
    divisions,
    boardRoles,
    projects,
  };

  try {
    await db.transaction(async (q) => {
      await lockDivisionHeadEligibilityRows(
        q,
        boardRoles
          .filter((boardRole) => boardRole.role === BOARD_ROLES.HEAD && boardRole.division_id != null)
          .map((boardRole) => boardRole.division_id),
      );
      await lockMemberEligibilityRows(q, [target.id]);
      canonicalRemoval = await removeMemberCanonicalState(q, target.id);
      if (!canonicalRemoval) return;
      await assertMemberProjectAssignmentEligibility(q, {
        userId: target.id,
        memberType: member.member_type,
        universityId: member.university_id,
        divisionIds: [],
      });
      const projectReconciliationGenerations = [];
      for (const projectId of canonicalRemoval.projectIds) {
        projectReconciliationGenerations.push({
          projectId,
          desiredGeneration: String(await enqueueProjectReconciliation(q, projectId)),
        });
      }
      const profile = await hideProfileAndEnqueue(q, target.id);
      const auditId = await writeAudit(q, {
        actorId: interaction.user.id,
        action: 'member.remove',
        targetType: 'member',
        targetId: target.id,
        universityId: member.university_id,
        before: { member, divisions, boardRoles, projects, removalPlan },
        after: {
          status: 'removed',
          boardAssignmentsDeactivated: canonicalRemoval.boardAssignmentsDeactivated,
          divisionsCleared: canonicalRemoval.divisionsCleared,
          projectAssignmentsDeleted: canonicalRemoval.projectAssignmentsDeleted,
          projectReconciliation: projectReconciliationGenerations,
          profile: profile == null
            ? { visibilityChanged: false, reconciliationRequested: false }
            : {
              visibility: 'hidden',
              desiredGeneration: String(profile.desiredGeneration),
              reconciliationRequested: true,
            },
        },
        reason: options.reason ?? null,
      });
      notificationId = await enqueueTransitionNotification(q, {
        auditId,
        recipientId: target.id,
        kind: 'member.removed',
        universityId: member.university_id,
        relatedEntityType: 'member',
        relatedEntityId: target.id,
        payload: formatMemberRemovalHandoff(handoffResult, {
          // The command reason is an internal audit reason. A distinct field
          // must be explicitly supplied by policy before any explanation is
          // included in the affected member's DM.
          shareableReason: options.memberFacingReason ?? null,
        }),
        metadata: { internalReasonShared: Boolean(options.memberFacingReason) },
      });
    });
  } catch (error) {
    throw recoveryError(error, 'The member was not removed because the membership record could not be saved. No Discord removal was attempted; try again.');
  }

  // The private explanation is attempted before the kick closes the member's
  // guild-member route. Its durable claim prevents a worker from replaying a
  // send whose outcome became uncertain during process interruption.
  const notificationDelivery = notificationId == null
    ? null
    : await deliverTransitionNotification({ db, guild: interaction.guild, notificationId, recipient: target });

  // A direct deletion closes the rejoin window immediately; the durable
  // reconciliation intent above then converges each channel to the complete
  // desired overwrite set (which cannot include this removed member).
  const overwriteCleanup = await removeProjectPermissionOverwrites(interaction.guild, target.id, projects);
  // Serialize this bounded removal batch so one removal cannot burst Discord
  // work or reconciliation claims across every past assignment at once.
  const reconciliations = [];
  for (const projectId of canonicalRemoval?.projectIds ?? []) {
    reconciliations.push(await reconcileProject({ projectId, guild: interaction.guild, db }));
  }
  const reconciliationFailures = reconciliations
    .filter((result) => result.status === 'failed')
    .map((result) => ({ channelId: String(result.projectId), code: 'reconciliation_failed' }));
  const cleanup = {
    cleanedChannelIds: overwriteCleanup.cleanedChannelIds,
    failures: [...overwriteCleanup.failures, ...reconciliationFailures],
  };

  let discordRemoval: { status: string; managedRolesRemoved: boolean; errorCode?: string } = {
    status: 'completed',
    managedRolesRemoved: true,
  };
  try {
    await target.kick(options.reason ?? 'BAINSA member removal');
  } catch (error) {
    logger.warn('Member removal kick failed after canonical removal', {
      userId: String(target.id), error: error instanceof Error ? error.message : String(error),
    });
    let fallbackRolesRemoved = true;
    try {
      await removeRolesByName(
        target,
        interaction.guild,
        stableRoleNames([
          ...removableMembershipRoleNames(member, divisions, member.university_name),
          ...removableBoardRoleNames(boardRoles),
        ]),
        'BAINSA member removal fallback after failed kick',
      );
    } catch (fallbackError) {
      fallbackRolesRemoved = false;
      logger.warn('Member removal fallback role cleanup failed', {
        userId: String(target.id),
        error: fallbackError instanceof Error ? fallbackError.message : String(fallbackError),
      });
    }
    discordRemoval = {
      status: 'pending_recovery',
      managedRolesRemoved: fallbackRolesRemoved,
      errorCode: error?.code == null ? 'unknown' : String(error.code),
    };
  }

  return {
    ...handoffResult,
    overwriteCleanup: cleanup,
    notificationDelivery,
    discordRemoval,
  };
}

/**
 * Discord can emit a departure event for a voluntary leave or a kick. It must
 * never alter canonical membership or create a second governance audit entry.
 */
export async function hideDepartedMemberProfile(member, deps: GovernanceDependencies = {}) {
  const db = dbFrom(deps);
  return db.transaction(async (client) => {
    if (await getMemberProfileVisibilityForUpdate(client, member.id) === 'hidden') return null;
    return hideProfileAndEnqueue(client, member.id);
  });
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

  assertUser(!await activeDivisionExists(db, university.id, divisionName), `${divisionName} already exists at ${university.name}.`);
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
  let notificationId = null;
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
      const divisionId = await createDivisionRecord(q, {
        universityId: university.id, name: divisionName, slug: slugify(divisionName), color: divisionColor.key,
        accessRoleId: accessRole.id, headRoleId: headRole.id,
        textChannelId: textChannel?.id ?? null, voiceChannelId: voiceChannel?.id ?? null,
      });
      await upsertMemberRecord(q, head.id, MEMBER_TYPES.RESEARCHER, university.id, null);
      await addMemberDivisionRow(q, head.id, divisionId);
      await ensureBoardAssignment(q, { userId: head.id, universityId: university.id, role: BOARD_ROLES.HEAD, divisionId });
      const auditId = await writeAudit(q, {
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
      const result = {
        university,
        divisionName,
        divisionColor,
        head,
        textChannel,
        voiceChannel,
        guildId: interaction.guild.id,
      };
      notificationId = await enqueueTransitionNotification(q, {
        auditId,
        recipientId: head.id,
        kind: 'board.head_assigned',
        universityId: university.id,
        relatedEntityType: 'division',
        relatedEntityId: divisionId,
        payload: formatDivisionHeadHandoff(result),
        metadata: { role: BOARD_ROLES.HEAD },
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
    throw recoveryError(error, 'Division creation was rolled back because a later step failed. Try again.');
  }

  const notificationDelivery = notificationId == null
    ? null
    : await deliverTransitionNotification({ db, guild: interaction.guild, notificationId, recipient: head });
  return {
    university,
    divisionName,
    divisionColor,
    head,
    textChannel,
    voiceChannel,
    guildId: interaction.guild.id,
    notificationDelivery,
  };
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
  const nameChanged = division.name !== newName;
  const colorChanged = division.color.toLowerCase() !== divisionColor.key;
  assertUser(nameChanged || colorChanged, 'Specify a new division name or color different from the current value.');

  if (nameChanged) {
    assertUser(!await activeDivisionConflictExists(db, university.id, newName, division.id), `${newName} already exists at ${university.name}.`);
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
      await updateDivisionRecord(q, {
        name: newName, slug: slugify(newName), color: divisionColor.key,
        accessRoleId: accessRole.id, headRoleId: headRole.id, divisionId: division.id,
      });
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
    throw recoveryError(error, 'Division update failed. Discord roles and channels were restored where possible; try again.');
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
  assertUser(
    previousRecord?.status === 'active'
      && previousRecord.member_type === MEMBER_TYPES.RESEARCHER
      && previousRecord.university_name === university.name,
    `Choose an active Researcher from ${university.name}.`,
  );
  const previousDivisions = await getMemberDivisions(db, target.id);
  const currentBoardRoles = await getBoardRoles(db, target.id);
  assertUser(
    !hasUniversityExecutiveAssignment(currentBoardRoles, university.name),
    'Presidents and Vice Presidents cannot hold university division memberships.',
  );
  assertUser(
    !previousDivisions.some((entry) => String(entry.id) === String(division.id)),
    `That member already belongs to ${division.name}.`,
  );

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
  let notificationId = null;

  try {
    await db.transaction(async (q) => {
      await lockMemberEligibilityRows(q, [target.id]);
      const currentMember = await getMemberRecord(q, target.id);
      const currentDivisions = await getMemberDivisions(q, target.id);
      const lockedBoardRoles = await getBoardRoles(q, target.id);
      assertUser(
        currentMember?.status === 'active'
          && currentMember.member_type === MEMBER_TYPES.RESEARCHER
          && String(currentMember.university_id) === String(university.id),
        'The selected member is no longer an active Researcher in this university.',
      );
      assertUser(
        !currentDivisions.some((entry) => String(entry.id) === String(division.id)),
        `That member already belongs to ${division.name}.`,
      );
      assertUser(
        !hasUniversityExecutiveAssignment(lockedBoardRoles, university.name),
        'The selected member became a President or Vice President while this panel was open.',
      );
      await assertMemberProjectAssignmentEligibility(q, {
        userId: target.id,
        memberType: MEMBER_TYPES.RESEARCHER,
        universityId: university.id,
        divisionIds: [...currentDivisions.map((entry) => entry.id), division.id],
      });
      await upsertMemberRecord(q, target.id, MEMBER_TYPES.RESEARCHER, university.id, null);
      await addMemberDivisionRow(q, target.id, division.id);
      const auditId = await writeAudit(q, {
        actorId: interaction.user.id,
        action: 'division.member.add',
        targetType: 'member',
        targetId: target.id,
        universityId: university.id,
        after: { division: division.name },
      });
      notificationId = await enqueueTransitionNotification(q, {
        auditId,
        recipientId: target.id,
        kind: 'division.access_added',
        universityId: university.id,
        relatedEntityType: 'member',
        relatedEntityId: target.id,
        payload: formatDivisionMemberHandoff(
          { target, university, division, guildId: interaction.guild.id },
          { removed: false },
        ),
      });
    });
  } catch (error) {
    await compensateRoles(target, addedRoles, removedRoles, 'Compensating failed division add member');
    throw recoveryError(error, 'Discord roles were restored because the division membership update could not be saved. Try again.');
  }

  const notificationDelivery = notificationId == null
    ? null
    : await deliverTransitionNotification({ db, guild: interaction.guild, notificationId, recipient: target });
  return { target, university, division, guildId: interaction.guild.id, notificationDelivery };
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
  const currentMember = await getMemberRecord(db, target.id);
  const currentDivisions = await getMemberDivisions(db, target.id);
  const currentBoardRoles = await getBoardRoles(db, target.id);
  assertUser(
    currentMember?.status === 'active'
      && currentMember.university_name === university.name,
    `Choose an active member from ${university.name}.`,
  );
  assertUser(
    currentDivisions.some((entry) => String(entry.id) === String(division.id)),
    `That member no longer belongs to ${division.name}.`,
  );
  assertUser(
    !currentBoardRoles.some((role) =>
      role.role === BOARD_ROLES.HEAD && String(role.division_id) === String(division.id),
    ),
    `Remove the member's Head of ${division.name} board role before removing their division membership.`,
  );
  assertMemberDivisionRequirement(
    currentMember.member_type,
    currentDivisions.filter((entry) => String(entry.id) !== String(division.id)),
    currentBoardRoles,
    university.name,
  );
  await assertNoActiveProjectAccessLoss(db, target.id, division);

  const reason = options.reason ?? `BAINSA governance: division.remove_member ${university.name}/${division.name}`;
  const removedRoles = await removeRolesByName(
    target,
    interaction.guild,
    [divisionRoleName(university.name, division.name)],
    reason,
  );
  let notificationId = null;

  try {
    await db.transaction(async (q) => {
      await lockMemberEligibilityRows(q, [target.id]);
      const lockedMember = await getMemberRecord(q, target.id);
      const lockedDivisions = await getMemberDivisions(q, target.id);
      const lockedBoardRoles = await getBoardRoles(q, target.id);
      assertUser(
        lockedMember?.status === 'active'
          && String(lockedMember.university_id) === String(university.id),
        'The selected member is no longer active in this university.',
      );
      assertUser(
        lockedDivisions.some((entry) => String(entry.id) === String(division.id)),
        `That member no longer belongs to ${division.name}.`,
      );
      assertUser(
        !lockedBoardRoles.some((role) =>
          role.role === BOARD_ROLES.HEAD && String(role.division_id) === String(division.id),
        ),
        `Remove the member's Head of ${division.name} board role before removing their division membership.`,
      );
      const remainingDivisions = lockedDivisions.filter((entry) =>
        String(entry.id) !== String(division.id),
      );
      assertMemberDivisionRequirement(
        lockedMember.member_type,
        remainingDivisions,
        lockedBoardRoles,
        university.name,
      );
      await assertMemberProjectAssignmentEligibility(q, {
        userId: target.id,
        memberType: lockedMember.member_type,
        universityId: lockedMember.university_id,
        divisionIds: remainingDivisions.map((entry) => entry.id),
      });
      await removeMemberDivisionRow(q, target.id, division.id);
      const auditId = await writeAudit(q, {
        actorId: interaction.user.id,
        action: 'division.member.remove',
        targetType: 'member',
        targetId: target.id,
        universityId: university.id,
        before: { division: division.name },
        reason: options.reason ?? null,
      });
      notificationId = await enqueueTransitionNotification(q, {
        auditId,
        recipientId: target.id,
        kind: 'division.access_removed',
        universityId: university.id,
        relatedEntityType: 'member',
        relatedEntityId: target.id,
        payload: formatDivisionMemberHandoff(
          { target, university, division, guildId: interaction.guild.id },
          { removed: true, reason: options.reason ?? null },
        ),
        metadata: { reasonSharedPrivately: Boolean(options.reason) },
      });
    });
  } catch (error) {
    await compensateRoles(target, [], removedRoles, 'Compensating failed division remove member');
    throw recoveryError(error, 'Discord roles were restored because the division membership update could not be saved. Try again.');
  }

  const notificationDelivery = notificationId == null
    ? null
    : await deliverTransitionNotification({ db, guild: interaction.guild, notificationId, recipient: target });
  return { target, university, division, guildId: interaction.guild.id, notificationDelivery };
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
  assertUser(
    previousRecord?.status === 'active' && previousRecord.university_name === university.name,
    `Choose an active member from ${university.name}.`,
  );

  const division =
    role === BOARD_ROLES.HEAD
      ? await getDivisionByName(db, university.id, university.name, divisionName)
      : null;

  const currentBoardRoles = await getBoardRoles(db, target.id);
  assertCanManageBoardMember(actor, university.name, target, currentBoardRoles);
  assertUser(
    !currentBoardRoles.some((assignment) =>
      assignment.role === role
      && assignment.university_name === university.name
      && (
        role !== BOARD_ROLES.HEAD
        || String(assignment.division_id) === String(division?.id)
      ),
    ),
    `That member already has the selected ${role === BOARD_ROLES.HEAD ? `Head of ${division.name}` : boardRoleLabel(role)} role.`,
  );
  if (role === BOARD_ROLES.HEAD) {
    assertHeadAssignmentCompatible(currentBoardRoles, university.name);
  }
  assertExclusiveBoardAssignmentAvailable(
    await getExclusiveBoardAssignment(db, university.id, role, division?.id ?? null),
    target.id,
    role,
    university,
    division,
  );
  const universityDivisionRoleIds = await getUniversityDivisionDiscordRoleIds(db, university.id);
  const currentUniversityHeadDivisionIds = currentBoardRoles
    .filter((boardRole) =>
      boardRole.role === BOARD_ROLES.HEAD &&
      boardRole.division_id != null &&
      boardRole.university_name === university.name,
    )
    .map((boardRole) => boardRole.division_id);
  const headEligibilityDivisionIds = role === BOARD_ROLES.HEAD
    ? [...new Set([division.id, ...currentUniversityHeadDivisionIds])]
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
  const removableRoles = discordDivisionRolesForUniversity(
    target,
    interaction.guild,
    universityDivisionRoleIds,
  );

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
  let notificationId = null;

  try {
    await db.transaction(async (q) => {
      await lockDivisionHeadEligibilityRows(q, headEligibilityDivisionIds);
      if (role === BOARD_ROLES.VICE_PRESIDENT) {
        await lockUniversityForUpdate(q, university.id);
      }
      await lockMemberEligibilityRows(q, [target.id]);
      const lockedMember = await getMemberRecord(q, target.id);
      const lockedBoardRoles = await getBoardRoles(q, target.id);
      assertUser(
        lockedMember?.status === 'active'
          && String(lockedMember.university_id) === String(university.id),
        'The selected member is no longer active in this university.',
      );
      assertCanManageBoardMember(actor, university.name, target, lockedBoardRoles);
      assertUser(
        !lockedBoardRoles.some((assignment) =>
          assignment.role === role
          && assignment.university_name === university.name
          && (
            role !== BOARD_ROLES.HEAD
            || String(assignment.division_id) === String(division?.id)
          ),
        ),
        'That board role was assigned while this panel was open. Reload the member before trying again.',
      );
      if (role === BOARD_ROLES.HEAD) {
        assertHeadAssignmentCompatible(lockedBoardRoles, university.name);
      }
      assertExclusiveBoardAssignmentAvailable(
        await getExclusiveBoardAssignment(q, university.id, role, division?.id ?? null),
        target.id,
        role,
        university,
        division,
      );
      await assertMemberProjectAssignmentEligibility(q, {
        userId: target.id,
        memberType: MEMBER_TYPES.RESEARCHER,
        universityId: university.id,
        divisionIds: [],
        additionalBoardUniversityIds: [university.id],
      });
      await upsertMemberRecord(q, target.id, MEMBER_TYPES.RESEARCHER, university.id, null);
      if (division) {
        await replaceMemberDivisionRows(q, target.id, [division]);
        await deactivateOtherHeadAssignments(q, target.id, university.id, division.id);
      }
      const insertedAssignment = await insertBoardAssignment(q, {
        userId: target.id, universityId: university.id, role, divisionId: division?.id ?? null,
      });
      assertUser(
        insertedAssignment === 1,
        'That board appointment changed while this panel was open. Reload the member before trying again.',
      );
      const auditId = await writeAudit(q, {
        actorId: interaction.user.id,
        action: 'board.assign',
        targetType: 'member',
        targetId: target.id,
        universityId: university.id,
        after: { role, division: division?.name ?? null },
      });
      const result = { target, university, role, division, guildId: interaction.guild.id };
      notificationId = await enqueueTransitionNotification(q, {
        auditId,
        recipientId: target.id,
        kind: 'board.authority_assigned',
        universityId: university.id,
        relatedEntityType: 'member',
        relatedEntityId: target.id,
        payload: formatBoardAssignmentHandoff(result),
        metadata: { role, division: division?.name ?? null },
      });
    });
  } catch (error) {
    await compensateRoles(target, addedRoles, removedRoles, 'Compensating failed board assign');
    throw recoveryError(error, 'Discord roles were restored because the board assignment could not be saved. Try again.');
  }

  const notificationDelivery = notificationId == null
    ? null
    : await deliverTransitionNotification({ db, guild: interaction.guild, notificationId, recipient: target });
  return { target, university, role, division, guildId: interaction.guild.id, notificationDelivery };
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
  const currentBoardRoles = await getBoardRoles(db, target.id);
  const currentMember = await getMemberRecord(db, target.id);
  assertUser(
    currentMember?.status === 'active' && currentMember.university_name === university.name,
    `Choose an active member from ${university.name}.`,
  );
  assertCanManageBoardMember(actor, university.name, target, currentBoardRoles);
  const matchingRoles = currentBoardRoles.filter((assignment) =>
    assignment.role === role
      && assignment.university_name === university.name
      && (
        role !== BOARD_ROLES.HEAD
        || !division
        || String(assignment.division_id) === String(division.id)
      ),
  );
  assertUser(
    matchingRoles.length > 0,
    role === BOARD_ROLES.HEAD && !division
      ? `That member no longer has a Head role at ${university.name}.`
      : `That member no longer has the selected ${boardRoleLabel(role)} role.`,
  );
  const headAssignments: Array<{ id: unknown; name: string }> = role !== BOARD_ROLES.HEAD
    ? []
    : division
      ? [division]
      : (
          await getActiveHeadDivisions(db, target.id, university.id)
        );
  const rolesToRemove = role === BOARD_ROLES.HEAD
    ? headAssignments.map((assignment) => divisionHeadRoleName(university.name, assignment.name))
    : [universityBoardRoleName(university.name, boardRoleLabel(role))];

  const removedRoles = await removeRolesByName(
    target,
    interaction.guild,
    rolesToRemove,
    options.reason ?? `BAINSA governance: board.remove ${university.name}/${role}`,
  );
  const removedAssignmentKeys = new Set(matchingRoles.map(boardAssignmentKey));
  const remainingRoles = currentBoardRoles.filter((assignment) => !removedAssignmentKeys.has(boardAssignmentKey(assignment)));
  let notificationId = null;

  try {
    await db.transaction(async (q) => {
      await lockDivisionHeadEligibilityRows(q, headAssignments.map((assignment) => assignment.id));
      await lockMemberEligibilityRows(q, [target.id]);
      const lockedMember = await getMemberRecord(q, target.id);
      const lockedBoardRoles = await getBoardRoles(q, target.id);
      assertUser(
        lockedMember?.status === 'active'
          && String(lockedMember.university_id) === String(university.id),
        'The selected member is no longer active in this university.',
      );
      assertCanManageBoardMember(actor, university.name, target, lockedBoardRoles);
      const lockedMatchingRoles = lockedBoardRoles.filter((assignment) =>
        assignment.role === role
          && assignment.university_name === university.name
          && (
            role !== BOARD_ROLES.HEAD
            || !division
            || String(assignment.division_id) === String(division.id)
          ),
      );
      assertUser(
        sameBoardAssignments(matchingRoles, lockedMatchingRoles),
        'That board assignment changed while this panel was open. Reload the member before trying again.',
      );
      await deactivateBoardAssignments(q, target.id, university.id, role, division?.id ?? null);
      const memberDivisions = await getMemberDivisions(q, target.id);
      await assertMemberProjectAssignmentEligibility(q, {
        userId: target.id,
        memberType: lockedMember.member_type,
        universityId: lockedMember.university_id,
        divisionIds: memberDivisions.map((entry) => entry.id),
      });
      const auditId = await writeAudit(q, {
        actorId: interaction.user.id,
        action: 'board.remove',
        targetType: 'member',
        targetId: target.id,
        universityId: university.id,
        before: { role, division: division?.name ?? null },
        reason: options.reason ?? null,
      });
      const result = {
        target,
        university,
        role,
        division,
        remainingRoles,
        guildId: interaction.guild.id,
      };
      notificationId = await enqueueTransitionNotification(q, {
        auditId,
        recipientId: target.id,
        kind: 'board.authority_removed',
        universityId: university.id,
        relatedEntityType: 'member',
        relatedEntityId: target.id,
        payload: formatBoardRemovalHandoff(result, options.memberFacingReason ?? null),
        metadata: {
          role,
          division: division?.name ?? null,
          reasonSharedPrivately: Boolean(options.memberFacingReason),
        },
      });
    });
  } catch (error) {
    await compensateRoles(target, [], removedRoles, 'Compensating failed board remove');
    throw recoveryError(error, 'Discord roles were restored because the board removal could not be saved. Try again.');
  }

  const notificationDelivery = notificationId == null
    ? null
    : await deliverTransitionNotification({ db, guild: interaction.guild, notificationId, recipient: target });
  return {
    target,
    university,
    role,
    division,
    remainingRoles,
    guildId: interaction.guild.id,
    notificationDelivery,
  };
}

export async function updateBoardRoster(interaction, options, deps: GovernanceDependencies = {}) {
  const db = dbFrom(deps);
  const actor = actorMember(interaction);
  const university = await getUniversityByName(db, options.university);
  const authorityResult = await getBoardAuthorityRoles(db, interaction.user.id, university.id);
  const actorRoles = new Set(authorityResult.map((assignment) => String(assignment.role)));
  const actorPresident = actorRoles.has(BOARD_ROLES.PRESIDENT);
  const actorVicePresident = actorRoles.has(BOARD_ROLES.VICE_PRESIDENT);
  const actorGlobal = isGlobalPresident(actor);
  assertUser(
    actorGlobal || actorPresident || actorVicePresident,
    `Only a Global President or the President or Vice President of ${university.name} can update its board.`,
  );

  const divisions = await listActiveDivisionsForBoard(db, university.id) as Array<{
    id: unknown;
    university_id: unknown;
    name: string;
    color: string;
    member_role_id: string | null;
    head_role_id: string | null;
  }>;
  const divisionsById = new Map(divisions.map((division) => [String(division.id), division]));
  const normalizeAssignments = (assignments) => assignments.map((assignment) => {
    const role = String(assignment.role);
    assertUser(
      ([BOARD_ROLES.HEAD, BOARD_ROLES.VICE_PRESIDENT, BOARD_ROLES.PRESIDENT] as string[]).includes(role),
      'The board update contains an unknown role.',
    );
    const division = role === BOARD_ROLES.HEAD
      ? divisionsById.get(String(assignment.divisionId ?? assignment.division_id ?? ''))
      : null;
    assertUser(role !== BOARD_ROLES.HEAD || division, 'The board update contains an unavailable division.');
    assertUser(
      role === BOARD_ROLES.HEAD || (assignment.divisionId == null && assignment.division_id == null),
      'Only Head roles can include a division.',
    );
    return {
      discord_user_id: String(assignment.userId ?? assignment.discord_user_id ?? ''),
      university_id: university.id,
      role,
      division_id: division?.id ?? null,
      division_name: division?.name ?? null,
    };
  });
  const expectedAssignments = normalizeAssignments(options.expectedAssignments ?? []);
  const desiredAssignments = normalizeAssignments(options.assignments ?? []);
  assertUser(
    desiredAssignments.every((assignment) => assignment.discord_user_id),
    'Every occupied board position must identify a member.',
  );

  const exactKeys = desiredAssignments.map((assignment) => boardAssignmentKey(assignment));
  assertUser(new Set(exactKeys).size === exactKeys.length, 'The board update contains a duplicate assignment.');
  assertUser(
    desiredAssignments.filter((assignment) => assignment.role === BOARD_ROLES.PRESIDENT).length > 0,
    `${university.name} must keep at least one President.`,
  );
  const headAssignments = desiredAssignments.filter((assignment) => assignment.role === BOARD_ROLES.HEAD);
  assertUser(
    new Set(headAssignments.map((assignment) => assignment.discord_user_id)).size === headAssignments.length,
    'A member can lead only one division at a time.',
  );
  const executiveUserIds = new Set(desiredAssignments
    .filter((assignment) => assignment.role !== BOARD_ROLES.HEAD)
    .map((assignment) => assignment.discord_user_id));
  assertUser(
    headAssignments.every((assignment) => !executiveUserIds.has(assignment.discord_user_id)),
    'Presidents and Vice Presidents cannot simultaneously hold a division Head position.',
  );

  const currentAssignments = await listActiveBoardAssignments(db, university.id);
  assertUser(
    sameBoardAssignments(currentAssignments, expectedAssignments),
    'The board changed while this panel was open. Run `/board-update` again to load the current roster.',
  );
  assertUser(
    !sameBoardAssignments(currentAssignments, desiredAssignments),
    'Choose at least one board change before saving.',
  );

  const currentKeys = new Set(currentAssignments.map(boardAssignmentKey));
  const desiredKeys = new Set(desiredAssignments.map(boardAssignmentKey));
  const removals = currentAssignments.filter((assignment) => !desiredKeys.has(boardAssignmentKey(assignment)));
  const additions = desiredAssignments.filter((assignment) => !currentKeys.has(boardAssignmentKey(assignment)));
  for (const assignment of [...removals, ...additions]) {
    assertUser(
      assignment.role !== BOARD_ROLES.PRESIDENT || actorGlobal || actorPresident,
      `Only the President of ${university.name} can change its President position.`,
    );
  }

  const affectedUserIds = [...new Set([...removals, ...additions].map((assignment) => assignment.discord_user_id))].sort();
  const universityDivisionRoleIds = await getUniversityDivisionDiscordRoleIds(db, university.id);
  const people = [];
  for (const userId of affectedUserIds) {
    const [target, member, memberDivisions, boardRoles] = await Promise.all([
      targetGuildMember(interaction, { id: userId }),
      getMemberRecord(db, userId),
      getMemberDivisions(db, userId),
      getBoardRoles(db, userId),
    ]);
    assertUser(!hasRole(target, ROLE_NAMES.BOT), 'The Bot member cannot be managed.');
    assertUser(
      !hasRole(target, ROLE_NAMES.GLOBAL_PRESIDENT)
        && !boardRoles.some((assignment) => assignment.role === BOARD_ROLES.GLOBAL_PRESIDENT),
      'You cannot manage Global President members.',
    );
    assertUser(
      member?.status === 'active' && String(member.university_id) === String(university.id),
      `<@${userId}> is no longer an active member of ${university.name}.`,
    );
    const currentRoles = boardAssignmentsForUser(currentAssignments, userId)
      .map((assignment) => ({ ...assignment, university_name: university.name }));
    assertUser(
      actorGlobal || actorPresident || !currentRoles.some((assignment) => assignment.role === BOARD_ROLES.PRESIDENT),
      'A Vice President cannot manage their university President.',
    );
    const nextRoles = boardAssignmentsForUser(desiredAssignments, userId);
    people.push({ target, member, memberDivisions, currentRoles, nextRoles });
  }

  const roleChanges = [];
  const memberChanges = people.map((person) => ({
    target: person.target,
    before: person.currentRoles.map(localBoardAssignmentLabel),
    after: person.nextRoles.map(localBoardAssignmentLabel),
    currentRoles: person.currentRoles,
    nextRoles: person.nextRoles,
  }));
  const notificationRecords = [];
  const discordReason = `BAINSA governance: board.update ${university.name}`;
  try {
    for (const person of people) {
      const executiveRoles = person.nextRoles.filter((assignment) => assignment.role !== BOARD_ROLES.HEAD);
      const headRole = person.nextRoles.find((assignment) => assignment.role === BOARD_ROLES.HEAD) ?? null;
      const finalDivisions = executiveRoles.length > 0
        ? []
        : headRole
          ? [divisionsById.get(String(headRole.division_id))]
          : person.memberDivisions;
      const desiredRoleNames = [
        universityAccessRoleName(university.name),
        ...finalDivisions.map((division) => divisionRoleName(university.name, division.name)),
        ...executiveRoles.map((assignment) =>
          universityBoardRoleName(university.name, boardRoleLabel(assignment.role)),
        ),
        ...(headRole ? [divisionHeadRoleName(university.name, headRole.division_name)] : []),
      ];
      const change = await enforceResearcherRoles(
        person.target,
        interaction.guild,
        desiredRoleNames,
        discordReason,
        {
          removableRoleNames: [
            universityBoardRoleName(university.name, 'President'),
            universityBoardRoleName(university.name, 'Vice President'),
          ],
          removableRoles: discordDivisionRolesForUniversity(
            person.target,
            interaction.guild,
            universityDivisionRoleIds,
          ),
        },
      );
      roleChanges.push({ person, ...change });
    }
  } catch (error) {
    await Promise.all(roleChanges.map(({ person, addedRoles, removedRoles }) =>
      compensateRoles(person.target, addedRoles, removedRoles, 'Compensating failed board roster update'),
    ));
    throw error;
  }

  try {
    await db.transaction(async (q) => {
      await lockUniversityForUpdate(q, university.id);
      await lockDivisionHeadEligibilityRows(q, divisions.map((division) => division.id));
      await lockMemberEligibilityRows(q, affectedUserIds);
      const locked = await listActiveBoardAssignments(q, university.id, { forUpdate: true });
      assertUser(
        sameBoardAssignments(locked, expectedAssignments),
        'The board changed while this update was being saved. Run `/board-update` again.',
      );

      for (const person of people) {
        const lockedMember = await getMemberRecord(q, person.target.id);
        assertUser(
          lockedMember?.status === 'active' && String(lockedMember.university_id) === String(university.id),
          `<@${person.target.id}> is no longer an active member of ${university.name}.`,
        );
        const nextRoles = boardAssignmentsForUser(desiredAssignments, person.target.id);
        const executiveRoles = nextRoles.filter((assignment) => assignment.role !== BOARD_ROLES.HEAD);
        const headRole = nextRoles.find((assignment) => assignment.role === BOARD_ROLES.HEAD) ?? null;
        const lockedDivisions = await getMemberDivisions(q, person.target.id);
        const finalDivisions = executiveRoles.length > 0
          ? []
          : headRole
            ? [divisionsById.get(String(headRole.division_id))]
            : lockedDivisions;
        await assertMemberProjectAssignmentEligibility(q, {
          userId: person.target.id,
          memberType: MEMBER_TYPES.RESEARCHER,
          universityId: university.id,
          divisionIds: finalDivisions.map((division) => division.id),
          additionalBoardUniversityIds: nextRoles.length > 0 ? [university.id] : [],
        });
        await upsertMemberRecord(q, person.target.id, MEMBER_TYPES.RESEARCHER, university.id, null);
        if (executiveRoles.length > 0 || headRole) {
          await replaceMemberDivisionRows(q, person.target.id, finalDivisions);
        }
      }

      for (const assignment of removals) {
        await deactivateExactBoardAssignment(q, assignment.discord_user_id, university.id, assignment.role, assignment.division_id);
      }
      for (const assignment of additions) {
        const inserted = await insertBoardAssignment(q, {
          userId: assignment.discord_user_id, universityId: university.id,
          role: assignment.role, divisionId: assignment.division_id,
        });
        assertUser(inserted === 1, 'A selected board position was assigned concurrently. Reload the board.');
      }
      const auditId = await writeAudit(q, {
        actorId: interaction.user.id,
        action: 'board.update',
        targetType: 'university',
        targetId: university.id,
        universityId: university.id,
        before: { assignments: currentAssignments },
        after: { assignments: desiredAssignments },
      });
      const handoffResult = {
        university,
        divisions,
        guildId: interaction.guild.id,
      };
      for (const change of memberChanges) {
        const notificationId = await enqueueTransitionNotification(q, {
          auditId,
          recipientId: change.target.id,
          kind: 'board.authority_changed',
          universityId: university.id,
          relatedEntityType: 'member',
          relatedEntityId: change.target.id,
          payload: formatBoardUpdateHandoff(handoffResult, change),
          metadata: { before: change.before, after: change.after },
        });
        if (notificationId != null) notificationRecords.push({ notificationId, target: change.target });
      }
    });
  } catch (error) {
    await Promise.all(roleChanges.map(({ person, addedRoles, removedRoles }) =>
      compensateRoles(person.target, addedRoles, removedRoles, 'Compensating failed board roster update'),
    ));
    throw recoveryError(error, 'Discord roles were restored because the board update could not be saved. Try again.');
  }

  const recipients = new Map(notificationRecords.map(({ notificationId, target }) => [String(notificationId), target]));
  const notificationDeliveries = await deliverTransitionNotifications({
    db,
    guild: interaction.guild,
    notificationIds: notificationRecords.map(({ notificationId }) => notificationId),
    recipients,
  });

  return {
    university,
    divisions,
    guildId: interaction.guild.id,
    assignments: desiredAssignments,
    previousAssignments: currentAssignments,
    positionChanges: boardPositionChanges(currentAssignments, desiredAssignments, divisions),
    memberChanges,
    notificationDeliveries,
  };
}

export async function getBoardInfo(interaction, options, deps: GovernanceDependencies = {}) {
  const db = dbFrom(deps);
  const actor = actorMember(interaction);
  const university = await getUniversityByName(db, options.university);
  const actorHasBoardAssignment = !isGlobalPresident(actor)
    && await hasActiveBoardAssignment(db, interaction.user.id, university.id);
  assertUser(
    isGlobalPresident(actor) ||
      hasRole(actor, universityBoardRoleName(university.name, 'President')) ||
      hasRole(actor, universityBoardRoleName(university.name, 'Vice President')) ||
      actorHasBoardAssignment,
    `Only ${university.name} board members can view board info.`,
  );

  const [result, divisions, notificationHealth] = await Promise.all([
    listBoardInfoAssignments(db, university.id),
    listActiveDivisionsForBoard(db, university.id),
    transitionNotificationHealth(db, university.id).catch((error) => {
      logger.warn('Board notification health could not be loaded', {
        universityId: String(university.id),
        error: error instanceof Error ? error.message : String(error),
      });
      return { pending: 0, failed: 0, uncertain: 0, unavailable: true };
    }),
  ]);
  const managedBoardRoleNames = [
    universityBoardRoleName(university.name, 'President'),
    universityBoardRoleName(university.name, 'Vice President'),
    ...divisions.map((division) => divisionHeadRoleName(university.name, division.name)),
  ];
  const assignmentsByMember = new Map();
  for (const row of result) {
    const userId = String(row.discord_user_id);
    assignmentsByMember.set(userId, [...(assignmentsByMember.get(userId) ?? []), row]);
  }

  const rows = [];
  for (const row of result) {
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
    const expectedManagedRoles = new Set((assignmentsByMember.get(String(row.discord_user_id)) ?? []).map((assignment) =>
      assignment.role === BOARD_ROLES.HEAD && assignment.division_name
        ? divisionHeadRoleName(university.name, assignment.division_name)
        : universityBoardRoleName(university.name, boardRoleLabel(assignment.role)),
    ));
    const unexpectedRoles = member
      ? managedBoardRoleNames.filter((roleName) => hasRole(member, roleName) && !expectedManagedRoles.has(roleName))
      : [];
    rows.push({ ...row, missingRoles, unexpectedRoles });
  }

  return { university, divisions, rows, notificationHealth };
}

export {
  divisionChannelName,
  divisionChannelOverwrites,
  findDivisions,
  findUniversities,
  formatBoardInfo,
  formatMemberInfo,
  invalidateGovernanceAutocompleteCache,
  listDivisions,
  listUniversities,
  memberRemovalCleanupPlan,
  projectChannelCleanupTargets,
  resolveDivisionTextForMemberUpdate,
  roleNamesForDivisionHead,
  warmGovernanceAutocompleteCache,
};
