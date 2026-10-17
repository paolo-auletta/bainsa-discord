import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  escapeMarkdown,
} from 'discord.js';

import { config } from '../config.js';
import { renderHandoffMessage, renderInteractionModal } from '../messages/index.js';
import { BAINSA_EMAIL_ACTIONS, bainsaEmailId } from './custom-ids.js';
import {
  BAINSA_EMAIL_CONTACT_NAME,
  BAINSA_EMAIL_DOMAIN,
  BAINSA_EMAIL_LIMITS,
  BAINSA_EMAIL_STATUSES,
  splitFullName,
} from './state.js';

const CONTACT = BAINSA_EMAIL_CONTACT_NAME;
const ADDRESS = `@${BAINSA_EMAIL_DOMAIN}`;

const EMBED_COLORS = Object.freeze({
  PENDING: 0xf0b429,
  SUCCESS: 0x57f287,
});

function boardName(request) {
  return request?.university_name ? `the ${escapeMarkdown(request.university_name)} board` : 'your university board';
}

function promptStatus(request) {
  const email = request?.contact_email ? `**${escapeMarkdown(request.contact_email)}**` : 'your main email';
  if (request?.status === BAINSA_EMAIL_STATUSES.HAS_ACCOUNT) {
    return `You already have an ${ADDRESS} email. Nothing else to do.`;
  }
  if (request?.status === BAINSA_EMAIL_STATUSES.REQUESTED) {
    return `Request sent. Someone from ${boardName(request)} will create your account and send the login credentials to ${email}.`;
  }
  if (request?.status === BAINSA_EMAIL_STATUSES.CREATED) {
    return `Your ${ADDRESS} account was created. The login credentials were sent to ${email}.`;
  }
  return null;
}

/**
 * The member-facing question, written in the account manager's voice. Once the
 * member answers, the same message is updated to show the outcome without buttons.
 */
export function bainsaEmailPromptPayload(request = null) {
  const status = promptStatus(request);
  const payload = renderHandoffMessage({
    kind: 'handoff-message',
    tone: 'brand',
    title: `A message from ${CONTACT} · Your ${ADDRESS} email`,
    context: `Hi, I'm ${CONTACT}. Every BAINSA member should have an ${ADDRESS} address, so I'd like to make sure you have one.`,
    sections: status
      ? [{ heading: 'Status', body: status }]
      : [{
        heading: `Do you already have an ${ADDRESS} email?`,
        body: [
          '• **Yes** — choose *I already have one* and you are all set.',
          `• **No** — choose *Request an ${ADDRESS} email* and enter your first name, last name, and the main email address where your login credentials should be sent. Your university board will create the account.`,
        ],
      }],
    provenance: `BAINSA accounts · Message from ${CONTACT}`,
    audience: 'member',
  });
  return {
    ...payload,
    components: status
      ? []
      : [
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder()
            .setCustomId(bainsaEmailId(BAINSA_EMAIL_ACTIONS.REQUEST))
            .setLabel(`Request an ${ADDRESS} email`)
            .setStyle(ButtonStyle.Primary),
          new ButtonBuilder()
            .setCustomId(bainsaEmailId(BAINSA_EMAIL_ACTIONS.HAS_ACCOUNT))
            .setLabel('I already have one')
            .setStyle(ButtonStyle.Secondary),
        ),
      ],
  };
}

export function bainsaEmailRequestModal({ fullName = null, request = null } = {}) {
  const defaults = splitFullName(fullName);
  return renderInteractionModal({
    id: bainsaEmailId(BAINSA_EMAIL_ACTIONS.REQUEST_MODAL),
    title: `Request an ${ADDRESS} email`,
    fields: [
      {
        id: 'first_name',
        label: 'First name',
        placeholder: 'e.g. Ada',
        value: request?.first_name ?? defaults.firstName,
        minLength: 1,
        maxLength: BAINSA_EMAIL_LIMITS.name.max,
      },
      {
        id: 'last_name',
        label: 'Last name',
        placeholder: 'e.g. Lovelace',
        value: request?.last_name ?? defaults.lastName,
        minLength: 1,
        maxLength: BAINSA_EMAIL_LIMITS.name.max,
      },
      {
        id: 'contact_email',
        label: 'Main email (credentials are sent here)',
        placeholder: 'e.g. ada.lovelace@gmail.com',
        value: request?.contact_email ?? null,
        minLength: 3,
        maxLength: BAINSA_EMAIL_LIMITS.email.max,
      },
    ],
  });
}

/** Private card posted in the member's university onboarding review channel. */
export function bainsaEmailReviewPayload(request) {
  const created = request.status === BAINSA_EMAIL_STATUSES.CREATED;
  const university = escapeMarkdown(request.university_name ?? 'their university');
  return {
    embeds: [
      new EmbedBuilder()
        .setColor(created ? EMBED_COLORS.SUCCESS : EMBED_COLORS.PENDING)
        .setAuthor({ name: `${config.botName} · ${ADDRESS} email requests` })
        .setTitle(created ? `${ADDRESS} account created` : `New ${ADDRESS} email request`)
        .setDescription(
          created
            ? `**<@${request.discord_user_id}>** was told their credentials were sent.`
            : `**<@${request.discord_user_id}>** needs an ${ADDRESS} account.`,
        )
        .addFields(
          { name: 'First name', value: escapeMarkdown(request.first_name), inline: true },
          { name: 'Last name', value: escapeMarkdown(request.last_name), inline: true },
          { name: 'University', value: university, inline: true },
          { name: 'Send credentials to', value: escapeMarkdown(request.contact_email), inline: false },
          {
            name: 'Status',
            value: created
              ? `🟢 Created${request.handled_by ? ` by <@${request.handled_by}>` : ''}`
              : '🟡 Waiting for an account',
            inline: true,
          },
        ),
    ],
    components: created
      ? []
      : [
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder()
            .setCustomId(bainsaEmailId(BAINSA_EMAIL_ACTIONS.MARK_CREATED, request.discord_user_id))
            .setLabel('Account created and credentials sent')
            .setStyle(ButtonStyle.Success),
        ),
      ],
    allowedMentions: { parse: [] },
  };
}

export function bainsaEmailCreatedHandoff(request) {
  return renderHandoffMessage({
    kind: 'handoff-message',
    tone: 'success',
    title: `Your ${ADDRESS} email is ready`,
    statusLabel: 'Account created',
    context: `Your ${ADDRESS} account was created and the login credentials were sent to ${escapeMarkdown(request.contact_email)}.`,
    nextActions: [
      'Check that inbox, including the spam folder, for the credentials email.',
      'Sign in and follow the instructions in that email to secure your account.',
    ],
    fallback: `If the email has not arrived within a couple of days, contact ${boardName(request)} in the BAINSA server.`,
    provenance: 'BAINSA accounts · Account handoff',
    audience: 'member',
  });
}
