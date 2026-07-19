import { defaultDivisionColorKey, divisionColorDetails } from './constants.mjs';

const MAX_CHANNEL_NAME_LENGTH = 100;

export function normalizeDisplayName(value, field = 'name') {
  const normalized = value?.trim().replace(/\s+/g, ' ');
  if (!normalized) throw new Error(`${field} is required.`);
  if (normalized.length > 80) throw new Error(`${field} must be at most 80 characters.`);
  return normalized;
}

export function slugify(value) {
  const slug = normalizeDisplayName(value)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, MAX_CHANNEL_NAME_LENGTH);
  return slug || 'untitled';
}

export function universityCategoryName(universityName) {
  return `BAINSA ${normalizeDisplayName(universityName).toUpperCase()}`;
}

export function divisionRoleName(universityName, divisionName) {
  return `${normalizeDisplayName(universityName)} - ${normalizeDisplayName(divisionName)}`;
}

export function divisionHeadRoleName(universityName, divisionName) {
  return `${normalizeDisplayName(universityName)} - Head of ${normalizeDisplayName(divisionName)}`;
}

export function universityBoardRoleName(universityName, title) {
  return `${normalizeDisplayName(universityName)} - ${normalizeDisplayName(title)}`;
}

function divisionChannelIcon(divisionName, color) {
  const details = divisionColorDetails(color) ?? divisionColorDetails(defaultDivisionColorKey(divisionName));
  return details.icon;
}

export function divisionTextChannelName(divisionName, color) {
  return `${divisionChannelIcon(divisionName, color)}-${slugify(divisionName)}`.slice(0, MAX_CHANNEL_NAME_LENGTH);
}

export function divisionVoiceChannelName(divisionName, color) {
  return `${divisionTextChannelName(divisionName, color)}-room`.slice(0, MAX_CHANNEL_NAME_LENGTH);
}

export function projectChannelName(projectId, projectName) {
  return `project-${projectId}-${slugify(projectName)}`.slice(0, MAX_CHANNEL_NAME_LENGTH);
}
