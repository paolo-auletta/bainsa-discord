import { MessageFlags } from 'discord.js';

import { UserFacingError } from '../errors.mjs';
import { logger } from '../logger.mjs';

export async function replyEphemeral(interaction, payload) {
  const body = typeof payload === 'string' ? { content: payload } : payload;
  const response = { ...body, flags: MessageFlags.Ephemeral };
  if (interaction.deferred && !interaction.replied) return interaction.editReply(body);
  if (interaction.deferred || interaction.replied) return interaction.followUp(response);
  return interaction.reply(response);
}

export async function replyPersistent(interaction, payload) {
  const body = typeof payload === 'string' ? { content: payload } : payload;
  const message = { allowedMentions: { parse: [] }, ...body };

  if (interaction.channel?.send) {
    await interaction.channel.send(message);
    return replyEphemeral(interaction, 'Command output posted in this channel.');
  }

  return replyEphemeral(interaction, body);
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
  await replyEphemeral(interaction, message).catch(() => undefined);
}
