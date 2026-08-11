import { UserFacingError } from '../errors.js';
import { logger } from '../logger.js';
import {
  ephemeralReplyPayload,
  interactionEditPayload,
  interactionOutcome,
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

export async function replyBoardActivity(interaction, payload, options = {}) {
  const delivery = await postBoardActivity(interaction, payload, options);
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
  const message = expected ? error.message : 'Something went wrong. The action was not completed.';
  await replyEphemeral(interaction, renderInteractionPanel(interactionOutcome({
    outcome: expected ? 'validation' : 'unexpected',
    title: expected ? 'Action could not be completed' : 'Something went wrong',
    description: message,
    status: expected ? 'Review the details and try again.' : 'Nothing was changed. Try again, or contact a President if this continues.',
  }))).catch(() => undefined);
}
