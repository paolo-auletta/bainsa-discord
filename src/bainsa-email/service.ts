import { MessageFlags } from 'discord.js';

import { assertUniversityAuthority } from '../authorization.js';
import { writeAudit } from '../audit.js';
import { config } from '../config.js';
import { BOARD_ROLES } from '../constants.js';
import { query, transaction } from '../db.js';
import { assertUser, UserFacingError } from '../errors.js';
import { logger } from '../logger.js';
import { enqueueTransitionNotification } from '../notifications/repository.js';
import { deliverTransitionNotification } from '../notifications/service.js';
import { getLatestRequestForUser } from '../onboarding/repository.js';
import {
  bainsaEmailCreatedHandoff,
  bainsaEmailPromptPayload,
  bainsaEmailRequestModal,
  bainsaEmailReviewPayload,
} from './components.js';
import { BAINSA_EMAIL_ACTIONS, isBainsaEmailCustomId, parseBainsaEmailId } from './custom-ids.js';
import {
  getActiveMembership,
  getBainsaEmailRequest,
  markBainsaEmailCreated,
  openBainsaEmailRequest,
  recordExistingAccount,
  setBainsaEmailReviewMessage,
} from './repository.js';
import { BAINSA_EMAIL_STATUSES, normalizeBainsaEmailRequest } from './state.js';

const NOT_A_MEMBER = 'BAINSA email accounts are available to approved members. Finish onboarding first.';

/** Member buttons also arrive from DMs, where Discord omits the guild. */
function defaultResolveGuild(interaction) {
  return interaction.guild ?? interaction.client?.guilds?.cache?.get(config.discordGuildId) ?? null;
}

/** Requests share the university's private onboarding review queue. */
async function resolveUniversityReviewChannel(guild, membership) {
  const channelId = membership.onboarding_review_channel_id;
  const channel = channelId ? await guild?.channels?.fetch(channelId).catch(() => null) : null;
  assertUser(
    channel?.isTextBased?.(),
    `The ${membership.university_name} review channel is not configured, so your request was not saved. Please contact your university board.`,
  );
  return channel;
}

/** Updates the message that carried the button, or answers privately when there is none. */
async function respond(interaction, payload) {
  if (interaction.message && typeof interaction.update === 'function') {
    await interaction.update(payload);
    return;
  }
  await interaction.reply({ ...payload, flags: MessageFlags.Ephemeral });
}

export function createBainsaEmailService({
  db = { query },
  runTransaction = transaction,
  resolveGuild = defaultResolveGuild,
} = {}) {
  async function handleButton(interaction) {
    const parsed = parseBainsaEmailId(interaction.customId);
    if (!parsed) return;
    const userId = String(interaction.user.id);

    if (parsed.action === BAINSA_EMAIL_ACTIONS.ASK) {
      assertUser(await getActiveMembership(db, userId), NOT_A_MEMBER);
      const request = await getBainsaEmailRequest(db, userId);
      const open = !request || request.status === BAINSA_EMAIL_STATUSES.HAS_ACCOUNT;
      await interaction.reply({ ...bainsaEmailPromptPayload(open ? null : request), flags: MessageFlags.Ephemeral });
      return;
    }

    if (parsed.action === BAINSA_EMAIL_ACTIONS.HAS_ACCOUNT) {
      assertUser(await getActiveMembership(db, userId), NOT_A_MEMBER);
      const recorded = await recordExistingAccount(db, userId);
      await respond(interaction, bainsaEmailPromptPayload(recorded ?? await getBainsaEmailRequest(db, userId)));
      return;
    }

    if (parsed.action === BAINSA_EMAIL_ACTIONS.REQUEST) {
      assertUser(await getActiveMembership(db, userId), NOT_A_MEMBER);
      const existing = await getBainsaEmailRequest(db, userId);
      if (existing && existing.status !== BAINSA_EMAIL_STATUSES.HAS_ACCOUNT) {
        await respond(interaction, bainsaEmailPromptPayload(existing));
        return;
      }
      const onboarding = await getLatestRequestForUser(db, userId);
      await interaction.showModal(bainsaEmailRequestModal({ fullName: onboarding?.full_name }));
      return;
    }

    if (parsed.action === BAINSA_EMAIL_ACTIONS.MARK_CREATED) {
      await markCreated(interaction, parsed.parts[0]);
    }
  }

  async function handleModalSubmit(interaction) {
    const parsed = parseBainsaEmailId(interaction.customId);
    if (parsed?.action !== BAINSA_EMAIL_ACTIONS.REQUEST_MODAL) return;
    const userId = String(interaction.user.id);
    const details = normalizeBainsaEmailRequest({
      firstName: interaction.fields.getTextInputValue('first_name'),
      lastName: interaction.fields.getTextInputValue('last_name'),
      contactEmail: interaction.fields.getTextInputValue('contact_email'),
    });
    const guild = resolveGuild(interaction);

    let message = null;
    let saved = null;
    try {
      await runTransaction(async (client) => {
        const membership = await getActiveMembership(client, userId);
        assertUser(membership, NOT_A_MEMBER);
        const channel = await resolveUniversityReviewChannel(guild, membership);
        const opened = await openBainsaEmailRequest(client, {
          discordUserId: userId,
          universityId: membership.university_id,
          ...details,
        });
        if (!opened) {
          saved = await getBainsaEmailRequest(client, userId);
          return;
        }
        const universityName = membership.university_name;
        message = await channel.send(bainsaEmailReviewPayload({ ...opened, university_name: universityName }));
        const updated = await setBainsaEmailReviewMessage(client, userId, message.id);
        assertUser(updated, 'Your request changed while it was being sent. Please try again.');
        saved = { ...updated, university_name: universityName };
        await writeAudit(client, {
          actorId: userId,
          action: 'bainsa_email.request',
          targetType: 'member',
          targetId: userId,
          universityId: membership.university_id,
          after: { status: saved.status },
        });
      });
    } catch (error) {
      await message?.delete().catch(() => undefined);
      throw error;
    }

    await respond(interaction, bainsaEmailPromptPayload(saved));
  }

  async function markCreated(interaction, memberId) {
    assertUser(interaction.guild && memberId, 'This email request is no longer available.');
    const current = await getBainsaEmailRequest(db, memberId);
    assertUser(current?.university_name, 'This email request is no longer available.');
    // The same people who review the university's applications: its President,
    // Vice President, and Division Heads, plus every Global President.
    const reviewer = await interaction.guild.members.fetch(interaction.user.id);
    assertUniversityAuthority(reviewer, current.university_name, [
      BOARD_ROLES.HEAD,
      BOARD_ROLES.VICE_PRESIDENT,
      BOARD_ROLES.PRESIDENT,
    ]);
    if (current.status === BAINSA_EMAIL_STATUSES.CREATED) {
      await interaction.update(bainsaEmailReviewPayload(current));
      return;
    }

    let request = null;
    let notificationId = null;
    await runTransaction(async (client) => {
      const marked = await markBainsaEmailCreated(client, memberId, interaction.user.id);
      if (!marked) return;
      request = { ...marked, university_name: current.university_name };
      const auditId = await writeAudit(client, {
        actorId: interaction.user.id,
        action: 'bainsa_email.created',
        targetType: 'member',
        targetId: memberId,
        universityId: request.university_id,
        before: { status: BAINSA_EMAIL_STATUSES.REQUESTED },
        after: { status: request.status },
      });
      notificationId = await enqueueTransitionNotification(client, {
        auditId,
        recipientId: memberId,
        kind: 'bainsa_email.created',
        universityId: request.university_id,
        relatedEntityType: 'bainsa_email_request',
        relatedEntityId: memberId,
        payload: bainsaEmailCreatedHandoff(request),
      });
    });

    if (!request) {
      const latest = await getBainsaEmailRequest(db, memberId);
      if (latest?.status === BAINSA_EMAIL_STATUSES.CREATED) {
        await interaction.update(bainsaEmailReviewPayload(latest));
        return;
      }
      throw new UserFacingError('This email request is no longer open.');
    }

    await interaction.update(bainsaEmailReviewPayload(request));
    const delivery = notificationId == null
      ? interaction.guild.members.fetch(memberId).then((member) => member.send(bainsaEmailCreatedHandoff(request)))
      : deliverTransitionNotification({ db, guild: interaction.guild, notificationId });
    await delivery.catch(() => {
      logger.warn('Could not tell the member their BAINSA email was created', { userId: memberId });
    });
  }

  return {
    canHandle: isBainsaEmailCustomId,
    handleButton,
    handleModalSubmit,
  };
}

/**
 * Queues the account question inside the approval transaction so it is
 * delivered by the same durable outbox as the approval handoff. Members who
 * already answered (for example after a reapplication) are not asked again.
 */
export async function enqueueBainsaEmailPrompt(db, { auditId, recipientId, universityId = null }) {
  if (auditId == null) return null;
  if (await getBainsaEmailRequest(db, recipientId)) return null;
  return enqueueTransitionNotification(db, {
    auditId,
    recipientId: String(recipientId),
    kind: 'bainsa_email.prompt',
    universityId,
    relatedEntityType: 'bainsa_email_request',
    relatedEntityId: String(recipientId),
    payload: bainsaEmailPromptPayload(),
  });
}
