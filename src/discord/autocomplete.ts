import { logger } from '../logger.js';

export async function respondAutocomplete(interaction, choices, context = 'Autocomplete') {
  if (interaction.responded || interaction.replied) return;
  try {
    await interaction.respond(choices);
  } catch (error) {
    logger.warn(`${context} response failed`, {
      command: interaction.commandName,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
