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

export async function replyBoardActivity(interaction, payload) {
  if (!payload) {
    return replyEphemeral(interaction, 'Update saved. No board-visible fields changed.');
  }

  const body = typeof payload === 'string' ? { content: payload } : payload;
  const message = { allowedMentions: { parse: [] }, ...body };
  if (interaction.channel?.send) {
    try {
      await interaction.channel.send(message);
    } catch (error) {
      logger.error('Board activity message could not be posted', {
        command: interaction.commandName,
        userId: interaction.user?.id,
        error: error instanceof Error ? error.message : String(error),
      });
      return replyEphemeral(
        interaction,
        'The change was saved, but its board activity message could not be posted. Please notify a President.',
      );
    }
    return replyEphemeral(interaction, 'Activity posted in this channel.');
  }

  return replyEphemeral(interaction, 'The change was saved, but the activity message could not be posted here.');
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
