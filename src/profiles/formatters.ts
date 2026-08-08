import {
  appliedProfileTagKeys,
  appliedProfileTags,
  assertPublishableProfile,
  normalizeProfileText,
  type ProfileInput,
  type ProfileTagKey,
} from './state.js';

const DISCORD_MESSAGE_LIMIT = 2_000;
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

export interface ProfileContactEmbed {
  title: string;
  fields: Array<{ name: string; value: string; inline: boolean }>;
}

export interface FormattedProfilePost {
  threadName: string;
  content: string;
  contactEmbed: ProfileContactEmbed | null;
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

function timestamp(value: ProfilePostInput['updated_at']): string {
  const date = value == null ? new Date() : new Date(value);
  if (Number.isNaN(date.getTime())) return 'Recently';
  return `<t:${Math.floor(date.getTime() / 1_000)}:F>`;
}

function contactEmbed(profile: ReturnType<typeof assertPublishableProfile>): ProfileContactEmbed | null {
  const fields: ProfileContactEmbed['fields'] = [];
  if (profile.email) fields.push({ name: 'Email', value: escapeProfileMarkdown(profile.email), inline: false });
  if (profile.linkedin_url) fields.push({ name: 'LinkedIn', value: profile.linkedin_url, inline: false });
  if (profile.research_profile_url) {
    fields.push({ name: 'Research profile', value: profile.research_profile_url, inline: false });
  }
  return fields.length ? { title: 'Contact', fields } : null;
}

export function profileThreadName(fullName: unknown, currentRole: unknown): string {
  return truncate(`${normalizeProfileText(fullName)} — ${normalizeProfileText(currentRole)}`, DISCORD_THREAD_NAME_LIMIT);
}

export function formatProfilePost(input: ProfilePostInput): FormattedProfilePost {
  const profile = assertPublishableProfile(input, input.member.member_type);
  const tags = appliedProfileTags(input.member.member_type, profile.selected_tags);
  const appliedTagKeys = appliedProfileTagKeys(input.member.member_type, profile.selected_tags);
  const member = input.member;
  const memberName = truncate(escapeProfileMarkdown(member.full_name) || 'BAINSA member', 160);
  const university = truncate(escapeProfileMarkdown(member.university_name) || 'BAINSA', 160);
  const division = member.division_name ? truncate(escapeProfileMarkdown(member.division_name), 160) : null;
  const identity = tags[0]!.label;
  const selectableLabels = tags.slice(1).map((tag) => tag.label).join(', ');
  const lines = [
    `**Name:** ${memberName}`,
    `**Headline:** ${escapeProfileMarkdown(profile.headline)}`,
    `**BAINSA status:** ${identity}`,
    `**BAINSA university${division ? ' / division' : ''}:** ${university}${division ? ` / ${division}` : ''}`,
    `**About:** ${escapeProfileMarkdown(profile.about)}`,
    `**Currently:** ${escapeProfileMarkdown(profile.current_role)}${profile.current_organization ? ` at ${escapeProfileMarkdown(profile.current_organization)}` : ''}${profile.location ? ` · ${escapeProfileMarkdown(profile.location)}` : ''}`,
    `**Aiming for:** ${escapeProfileMarkdown(profile.goals)}`,
    `**Tags:** ${selectableLabels}`,
    `**Discord:** <@${member.discord_user_id}>`,
    `**Last updated:** ${timestamp(input.updated_at)}`,
  ];

  // Valid authored fields fit well below Discord's limit. This final guard also
  // protects the post if a legacy membership name or university is unexpectedly long.
  const content = truncate(lines.join('\n'), DISCORD_MESSAGE_LIMIT);
  return {
    threadName: profileThreadName(member.full_name, profile.current_role),
    content,
    contactEmbed: contactEmbed(profile),
    appliedTagKeys,
    appliedTagLabels: tags.map((tag) => tag.label),
    allowedMentions: { parse: [...SAFE_ALLOWED_MENTIONS.parse] },
  };
}
