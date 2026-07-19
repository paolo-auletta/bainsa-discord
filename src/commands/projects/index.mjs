import { MessageFlags, SlashCommandBuilder } from 'discord.js';

import { respondAutocomplete } from '../../discord/autocomplete.mjs';
import { divisionLabel, PROJECT_PERSON_ROLES, PROJECT_STATUSES } from '../../constants.mjs';
import { handleInteractionError, replyPersistent } from '../../discord/reply.mjs';
import {
  addProjectMember,
  closeProject,
  createProject,
  findProjectDivisions,
  findProjectUniversities,
  getProjectInfo,
  projectInfoMessage,
  projectSuccessMessage,
  readProjectCreateOptions,
  removeProjectMember,
  searchVisibleProjects,
  updateProject,
} from '../../services/projects/index.mjs';

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

async function runPersistentCommand(interaction, work) {
  try {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const content = await work();
    await replyPersistent(interaction, content);
  } catch (error) {
    await handleInteractionError(interaction, error);
  }
}

async function autocompleteProjects(interaction) {
  try {
    const choices = await searchVisibleProjects({
      interaction,
      query: interaction.options.getFocused(),
    });
    await respondAutocomplete(interaction, choices);
  } catch (error) {
    await respondAutocomplete(interaction, [], 'Project autocomplete fallback');
  }
}

async function autocompleteProjectCreate(interaction) {
  const focused = interaction.options.getFocused(true);
  const university = interaction.options.getString('university') ?? '';
  try {
    if (focused.name === 'university') {
      const rows = await findProjectUniversities(focused.value);
      await respondAutocomplete(interaction, rows.map((row) => ({ name: row.name, value: row.name })));
      return;
    }
    if (focused.name === 'division') {
      const rows = await findProjectDivisions(university, focused.value);
      await respondAutocomplete(
        interaction,
        rows.map((row) => ({ name: divisionLabel(row.name, row.color), value: row.name })),
      );
      return;
    }
    if (['members', 'supervisors'].includes(focused.name)) {
      await respondAutocomplete(interaction, await memberChoices(interaction, focused.value));
      return;
    }
    await respondAutocomplete(interaction, []);
  } catch (error) {
    await respondAutocomplete(interaction, [], 'Project setup autocomplete fallback');
  }
}

function memberSearchTerm(value) {
  const raw = String(value ?? '');
  const lastToken = raw.split(/[\s,;]+/).at(-1) ?? '';
  return lastToken.replace(/^@/, '').trim().slice(0, 32);
}

function memberSearchPrefix(value) {
  const raw = String(value ?? '');
  const lastToken = raw.split(/[\s,;]+/).at(-1) ?? '';
  return raw.slice(0, raw.length - lastToken.length);
}

async function memberChoices(interaction, value) {
  const guild = interaction.guild;
  if (!guild?.members) return [];

  const term = memberSearchTerm(value);
  const members = term
    ? await guild.members.fetch({ query: term, limit: 25 })
    : guild.members.cache;
  const prefix = memberSearchPrefix(value);

  return [...members.values()]
    .filter((member) => member.user && !member.user.bot)
    .sort((left, right) => left.displayName.localeCompare(right.displayName))
    .slice(0, 25)
    .map((member) => ({
      name: `${member.displayName} (@${member.user.username})`.slice(0, 100),
      value: `${prefix}<@${member.id}>`.slice(0, 100),
    }));
}

const projectCreate = {
  data: withNoDm(
    new SlashCommandBuilder()
      .setName('project-create')
      .setDescription('Create a private university division project')
      .addStringOption((option) => option.setName('name').setDescription('Project name').setRequired(true))
      .addStringOption((option) =>
        option.setName('university').setDescription('University name').setRequired(true).setAutocomplete(true),
      )
      .addStringOption((option) =>
        option.setName('division').setDescription('Division name').setRequired(true).setAutocomplete(true),
      )
      .addStringOption((option) =>
        option
          .setName('members')
          .setDescription('Server members as comma-separated mentions')
          .setRequired(true)
          .setAutocomplete(true),
      )
      .addStringOption((option) =>
        option
          .setName('supervisors')
          .setDescription('Server members as comma-separated mentions')
          .setRequired(true)
          .setAutocomplete(true),
      )
      .addStringOption((option) => option.setName('start_date').setDescription('YYYY-MM-DD').setRequired(true))
      .addStringOption((option) => option.setName('expected_end').setDescription('YYYY-MM-DD').setRequired(true))
      .addStringOption((option) => option.setName('notes').setDescription('Project notes').setRequired(false)),
  ),
  autocomplete: autocompleteProjectCreate,
  async execute(interaction) {
    await runPersistentCommand(interaction, async () => {
      const project = await createProject(readProjectCreateOptions(interaction));
      return projectSuccessMessage('Created', project);
    });
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
    await runPersistentCommand(interaction, async () => {
      const { project } = await addProjectMember({
        interaction,
        project: interaction.options.getString('project', true),
        user: interaction.options.getUser('user', true),
        role: interaction.options.getString('role', true),
      });
      return projectSuccessMessage('Updated access for', project);
    });
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
    await runPersistentCommand(interaction, async () => {
      const { project } = await removeProjectMember({
        interaction,
        project: interaction.options.getString('project', true),
        user: interaction.options.getUser('user', true),
        reason: interaction.options.getString('reason', false),
      });
      return projectSuccessMessage('Removed member from', project);
    });
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
    await runPersistentCommand(interaction, async () => {
      const { project } = await updateProject({
        interaction,
        project: interaction.options.getString('project', true),
        name: interaction.options.getString('name', false),
        expectedEnd: interaction.options.getString('expected_end', false),
        notes: interaction.options.getString('notes', false),
        status: interaction.options.getString('status', false),
      });
      return projectSuccessMessage('Updated', project);
    });
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
    await runPersistentCommand(interaction, async () => {
      const { project } = await closeProject({
        interaction,
        project: interaction.options.getString('project', true),
        outcome: interaction.options.getString('outcome', true),
        finalNotes: interaction.options.getString('final_notes', true),
      });
      return projectSuccessMessage('Closed', project);
    });
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
    await runPersistentCommand(interaction, async () => {
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
