import type { InteractionReplyOptions } from 'discord.js';

export type MessageTone =
  | 'brand'
  | 'success'
  | 'pending'
  | 'warning'
  | 'changed'
  | 'danger'
  | 'neutral';

export type MessageAudience = 'actor' | 'board' | 'workspace' | 'university' | 'member';

export interface MessageFieldSpec {
  label: string;
  value: string;
  inline?: boolean;
}

export interface EventCardSpec {
  kind: 'event-card';
  tone: MessageTone;
  title: string;
  subject: MessageFieldSpec;
  scope?: string;
  details?: readonly MessageFieldSpec[];
  result?: MessageFieldSpec;
  discordState?: string;
  actor?: string;
  description?: string;
  footer?: string;
  audience?: MessageAudience;
}

export interface WorkspaceSectionSpec {
  heading?: string;
  body: string | readonly string[];
  spacingBefore?: boolean;
}

export interface WorkspaceDocumentSpec {
  kind: 'workspace-document';
  title: string;
  metadata?: readonly MessageFieldSpec[];
  sections?: readonly WorkspaceSectionSpec[];
  provenance: string;
  audience?: MessageAudience;
}

export type InteractionActionStyle = 'primary' | 'secondary' | 'success' | 'danger' | 'link';

export interface InteractionActionSpec {
  id?: string;
  label: string;
  style?: InteractionActionStyle;
  url?: string;
  disabled?: boolean;
  loading?: boolean;
  emoji?: string;
}

export interface StringSelectOptionSpec {
  label: string;
  value: string;
  description?: string;
  emoji?: string;
  selected?: boolean;
}

export type InteractionControlSpec =
  | {
      kind: 'button';
      id: string;
      label: string;
      groupLabel?: string;
      groupSpacingBefore?: boolean;
      fieldLabel?: string;
      description?: string;
      style?: Exclude<InteractionActionStyle, 'link'>;
      disabled?: boolean;
      emoji?: string;
    }
  | {
      kind: 'string-select';
      id: string;
      placeholder: string;
      label?: string;
      groupLabel?: string;
      groupSpacingBefore?: boolean;
      description?: string;
      options: readonly StringSelectOptionSpec[];
      min?: number;
      max?: number;
      disabled?: boolean;
    }
  | {
      kind: 'user-select';
      id: string;
      placeholder: string;
      label?: string;
      groupLabel?: string;
      groupSpacingBefore?: boolean;
      description?: string;
      selectedUserIds?: readonly string[];
      min?: number;
      max?: number;
      disabled?: boolean;
    };

export interface InteractionPanelSpec {
  kind: 'interaction-panel';
  tone: MessageTone;
  title: string;
  description?: string;
  progress?: {
    label: string;
    current: number;
    total: number;
  };
  facts?: readonly MessageFieldSpec[];
  sections?: readonly WorkspaceSectionSpec[];
  detailsDensity?: 'comfortable' | 'compact' | 'compact-groups';
  controls?: readonly InteractionControlSpec[];
  contentActionsLabel?: {
    label: string;
    description?: string;
  };
  contentActions?: readonly InteractionActionSpec[];
  actions?: readonly InteractionActionSpec[];
  status?: string;
  audience?: 'actor';
}

export type InteractionModalFieldStyle = 'short' | 'paragraph';

export interface InteractionModalFieldSpec {
  id: string;
  label: string;
  style?: InteractionModalFieldStyle;
  placeholder?: string;
  value?: string | null;
  required?: boolean;
  minLength?: number;
  maxLength?: number;
}

export interface InteractionModalSpec {
  id: string;
  title: string;
  fields: readonly InteractionModalFieldSpec[];
}

export interface HandoffLinkSpec {
  label: string;
  url: string;
}

export interface HandoffMessageSpec {
  kind: 'handoff-message';
  tone?: MessageTone;
  title: string;
  context?: string;
  sections?: readonly WorkspaceSectionSpec[];
  nextActions?: readonly string[];
  links?: readonly HandoffLinkSpec[];
  fallback?: string;
  provenance?: string;
  audience?: 'member';
}

export type BotMessageSpec =
  | EventCardSpec
  | WorkspaceDocumentSpec
  | InteractionPanelSpec
  | HandoffMessageSpec;

export type BotMessagePayload = Pick<
  InteractionReplyOptions,
  'content' | 'embeds' | 'components' | 'allowedMentions' | 'flags'
>;
