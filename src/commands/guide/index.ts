import { SlashCommandBuilder } from 'discord.js';

import { handleInteractionError } from '../../discord/reply.js';
import { showGuide } from '../../guide/service.js';

export const guideCommand = {
  data: new SlashCommandBuilder()
    .setName('guide')
    .setDescription('Show the private command guide for your board roles.')
    .setDMPermission(false),
  async execute(interaction) {
    try {
      await showGuide(interaction);
    } catch (error) {
      await handleInteractionError(interaction, error);
    }
  },
};
