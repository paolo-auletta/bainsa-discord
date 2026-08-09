import {
  appliedProfileTagKeys,
  appliedProfileTags,
  assertPublishableProfile,
  normalizeOptionalProfileText,
  normalizeProfileText,
  profileTag,
  type ProfileInput,
  type ProfileTagKey,
} from './state.js';

const DISCORD_TEXT_DISPLAY_LIMIT = 4_000;
const DISCORD_THREAD_NAME_LIMIT = 100;
const SAFE_ALLOWED_MENTIONS = Object.freeze({ parse: [] as string[] });

export interface ProfileDirectoryMember {
  discord_user_id: string;
  full_name: string;
  member_type: string;
  university_name: string;
  division_name?: string | null;
}

export interface ProfilePostInput extends ProfileInput {
  member: ProfileDirectoryMember;
  updated_at?: Date | string | number | null;
}

export interface FormattedProfilePost {
  threadName: string;
  content: string;
  appliedTagKeys: ProfileTagKey[];
  appliedTagLabels: string[];
  allowedMentions: { parse: string[] };
}

export function escapeProfileMarkdown(value: unknown): string {
  const normalized = normalizeProfileText(value);
  return normalized
    .replace(/([\\`*_{}\[\]()<>|~])/g, '\\$1')
    .replace(/^([>#\-+])/u, '\\$1');
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  if (maxLength <= 1) return '…'.slice(0, maxLength);
  return `${value.slice(0, maxLength - 1).trimEnd()}…`;
}

function optionalSummaryValue(value: unknown): string {
  const normalized = normalizeOptionalProfileText(value);
  return normalized ? escapeProfileMarkdown(normalized) : 'Not added';
}

function summaryTagLabels(values: unknown): string {
  if (!Array.isArray(values) || values.length === 0) return 'Not selected';
  return values
    .map((value) => profileTag(value)?.label ?? normalizeProfileText(value))
    .map(escapeProfileMarkdown)
    .join(', ');
}

export function formatProfileSummary(
  profile: ProfileInput,
  { discordUserId = null }: { discordUserId?: unknown } = {},
): string {
  const discord = normalizeProfileText(discordUserId);
  return [
    '## Your BAINSA people database profile',
    '',
    '🪪 **Where you are now**',
    `**Headline** · ${optionalSummaryValue(profile.headline)}`,
    `**What are you doing now?** · ${optionalSummaryValue(profile.current_role)}`,
    `**Organisation** · ${optionalSummaryValue(profile.current_organization)}`,
    `**Location** · ${optionalSummaryValue(profile.location)}`,
    '',
    '🧭 **What you want to explore**',
    `**What would you like to explore next?** · ${optionalSummaryValue(profile.goals)}`,
    `**You and your interests** · ${optionalSummaryValue(profile.about)}`,
    '',
    '💬 **How members can reach you**',
    ...(discord ? [`**Discord** · <@${discord}>`] : []),
    `**Email** · ${optionalSummaryValue(profile.email)}`,
    `**LinkedIn** · ${optionalSummaryValue(profile.linkedin_url)}`,
    `**Research profile** · ${optionalSummaryValue(profile.research_profile_url)}`,
    '',
    `**Tags** · ${summaryTagLabels(profile.selected_tags)}`,
  ].join('\n');
}

export function profileThreadName(fullName: unknown, currentRole: unknown): string {
  return truncate(`${normalizeProfileText(fullName)} — ${normalizeProfileText(currentRole)}`, DISCORD_THREAD_NAME_LIMIT);
}

export function formatProfilePost(input: ProfilePostInput): FormattedProfilePost {
  const profile = assertPublishableProfile(input, input.member.member_type);
  const tags = appliedProfileTags(input.member.university_name, profile.selected_tags);
  const appliedTagKeys = appliedProfileTagKeys(input.member.university_name, profile.selected_tags);
  const member = input.member;
  const content = truncate(
    formatProfileSummary(profile, { discordUserId: member.discord_user_id }),
    DISCORD_TEXT_DISPLAY_LIMIT,
  );
  return {
    threadName: profileThreadName(member.full_name, profile.headline),
    content,
    appliedTagKeys,
    appliedTagLabels: tags.map((tag) => tag.label),
    allowedMentions: { parse: [...SAFE_ALLOWED_MENTIONS.parse] },
  };
}
