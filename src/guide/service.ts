import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
  StringSelectMenuBuilder,
} from 'discord.js';

import { replyEphemeral } from '../discord/reply.js';
import { UserFacingError } from '../errors.js';
import { botCommandChannelScope } from '../runtime/command-channels.js';
import { buildGuideAccess, guideScopeLabel } from './access.js';
import { GUIDE_CATALOG, GUIDE_TOPICS, guideEntry } from './catalog.js';

const GUIDE_PREFIX = 'guide:v1:';
const GUIDE_COLOR = 0x5865f2;

const TOPICS = Object.freeze([
  Object.freeze({ id: GUIDE_TOPICS.MEMBERS, label: 'Members and divisions', emoji: '👥' }),
  Object.freeze({ id: GUIDE_TOPICS.PROJECTS, label: 'Manage projects', emoji: '📁' }),
  Object.freeze({ id: GUIDE_TOPICS.LOOKUPS, label: 'Look up information', emoji: '🔎' }),
  Object.freeze({ id: GUIDE_TOPICS.RULES, label: 'Rules and limits', emoji: '📌' }),
]);

function topicLabel(topic, access) {
  const scopedHead = !access.global
    && !access.president
    && !access.vicePresident
    && access.divisions.length === 1;
  if (scopedHead && topic.id === GUIDE_TOPICS.MEMBERS) {
    return `Manage ${access.divisions[0]} members`;
  }
  if (scopedHead && topic.id === GUIDE_TOPICS.PROJECTS) {
    return `Manage ${access.divisions[0]} projects`;
  }
  if (!access.global && topic.id === GUIDE_TOPICS.LOOKUPS) {
    return `Look up ${access.universityName} information`;
  }
  return topic.label;
}

function customId(userId, kind, value) {
  return `${GUIDE_PREFIX}${userId}:${kind}:${value}`;
}

function parseCustomId(value) {
  if (!String(value ?? '').startsWith(GUIDE_PREFIX)) return null;
  const [userId, kind, ...rest] = String(value).slice(GUIDE_PREFIX.length).split(':');
  if (!userId || !kind || rest.length === 0) return null;
  return { userId, kind, value: rest.join(':') };
}

function accessForInteraction(interaction) {
  return buildGuideAccess({
    member: interaction.member,
    channelScope: botCommandChannelScope(interaction.channel),
  });
}

function requireAccess(interaction) {
  const access = accessForInteraction(interaction);
  if (!access) {
    throw new UserFacingError('No board command guide is available for your roles in this channel.');
  }
  return access;
}

function topicButtons(userId, access) {
  const availableTopics = new Set(
    GUIDE_CATALOG
      .filter((item) => access.availableCommands.has(item.command))
      .map((item) => item.topic),
  );
  availableTopics.add(GUIDE_TOPICS.RULES);
  const buttons = TOPICS
    .filter((topic) => availableTopics.has(topic.id))
    .map((topic) =>
      new ButtonBuilder()
        .setCustomId(customId(userId, 'topic', topic.id))
        .setLabel(topicLabel(topic, access).slice(0, 80))
        .setEmoji(topic.emoji)
        .setStyle(ButtonStyle.Primary),
    );
  return [new ActionRowBuilder().addComponents(...buttons)];
}

function navigationButtons(userId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(customId(userId, 'home', 'home'))
      .setLabel('Guide home')
      .setStyle(ButtonStyle.Secondary),
  );
}

function homePayload(interaction, access) {
  const embed = new EmbedBuilder()
    .setColor(GUIDE_COLOR)
    .setTitle('BAINSA Bot Guide')
    .setDescription('This private guide only shows commands available to your current board roles.')
    .addFields(
      { name: 'Your access', value: access.roleLabels.join('\n') },
      { name: 'Working scope', value: guideScopeLabel(access) },
      { name: 'Choose a topic', value: 'Use the buttons below. This message will update in place.' },
    );
  return {
    embeds: [embed],
    components: topicButtons(interaction.user.id, access),
  };
}

function rulesFor(access) {
  if (access.global) {
    return [
      'You can work across universities, but commands still require the correct university and division inputs.',
      'Member and project eligibility rules still apply.',
      'Guides, lookups, and failures stay private; successful shared-state changes create a board-log entry.',
    ];
  }
  if (access.president) {
    return [
      `Your authority is limited to ${access.universityName}.`,
      'You can appoint or remove university Presidents, including co-Presidents, within your university.',
      'Member and project eligibility rules still apply.',
      'Guides, lookups, and failures stay private; successful shared-state changes create a board-log entry.',
    ];
  }
  if (access.vicePresident) {
    return [
      `Your authority is limited to ${access.universityName}.`,
      'You cannot manage your university President or appoint/remove a university President.',
      'Member and project eligibility rules still apply.',
      'Guides, lookups, and failures stay private; successful shared-state changes create a board-log entry.',
    ];
  }
  return [
    `Your management authority is limited to: ${guideScopeLabel(access)}.`,
    'You cannot manage university membership, board appointments, division structure, or another division.',
    'Project members must be active Researchers in the division; supervisors must be active university members.',
    'Guides, lookups, and failures stay private; successful shared-state changes create a board-log entry.',
  ];
}

function topicPayload(interaction, access, topicId) {
  if (topicId === GUIDE_TOPICS.RULES) {
    const embed = new EmbedBuilder()
      .setColor(GUIDE_COLOR)
      .setTitle('Rules and limits')
      .setDescription(rulesFor(access).map((rule) => `• ${rule}`).join('\n'))
      .addFields({ name: 'Your scope', value: guideScopeLabel(access) });
    return { embeds: [embed], components: [navigationButtons(interaction.user.id)] };
  }

  const topic = TOPICS.find((candidate) => candidate.id === topicId);
  const entries = GUIDE_CATALOG.filter(
    (item) => item.topic === topicId && access.availableCommands.has(item.command),
  );
  if (!topic || entries.length === 0) throw new UserFacingError('That guide section is not available to you.');

  const embed = new EmbedBuilder()
    .setColor(GUIDE_COLOR)
    .setTitle(topicLabel(topic, access))
    .setDescription(entries.map((item) => `**/${item.command}**\n${item.summary}`).join('\n\n'))
    .addFields({ name: 'Your scope', value: guideScopeLabel(access) });
  const select = new StringSelectMenuBuilder()
    .setCustomId(customId(interaction.user.id, 'command', topicId))
    .setPlaceholder('Choose a command for full details')
    .addOptions(
      ...entries.map((item) => ({
        label: item.title.slice(0, 100),
        description: item.summary.slice(0, 100),
        value: item.command,
      })),
    );
  return {
    embeds: [embed],
    components: [
      new ActionRowBuilder().addComponents(select),
      navigationButtons(interaction.user.id),
    ],
  };
}

function commandPayload(interaction, access, commandName) {
  const item = guideEntry(commandName);
  if (!item || !access.availableCommands.has(commandName)) {
    throw new UserFacingError('That command guide is not available to you.');
  }
  const embed = new EmbedBuilder()
    .setColor(GUIDE_COLOR)
    .setTitle(item.title)
    .setDescription(`**/${item.command}**\n${item.summary}`)
    .addFields(
      { name: 'Your scope', value: guideScopeLabel(access, item) },
      { name: 'Before you start', value: item.before.map((line) => `• ${line}`).join('\n') },
      { name: 'What you provide', value: item.inputs.map((line) => `• ${line}`).join('\n') },
      { name: 'What happens after success', value: `${item.success}\n\n${item.activity}` },
    );
  return {
    embeds: [embed],
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(customId(interaction.user.id, 'topic', item.topic))
          .setLabel('Back')
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId(customId(interaction.user.id, 'home', 'home'))
          .setLabel('Guide home')
          .setStyle(ButtonStyle.Secondary),
      ),
    ],
  };
}

export async function showGuide(interaction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const access = requireAccess(interaction);
  await interaction.editReply(homePayload(interaction, access));
}

export const guideInteractions = Object.freeze({
  canHandle(customId) {
    return Boolean(parseCustomId(customId));
  },

  async handleComponent(interaction) {
    const parsed = parseCustomId(interaction.customId);
    if (!parsed) throw new UserFacingError('This guide is no longer available. Run /guide again.');
    if (String(parsed.userId) !== String(interaction.user.id)) {
      await replyEphemeral(interaction, 'This private guide belongs to another member. Run /guide for your own guide.');
      return;
    }
    const access = requireAccess(interaction);
    let payload;
    if (parsed.kind === 'home') payload = homePayload(interaction, access);
    else if (parsed.kind === 'topic') payload = topicPayload(interaction, access, parsed.value);
    else if (parsed.kind === 'command') {
      const commandName = interaction.values?.[0];
      const item = guideEntry(commandName);
      if (!item || item.topic !== parsed.value) {
        throw new UserFacingError('This guide selection is no longer available. Run /guide again.');
      }
      payload = commandPayload(interaction, access, commandName);
    } else {
      throw new UserFacingError('This guide is no longer available. Run /guide again.');
    }
    await interaction.update(payload);
  },
});

export {
  commandPayload,
  homePayload,
  parseCustomId,
  topicPayload,
};
