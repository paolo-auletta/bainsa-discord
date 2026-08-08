import { MessageFlags, SlashCommandBuilder } from 'discord.js';

import { formatBoardActivity } from '../../activity/formatters.js';
import { respondAutocomplete } from '../../discord/autocomplete.js';
import { OPEN_PROJECT_STATUSES, PROJECT_PERSON_ROLES, PROJECT_STATUSES } from '../../constants.js';
import {
  handleInteractionError,
  replyBoardActivity,
  replyEphemeral,
} from '../../discord/reply.js';
import {
  addProjectMember,
  closeProject,
  getProjectInfo,
  projectCreateSetup,
  projectInfoMessage,
  removeProjectMember,
  searchVisibleProjects,
  updateProject,
} from '../../services/projects/index.js';

function projectOption(option) {
  return option
    .setName('project')
    .setDescription('Project ID or selected project')
    .setRequired(true)
    .setAutocomplete(true);
}

function withNoDm(builder) {
  return builder.setDMPermission(false);
}

async function runActivityCommand(interaction, commandName, work) {
  try {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const result = await work();
    await replyBoardActivity(
      interaction,
      formatBoardActivity(commandName, {
        actorId: interaction.user.id,
        result,
      }),
    );
  } catch (error) {
    await handleInteractionError(interaction, error);
  }
}

async function runPrivateCommand(interaction, work) {
  try {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    await replyEphemeral(interaction, await work());
  } catch (error) {
    await handleInteractionError(interaction, error);
  }
}

async function autocompleteProjects(interaction) {
  try {
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

const projectAddMember = {
  data: withNoDm(
    new SlashCommandBuilder()
      .setName('project-add-member')
      .setDescription('Add or update a project participant')
      .addStringOption(projectOption)
      .addUserOption((option) => option.setName('user').setDescription('User to add').setRequired(true))
      .addStringOption((option) =>
        option
          .setName('role')
          .setDescription('Project role')
          .setRequired(true)
          .addChoices(
            { name: 'member', value: PROJECT_PERSON_ROLES.MEMBER },
            { name: 'supervisor', value: PROJECT_PERSON_ROLES.SUPERVISOR },
            { name: 'board_liaison', value: PROJECT_PERSON_ROLES.BOARD_LIAISON },
          ),
      ),
  ),
  autocomplete: autocompleteProjects,
  async execute(interaction) {
    await runActivityCommand(
      interaction,
      'project-add-member',
      () => addProjectMember({
        interaction,
        project: interaction.options.getString('project', true),
        user: interaction.options.getUser('user', true),
        role: interaction.options.getString('role', true),
      }),
    );
  },
};

const projectRemoveMember = {
  data: withNoDm(
    new SlashCommandBuilder()
      .setName('project-remove-member')
      .setDescription('Remove a project participant')
      .addStringOption(projectOption)
      .addUserOption((option) => option.setName('user').setDescription('User to remove').setRequired(true))
      .addStringOption((option) => option.setName('reason').setDescription('Optional reason').setRequired(false)),
  ),
  autocomplete: autocompleteProjects,
  async execute(interaction) {
    await runActivityCommand(
      interaction,
      'project-remove-member',
      () => removeProjectMember({
        interaction,
        project: interaction.options.getString('project', true),
        user: interaction.options.getUser('user', true),
        reason: interaction.options.getString('reason', false),
      }),
    );
  },
};

const projectUpdate = {
  data: withNoDm(
    new SlashCommandBuilder()
      .setName('project-update')
      .setDescription('Update project metadata')
      .addStringOption(projectOption)
      .addStringOption((option) => option.setName('name').setDescription('New project name').setRequired(false))
      .addStringOption((option) => option.setName('expected_end').setDescription('YYYY-MM-DD').setRequired(false))
      .addStringOption((option) => option.setName('notes').setDescription('Updated project notes').setRequired(false))
      .addStringOption((option) =>
        option
          .setName('status')
          .setDescription('Approved project status')
          .setRequired(false)
          .addChoices(
            { name: 'active', value: PROJECT_STATUSES.ACTIVE },
            { name: 'paused', value: PROJECT_STATUSES.PAUSED },
          ),
      ),
  ),
  autocomplete: autocompleteProjects,
  async execute(interaction) {
    await runActivityCommand(
      interaction,
      'project-update',
      () => updateProject({
        interaction,
        project: interaction.options.getString('project', true),
        name: interaction.options.getString('name', false),
        expectedEnd: interaction.options.getString('expected_end', false),
        notes: interaction.options.getString('notes', false),
        status: interaction.options.getString('status', false),
      }),
    );
  },
};

const projectClose = {
  data: withNoDm(
    new SlashCommandBuilder()
      .setName('project-close')
      .setDescription('Mark a project completed and move it to history')
      .addStringOption(projectOption)
      .addStringOption((option) => option.setName('outcome').setDescription('Project outcome').setRequired(true))
      .addStringOption((option) => option.setName('final_notes').setDescription('Final notes').setRequired(true)),
  ),
  autocomplete: autocompleteProjects,
  async execute(interaction) {
    await runActivityCommand(
      interaction,
      'project-close',
      () => closeProject({
        interaction,
        project: interaction.options.getString('project', true),
        outcome: interaction.options.getString('outcome', true),
        finalNotes: interaction.options.getString('final_notes', true),
      }),
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
        project: interaction.options.getString('project', true),
      });
      return projectInfoMessage(project, people);
    });
  },
};

export const projectCommands = [
  projectCreate,
  projectAddMember,
  projectRemoveMember,
  projectUpdate,
  projectClose,
  projectInfo,
];
