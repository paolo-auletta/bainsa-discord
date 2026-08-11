import {
  ActionRowBuilder,
  ButtonBuilder,
  ContainerBuilder,
  MessageFlags,
  SeparatorBuilder,
  SeparatorSpacingSize,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  TextDisplayBuilder,
  UserSelectMenuBuilder,
} from 'discord.js';

import { DISCORD_LIMITS } from './limits.js';
import { ACTION_STYLES, MESSAGE_COLORS, SAFE_ALLOWED_MENTIONS } from './tokens.js';
import { cleanText, truncateText } from './text.js';
import type {
  BotMessagePayload,
  InteractionActionSpec,
  InteractionControlSpec,
  InteractionPanelSpec,
  WorkspaceSectionSpec,
} from './types.js';

function text(content: string) {
  return new TextDisplayBuilder().setContent(truncateText(content, DISCORD_LIMITS.textDisplay));
}

function separator() {
  return new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Large);
}

function actionButton(action: InteractionActionSpec) {
  const style = action.style ?? 'secondary';
  const button = new ButtonBuilder()
    .setLabel(truncateText(action.loading ? 'Loading…' : action.label, 80))
    .setStyle(ACTION_STYLES[style])
    .setDisabled(Boolean(action.disabled || action.loading));
  if (style === 'link') {
    if (!action.url) throw new Error(`Link action "${action.label}" requires a URL.`);
    button.setURL(action.url);
  } else {
    if (!action.id) throw new Error(`Action "${action.label}" requires a custom id.`);
    button.setCustomId(truncateText(action.id, DISCORD_LIMITS.customId));
  }
  if (action.emoji) button.setEmoji(action.emoji);
  return button;
}

function controlRow(control: InteractionControlSpec) {
  if (control.kind === 'button') {
    return new ActionRowBuilder<ButtonBuilder>().addComponents(actionButton(control));
  }

  if (control.kind === 'user-select') {
    const menu = new UserSelectMenuBuilder()
      .setCustomId(truncateText(control.id, DISCORD_LIMITS.customId))
      .setPlaceholder(truncateText(control.placeholder, 150))
      .setMinValues(control.min ?? 1)
      .setMaxValues(Math.min(control.max ?? 1, 25))
      .setDisabled(Boolean(control.disabled));
    if (control.selectedUserIds?.length) menu.setDefaultUsers([...control.selectedUserIds].slice(0, 25));
    return new ActionRowBuilder<UserSelectMenuBuilder>().addComponents(menu);
  }

  const menu = new StringSelectMenuBuilder()
    .setCustomId(truncateText(control.id, DISCORD_LIMITS.customId))
    .setPlaceholder(truncateText(control.placeholder, 150))
    .setMinValues(control.min ?? 1)
    .setMaxValues(Math.min(control.max ?? 1, DISCORD_LIMITS.selectOptions))
    .setDisabled(Boolean(control.disabled))
    .addOptions(...control.options.slice(0, DISCORD_LIMITS.selectOptions).map((option) => {
      const builder = new StringSelectMenuOptionBuilder()
        .setLabel(truncateText(option.label, 100))
        .setValue(truncateText(option.value, 100))
        .setDefault(Boolean(option.selected));
      if (option.description) builder.setDescription(truncateText(option.description, 100));
      if (option.emoji) builder.setEmoji(option.emoji);
      return builder;
    }));
  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu);
}

function sectionText(section: WorkspaceSectionSpec, compact = false) {
  const body = Array.isArray(section.body) ? section.body.join('\n') : section.body;
  if (!section.heading) return String(body ?? '');
  if (!compact) return `**${section.heading}**\n${body}`;
  return String(body ?? '').includes('\n')
    ? `**${section.heading}:**\n${body}`
    : `**${section.heading}:** ${body}`;
}

function fieldGuidance(label: string, description?: string) {
  return [
    `**${cleanText(label)}**`,
    description ? cleanText(description) : null,
  ].filter(Boolean).join('\n');
}

function controlLabel(control: InteractionControlSpec) {
  const label = control.kind === 'button' ? control.fieldLabel : control.label;
  if (!label) return null;
  return fieldGuidance(label, control.description);
}

export function renderInteractionPanel(spec: InteractionPanelSpec): BotMessagePayload {
  const heading: string[] = [];
  if (spec.progress) {
    heading.push(`-# ${cleanText(spec.progress.label)} · Step ${spec.progress.current} of ${spec.progress.total}`);
  }
  heading.push(`**${cleanText(spec.title)}**`);
  if (spec.description) heading.push(cleanText(spec.description));

  const facts = spec.facts?.filter((fact) => String(fact.value ?? '').trim()) ?? [];
  const sections = spec.sections ?? [];
  const compact = spec.detailsDensity === 'compact' || spec.detailsDensity === 'compact-groups';
  const detailSeparator = spec.detailsDensity === 'compact' ? '\n' : '\n\n';
  const factSeparator = compact ? '\n' : '\n\n';
  const detailBlocks = [
    ...(facts.length ? [facts.map((fact) => compact
      ? `**${fact.label}:** ${fact.value}`
      : `**${fact.label}**\n${fact.value}`).join(factSeparator)] : []),
    ...sections.map((section) => sectionText(section, compact)),
    ...(spec.status ? [cleanText(spec.status)] : []),
  ].filter(Boolean);

  const controls = (spec.controls ?? []).slice(0, DISCORD_LIMITS.controlRows);
  const footerActions = spec.actions?.slice(
    0,
    DISCORD_LIMITS.actionRows * DISCORD_LIMITS.actionRowButtons,
  ) ?? [];
  const footerRows = Math.ceil(footerActions.length / DISCORD_LIMITS.actionRowButtons);
  const estimatedComponents = 1
    + (detailBlocks.length ? 2 : 0)
    + (controls.length || spec.contentActions?.length
      ? 1
        + controls.length
        + controls.filter((control) => controlLabel(control)).length
        + (spec.contentActions?.length && spec.contentActionsLabel ? 1 : 0)
        + (spec.contentActions?.length ? 1 : 0)
      : 0)
    + (footerRows ? 1 + footerRows : 0);
  const compactDetails = detailBlocks.length > 0
    && estimatedComponents > DISCORD_LIMITS.containerComponents;
  const headingContent = compactDetails
    ? `${heading.join('\n')}\n\n${detailBlocks.join(detailSeparator)}`
    : heading.join('\n');
  const container = new ContainerBuilder()
    .setAccentColor(MESSAGE_COLORS[spec.tone])
    .addTextDisplayComponents(text(headingContent));

  if (detailBlocks.length && !compactDetails) {
    container.addSeparatorComponents(separator());
    container.addTextDisplayComponents(text(detailBlocks.join(detailSeparator)));
  }

  if (controls.length || spec.contentActions?.length) {
    container.addSeparatorComponents(separator());
    for (const control of controls) {
      const label = controlLabel(control);
      if (label) container.addTextDisplayComponents(text(label));
      if (control.kind === 'button') {
        container.addActionRowComponents(controlRow(control) as ActionRowBuilder<ButtonBuilder>);
      } else if (control.kind === 'user-select') {
        container.addActionRowComponents(controlRow(control) as ActionRowBuilder<UserSelectMenuBuilder>);
      } else {
        container.addActionRowComponents(controlRow(control) as ActionRowBuilder<StringSelectMenuBuilder>);
      }
    }
    if (spec.contentActions?.length) {
      if (spec.contentActionsLabel) {
        container.addTextDisplayComponents(text(fieldGuidance(
          spec.contentActionsLabel.label,
          spec.contentActionsLabel.description,
        )));
      }
      container.addActionRowComponents(
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          ...spec.contentActions
            .slice(0, DISCORD_LIMITS.actionRowButtons)
            .map(actionButton),
        ),
      );
    }
  }

  if (spec.actions?.length) {
    container.addSeparatorComponents(separator());
    for (let index = 0; index < footerActions.length; index += DISCORD_LIMITS.actionRowButtons) {
      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        ...footerActions.slice(index, index + DISCORD_LIMITS.actionRowButtons).map(actionButton),
      );
      container.addActionRowComponents(row);
    }
  }

  const componentCount = container.toJSON().components.length;
  if (componentCount > DISCORD_LIMITS.containerComponents) {
    throw new Error(`Interaction panel has ${componentCount} components; Discord allows ${DISCORD_LIMITS.containerComponents}.`);
  }

  return {
    components: [container],
    flags: MessageFlags.IsComponentsV2,
    allowedMentions: SAFE_ALLOWED_MENTIONS,
  };
}
