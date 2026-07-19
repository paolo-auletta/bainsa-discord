import { ChannelType } from 'discord.js';

const EMOJI_PREFIX = /^[^\p{Letter}\p{Number}#]+/u;

export function normalizeComparableName(name) {
  return String(name ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(EMOJI_PREFIX, '')
    .replace(/[#|_]+/g, ' ')
    .replace(/[-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

export function findByNameOrAlias(collection, targetName, aliases = [], predicate = () => true) {
  const names = [targetName, ...aliases].map(normalizeComparableName);
  const exactTarget = collection.find(
    (item) => normalizeComparableName(item.name) === names[0] && predicate(item),
  );
  if (exactTarget) return { resource: exactTarget, matchedName: targetName, legacy: false };

  for (const alias of names.slice(1)) {
    const resource = collection.find(
      (item) => normalizeComparableName(item.name) === alias && predicate(item),
    );
    if (resource) return { resource, matchedName: resource.name, legacy: true };
  }

  return { resource: null, matchedName: null, legacy: false };
}

export function findEmojiPrefixedDivisionChannel(collection, divisionName, suffixWords, type) {
  const division = normalizeComparableName(divisionName);
  return collection.find((channel) => {
    if (channel.type !== type) return false;
    const comparable = normalizeComparableName(channel.name);
    return suffixWords.some((suffix) => comparable === `${division} ${suffix}`);
  });
}

export function ignoredLegacyWarnings(guild) {
  const warnings = [];
  const crossUniversity = guild.channels.cache.find(
    (channel) =>
      channel.type === ChannelType.GuildCategory &&
      normalizeComparableName(channel.name) === 'cross university projects',
  );
  if (crossUniversity) {
    warnings.push({
      type: 'ignored_legacy_category',
      name: crossUniversity.name,
      id: crossUniversity.id,
      reason: 'Cross-university projects are intentionally absent from the v1 provision plan.',
    });
  }
  return warnings;
}
