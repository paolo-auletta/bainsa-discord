import { MessageFlags } from 'discord.js';

import { config } from '../config.js';
import { replyEphemeral } from '../discord/reply.js';
import { UserFacingError } from '../errors.js';
import { interactionAction, interactionOutcome, renderInteractionPanel } from '../messages/index.js';
import { botCommandChannelScope } from '../runtime/command-channels.js';
import { buildGuideAccess, guideScopeLabel } from './access.js';
import { GUIDE_CATALOG, GUIDE_TOPICS, guideEntry } from './catalog.js';

const GUIDE_PREFIX = 'guide:v1:';
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

/** @returns {import('../messages/types.js').InteractionActionSpec[]} */
function topicButtons(userId, access) {
  const availableTopics = new Set(
    GUIDE_CATALOG
      .filter((item) => access.availableCommands.has(item.command))
      .map((item) => item.topic),
  );
  availableTopics.add(GUIDE_TOPICS.RULES);
  return TOPICS
    .filter((topic) => availableTopics.has(topic.id))
    .map((topic) => interactionAction({
      id: customId(userId, 'topic', topic.id),
      label: topicLabel(topic, access).slice(0, 80),
      emoji: topic.emoji,
      style: 'primary',
    }));
}

/** @returns {import('../messages/types.js').InteractionActionSpec[]} */
function navigationButtons(userId) {
  return [interactionAction({
    id: customId(userId, 'home', 'home'),
    label: 'Guide home',
    style: 'secondary',
  })];
}

function homePayload(interaction, access) {
  return renderInteractionPanel({
    kind: 'interaction-panel',
    tone: 'brand',
    title: `${config.botName} Bot Guide`,
    description: 'This private guide only shows commands available to your current board roles.',
    facts: [
      { label: 'Your access', value: access.roleLabels.join('\n') },
      { label: 'Working scope', value: guideScopeLabel(access) },
    ],
    status: 'Choose a topic below. This message will update in place.',
    actions: topicButtons(interaction.user.id, access),
    audience: 'actor',
  });
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
    return renderInteractionPanel({
      kind: 'interaction-panel',
      tone: 'brand',
      title: 'Rules and limits',
      facts: [{ label: 'Your scope', value: guideScopeLabel(access) }],
      sections: [{ body: rulesFor(access).map((rule) => `• ${rule}`) }],
      actions: navigationButtons(interaction.user.id),
      audience: 'actor',
    });
  }

  const topic = TOPICS.find((candidate) => candidate.id === topicId);
  const entries = GUIDE_CATALOG.filter(
    (item) => item.topic === topicId && access.availableCommands.has(item.command),
  );
  if (!topic || entries.length === 0) throw new UserFacingError('That guide section is not available to you.');

  return renderInteractionPanel({
    kind: 'interaction-panel',
    tone: 'brand',
    title: topicLabel(topic, access),
    facts: [{ label: 'Your scope', value: guideScopeLabel(access) }],
    sections: entries.map((item) => ({ heading: `/${item.command}`, body: item.summary })),
    controls: [{
      kind: 'string-select',
      id: customId(interaction.user.id, 'command', topicId),
      placeholder: 'Choose a command for full details',
      options: entries.map((item) => ({
        label: item.title.slice(0, 100),
        description: item.summary.slice(0, 100),
        value: item.command,
      })),
    }],
    actions: navigationButtons(interaction.user.id),
    audience: 'actor',
  });
}

function commandPayload(interaction, access, commandName) {
  const item = guideEntry(commandName);
  if (!item || !access.availableCommands.has(commandName)) {
    throw new UserFacingError('That command guide is not available to you.');
  }
  return renderInteractionPanel({
    kind: 'interaction-panel',
    tone: 'brand',
    title: item.title,
    description: `**/${item.command}**\n${item.summary}`,
    facts: [{ label: 'Your scope', value: guideScopeLabel(access, item) }],
    sections: [
      { heading: 'Before you start', body: item.before.map((line) => `• ${line}`) },
      { heading: 'What you provide', body: item.inputs.map((line) => `• ${line}`) },
      { heading: 'What happens after success', body: [item.success, item.activity] },
    ],
    actions: [
      interactionAction({
        id: customId(interaction.user.id, 'topic', item.topic),
        label: 'Back',
        style: 'secondary',
      }),
      ...navigationButtons(interaction.user.id),
    ],
    audience: 'actor',
  });
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
      await replyEphemeral(interaction, renderInteractionPanel(interactionOutcome({
        outcome: 'forbidden',
        title: 'This guide belongs to another member',
        description: 'Run `/guide` to open a private guide for your own roles and scope.',
      })));
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
