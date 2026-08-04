import {
  ActionRowBuilder,
  MessageFlags,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';

import { assertUniversityAuthority } from '../authorization.js';
import { writeAudit } from '../audit.js';
import { BOARD_ROLES, MEMBER_TYPES, ROLE_NAMES } from '../constants.js';
import { query, transaction } from '../db.js';
import { UserFacingError, assertUser } from '../errors.js';
import { logger } from '../logger.js';
import { divisionRoleName } from '../naming.js';
import {
  confirmPayload,
  divisionPayload,
  memberTypePayload,
  reviewPayload,
  reviewedPayload,
  universityPayload,
} from './components.js';
import { ONBOARDING_ACTIONS, isOnboardingCustomId, onboardingId, parseOnboardingId } from './custom-ids.js';
import {
  createDraft,
  getRequestForUser,
  getUniversity,
  listAllDivisions,
  listAllUniversities,
  listDivisionsByIds,
  listDivisionsForUniversity,
  listUniversities,
  lockRequest,
  markReviewed,
  updateDraft,
  upsertActiveMember,
} from './repository.js';
import {
  ONBOARDING_STATUSES,
  canSubmitOnboardingRequest,
  hasValidFullName,
  normalizeFullName,
  normalizeSelectedDivisionIds,
} from './state.js';

const DISCORD_NICKNAME_LIMIT = 32;

export function createOnboardingService({ db = { query }, runTransaction = transaction } = {}) {
  async function handleButton(interaction) {
    const parsed = parseOnboardingId(interaction.customId);
    if (!parsed) return;

    const [requestId, value] = parsed.parts;

    if (parsed.action === ONBOARDING_ACTIONS.START) {
      const request = await createDraft(db, interaction.user.id);
      if (request.status === ONBOARDING_STATUSES.PENDING) {
        await interaction.reply({
          content: 'Your onboarding request is already pending board review.',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      await showNameModal(interaction, request);
      return;
    }

    if (parsed.action === ONBOARDING_ACTIONS.MEMBER_TYPE) {
      assertMemberType(value);
      const request = await updateOwnedDraft(db, requestId, interaction.user.id, {
        member_type: value,
        division_ids: value === MEMBER_TYPES.ALUMNI ? [] : undefined,
      });
      const universities = await listUniversities(db);
      assertUser(universities.length > 0, 'No universities are available for onboarding yet.');
      await interaction.update(universityPayload(request.id, universities, 0));
      return;
    }

    if (parsed.action === ONBOARDING_ACTIONS.UNIVERSITY_PAGE) {
      const request = await requireOwnedDraft(db, requestId, interaction.user.id);
      const universities = await listUniversities(db);
      await interaction.update(universityPayload(request.id, universities, Number(value) || 0, request.university_id));
      return;
    }

    if (parsed.action === ONBOARDING_ACTIONS.UNIVERSITY_DONE) {
      let request = await requireOwnedDraft(db, requestId, interaction.user.id);
      assertUser(request.university_id, 'Choose a university before continuing.');

      const university = await getUniversity(db, request.university_id);
      assertUser(university, 'That university is not available.');

      if (request.member_type === MEMBER_TYPES.ALUMNI) {
        request = await updateOwnedDraft(db, requestId, interaction.user.id, { division_ids: [] });
        await showConfirmation(interaction, request);
        return;
      }

      const divisions = await listDivisionsForUniversity(db, request.university_id);
      assertUser(divisions.length > 0, 'No divisions are available for that university yet.');
      await interaction.update(divisionPayload(request.id, divisions, request.division_ids, 0));
      return;
    }

    if (parsed.action === ONBOARDING_ACTIONS.DIVISIONS_PAGE) {
      const request = await requireOwnedDraft(db, requestId, interaction.user.id);
      const divisions = await listDivisionsForUniversity(db, request.university_id);
      await interaction.update(divisionPayload(request.id, divisions, request.division_ids, Number(value) || 0));
      return;
    }

    if (parsed.action === ONBOARDING_ACTIONS.DIVISIONS_DONE) {
      const request = await requireOwnedDraft(db, requestId, interaction.user.id);
      assertUser(canSubmitOnboardingRequest(request), 'Choose at least one division before continuing.');
      await showConfirmation(interaction, request);
      return;
    }

    if (parsed.action === ONBOARDING_ACTIONS.SUBMIT) {
      const request = await requireOwnedDraft(db, requestId, interaction.user.id);
      assertUser(canSubmitOnboardingRequest(request), 'The onboarding request is incomplete.');
      await submitForReview(interaction, request);
      return;
    }

    if (parsed.action === ONBOARDING_ACTIONS.CANCEL) {
      await updateOwnedDraft(db, requestId, interaction.user.id, { status: ONBOARDING_STATUSES.CANCELLED });
      await interaction.update({ content: 'Onboarding cancelled. You can start again from #onboarding.', embeds: [], components: [] });
      return;
    }

    if (parsed.action === ONBOARDING_ACTIONS.APPROVE) {
      await approveRequest(interaction, requestId);
      return;
    }

    if (parsed.action === ONBOARDING_ACTIONS.REJECT) {
      await showRejectModal(interaction, requestId);
      return;
    }
  }

  async function handleStringSelect(interaction) {
    const parsed = parseOnboardingId(interaction.customId);
    if (!parsed) return;
    const [requestId, pageValue] = parsed.parts;

    if (parsed.action === ONBOARDING_ACTIONS.UNIVERSITY) {
      const universityId = interaction.values[0];
      const universities = await listUniversities(db);
      const page = Number(pageValue) || 0;
      const pageIds = universities.slice(page * 25, page * 25 + 25).map((university) => String(university.id));
      assertUser(interaction.values.length === 1, 'Choose exactly one university.');
      assertUser(pageIds.includes(String(universityId)), 'Choose a university from this page.');

      const request = await updateOwnedDraft(db, requestId, interaction.user.id, {
        university_id: universityId,
        division_ids: [],
      });
      const university = await getUniversity(db, universityId);
      assertUser(university, 'That university is not available.');
      await interaction.update(universityPayload(request.id, universities, page, university.id));
      return;
    }

    if (parsed.action === ONBOARDING_ACTIONS.DIVISIONS) {
      const request = await requireOwnedDraft(db, requestId, interaction.user.id);
      const divisions = await listDivisionsForUniversity(db, request.university_id);
      const page = Number(pageValue) || 0;
      const pageIds = divisions.slice(page * 25, page * 25 + 25).map((division) => String(division.id));
      assertUser(interaction.values.length === 1, 'Choose exactly one division.');
      assertUser(pageIds.includes(String(interaction.values[0])), 'Choose a division from this page.');
      const next = [String(interaction.values[0])];
      const updated = await updateOwnedDraft(db, requestId, interaction.user.id, { division_ids: next });
      await interaction.update(divisionPayload(updated.id, divisions, updated.division_ids, page));
    }
  }

  async function handleModalSubmit(interaction) {
    const parsed = parseOnboardingId(interaction.customId);
    if (parsed?.action === ONBOARDING_ACTIONS.NAME_MODAL) {
      const [requestId] = parsed.parts;
      const fullName = normalizeFullName(interaction.fields.getTextInputValue('full_name'));
      assertUser(hasValidFullName(fullName), 'Enter your full name using 2 to 120 characters.');
      const request = await updateOwnedDraft(db, requestId, interaction.user.id, { full_name: fullName });
      await interaction.reply({ ...memberTypePayload(request.id), flags: MessageFlags.Ephemeral });
      return;
    }
    if (parsed?.action !== ONBOARDING_ACTIONS.REJECT_MODAL) return;
    const [requestId] = parsed.parts;
    const reason = interaction.fields.getTextInputValue('reason')?.trim() || null;
    await rejectRequest(interaction, requestId, reason);
  }

  async function submitForReview(interaction, request) {
    let message = null;

    try {
      await runTransaction(async (client) => {
        const locked = await lockRequest(client, request.id);
        assertUser(
          locked?.discord_user_id === interaction.user.id,
          'This onboarding request was not found.',
        );
        assertUser(locked.status === ONBOARDING_STATUSES.DRAFT, 'This onboarding request is no longer editable.');
        assertUser(canSubmitOnboardingRequest(locked), 'The onboarding request is incomplete.');

        const university = await getUniversity(client, locked.university_id);
        assertUser(university, 'That university is not available.');
        const divisions = await listDivisionsByIds(client, locked.university_id, locked.division_ids);
        const reviewChannel = await resolveReviewChannel(interaction.guild, university);
        message = await reviewChannel.send(
          reviewPayload({ ...locked, status: ONBOARDING_STATUSES.PENDING }, university, divisions),
        );

        const updated = await updateDraft(client, locked.id, interaction.user.id, {
          status: ONBOARDING_STATUSES.PENDING,
          review_message_id: message.id,
        });
        await assertDraftWriteSucceeded(client, locked.id, interaction.user.id, updated);
      });
    } catch (error) {
      await message?.delete().catch(() => undefined);
      throw error;
    }

    await interaction.update({
      content: 'Your onboarding request was sent to the university board for review.',
      embeds: [],
      components: [],
    });
  }

  async function approveRequest(interaction, requestId) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    let reviewed;
    let university;
    let divisions;
    let rollbackDiscordState = null;

    try {
      await runTransaction(async (client) => {
        const request = await lockRequest(client, requestId);
        assertPendingRequest(request);
        university = await getUniversity(client, request.university_id);
        assertUser(university, 'That university is not available.');
        divisions = await listDivisionsByIds(client, request.university_id, request.division_ids);
        const allDivisions = await listAllDivisions(client);
        const allUniversities = await listAllUniversities(client);
        await assertReviewer(interaction, university.name);
        rollbackDiscordState = await assignApprovedDiscordState(
          interaction.guild,
          request,
          university,
          divisions,
          allDivisions,
          allUniversities,
        );
        await upsertActiveMember(client, request);
        reviewed = await markReviewed(client, request.id, ONBOARDING_STATUSES.APPROVED, interaction.user.id);
        await writeAudit(client, {
          actorId: interaction.user.id,
          action: 'onboarding.approve',
          targetType: 'member',
          targetId: request.discord_user_id,
          universityId: request.university_id,
          after: {
            requestId: request.id,
            memberType: request.member_type,
            divisionIds: normalizeSelectedDivisionIds(request.division_ids),
          },
        });
      });
    } catch (error) {
      if (rollbackDiscordState) {
        await rollbackDiscordState().catch((rollbackError) => {
          logger.error('Failed to roll back Discord member state after approval error', {
            userId: interaction.user.id,
            requestId,
            error: rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
          });
        });
      }
      throw error;
    }

    await editReviewMessage(interaction, reviewed, university, divisions);
    await interaction.editReply('Onboarding request approved.');
  }

  async function rejectRequest(interaction, requestId, reason) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    let reviewed;
    let university;
    let divisions;

    await runTransaction(async (client) => {
      const request = await lockRequest(client, requestId);
      assertPendingRequest(request);
      university = await getUniversity(client, request.university_id);
      assertUser(university, 'That university is not available.');
      divisions = await listDivisionsByIds(client, request.university_id, request.division_ids);
      await assertReviewer(interaction, university.name);
      reviewed = await markReviewed(client, request.id, ONBOARDING_STATUSES.REJECTED, interaction.user.id, reason);
      await writeAudit(client, {
        actorId: interaction.user.id,
        action: 'onboarding.reject',
        targetType: 'onboarding_request',
        targetId: request.id,
        universityId: request.university_id,
        reason,
      });
    });

    await editReviewMessage(interaction, reviewed, university, divisions, reason);
    await interaction.editReply('Onboarding request rejected.');
  }

  async function showConfirmation(interaction, request) {
    const university = await getUniversity(db, request.university_id);
    assertUser(university, 'That university is not available.');
    const divisions = await listDivisionsByIds(db, request.university_id, request.division_ids);
    await interaction.update(confirmPayload(request.id, request, university, divisions));
  }

  async function showRejectModal(interaction, requestId) {
    const modal = new ModalBuilder()
      .setCustomId(onboardingId(ONBOARDING_ACTIONS.REJECT_MODAL, requestId))
      .setTitle('Reject onboarding request')
      .addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder()
            .setCustomId('reason')
            .setLabel('Reason')
            .setRequired(false)
            .setStyle(TextInputStyle.Paragraph)
            .setMaxLength(1000),
        ),
      );
    await interaction.showModal(modal);
  }

  async function showNameModal(interaction, request) {
    const fullNameInput = new TextInputBuilder()
      .setCustomId('full_name')
      .setLabel('Full name')
      .setPlaceholder('e.g. Ada Lovelace')
      .setRequired(true)
      .setStyle(TextInputStyle.Short)
      .setMinLength(2)
      .setMaxLength(120);

    if (hasValidFullName(request.full_name)) {
      fullNameInput.setValue(request.full_name);
    }

    const modal = new ModalBuilder()
      .setCustomId(onboardingId(ONBOARDING_ACTIONS.NAME_MODAL, request.id))
      .setTitle('Step 1 of 4 · Your name')
      .addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          fullNameInput,
        ),
      );
    await interaction.showModal(modal);
  }

  async function sendJoinDm(member) {
    try {
      await member.send('Welcome to BAINSA. Open #onboarding in the server and press Begin onboarding to request access.');
    } catch (error) {
      logger.info('Could not DM onboarding instructions', {
        userId: member.user?.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    canHandle: isOnboardingCustomId,
    handleButton,
    handleStringSelect,
    handleModalSubmit,
    sendJoinDm,
  };
}

async function requireOwnedDraft(db, requestId, userId) {
  const request = await getRequestForUser(db, requestId, userId);
  assertUser(request, 'This onboarding request was not found.');
  assertUser(request.status === ONBOARDING_STATUSES.DRAFT, 'This onboarding request is no longer editable.');
  return request;
}

async function updateOwnedDraft(db, requestId, userId, patch) {
  const request = await updateDraft(db, requestId, userId, patch);
  return assertDraftWriteSucceeded(db, requestId, userId, request);
}

async function assertDraftWriteSucceeded(db, requestId, userId, request) {
  if (request) return request;

  const current = await getRequestForUser(db, requestId, userId);
  assertUser(current, 'This onboarding request was not found.');
  assertUser(current.status === ONBOARDING_STATUSES.DRAFT, 'This onboarding request is no longer editable.');
  throw new Error('Conditional onboarding draft update did not return a row.');
}

function assertMemberType(memberType) {
  assertUser(Object.values(MEMBER_TYPES).includes(memberType), 'Choose Researcher or Alumni.');
}

function assertPendingRequest(request) {
  assertUser(request, 'This onboarding request was not found.');
  assertUser(request.status === ONBOARDING_STATUSES.PENDING, 'This request has already been reviewed.');
}

async function assertReviewer(interaction, universityName) {
  const member = await interaction.guild.members.fetch(interaction.user.id);
  assertUniversityAuthority(member, universityName, [
    BOARD_ROLES.HEAD,
    BOARD_ROLES.VICE_PRESIDENT,
    BOARD_ROLES.PRESIDENT,
  ]);
}

async function resolveReviewChannel(guild, university) {
  assertUser(university, 'That university is not available.');
  const channelId = university?.onboarding_review_channel_id;
  const channel = channelId ? await guild.channels.fetch(channelId).catch(() => null) : null;
  assertUser(channel?.isTextBased?.(), `The onboarding review channel for ${university.name} is not configured.`);
  return channel;
}

async function editReviewMessage(interaction, request, university, divisions, reason = null) {
  const payload = reviewedPayload(request, university, divisions, interaction.user.id, reason);
  if (interaction.message?.editable) {
    await interaction.message.edit(payload);
    return;
  }

  const channel = await resolveReviewChannel(interaction.guild, university);
  const message = request.review_message_id
    ? await channel.messages.fetch(request.review_message_id).catch(() => null)
    : null;

  await message?.edit(payload);
}

async function assignApprovedDiscordState(guild, request, university, divisions, allDivisions, allUniversities) {
  const member = await guild.members.fetch(request.discord_user_id);
  const previousRoleIds = new Set(member.roles.cache.keys());
  const previousNickname = member.nickname ?? null;
  const targetRoleIds = new Set();
  targetRoleIds.add(await resolveRoleId(guild, request.member_type === MEMBER_TYPES.ALUMNI ? ROLE_NAMES.ALUMNI : ROLE_NAMES.RESEARCHER));
  targetRoleIds.add(await resolveRoleId(guild, university.discord_role_id, university.name));

  for (const division of divisions) {
    targetRoleIds.add(await resolveRoleId(guild, division.member_role_id, divisionRoleName(university.name, division.name)));
  }

  const memberTypeIds = await Promise.all([
    resolveRoleId(guild, ROLE_NAMES.RESEARCHER).catch(() => null),
    resolveRoleId(guild, ROLE_NAMES.ALUMNI).catch(() => null),
  ]);
  const allDivisionIds = allDivisions
    .map((division) => member.guild.roles.cache.get(division.member_role_id)?.id
      ?? member.guild.roles.cache.find((role) => role.name === divisionRoleName(division.university_name, division.name))?.id)
    .filter(Boolean);
  const allUniversityIds = allUniversities
    .map((candidate) => member.guild.roles.cache.get(candidate.discord_role_id)?.id
      ?? member.guild.roles.cache.find((role) => role.name === candidate.name)?.id)
    .filter(Boolean);

  const removableIds = [...memberTypeIds, ...allUniversityIds, ...allDivisionIds]
    .filter((roleId) => roleId && !targetRoleIds.has(roleId));
  try {
    if (removableIds.length > 0) await member.roles.remove(removableIds);
    await member.roles.add([...targetRoleIds]);
    await member.setNickname(
      discordNicknameFromFullName(request.full_name),
      `BAINSA onboarding approval ${request.id}`,
    );
  } catch (error) {
    await restoreMemberDiscordState(
      guild,
      request.discord_user_id,
      previousRoleIds,
      previousNickname,
    );
    throw error;
  }

  return () => restoreMemberDiscordState(
    guild,
    request.discord_user_id,
    previousRoleIds,
    previousNickname,
  );
}

export function discordNicknameFromFullName(fullName) {
  return [...normalizeFullName(fullName)].slice(0, DISCORD_NICKNAME_LIMIT).join('').trimEnd();
}

async function resolveRoleId(guild, idOrName, fallbackName = null) {
  const byId = idOrName ? guild.roles.cache.get(String(idOrName)) : null;
  if (byId) return byId.id;
  const roleName = fallbackName ?? idOrName;
  const byName = guild.roles.cache.find((role) => role.name === roleName);
  if (!byName) throw new UserFacingError(`Missing Discord role: ${roleName}`);
  return byName.id;
}

async function restoreMemberRoles(guild, userId, previousRoleIds) {
  const member = await guild.members.fetch(userId);
  const currentRoleIds = new Set(member.roles.cache.keys());
  const { add, remove } = roleRestorePlan(previousRoleIds, currentRoleIds, guild.id);

  if (remove.length > 0) await member.roles.remove(remove);
  if (add.length > 0) await member.roles.add(add);
}

async function restoreMemberDiscordState(guild, userId, previousRoleIds, previousNickname) {
  const results = await Promise.allSettled([
    restoreMemberRoles(guild, userId, previousRoleIds),
    guild.members.fetch(userId).then((member) =>
      member.setNickname(previousNickname, 'Compensating failed BAINSA onboarding approval'),
    ),
  ]);
  const failures = results.filter((result) => result.status === 'rejected');
  if (failures.length > 0) {
    throw new AggregateError(failures.map((failure) => failure.reason), 'Could not restore Discord member state.');
  }
}

export function roleRestorePlan(previousRoleIds, currentRoleIds, guildId) {
  const previous = new Set([...previousRoleIds].map(String));
  const current = new Set([...currentRoleIds].map(String));
  const protectedIds = new Set([String(guildId)]);

  return {
    remove: [...current].filter((roleId) => !previous.has(roleId) && !protectedIds.has(roleId)),
    add: [...previous].filter((roleId) => !current.has(roleId) && !protectedIds.has(roleId)),
  };
}
