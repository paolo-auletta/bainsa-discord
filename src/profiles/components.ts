import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  MessageFlags,
  ModalBuilder,
  SeparatorBuilder,
  SeparatorSpacingSize,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  TextDisplayBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';

import { profileSessionId, PROFILE_ACTIONS } from './custom-ids.js';
import { normalizeOptionalProfileText, profileTag, selectableProfileTags } from './state.js';

const BRAND = 0x5865f2;

function text(content: string) {
  return new TextDisplayBuilder().setContent(content);
}

function separator() {
  return new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Large);
}

function actionButton(session, action: string, label: string, style = ButtonStyle.Secondary) {
  return new ButtonBuilder()
    .setCustomId(profileSessionId(action, session.id, session.actorId))
    .setLabel(label)
    .setStyle(style);
}

function wizardPayload(container: ContainerBuilder) {
  return {
    components: [container],
    flags: MessageFlags.Ephemeral | MessageFlags.IsComponentsV2,
    allowedMentions: { parse: [] },
  };
}

function optional(value: unknown) {
  return normalizeOptionalProfileText(value) ?? 'Not added';
}

function tagLabels(values: unknown) {
  return Array.isArray(values)
    ? values.map((value) => profileTag(value)?.label ?? String(value)).join(', ')
    : '';
}

function profileSummary(session) {
  const profile = session.profile;
  return [
    '## Your BAINSA directory profile',
    '',
    `**Headline** · ${optional(profile.headline)}`,
    `**Current role** · ${optional(profile.current_role)}`,
    `**Tags** · ${profile.selected_tags?.length ? tagLabels(profile.selected_tags) : 'Not selected'}`,
  ].join('\n');
}

function navigation(session, nextAction: string, nextLabel: string, backAction: string, backLabel: string) {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    actionButton(session, nextAction, nextLabel, ButtonStyle.Primary),
    actionButton(session, backAction, backLabel),
    actionButton(session, PROFILE_ACTIONS.CANCEL, 'Cancel', ButtonStyle.Danger),
  );
}

function modalInput(customId: string, label: string, value: unknown, options: {
  required: boolean;
  style: TextInputStyle;
  minLength?: number;
  maxLength: number;
  placeholder?: string;
}) {
  const input = new TextInputBuilder()
    .setCustomId(customId)
    .setLabel(label)
    .setRequired(options.required)
    .setStyle(options.style)
    .setMaxLength(options.maxLength);
  if (options.minLength) input.setMinLength(options.minLength);
  if (options.placeholder) input.setPlaceholder(options.placeholder);
  const normalized = String(value ?? '').trim();
  if (normalized) input.setValue(normalized);
  return new ActionRowBuilder<TextInputBuilder>().addComponents(input);
}

export function profileIdentityModal(session) {
  return new ModalBuilder()
    .setCustomId(profileSessionId(PROFILE_ACTIONS.IDENTITY_MODAL, session.id, session.actorId))
    .setTitle('Profile · About you')
    .addComponents(
      modalInput('headline', 'Your one-line headline', session.profile.headline, {
        required: true, style: TextInputStyle.Short, minLength: 10, maxLength: 80,
        placeholder: 'How should BAINSA members understand what you do?',
      }),
      modalInput('about', 'About you and your interests', session.profile.about, {
        required: true, style: TextInputStyle.Paragraph, minLength: 20, maxLength: 300,
        placeholder: 'Topics, problems, or industries that interest you',
      }),
    );
}

export function profileCurrentModal(session) {
  return new ModalBuilder()
    .setCustomId(profileSessionId(PROFILE_ACTIONS.CURRENT_MODAL, session.id, session.actorId))
    .setTitle('Profile · Current and future')
    .addComponents(
      modalInput('current_role', 'What are you doing now?', session.profile.current_role, {
        required: true, style: TextInputStyle.Short, minLength: 2, maxLength: 80,
        placeholder: 'MSc student, research assistant, ML engineer…',
      }),
      modalInput('current_organization', 'Organisation (optional)', session.profile.current_organization, {
        required: false, style: TextInputStyle.Short, maxLength: 100,
      }),
      modalInput('location', 'Location (optional)', session.profile.location, {
        required: false, style: TextInputStyle.Short, maxLength: 60,
      }),
      modalInput('goals', 'What would you like to explore next?', session.profile.goals, {
        required: true, style: TextInputStyle.Paragraph, minLength: 10, maxLength: 250,
      }),
    );
}

export function profileContactModal(session) {
  return new ModalBuilder()
    .setCustomId(profileSessionId(PROFILE_ACTIONS.CONTACT_MODAL, session.id, session.actorId))
    .setTitle('Profile · Optional contact')
    .addComponents(
      modalInput('email', 'Public contact email (optional)', session.profile.email, {
        required: false, style: TextInputStyle.Short, maxLength: 254,
      }),
      modalInput('linkedin_url', 'LinkedIn URL (optional)', session.profile.linkedin_url, {
        required: false, style: TextInputStyle.Short, maxLength: 500,
      }),
      modalInput('research_profile_url', 'Research profile URL (optional)', session.profile.research_profile_url, {
        required: false, style: TextInputStyle.Short, maxLength: 500,
      }),
    );
}

export function profileTagsPayload(session) {
  const selected = new Set(session.profile.selected_tags ?? []);
  const menu = new StringSelectMenuBuilder()
    .setCustomId(profileSessionId(PROFILE_ACTIONS.TAGS, session.id, session.actorId))
    .setPlaceholder('Choose one to four areas')
    .setMinValues(1)
    .setMaxValues(4)
    .addOptions(selectableProfileTags().map((tag) => new StringSelectMenuOptionBuilder()
      .setLabel(tag.label)
      .setValue(tag.key)
      .setDescription(tag.description.slice(0, 100))
      .setDefault(selected.has(tag.key))));
  const container = new ContainerBuilder()
    .setAccentColor(BRAND)
    .addTextDisplayComponents(text(profileSummary(session)))
    .addSeparatorComponents(separator())
    .addTextDisplayComponents(text('### Choose your tags\nPick one to four fields or environments.'))
    .addActionRowComponents(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu))
    .addActionRowComponents(navigation(session, PROFILE_ACTIONS.CONTACT, 'Continue to contact', PROFILE_ACTIONS.CURRENT, 'Edit current/future'));
  return wizardPayload(container);
}

export function profileCurrentPayload(session) {
  const container = new ContainerBuilder()
    .setAccentColor(BRAND)
    .addTextDisplayComponents(text(profileSummary(session)))
    .addSeparatorComponents(separator())
    .addTextDisplayComponents(text('### Current and future\nAdd your current role, optional organisation and location, and what you would like to explore next.'))
    .addActionRowComponents(new ActionRowBuilder<ButtonBuilder>().addComponents(
      actionButton(session, PROFILE_ACTIONS.CURRENT, 'Edit current/future', ButtonStyle.Primary),
      actionButton(session, PROFILE_ACTIONS.TAGS, 'Continue to tags'),
      actionButton(session, PROFILE_ACTIONS.IDENTITY, 'Back to about'),
      actionButton(session, PROFILE_ACTIONS.CANCEL, 'Cancel', ButtonStyle.Danger),
    ));
  return wizardPayload(container);
}

export function profileReviewPayload(session) {
  const profile = session.profile;
  const contact = [
    profile.email && `Email: ${profile.email}`,
    profile.linkedin_url && `LinkedIn: ${profile.linkedin_url}`,
    profile.research_profile_url && `Research profile: ${profile.research_profile_url}`,
  ].filter(Boolean).join('\n') || 'No public contact details added. Discord is the default contact path.';
  const container = new ContainerBuilder()
    .setAccentColor(BRAND)
    .addTextDisplayComponents(text([
      '## Review your profile',
      '',
      `**Headline**\n${optional(profile.headline)}`,
      `**About**\n${optional(profile.about)}`,
      `**Currently**\n${optional(profile.current_role)}${profile.current_organization ? ` · ${profile.current_organization}` : ''}${profile.location ? ` · ${profile.location}` : ''}`,
      `**Aiming for**\n${optional(profile.goals)}`,
      `**Tags**\n${tagLabels(profile.selected_tags) || 'Not selected'}`,
      `**Contact**\n${contact}`,
    ].join('\n\n')))
    .addSeparatorComponents(separator())
    .addTextDisplayComponents(text('Publishing makes this profile visible to every approved BAINSA member.'))
    .addActionRowComponents(new ActionRowBuilder<ButtonBuilder>().addComponents(
      actionButton(session, PROFILE_ACTIONS.PUBLISH, 'Publish profile', ButtonStyle.Success),
      actionButton(session, PROFILE_ACTIONS.IDENTITY, 'Edit about'),
      actionButton(session, PROFILE_ACTIONS.CURRENT, 'Edit current'),
      actionButton(session, PROFILE_ACTIONS.TAGS, 'Edit tags'),
      actionButton(session, PROFILE_ACTIONS.CONTACT, 'Edit contact'),
    ))
    .addActionRowComponents(new ActionRowBuilder<ButtonBuilder>().addComponents(
      actionButton(session, PROFILE_ACTIONS.CANCEL, 'Cancel', ButtonStyle.Danger),
    ));
  return wizardPayload(container);
}

export function profileCancelledPayload() {
  return terminalProfilePayload('Profile editing cancelled. Nothing was changed.');
}

export function profilePublishedPayload({ pending = false, forumThreadId = null } = {}) {
  const link = forumThreadId ? ` Your directory post is available at <#${forumThreadId}>.` : '';
  const content = pending
    ? 'Your profile was saved. Discord synchronization will retry automatically.'
    : `Your profile is published.${link}`;
  return terminalProfilePayload(content);
}

export function profileUnpublishConfirmationPayload(session) {
  const container = new ContainerBuilder()
    .setAccentColor(BRAND)
    .addTextDisplayComponents(text('## Unpublish your profile\n\nThis hides your profile from the directory and queues its forum post for deletion. You can republish it later.'))
    .addActionRowComponents(new ActionRowBuilder<ButtonBuilder>().addComponents(
      actionButton(session, PROFILE_ACTIONS.UNPUBLISH_CONFIRM, 'Unpublish profile', ButtonStyle.Danger),
      actionButton(session, PROFILE_ACTIONS.CANCEL, 'Cancel'),
    ));
  return wizardPayload(container);
}

export function profileUnpublishedPayload({ alreadyHidden = false } = {}) {
  return terminalProfilePayload(
    alreadyHidden
      ? 'Your profile is already unpublished.'
      : 'Your profile is unpublished. Discord cleanup will retry automatically if needed.',
  );
}

export function profileMutationFailedPayload(session, { action, message }) {
  const container = new ContainerBuilder()
    .setAccentColor(BRAND)
    .addTextDisplayComponents(text(`## Profile update failed\n\n${message}`))
    .addActionRowComponents(new ActionRowBuilder<ButtonBuilder>().addComponents(
      actionButton(session, action, 'Try again', ButtonStyle.Primary),
      actionButton(session, PROFILE_ACTIONS.CANCEL, 'Cancel'),
    ));
  return wizardPayload(container);
}

function terminalProfilePayload(content: string) {
  const container = new ContainerBuilder()
    .setAccentColor(BRAND)
    .addTextDisplayComponents(text(content));
  return wizardPayload(container);
}
