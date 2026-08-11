import {
  ActionRowBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';

import { DISCORD_LIMITS } from './limits.js';
import { truncateText } from './text.js';
import type { InteractionModalFieldSpec, InteractionModalSpec } from './types.js';

function modalField(field: InteractionModalFieldSpec) {
  const maxLength = Math.min(
    field.maxLength ?? DISCORD_LIMITS.modalFieldValue,
    DISCORD_LIMITS.modalFieldValue,
  );
  const input = new TextInputBuilder()
    .setCustomId(truncateText(field.id, DISCORD_LIMITS.customId))
    .setLabel(truncateText(field.label, DISCORD_LIMITS.modalFieldLabel))
    .setStyle(field.style === 'paragraph' ? TextInputStyle.Paragraph : TextInputStyle.Short)
    .setRequired(field.required ?? true)
    .setMaxLength(maxLength);

  if (field.minLength != null) input.setMinLength(Math.max(0, field.minLength));
  if (field.placeholder) {
    input.setPlaceholder(truncateText(field.placeholder, DISCORD_LIMITS.modalFieldPlaceholder));
  }
  if (field.value != null && field.value !== '') {
    input.setValue(truncateText(field.value, maxLength));
  }
  return input;
}

export function renderInteractionModal(spec: InteractionModalSpec): ModalBuilder {
  if (spec.fields.length === 0) throw new Error('An interaction modal requires at least one field.');
  if (spec.fields.length > DISCORD_LIMITS.modalFields) {
    throw new Error(`An interaction modal supports at most ${DISCORD_LIMITS.modalFields} fields.`);
  }

  return new ModalBuilder()
    .setCustomId(truncateText(spec.id, DISCORD_LIMITS.customId))
    .setTitle(truncateText(spec.title, DISCORD_LIMITS.modalTitle))
    .addComponents(
      ...spec.fields.map((field) =>
        new ActionRowBuilder<TextInputBuilder>().addComponents(modalField(field)),
      ),
    );
}
