import {
  ActionRowBuilder,
  escapeMarkdown,
  MessageFlags,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';

import { assertUniversityAuthority } from '../authorization.js';
import { writeAudit } from '../audit.js';
import { BOARD_ROLES, divisionLabel, MEMBER_TYPES, ROLE_NAMES } from '../constants.js';
import { query, transaction } from '../db.js';
import { UserFacingError, assertUser } from '../errors.js';
import { logger } from '../logger.js';
import { divisionRoleName, divisionTextChannelName, universityCategoryName } from '../naming.js';
import { hasPublishedProfile } from '../profiles/repository.js';
import {
  applicationStatusPayload,
  confirmPayload,
  divisionPayload,
  memberTypePayload,
  memberSpacesPayload,
  noApplicationStatusPayload,
  onboardingSubmissionFailedPayload,
  onboardingSubmittingPayload,
  reviewPayload,
  reviewDecisionFailedPayload,
  reviewDecisionProgressPayload,
  reviewedPayload,
  universityPayload,
} from './components.js';
import { ONBOARDING_ACTIONS, isOnboardingCustomId, onboardingId, parseOnboardingId } from './custom-ids.js';
import {
  createDraft,
  getLatestRequestForUser,
  getRequestForUser,
  getUniversity,
  listAllDivisions,
  listAllUniversities,
  listDivisionsByIds,
  listDivisionsForUniversity,
  listRequestDivisionsByIds,
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

/** Sends the member-facing approval handoff only after approval has committed. */
export async function notifyApprovedMemberAboutDirectory({ guild, userId, request, university, divisions = [] }) {
  const member = await guild.members.fetch(String(userId));
  const directory = guild.channels?.cache?.find((channel) => channel?.name === 'people-directory');
  const directoryLink = channelUrl(guild, directory);
  const links = approvedStartLinks(guild, university, divisions);
  const access = accessSummary(request, university, divisions);
  const startLines = links.length > 0
    ? links.map((line) => `• ${line}`)
    : ['• Open the newly available Global BAINSA and university spaces to get started.'];
  await member.send([
    '✅ Your BAINSA application was approved.',
    '',
    `**Your access** · ${access}`,
    '',
    '**Start here**',
    ...startLines,
    '',
    directoryLink
      ? `Create your profile in <#${directory.id}> next. It helps BAINSA members find you for research, projects, and collaboration.`
      : 'Create your profile in the people directory next. It helps BAINSA members find you for research, projects, and collaboration.',
  ].join('\n'));
}

export async function notifyRejectedApplicant({ guild, userId, request, university, divisions = [] }) {
  const member = await guild.members.fetch(String(userId));
  const onboarding = guild.channels?.cache?.find((channel) => channel?.name === 'onboarding');
  const onboardingLink = channelUrl(guild, onboarding);
  await member.send([
    'Your BAINSA application was declined.',
    `**Application** · ${accessSummary(request, university, divisions)}`,
    `**Reason shared by the reviewer** · ${escapeMarkdown(request.review_reason || 'No reason was provided.')}`,
    '',
    onboardingLink ? `You can review this decision again in onboarding: ${onboardingLink}` : 'You can review this decision again in #onboarding in the BAINSA server.',
  ].join('\n'));
}

export function createOnboardingService({
  db = { query },
  runTransaction = transaction,
  notifyApprovedMember = notifyApprovedMemberAboutDirectory,
  notifyRejectedMember = notifyRejectedApplicant,
  hasPublishedDirectoryProfile = hasPublishedProfile,
} = {}) {
  async function handleButton(interaction) {
    const parsed = parseOnboardingId(interaction.customId);
    if (!parsed) return;

    const [requestId, value] = parsed.parts;

    if (parsed.action === ONBOARDING_ACTIONS.START) {
      const request = await createDraft(db, interaction.user.id);
      if (request.status === ONBOARDING_STATUSES.PENDING) {
        await replyWithApplicationStatus(interaction, request);
        return;
      }
      await showNameModal(interaction, request);
      return;
    }

    if (parsed.action === ONBOARDING_ACTIONS.STATUS) {
      const request = await getLatestRequestForUser(db, interaction.user.id);
      if (!request) {
        await interaction.reply({ ...noApplicationStatusPayload(), flags: MessageFlags.Ephemeral });
        return;
      }
      await replyWithApplicationStatus(interaction, request);
      return;
    }

    if (parsed.action === ONBOARDING_ACTIONS.SPACES) {
      const request = await getLatestRequestForUser(db, interaction.user.id);
      if (!request) {
        await interaction.reply({ ...noApplicationStatusPayload(), flags: MessageFlags.Ephemeral });
        return;
      }
      await replyWithMemberSpaces(interaction, request);
      return;
    }

    if (parsed.action === ONBOARDING_ACTIONS.MEMBER_TYPE) {
      assertMemberType(value);
      const request = await updateOwnedDraft(db, requestId, interaction.user.id, {
        member_type: value,
        division_ids: value === MEMBER_TYPES.ALUMNI ? [] : undefined,
      });
      await interaction.update(memberTypePayload(request.id, request.member_type));
      return;
    }

    if (parsed.action === ONBOARDING_ACTIONS.MEMBER_TYPE_DONE) {
      const request = await requireOwnedDraft(db, requestId, interaction.user.id);
      assertMemberType(request.member_type);
      const universities = await listUniversities(db);
      assertUser(universities.length > 0, 'No universities are available for onboarding yet.');
      await interaction.update(universityPayload(request.id, universities, 0, null, request.member_type));
      return;
    }

    if (parsed.action === ONBOARDING_ACTIONS.BACK_NAME) {
      const request = await requireOwnedDraft(db, requestId, interaction.user.id);
      await showNameModal(interaction, request, { updateOrigin: true });
      return;
    }

    if (parsed.action === ONBOARDING_ACTIONS.BACK_MEMBER_TYPE) {
      const request = await requireOwnedDraft(db, requestId, interaction.user.id);
      await interaction.update(memberTypePayload(request.id, request.member_type));
      return;
    }

    if (parsed.action === ONBOARDING_ACTIONS.BACK_UNIVERSITY) {
      const request = await requireOwnedDraft(db, requestId, interaction.user.id);
      const universities = await listUniversities(db);
      await interaction.update(universityPayload(
        request.id,
        universities,
        pageContaining(universities, request.university_id),
        request.university_id,
        request.member_type,
      ));
      return;
    }

    if (parsed.action === ONBOARDING_ACTIONS.BACK_DIVISIONS) {
      const request = await requireOwnedDraft(db, requestId, interaction.user.id);
      assertUser(request.member_type === MEMBER_TYPES.RESEARCHER, 'This application does not use a division.');
      const divisions = await listDivisionsForUniversity(db, request.university_id);
      await interaction.update(divisionPayload(
        request.id,
        divisions,
        request.division_ids,
        pageContaining(divisions, request.division_ids?.[0]),
      ));
      return;
    }

    if (parsed.action === ONBOARDING_ACTIONS.UNIVERSITY_PAGE) {
      const request = await requireOwnedDraft(db, requestId, interaction.user.id);
      const universities = await listUniversities(db);
      await interaction.update(universityPayload(
        request.id,
        universities,
        Number(value) || 0,
        request.university_id,
        request.member_type,
      ));
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
      await interaction.update(onboardingSubmittingPayload());
      try {
        const request = await requireOwnedDraft(db, requestId, interaction.user.id);
        assertUser(canSubmitOnboardingRequest(request), 'The onboarding request is incomplete.');
        await submitForReview(interaction, request);
      } catch (error) {
        await recoverSubmission(interaction, requestId, error);
      }
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

    if (parsed.action === ONBOARDING_ACTIONS.MEMBER_TYPE) {
      assertUser(interaction.values.length === 1, 'Choose Researcher or Alumni.');
      const memberType = interaction.values[0];
      assertMemberType(memberType);
      const request = await updateOwnedDraft(db, requestId, interaction.user.id, {
        member_type: memberType,
        division_ids: memberType === MEMBER_TYPES.ALUMNI ? [] : undefined,
      });
      await interaction.update(memberTypePayload(request.id, request.member_type));
      return;
    }

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
      await interaction.update(universityPayload(request.id, universities, page, university.id, request.member_type));
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
      const [requestId, responseMode] = parsed.parts;
      const fullName = normalizeFullName(interaction.fields.getTextInputValue('full_name'));
      assertUser(hasValidFullName(fullName), 'Enter your full name using 2 to 120 characters.');
      const request = await updateOwnedDraft(db, requestId, interaction.user.id, { full_name: fullName });
      if (responseMode === 'update') {
        await interaction.update(memberTypePayload(request.id, request.member_type));
      } else {
        await interaction.reply({ ...memberTypePayload(request.id, request.member_type), flags: MessageFlags.Ephemeral });
      }
      return;
    }
    if (parsed?.action !== ONBOARDING_ACTIONS.REJECT_MODAL) return;
    const [requestId] = parsed.parts;
    const reason = interaction.fields.getTextInputValue('reason')?.trim() || null;
    assertUser(reason, 'Enter a reason the applicant can use to correct or understand the decision.');
    await rejectRequest(interaction, requestId, reason);
  }

  async function submitForReview(interaction, request) {
    let message = null;
    let submittedRequest = request;
    let university;
    let divisions = [];

    try {
      await runTransaction(async (client) => {
        const locked = await lockRequest(client, request.id);
        assertUser(
          locked?.discord_user_id === interaction.user.id,
          'This onboarding request was not found.',
        );
        assertUser(locked.status === ONBOARDING_STATUSES.DRAFT, 'This onboarding request is no longer editable.');
        assertUser(canSubmitOnboardingRequest(locked), 'The onboarding request is incomplete.');

        university = await getUniversity(client, locked.university_id);
        assertUser(university, 'That university is not available.');
        divisions = await listDivisionsByIds(client, locked.university_id, locked.division_ids);
        const reviewChannel = await resolveReviewChannel(interaction.guild, university);
        message = await reviewChannel.send(
          reviewPayload({ ...locked, status: ONBOARDING_STATUSES.PENDING }, university, divisions),
        );

        const updated = await updateDraft(client, locked.id, interaction.user.id, {
          status: ONBOARDING_STATUSES.PENDING,
          review_message_id: message.id,
        });
        await assertDraftWriteSucceeded(client, locked.id, interaction.user.id, updated);
        submittedRequest = updated;
      });
    } catch (error) {
      await message?.delete().catch(() => undefined);
      throw error;
    }

    await interaction.editReply(applicationStatusPayload({
      request: submittedRequest,
      university,
      divisions,
      submitted: true,
    }));
  }

  async function approveRequest(interaction, requestId) {
    await beginReviewDecision(interaction, 'approve');
    let reviewed;
    let pendingRequest;
    let university;
    let divisions = [];
    let rollbackDiscordState = null;

    try {
      await runTransaction(async (client) => {
        const request = await lockRequest(client, requestId);
        assertPendingRequest(request);
        pendingRequest = request;
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
      await finishReviewDecisionWithFailure(
        interaction,
        pendingRequest,
        university,
        divisions,
        'approve',
        error,
      );
      return;
    }

    await interaction.editReply(reviewedPayload(reviewed, university, divisions, interaction.user.id)).catch((error) => {
      logger.error('Approved onboarding review card could not be updated', {
        requestId: String(requestId),
        error: error instanceof Error ? error.message : String(error),
      });
    });
    await notifyApprovedMember({
      guild: interaction.guild,
      userId: reviewed.discord_user_id,
      request: reviewed,
      university,
      divisions,
    }).catch(() => {
      logger.warn('Could not send approved member onboarding decision', {
        requestId: String(requestId),
        userId: String(reviewed.discord_user_id),
      });
    });
  }

  async function rejectRequest(interaction, requestId, reason) {
    await beginReviewDecision(interaction, 'reject');
    let reviewed;
    let pendingRequest;
    let university;
    let divisions = [];

    try {
      await runTransaction(async (client) => {
        const request = await lockRequest(client, requestId);
        assertPendingRequest(request);
        pendingRequest = request;
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
    } catch (error) {
      await finishReviewDecisionWithFailure(
        interaction,
        pendingRequest,
        university,
        divisions,
        'reject',
        error,
      );
      return;
    }

    await interaction.editReply(reviewedPayload(reviewed, university, divisions, interaction.user.id, reason)).catch((error) => {
      logger.error('Declined onboarding review card could not be updated', {
        requestId: String(requestId),
        error: error instanceof Error ? error.message : String(error),
      });
    });
    await notifyRejectedMember({
      guild: interaction.guild,
      userId: reviewed.discord_user_id,
      request: reviewed,
      university,
      divisions,
    }).catch(() => {
      logger.warn('Could not send rejected member onboarding decision', {
        requestId: String(requestId),
        userId: String(reviewed.discord_user_id),
      });
    });
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
            .setLabel('Reason shared with the applicant')
            .setPlaceholder('Explain what they should correct or clarify before reapplying')
            .setRequired(true)
            .setStyle(TextInputStyle.Paragraph)
            .setMinLength(2)
            .setMaxLength(1000),
        ),
      );
    await interaction.showModal(modal);
  }

  async function showNameModal(interaction, request, { updateOrigin = false } = {}) {
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
      .setCustomId(onboardingId(
        ONBOARDING_ACTIONS.NAME_MODAL,
        request.id,
        ...(updateOrigin ? ['update'] : []),
      ))
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
      await member.send('Welcome to BAINSA. Open #onboarding to begin your private application. You can return there and use Check application status at any time.');
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

  async function replyWithApplicationStatus(interaction, request) {
    const university = await getUniversity(db, request.university_id)
      ?? { name: request.university_name ?? 'Selected university' };
    const divisions = await listRequestDivisionsByIds(db, request.university_id, request.division_ids);
    await interaction.reply({
      ...applicationStatusPayload({
        request,
        university,
        divisions,
        links: request.status === ONBOARDING_STATUSES.APPROVED
          ? approvedStartLinks(interaction.guild, university, divisions)
          : [],
      }),
      flags: MessageFlags.Ephemeral,
    });
  }

  async function replyWithMemberSpaces(interaction, request) {
    const university = await getUniversity(db, request.university_id)
      ?? { name: request.university_name ?? 'Selected university' };
    const divisions = await listRequestDivisionsByIds(db, request.university_id, request.division_ids);
    if (request.status !== ONBOARDING_STATUSES.APPROVED) {
      await interaction.reply({
        ...applicationStatusPayload({ request, university, divisions }),
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    let profilePublished = false;
    try {
      profilePublished = await hasPublishedDirectoryProfile(db, interaction.user.id);
    } catch (error) {
      logger.warn('Could not check member directory profile before showing space guide', {
        userId: String(interaction.user.id),
        error: error instanceof Error ? error.message : String(error),
      });
    }
    await interaction.reply({
      ...memberSpacesPayload({
        university,
        divisions,
        channels: memberSpaceChannels(interaction.guild, university, divisions),
        profilePublished,
      }),
      flags: MessageFlags.Ephemeral,
    });
  }

  async function recoverSubmission(interaction, requestId, error) {
    const current = await getRequestForUser(db, requestId, interaction.user.id);
    if (!current) {
      await interaction.editReply({
        content: 'The application could not be found. Return to #onboarding and use Check application status before trying again.',
        embeds: [],
        components: [],
      });
      return;
    }
    const university = await getUniversity(db, current.university_id)
      ?? { name: current.university_name ?? 'Selected university' };
    const divisions = await listRequestDivisionsByIds(db, current.university_id, current.division_ids);
    if (current.status !== ONBOARDING_STATUSES.DRAFT) {
      await interaction.editReply(applicationStatusPayload({ request: current, university, divisions }));
      return;
    }
    const message = error instanceof UserFacingError
      ? error.message
      : 'BAINSA could not deliver the application. Please try again.';
    await interaction.editReply(
      onboardingSubmissionFailedPayload(current.id, current, university, divisions, message),
    );
  }
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

async function beginReviewDecision(interaction, decision) {
  const payload = reviewDecisionProgressPayload(decision);
  if (typeof interaction.update === 'function') {
    await interaction.update(payload);
    return;
  }
  await interaction.deferUpdate();
  await interaction.editReply(payload);
}

async function finishReviewDecisionWithFailure(
  interaction,
  request,
  university,
  divisions,
  decision,
  error,
) {
  const message = error instanceof UserFacingError
    ? error.message
    : 'BAINSA could not complete this decision. Please try again.';
  logger[error instanceof UserFacingError ? 'warn' : 'error']('Onboarding review decision failed', {
    requestId: request?.id,
    decision,
    error: error instanceof Error ? error.message : String(error),
  });
  await interaction.editReply(
    reviewDecisionFailedPayload(request, university, divisions, decision, message),
  ).catch((replyError) => {
    logger.error('Onboarding review failure card could not be updated', {
      requestId: request?.id,
      decision,
      error: replyError instanceof Error ? replyError.message : String(replyError),
    });
  });
}

async function assignApprovedDiscordState(guild, request, university, divisions, allDivisions, allUniversities) {
  const member = await guild.members.fetch(request.discord_user_id);
  const previousRoleIds = new Set(member.roles.cache.keys());
  const previousNickname = member.nickname ?? null;
  let nicknameChangeAttempted = false;
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
  } catch (error) {
    await restoreMemberRoles(guild, request.discord_user_id, previousRoleIds);
    throw error;
  }

  if (member.manageable === false) {
    logger.warn('Onboarding approved without updating the Discord nickname because the member is not manageable', {
      requestId: String(request.id),
      userId: String(request.discord_user_id),
    });
  } else {
    nicknameChangeAttempted = true;
    try {
      await member.setNickname(
        discordNicknameFromFullName(request.full_name),
        `BAINSA onboarding approval ${request.id}`,
      );
    } catch (error) {
      logger.warn('Onboarding approved without updating the Discord nickname', {
        requestId: String(request.id),
        userId: String(request.discord_user_id),
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return () => restoreMemberDiscordState(
    guild,
    request.discord_user_id,
    previousRoleIds,
    previousNickname,
    { restoreNickname: nicknameChangeAttempted },
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

async function restoreMemberDiscordState(
  guild,
  userId,
  previousRoleIds,
  previousNickname,
  { restoreNickname = true } = {},
) {
  const operations = [restoreMemberRoles(guild, userId, previousRoleIds)];
  if (restoreNickname) {
    operations.push(
      guild.members.fetch(userId).then((member) =>
        member.setNickname(previousNickname, 'Compensating failed BAINSA onboarding approval'),
      ),
    );
  }
  const results = await Promise.allSettled(operations);
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

function pageContaining(items, selectedId, pageSize = 25) {
  if (selectedId == null) return 0;
  const index = items.findIndex((item) => String(item.id) === String(selectedId));
  return index < 0 ? 0 : Math.floor(index / pageSize);
}

function accessSummary(request, university, divisions) {
  const path = request.member_type === MEMBER_TYPES.ALUMNI ? 'Alumni' : 'Researcher';
  const universityName = escapeMarkdown(university?.name ?? 'Selected university');
  const divisionNames = divisions.length > 0
    ? divisions.map((division) => escapeMarkdown(divisionLabel(division.name, division.color))).join(', ')
    : request.member_type === MEMBER_TYPES.ALUMNI
      ? 'University-level access (no division required)'
      : 'Division not recorded';
  return `${path} · ${universityName} · ${divisionNames}`;
}

function approvedStartLinks(guild, university, divisions) {
  const cache = guild?.channels?.cache;
  if (!cache?.find) return [];

  const globalGeneral = cache.find((channel) => channel?.name === 'bainsa-general');
  const universityCategory = cache.find(
    (channel) => channel?.name === universityCategoryName(university.name),
  );
  const universityGeneral = cache.find(
    (channel) => channel?.name === 'general' && channel?.parentId === universityCategory?.id,
  );
  const division = divisions[0];
  const divisionChannel = division
    ? cache.get?.(String(division.text_channel_id))
      ?? cache.find((channel) =>
        channel?.name === divisionTextChannelName(division.name, division.color)
        && channel?.parentId === universityCategory?.id)
    : null;

  return [
    globalGeneral ? `Global general: ${channelMention(globalGeneral)} — meet the wider BAINSA community` : null,
    universityGeneral ? `${escapeMarkdown(university.name)} general: ${channelMention(universityGeneral)} — university questions and updates` : null,
    divisionChannel ? `Your division: ${channelMention(divisionChannel)} — start working with your team` : null,
  ].filter(Boolean);
}

function memberSpaceChannels(guild, university, divisions) {
  const cache = guild?.channels?.cache;
  if (!cache?.find) return {};

  const globalCategory = cache.find((channel) => channel?.name === 'GLOBAL BAINSA');
  const universityCategory = cache.find(
    (channel) => channel?.name === universityCategoryName(university.name),
  );
  const channelIn = (name, parentId = null) => cache.find((channel) =>
    channel?.name === name && (!parentId || channel?.parentId === parentId));
  const division = divisions[0];

  return {
    globalGeneral: channelIn('bainsa-general', globalCategory?.id),
    universityGeneral: channelIn('general', universityCategory?.id),
    division: division
      ? cache.get?.(String(division.text_channel_id))
        ?? channelIn(divisionTextChannelName(division.name, division.color), universityCategory?.id)
      : null,
    resources: channelIn('resources', globalCategory?.id),
    projectShowcase: channelIn('projects-showcase', globalCategory?.id),
    peopleDirectory: channelIn('people-directory', globalCategory?.id),
  };
}

function channelUrl(guild, channel) {
  if (!guild?.id || !channel?.id) return null;
  return `https://discord.com/channels/${guild.id}/${channel.id}`;
}

function channelMention(channel) {
  return `<#${channel.id}>`;
}
