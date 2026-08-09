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
import { formatProfileSummary } from './formatters.js';
import { selectableProfileTags } from './state.js';

const BRAND = 0x5865f2;

function text(content: string) {
  return new TextDisplayBuilder().setContent(content);
}

function separator() {
  return new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Large);
}

function actionButton(
  session,
  action: string,
  label: string,
  style = ButtonStyle.Secondary,
  { disabled = false }: { disabled?: boolean } = {},
) {
  return new ButtonBuilder()
    .setCustomId(profileSessionId(action, session.id, session.actorId))
    .setLabel(label)
    .setStyle(style)
    .setDisabled(disabled);
}

function wizardPayload(container: ContainerBuilder) {
  return {
    components: [container],
    flags: MessageFlags.Ephemeral | MessageFlags.IsComponentsV2,
    allowedMentions: { parse: [] },
  };
}

function profileSummary(session) {
  return formatProfileSummary(session.profile, { discordUserId: session.actorId });
}

function navigation(
  session,
  nextAction: string,
  nextLabel: string,
  backAction: string,
  backLabel: string,
  { nextDisabled = false }: { nextDisabled?: boolean } = {},
) {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    actionButton(session, nextAction, nextLabel, ButtonStyle.Primary, { disabled: nextDisabled }),
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

export function profileCurrentModal(session) {
  return new ModalBuilder()
    .setCustomId(profileSessionId(PROFILE_ACTIONS.CURRENT_MODAL, session.id, session.actorId))
    .setTitle('Profile · Where you are now')
    .addComponents(
      modalInput('headline', 'Your one-line headline', session.profile.headline, {
        required: true, style: TextInputStyle.Short, minLength: 10, maxLength: 80,
        placeholder: 'How should BAINSA members understand what you do?',
      }),
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
    );
}

export function profileDirectionModal(session) {
  return new ModalBuilder()
    .setCustomId(profileSessionId(PROFILE_ACTIONS.DIRECTION_MODAL, session.id, session.actorId))
    .setTitle('Profile · What you want to explore')
    .addComponents(
      modalInput('goals', 'What would you like to explore next?', session.profile.goals, {
        required: true, style: TextInputStyle.Paragraph, minLength: 10, maxLength: 250,
      }),
      modalInput('about', 'You and your interests', session.profile.about, {
        required: true, style: TextInputStyle.Paragraph, minLength: 20, maxLength: 300,
        placeholder: 'Topics, problems, or industries that interest you',
      }),
    );
}

export function profileContactModal(session) {
  return new ModalBuilder()
    .setCustomId(profileSessionId(PROFILE_ACTIONS.CONTACT_MODAL, session.id, session.actorId))
    .setTitle('Profile · How members can reach you')
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
    .addTextDisplayComponents(text('### Choose your tags\nPick one to four fields or environments that will help members find you.'))
    .addActionRowComponents(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu))
    .addSeparatorComponents(separator())
    .addActionRowComponents(navigation(
      session,
      PROFILE_ACTIONS.CONTACT,
      'Continue to contact',
      PROFILE_ACTIONS.DIRECTION,
      'Back to exploration',
      { nextDisabled: selected.size === 0 },
    ));
  return wizardPayload(container);
}

export function profileDirectionPayload(session) {
  const container = new ContainerBuilder()
    .setAccentColor(BRAND)
    .addTextDisplayComponents(text(profileSummary(session)))
    .addSeparatorComponents(separator())
    .addTextDisplayComponents(text('### What you want to explore\nShare what you would like to explore next, followed by the topics, problems, or industries that interest you.'))
    .addActionRowComponents(new ActionRowBuilder<ButtonBuilder>().addComponents(
      actionButton(session, PROFILE_ACTIONS.DIRECTION_OPEN, session.profile.goals ? 'Edit what you want to explore' : 'Add what you want to explore', ButtonStyle.Primary),
    ))
    .addSeparatorComponents(separator())
    .addActionRowComponents(navigation(
      session,
      PROFILE_ACTIONS.TAGS,
      'Continue to tags',
      PROFILE_ACTIONS.CURRENT,
      'Back to current',
      { nextDisabled: !session.profile.goals || !session.profile.about },
    ));
  return wizardPayload(container);
}

export function profileContactPayload(session) {
  const hasContact = Boolean(session.profile.email || session.profile.linkedin_url || session.profile.research_profile_url);
  const container = new ContainerBuilder()
    .setAccentColor(BRAND)
    .addTextDisplayComponents(text(profileSummary(session)))
    .addSeparatorComponents(separator())
    .addTextDisplayComponents(text('### How members can reach you\nPublic contact details are optional. Members can always reach you through Discord.'))
    .addActionRowComponents(new ActionRowBuilder<ButtonBuilder>().addComponents(
      actionButton(session, PROFILE_ACTIONS.CONTACT_OPEN, hasContact ? 'Edit contact details' : 'Add contact details', ButtonStyle.Primary),
    ))
    .addSeparatorComponents(separator())
    .addActionRowComponents(navigation(session, PROFILE_ACTIONS.REVIEW, 'Continue to review', PROFILE_ACTIONS.TAGS, 'Back to tags'));
  return wizardPayload(container);
}

export function profileReviewPayload(session) {
  const container = new ContainerBuilder()
    .setAccentColor(BRAND)
    .addTextDisplayComponents(text(profileSummary(session)))
    .addSeparatorComponents(separator())
    .addTextDisplayComponents(text('### Ready to publish?\nPublishing makes this profile visible to every approved BAINSA member.'))
    .addActionRowComponents(navigation(session, PROFILE_ACTIONS.PUBLISH, 'Publish profile', PROFILE_ACTIONS.CONTACT, 'Back to contact'));
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

export function profilePublishingPayload() {
  return terminalProfilePayload('## Publishing your profile\nPlease wait while your directory post is updated.');
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

export function profileUnpublishingPayload() {
  return terminalProfilePayload('## Unpublishing your profile\nPlease wait while your directory post is removed.');
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
