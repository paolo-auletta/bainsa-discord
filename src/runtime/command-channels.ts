import { assertUser } from '../errors.js';

const BOT_LOG_CHANNEL_NAME = 'bot-log';
const GLOBAL_LOG_CATEGORY_NAME = 'LOGS';
const UNIVERSITY_CATEGORY_PREFIX = 'BAINSA ';

export function botCommandChannelScope(channel) {
  if (!channel || channel.name !== BOT_LOG_CHANNEL_NAME) return null;

  const parentName = channel.parent?.name ?? channel.parent?.parent?.name ?? null;
  if (parentName === GLOBAL_LOG_CATEGORY_NAME) return { kind: 'global' };
  if (!parentName?.startsWith(UNIVERSITY_CATEGORY_PREFIX)) return null;

  const universityName = parentName.slice(UNIVERSITY_CATEGORY_PREFIX.length).trim();
  return universityName ? { kind: 'university', universityName } : null;
}

export function isBotCommandChannel(channel) {
  return Boolean(botCommandChannelScope(channel));
}

export function assertBotCommandChannel(interaction) {
  assertUser(
    isBotCommandChannel(interaction.channel),
    'Bot commands can only be used in a university #bot-log channel or the global #bot-log under LOGS.',
  );
}
