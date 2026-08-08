import { MEMBER_TYPES } from '../constants.js';
import { UserFacingError } from '../errors.js';

export const PROFILE_LIMITS = Object.freeze({
  headline: Object.freeze({ min: 10, max: 80 }),
  about: Object.freeze({ min: 20, max: 300 }),
  current_role: Object.freeze({ min: 2, max: 80 }),
  goals: Object.freeze({ min: 10, max: 250 }),
  current_organization: Object.freeze({ min: 2, max: 100 }),
  location: Object.freeze({ min: 2, max: 60 }),
  email: Object.freeze({ max: 254 }),
  linkedin_url: Object.freeze({ max: 500 }),
  research_profile_url: Object.freeze({ max: 500 }),
  selected_tags: Object.freeze({ min: 1, max: 4 }),
});

export const PROFILE_TAG_CATEGORIES = Object.freeze({
  IDENTITY: 'identity',
  FIELD: 'field',
  ENVIRONMENT: 'environment',
});

export const PROFILE_TAGS = Object.freeze([
  Object.freeze({ key: 'researcher', label: 'Researcher', category: PROFILE_TAG_CATEGORIES.IDENTITY, description: 'Current BAINSA researcher.', selectable: false }),
  Object.freeze({ key: 'alumni', label: 'Alumni', category: PROFILE_TAG_CATEGORIES.IDENTITY, description: 'BAINSA alumnus or alumna.', selectable: false }),
  Object.freeze({ key: 'ai_data', label: 'AI & Data', category: PROFILE_TAG_CATEGORIES.FIELD, description: 'Artificial intelligence, machine learning, and data.', selectable: true }),
  Object.freeze({ key: 'econ_finance', label: 'Econ & Finance', category: PROFILE_TAG_CATEGORIES.FIELD, description: 'Economics, markets, and finance.', selectable: true }),
  Object.freeze({ key: 'neuroscience', label: 'Neuroscience', category: PROFILE_TAG_CATEGORIES.FIELD, description: 'Neuroscience and cognition.', selectable: true }),
  Object.freeze({ key: 'biology', label: 'Biology', category: PROFILE_TAG_CATEGORIES.FIELD, description: 'Biology and biological systems.', selectable: true }),
  Object.freeze({ key: 'eng_robotics', label: 'Eng & Robotics', category: PROFILE_TAG_CATEGORIES.FIELD, description: 'Engineering, robotics, and hardware.', selectable: true }),
  Object.freeze({ key: 'life_health', label: 'Life & Health Sci', category: PROFILE_TAG_CATEGORIES.FIELD, description: 'Life sciences and health.', selectable: true }),
  Object.freeze({ key: 'social_sciences', label: 'Social Sciences', category: PROFILE_TAG_CATEGORIES.FIELD, description: 'Social and behavioural sciences.', selectable: true }),
  Object.freeze({ key: 'math_physics', label: 'Math & Physics', category: PROFILE_TAG_CATEGORIES.FIELD, description: 'Mathematics and physics.', selectable: true }),
  Object.freeze({ key: 'humanities_design', label: 'Humanities & Design', category: PROFILE_TAG_CATEGORIES.FIELD, description: 'Humanities, arts, and design.', selectable: true }),
  Object.freeze({ key: 'academia', label: 'Academia', category: PROFILE_TAG_CATEGORIES.ENVIRONMENT, description: 'Academic research and study.', selectable: true }),
  Object.freeze({ key: 'industry', label: 'Industry', category: PROFILE_TAG_CATEGORIES.ENVIRONMENT, description: 'Industry and professional work.', selectable: true }),
  Object.freeze({ key: 'entrepreneurship', label: 'Entrepreneurship', category: PROFILE_TAG_CATEGORIES.ENVIRONMENT, description: 'Startups and entrepreneurship.', selectable: true }),
]);

export type ProfileTag = (typeof PROFILE_TAGS)[number];
export type ProfileTagKey = ProfileTag['key'];
export type ProfileMemberType = (typeof MEMBER_TYPES)[keyof typeof MEMBER_TYPES];

export interface ProfileInput {
  headline?: unknown;
  about?: unknown;
  current_role?: unknown;
  goals?: unknown;
  selected_tags?: unknown;
  current_organization?: unknown;
  location?: unknown;
  email?: unknown;
  linkedin_url?: unknown;
  research_profile_url?: unknown;
}

export interface NormalizedProfile {
  headline: string;
  about: string;
  current_role: string;
  goals: string;
  selected_tags: ProfileTagKey[];
  current_organization: string | null;
  location: string | null;
  email: string | null;
  linkedin_url: string | null;
  research_profile_url: string | null;
}

const profileTagsByKey = new Map<string, ProfileTag>(PROFILE_TAGS.map((tag) => [tag.key, tag]));
const identityTagKeys = new Set<ProfileTagKey>(['researcher', 'alumni']);
const selectableTagKeys = new Set<ProfileTagKey>(
  PROFILE_TAGS.filter((tag) => tag.selectable).map((tag) => tag.key),
);
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function validationError(message: string): never {
  throw new UserFacingError(message);
}

function asText(value: unknown): string {
  return String(value ?? '').trim().replace(/\s+/g, ' ');
}

function normalizeRequiredText(value: unknown, field: keyof typeof PROFILE_LIMITS): string {
  const normalized = asText(value);
  const limits = PROFILE_LIMITS[field] as { min: number; max: number };
  if (normalized.length < limits.min || normalized.length > limits.max) {
    validationError(`${field} must be between ${limits.min} and ${limits.max} characters.`);
  }
  return normalized;
}

function normalizeOptionalText(value: unknown, field: 'current_organization' | 'location'): string | null {
  const normalized = asText(value);
  if (!normalized) return null;
  const limits = PROFILE_LIMITS[field];
  if (normalized.length < limits.min || normalized.length > limits.max) {
    validationError(`${field} must be blank or between ${limits.min} and ${limits.max} characters.`);
  }
  return normalized;
}

function normalizeOptionalValue(value: unknown, field: 'email' | 'linkedin_url' | 'research_profile_url'): string | null {
  const normalized = String(value ?? '').trim();
  if (!normalized) return null;
  if (normalized.length > PROFILE_LIMITS[field].max) {
    validationError(`${field} must be at most ${PROFILE_LIMITS[field].max} characters.`);
  }
  return normalized;
}

export function normalizeProfileText(value: unknown): string {
  return asText(value);
}

export function normalizeOptionalProfileText(value: unknown): string | null {
  const normalized = asText(value);
  return normalized || null;
}

export function profileTag(key: unknown): ProfileTag | null {
  return profileTagsByKey.get(String(key ?? '').trim().toLowerCase()) ?? null;
}

export function selectableProfileTags(): ProfileTag[] {
  return PROFILE_TAGS.filter((tag) => tag.selectable);
}

export function validateProfileTagTaxonomy(): void {
  if (PROFILE_TAGS.length !== 14 || PROFILE_TAGS.length > 20) {
    throw new Error('Profile taxonomy must contain exactly 14 tags and stay within Discord’s 20-tag limit.');
  }
  const keys = new Set<string>();
  const labels = new Set<string>();
  for (const tag of PROFILE_TAGS) {
    if (!tag.key || keys.has(tag.key) || !tag.label || labels.has(tag.label) || tag.label.length > 20) {
      throw new Error('Profile taxonomy keys and labels must be unique; labels may be at most 20 characters.');
    }
    keys.add(tag.key);
    labels.add(tag.label);
  }
  if (identityTagKeys.size !== 2 || selectableTagKeys.size !== 12) {
    throw new Error('Profile taxonomy must have two derived identity tags and twelve selectable tags.');
  }
}

export function normalizeSelectedProfileTags(values: unknown): ProfileTagKey[] {
  if (!Array.isArray(values)) validationError('selected_tags must be a list of tags.');
  const normalized = values.map((value) => String(value ?? '').trim().toLowerCase());
  if (normalized.some((key) => !key)) validationError('selected_tags cannot contain blank tags.');
  if (new Set(normalized).size !== normalized.length) validationError('selected_tags cannot contain duplicate tags.');
  if (normalized.length < PROFILE_LIMITS.selected_tags.min || normalized.length > PROFILE_LIMITS.selected_tags.max) {
    validationError('selected_tags must contain between 1 and 4 tags.');
  }

  return normalized.map((key) => {
    const tag = profileTag(key);
    if (!tag) validationError(`selected_tags contains an unknown tag.`);
    if (!selectableTagKeys.has(tag.key)) validationError('selected_tags cannot contain derived identity tags.');
    return tag.key;
  });
}

export function derivedProfileTag(memberType: unknown): ProfileTagKey {
  const normalized = String(memberType ?? '').trim().toLowerCase();
  if (normalized === MEMBER_TYPES.RESEARCHER) return 'researcher';
  if (normalized === MEMBER_TYPES.ALUMNI) return 'alumni';
  validationError('A profile can only be published by a Researcher or Alumni member.');
}

export function appliedProfileTagKeys(memberType: unknown, selectedTags: unknown): ProfileTagKey[] {
  const selected = normalizeSelectedProfileTags(selectedTags);
  const applied = [derivedProfileTag(memberType), ...selected];
  if (applied.length > 5) validationError('A directory post cannot have more than five tags.');
  return applied;
}

export function appliedProfileTags(memberType: unknown, selectedTags: unknown): ProfileTag[] {
  return appliedProfileTagKeys(memberType, selectedTags).map((key) => profileTag(key)!);
}

export function normalizeProfileEmail(value: unknown): string | null {
  const normalized = normalizeOptionalValue(value, 'email')?.toLowerCase() ?? null;
  if (normalized && (!EMAIL_PATTERN.test(normalized) || normalized.startsWith('@') || normalized.endsWith('@'))) {
    validationError('email must be a valid email address.');
  }
  return normalized;
}

export function normalizeProfileUrl(
  value: unknown,
  options: { requireHttps?: boolean; hostname?: string } = {},
): string | null {
  const normalized = String(value ?? '').trim();
  if (!normalized) return null;
  if (normalized.length > 500) validationError('Profile URLs must be at most 500 characters.');

  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    validationError('Profile URLs must be valid HTTP(S) URLs.');
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    validationError('Profile URLs must use HTTP or HTTPS.');
  }
  if (options.requireHttps && parsed.protocol !== 'https:') {
    validationError('This profile URL must use HTTPS.');
  }
  if (parsed.username || parsed.password) validationError('Profile URLs cannot contain credentials.');

  if (options.hostname) {
    const expected = options.hostname.toLowerCase();
    const hostname = parsed.hostname.toLowerCase().replace(/\.$/, '');
    if (hostname !== expected && !hostname.endsWith(`.${expected}`)) {
      validationError('LinkedIn URLs must use linkedin.com or one of its subdomains.');
    }
  }
  return parsed.toString();
}

export function normalizeLinkedinUrl(value: unknown): string | null {
  return normalizeProfileUrl(value, { requireHttps: true, hostname: 'linkedin.com' });
}

export function normalizeResearchProfileUrl(value: unknown): string | null {
  return normalizeProfileUrl(value);
}

export function normalizeProfile(input: ProfileInput = {}): NormalizedProfile {
  return {
    headline: normalizeRequiredText(input.headline, 'headline'),
    about: normalizeRequiredText(input.about, 'about'),
    current_role: normalizeRequiredText(input.current_role, 'current_role'),
    goals: normalizeRequiredText(input.goals, 'goals'),
    selected_tags: normalizeSelectedProfileTags(input.selected_tags),
    current_organization: normalizeOptionalText(input.current_organization, 'current_organization'),
    location: normalizeOptionalText(input.location, 'location'),
    email: normalizeProfileEmail(input.email),
    linkedin_url: normalizeLinkedinUrl(input.linkedin_url),
    research_profile_url: normalizeResearchProfileUrl(input.research_profile_url),
  };
}

export function canPublishProfile(input: ProfileInput, memberType?: unknown): boolean {
  try {
    assertPublishableProfile(input, memberType);
    return true;
  } catch {
    return false;
  }
}

export function assertPublishableProfile(input: ProfileInput, memberType?: unknown): NormalizedProfile {
  const profile = normalizeProfile(input);
  if (memberType != null) appliedProfileTagKeys(memberType, profile.selected_tags);
  return profile;
}

validateProfileTagTaxonomy();
