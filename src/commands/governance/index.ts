import { MessageFlags, SlashCommandBuilder } from 'discord.js';

import { formatBoardActivity } from '../../activity/formatters.js';
import { respondAutocomplete } from '../../discord/autocomplete.js';
import {
  handleInteractionError,
  replyBoardActivity,
  replyEphemeral,
} from '../../discord/reply.js';
import { logger } from '../../logger.js';
import { divisionLabel } from '../../constants.js';
import {
  BOARD_ROLE_CHOICES,
} from '../../services/governance/policy.js';
import {
  addDivisionMember,
  assignBoardRole,
  findDivisions,
  findUniversities,
  formatBoardInfo,
  formatMemberInfo,
  getBoardInfo,
  getMemberInfo,
  removeDivisionMember,
  removeMember,
} from '../../services/governance/service.js';
import { boardRoleRemovalConfirmation } from '../../services/governance/confirmations.js';
import { formatBoardAssignmentHandoff } from '../../services/governance/formatters.js';
import { governanceCommandPanels } from '../../services/governance/panels.js';

function withBoardRoleChoices(option) {
  return option
    .setName('role')
    .setDescription('Board role')
    .addChoices(...BOARD_ROLE_CHOICES);
}

function universityOption(option) {
  return option
    .setName('university')
    .setDescription('University scope')
    .setRequired(true)
    .setAutocomplete(true);
}

function divisionOption(option, name = 'division', description = 'Division name', required = true) {
  return option
    .setName(name)
    .setDescription(description)
    .setRequired(required)
    .setAutocomplete(true);
}

function command(name, description) {
  return new SlashCommandBuilder()
    .setName(name)
    .setDescription(description)
    .setDMPermission(false);
}

const AUTOCOMPLETE_LIMIT = 25;
const DISCORD_CHOICE_TEXT_LIMIT = 100;

function toAutocompleteChoice(name, value = name) {
  if (name.length > DISCORD_CHOICE_TEXT_LIMIT || value.length > DISCORD_CHOICE_TEXT_LIMIT) {
    return null;
  }
  return { name, value };
}

export function divisionAutocompleteChoice(row) {
  return {
    ...row,
    name: divisionLabel(row.name, row.color),
    value: row.name,
  };
}

async function findDivisionChoices(interaction, focusedName, value) {
  const university = interaction.options.getString('university');
  if (focusedName !== 'divisions') {
    const rows = await findDivisions(university, value);
    return rows.map(divisionAutocompleteChoice);
  }

  const finalCommaIndex = value.lastIndexOf(',');
  let tokenStart = finalCommaIndex + 1;
  while (tokenStart < value.length && value[tokenStart] === ' ') {
    tokenStart += 1;
  }
  const prefix = finalCommaIndex === -1 ? '' : value.slice(0, tokenStart);
  const search = finalCommaIndex === -1 ? value : value.slice(tokenStart);
  const existing = new Set(
    prefix
      .split(',')
      .map((division) => division.trim().toLowerCase())
      .filter(Boolean),
  );
  const rows = await findDivisions(university, search);

  return rows
    .filter((row) => !existing.has(row.name.toLowerCase()))
    .map((row) => ({
      ...row,
      name: divisionLabel(row.name, row.color),
      value: `${prefix}${row.name}`,
    }));
}

async function run(interaction, work) {
  try {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    await work();
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

async function postActivity(interaction, commandName, result) {
  await replyBoardActivity(
    interaction,
    formatBoardActivity(commandName, {
      actorId: interaction.user.id,
      result,
    }),
  );
}

async function notifyBoardAssignment(result) {
  try {
    await result.target.send(formatBoardAssignmentHandoff(result));
  } catch (error) {
    logger.warn('Board assignment DM could not be delivered', {
      userId: String(result.target.id),
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function autocomplete(interaction) {
  const focused = interaction.options.getFocused(true);
  const value = focused.value ?? '';
  try {
    const rows = focused.name === 'university'
      ? await findUniversities(value)
      : ['division', 'current_name', 'divisions'].includes(focused.name)
        ? await findDivisionChoices(interaction, focused.name, value)
        : [];
    await respondAutocomplete(
      interaction,
      rows
        .map((row) => toAutocompleteChoice(row.name, row.value ?? row.name))
        .filter(Boolean)
        .slice(0, AUTOCOMPLETE_LIMIT),
    );
  } catch (error) {
    logger.warn('Governance autocomplete lookup failed', {
      command: interaction.commandName,
      option: focused.name,
      error: error instanceof Error ? error.message : String(error),
    });
    await respondAutocomplete(interaction, [], 'Governance autocomplete fallback');
  }
}

const memberUpdate = {
  data: command('member-update', 'Open the private guided member update panel.'),
  execute: (interaction) => openPanel(
    interaction,
    () => governanceCommandPanels.startMemberUpdate(interaction),
  ),
};

const memberRemove = {
  data: command('member-remove', 'Remove a member from the server immediately.')
    .addUserOption((option) => option.setName('user').setDescription('Member to kick').setRequired(true))
    .addStringOption((option) => option.setName('reason').setDescription('Optional removal reason').setRequired(false)),
  execute: (interaction) =>
    run(interaction, async () => {
      const result = await removeMember(interaction, {
        user: interaction.options.getUser('user', true),
        reason: interaction.options.getString('reason') ?? null,
      });
      await postActivity(interaction, 'member-remove', result);
    }),
};

const memberInfo = {
  data: command('member-info', 'Show member profile, board roles, and active project access.')
    .addUserOption((option) => option.setName('user').setDescription('Member to inspect').setRequired(false)),
  execute: (interaction) =>
    run(interaction, async () => {
      const info = await getMemberInfo(interaction, {
        user: interaction.options.getUser('user') ?? undefined,
      });
      await replyEphemeral(interaction, formatMemberInfo(info));
    }),
};

const divisionCreate = {
  data: command('division-create', 'Open the private guided division setup.'),
  execute: (interaction) => openPanel(
    interaction,
    () => governanceCommandPanels.startDivisionCreate(interaction),
  ),
};

const divisionUpdate = {
  data: command('division-update', 'Open the private guided division update panel.'),
  execute: (interaction) => openPanel(
    interaction,
    () => governanceCommandPanels.startDivisionUpdate(interaction),
  ),
};

const divisionAddMember = {
  data: command('division-add-member', 'Add a Researcher to a division.')
    .addUserOption((option) => option.setName('user').setDescription('Member to add').setRequired(true))
    .addStringOption(universityOption)
    .addStringOption((option) => divisionOption(option)),
  autocomplete,
  execute: (interaction) =>
    run(interaction, async () => {
      const result = await addDivisionMember(interaction, {
        user: interaction.options.getUser('user', true),
        university: interaction.options.getString('university', true),
        division: interaction.options.getString('division', true),
      });
      await postActivity(interaction, 'division-add-member', result);
    }),
};

const divisionRemoveMember = {
  data: command('division-remove-member', 'Remove a member from a division.')
    .addUserOption((option) => option.setName('user').setDescription('Member to remove').setRequired(true))
    .addStringOption(universityOption)
    .addStringOption((option) => divisionOption(option))
    .addStringOption((option) => option.setName('reason').setDescription('Optional removal reason').setRequired(false)),
  autocomplete,
  execute: (interaction) =>
    run(interaction, async () => {
      const result = await removeDivisionMember(interaction, {
        user: interaction.options.getUser('user', true),
        university: interaction.options.getString('university', true),
        division: interaction.options.getString('division', true),
        reason: interaction.options.getString('reason') ?? null,
      });
      await postActivity(interaction, 'division-remove-member', result);
    }),
};

const boardAssign = {
  data: command('board-assign', 'Assign a university board role.')
    .addUserOption((option) => option.setName('user').setDescription('Member to promote').setRequired(true))
    .addStringOption(universityOption)
    .addStringOption((option) => withBoardRoleChoices(option).setRequired(true))
    .addStringOption((option) => divisionOption(option, 'division', 'Required for Head roles', false)),
  autocomplete,
  execute: (interaction) =>
    run(interaction, async () => {
      const result = await assignBoardRole(interaction, {
        user: interaction.options.getUser('user', true),
        university: interaction.options.getString('university', true),
        role: interaction.options.getString('role', true),
        division: interaction.options.getString('division') ?? null,
      });
      await notifyBoardAssignment(result);
      await postActivity(interaction, 'board-assign', result);
    }),
};

const boardRemove = {
  data: command('board-remove', 'Remove a university board role while keeping base member roles.')
    .addUserOption((option) => option.setName('user').setDescription('Member to update').setRequired(true))
    .addStringOption(universityOption)
    .addStringOption((option) => withBoardRoleChoices(option).setRequired(true))
    .addStringOption((option) => divisionOption(option, 'division', 'Head division to remove, or blank for all', false))
    .addStringOption((option) => option.setName('reason').setDescription('Optional removal reason').setRequired(false)),
  autocomplete,
  execute: async (interaction) => {
    try {
      await boardRoleRemovalConfirmation.start(interaction, {
        user: interaction.options.getUser('user', true),
        university: interaction.options.getString('university', true),
        role: interaction.options.getString('role', true),
        division: interaction.options.getString('division') ?? null,
        reason: interaction.options.getString('reason') ?? null,
      });
    } catch (error) {
      await handleInteractionError(interaction, error);
    }
  },
};

const boardInfo = {
  data: command('board-info', 'Show a university board roster and role consistency.')
    .addStringOption(universityOption),
  autocomplete,
  execute: (interaction) =>
    run(interaction, async () => {
      const info = await getBoardInfo(interaction, {
        university: interaction.options.getString('university', true),
      });
      await replyEphemeral(interaction, formatBoardInfo(info));
    }),
};

export const governanceCommands = [
  memberUpdate,
  memberRemove,
  memberInfo,
  divisionCreate,
  divisionUpdate,
  divisionAddMember,
  divisionRemoveMember,
  boardAssign,
  boardRemove,
  boardInfo,
];

export default governanceCommands;
