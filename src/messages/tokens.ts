import { ButtonStyle } from 'discord.js';
import type { MessageMentionOptions } from 'discord.js';

import type { InteractionActionStyle, MessageTone } from './types.js';

export const MESSAGE_COLORS: Readonly<Record<MessageTone, number>> = Object.freeze({
  brand: 0x5865f2,
  success: 0x27ae60,
  pending: 0xf0b429,
  warning: 0xf0b429,
  changed: 0xf2994a,
  danger: 0xd7263d,
  neutral: 0x7a7a7a,
});

export const EVENT_MARKERS: Readonly<Record<MessageTone, string>> = Object.freeze({
  brand: '🔵',
  success: '🟢',
  pending: '🟡',
  warning: '🟡',
  changed: '🟠',
  danger: '🔴',
  neutral: '⚪',
});

export const ACTION_STYLES: Readonly<Record<InteractionActionStyle, ButtonStyle>> = Object.freeze({
  primary: ButtonStyle.Primary,
  secondary: ButtonStyle.Secondary,
  success: ButtonStyle.Success,
  danger: ButtonStyle.Danger,
  link: ButtonStyle.Link,
});

export const EMPTY_VALUES = Object.freeze({
  notProvided: 'Not provided',
  notSelected: 'Not selected yet',
  notRecorded: 'Not recorded',
  noChanges: 'No visible changes',
});

export const MESSAGE_LABELS = Object.freeze({
  scope: 'Scope',
  result: 'Result',
  discordState: 'Discord state',
  actor: 'Performed by',
});

export const SAFE_ALLOWED_MENTIONS = Object.freeze({ parse: [] }) satisfies MessageMentionOptions;
