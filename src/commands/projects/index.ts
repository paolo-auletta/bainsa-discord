import { MessageFlags, SlashCommandBuilder } from 'discord.js';

import { formatBoardActivity } from '../../activity/formatters.js';
import { respondAutocomplete } from '../../discord/autocomplete.js';
import { divisionLabel, PROJECT_PERSON_ROLES, PROJECT_STATUSES } from '../../constants.js';
import {
  handleInteractionError,
  replyBoardActivity,
  replyEphemeral,
} from '../../discord/reply.js';
import {
  addProjectMember,
  closeProject,
  createProject,
  findProjectDivisions,
  findProjectPeople,
  findProjectUniversities,
  getProjectInfo,
  projectInfoMessage,
  readProjectCreateOptions,
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
    });
    await respondAutocomplete(interaction, choices);
  } catch {
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
      const role = focused.name === 'members' ? PROJECT_PERSON_ROLES.MEMBER : PROJECT_PERSON_ROLES.SUPERVISOR;
      await respondAutocomplete(interaction, await memberChoices(interaction, role, focused.value));
      return;
    }
    await respondAutocomplete(interaction, []);
  } catch {
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

async function memberChoices(interaction, role, value) {
  const term = memberSearchTerm(value);
  const prefix = memberSearchPrefix(value);
  const universityName = interaction.options.getString('university') ?? '';
  const divisionName =
    role === PROJECT_PERSON_ROLES.MEMBER ? interaction.options.getString('division') ?? '' : null;
  const people = await findProjectPeople({ universityName, divisionName, role, term });

  return people
    .slice(0, 25)
    .map((person) => ({
      name: `${person.full_name || `Member ${person.discord_user_id}`} (<@${person.discord_user_id}>)`.slice(0, 100),
      value: `${prefix}<@${person.discord_user_id}>`.slice(0, 100),
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
          .setDescription('Member mentions; 994 total project participants max')
          .setRequired(true)
          .setAutocomplete(true),
      )
      .addStringOption((option) =>
        option
          .setName('supervisors')
          .setDescription('Supervisor mentions; 994 total participants max')
          .setRequired(true)
          .setAutocomplete(true),
      )
      .addStringOption((option) => option.setName('start_date').setDescription('YYYY-MM-DD').setRequired(true))
      .addStringOption((option) => option.setName('expected_end').setDescription('YYYY-MM-DD').setRequired(true))
      .addStringOption((option) => option.setName('notes').setDescription('Project notes').setRequired(false)),
  ),
  autocomplete: autocompleteProjectCreate,
  async execute(interaction) {
    await runActivityCommand(
      interaction,
      'project-create',
      () => createProject(readProjectCreateOptions(interaction)),
    );
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
