import { MessageFlags, SlashCommandBuilder } from 'discord.js';

import { formatBoardActivity } from '../../activity/formatters.js';
import { universityActivityChannel } from '../../activity/router.js';
import {
  handleInteractionError,
  replyBoardActivity,
  replyEphemeral,
} from '../../discord/reply.js';
import { divisionLabel } from '../../constants.js';
import {
  formatMemberInfo,
  getMemberInfo,
  removeMember,
} from '../../services/governance/service.js';
import { governanceMembershipPanels } from '../../services/governance/membership-panels.js';
import { boardUpdatePanel } from '../../services/governance/board-update-panel.js';
import { boardInfoPanel } from '../../services/governance/board-info-panel.js';
import { governanceCommandPanels } from '../../services/governance/panels.js';

function command(name, description) {
  return new SlashCommandBuilder()
    .setName(name)
    .setDescription(description)
    .setDMPermission(false);
}

export function divisionAutocompleteChoice(row) {
  return {
    ...row,
    name: divisionLabel(row.name, row.color),
    value: row.name,
  };
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
  const payload = formatBoardActivity(commandName, {
      actorId: interaction.user.id,
      result,
    });
  const universityName = result.university?.name ?? result.universityName;
  await replyBoardActivity(interaction, payload, {
    channel: universityActivityChannel(interaction, universityName),
  });
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
  data: command('division-add-member', 'Open the private guided division-member panel.'),
  execute: (interaction) => openPanel(
    interaction,
    () => governanceMembershipPanels.startDivisionAddMember(interaction),
  ),
};

const divisionRemoveMember = {
  data: command('division-remove-member', 'Open the private guided division-removal panel.'),
  execute: (interaction) => openPanel(
    interaction,
    () => governanceMembershipPanels.startDivisionRemoveMember(interaction),
  ),
};

const boardUpdate = {
  data: command('board-update', 'Open the private university board roster editor.'),
  execute: (interaction) => openPanel(
    interaction,
    () => boardUpdatePanel.start(interaction),
  ),
};

const boardInfo = {
  data: command('board-info', 'Open the private university board roster.'),
  execute: (interaction) => openPanel(interaction, () => boardInfoPanel.start(interaction)),
};

export const governanceCommands = [
  memberUpdate,
  memberRemove,
  memberInfo,
  divisionCreate,
  divisionUpdate,
  divisionAddMember,
  divisionRemoveMember,
  boardUpdate,
  boardInfo,
];

export default governanceCommands;
