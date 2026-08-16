import { UserFacingError } from '../errors.js';
import { logger } from '../logger.js';
import {
  ephemeralReplyPayload,
  interactionEditPayload,
  interactionOutcome,
  interactionRecovery,
  recoveryKindForMessage,
  renderInteractionPanel,
} from '../messages/index.js';

function normalizedPrivatePayload(payload) {
  if (typeof payload !== 'string') return payload;
  return renderInteractionPanel(interactionOutcome({
    outcome: 'no-change',
    title: 'Update',
    description: payload,
  }));
}

export async function replyEphemeral(interaction, payload) {
  const body = normalizedPrivatePayload(payload);
  const response = ephemeralReplyPayload(body);
  if (interaction.deferred && !interaction.replied) return interaction.editReply(interactionEditPayload(body));
  if (interaction.deferred || interaction.replied) return interaction.followUp(response);
  return interaction.reply(response);
}

export async function postBoardActivity(interaction, payload, { channel = interaction.channel } = {}) {
  if (!payload) return { status: 'no-change', channel: null };
  const body = typeof payload === 'string' ? { content: payload } : payload;
  const message = { allowedMentions: { parse: [] }, ...body };
  if (channel?.send) {
    try {
      await channel.send(message);
    } catch (error) {
      logger.error('Board activity message could not be posted', {
        command: interaction.commandName,
        userId: interaction.user?.id,
        error: error instanceof Error ? error.message : String(error),
      });
      return { status: 'failed', channel };
    }
    return { status: 'posted', channel };
  }
  return { status: 'unavailable', channel: null };
}

export async function replyBoardActivity(
  interaction,
  payload,
  options: {
    channel?: unknown;
    channels?: unknown[];
    recovery?: {
      whatHappened: string;
      preservedState?: string;
      correction?: string;
      continueWith?: string;
    };
  } = {},
) {
  const channels = Array.isArray(options.channels) && options.channels.length
    ? options.channels
    : [options.channel ?? interaction.channel];
  const [delivery] = await Promise.all(
    channels.map((channel) => postBoardActivity(interaction, payload, { channel })),
  );
  if (options.recovery) {
    const activityNote = delivery.status === 'posted'
      ? 'The shared activity record was posted.'
      : delivery.status === 'failed'
        ? 'The shared activity record could not be posted.'
        : 'This channel could not accept the shared activity record.';
    return replyEphemeral(interaction, renderInteractionPanel(interactionRecovery({
      kind: 'reconciliation',
      whatHappened: `${options.recovery.whatHappened} ${activityNote}`,
      preservedState: options.recovery.preservedState,
      correction: options.recovery.correction,
      continueWith: options.recovery.continueWith,
    })));
  }
  if (delivery.status === 'no-change') {
    return replyEphemeral(interaction, renderInteractionPanel(interactionOutcome({
      outcome: 'no-change',
      title: 'Update saved',
      description: 'No board-visible fields changed.',
    })));
  }
  if (delivery.status === 'posted') {
    const destination = delivery.channel?.id && delivery.channel.id !== interaction.channel?.id
      ? ` in <#${delivery.channel.id}>`
      : '';
    return replyEphemeral(interaction, renderInteractionPanel(interactionOutcome({
      outcome: 'success',
      title: 'Change saved',
      description: `Activity posted${destination || ' in this channel'}.`,
    })));
  }
  return replyEphemeral(interaction, renderInteractionPanel(interactionOutcome({
    outcome: 'delivery-failed',
    title: 'Change saved; activity delivery failed',
    description: delivery.status === 'failed'
      ? 'The board activity message could not be posted.'
      : 'This channel cannot accept the board activity message.',
    status: 'Please notify a President so the shared activity record can be restored.',
  })));
}

export async function handleInteractionError(interaction, error) {
  const expected = error instanceof UserFacingError;
  logger[expected ? 'warn' : 'error']('Interaction failed', {
    command: interaction.commandName,
    userId: interaction.user?.id,
    error: error instanceof Error ? error.message : String(error),
    stack: expected ? undefined : error?.stack,
  });
  const recovery = expected ? error.recovery : null;
  await replyEphemeral(interaction, renderInteractionPanel(interactionRecovery({
    kind: recovery?.kind ?? (expected ? recoveryKindForMessage(error.message) : 'unexpected'),
    title: recovery?.title,
    whatHappened: expected ? error.message : 'The action could not be completed.',
    preservedState: recovery?.preservedState,
    correction: recovery?.correction,
    continueWith: recovery?.continueWith
      ?? (interaction.commandName ? `Run /${interaction.commandName} again when you are ready.` : undefined),
  }))).catch(() => undefined);
}
