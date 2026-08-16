import { MessageFlags, SlashCommandBuilder } from 'discord.js';

import { respondAutocomplete } from '../../discord/autocomplete.js';
import { OPEN_PROJECT_STATUSES } from '../../constants.js';
import {
  handleInteractionError,
  replyEphemeral,
} from '../../discord/reply.js';
import {
  getProjectInfo,
  projectCreateSetup,
  projectInfoMessage,
  searchVisibleProjects,
} from '../../services/projects/index.js';
import { projectAutocompleteChoice } from '../../services/projects/formatters.js';
import { projectManagementPanels } from '../../services/projects/management-panels.js';
import { projectCommandChannelScope } from '../../runtime/command-channels.js';

function projectOption(option) {
  return option
    .setName('project')
    .setDescription('Project; optional when used inside its project channel')
    .setRequired(false)
    .setAutocomplete(true);
}

function withNoDm(builder) {
  return builder.setDMPermission(false);
}

async function runPrivateCommand(interaction, work) {
  try {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    await replyEphemeral(interaction, await work());
  } catch (error) {
    await handleInteractionError(interaction, error);
  }
}

async function openPanel(interaction, start) {
  try {
    await start();
  } catch (error) {
    await handleInteractionError(interaction, error);
  }
}

async function autocompleteProjects(interaction) {
  try {
    const channelProject = projectCommandChannelScope(interaction.channel);
    if (channelProject) {
      const { project } = await getProjectInfo({ interaction, project: null });
      const allowedStatus = interaction.commandName !== 'project-close'
        || OPEN_PROJECT_STATUSES.includes(project.status);
      await respondAutocomplete(interaction, allowedStatus ? [projectAutocompleteChoice(project)] : []);
      return;
    }
    const choices = await searchVisibleProjects({
      interaction,
      query: interaction.options.getFocused(),
      statuses: interaction.commandName === 'project-close' ? OPEN_PROJECT_STATUSES : undefined,
    });
    await respondAutocomplete(interaction, choices);
  } catch {
    await respondAutocomplete(interaction, [], 'Project autocomplete fallback');
  }
}

const projectCreate = {
  data: withNoDm(
    new SlashCommandBuilder()
      .setName('project-create')
      .setDescription('Open the private guided project setup'),
  ),
  async execute(interaction) {
    try {
      await projectCreateSetup.start(interaction);
    } catch (error) {
      await handleInteractionError(interaction, error);
    }
  },
};

const projectUpdate = {
  data: withNoDm(
    new SlashCommandBuilder()
      .setName('project-update')
      .setDescription('Open the private guided project update panel'),
  ),
  async execute(interaction) {
    await openPanel(
      interaction,
      () => projectManagementPanels.startProjectUpdate(interaction),
    );
  },
};

const projectClose = {
  data: withNoDm(
    new SlashCommandBuilder()
      .setName('project-close')
      .setDescription('Open the private guided project closure panel'),
  ),
  async execute(interaction) {
    await openPanel(
      interaction,
      () => projectManagementPanels.startProjectClose(interaction),
    );
  },
};

const projectInfo = {
  data: withNoDm(
    new SlashCommandBuilder()
      .setName('project-info')
      .setDescription('Show private project details')
      .addStringOption(projectOption),
  ),
  autocomplete: autocompleteProjects,
  async execute(interaction) {
    await runPrivateCommand(interaction, async () => {
      const { project, people } = await getProjectInfo({
        interaction,
        project: interaction.options.getString('project', false),
      });
      return projectInfoMessage(project, people);
    });
  },
};

export const projectCommands = [
  projectCreate,
  projectUpdate,
  projectClose,
  projectInfo,
];
