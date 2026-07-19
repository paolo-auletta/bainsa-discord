import { assertUser } from '../errors.mjs';

const BOT_LOG_CHANNEL_NAME = 'bot-log';
const GLOBAL_LOG_CATEGORY_NAME = 'LOGS';
const UNIVERSITY_CATEGORY_PREFIX = 'BAINSA ';

export function isBotCommandChannel(channel) {
  if (!channel || channel.name !== BOT_LOG_CHANNEL_NAME) return false;
  const parentName = channel.parent?.name ?? channel.parent?.parent?.name ?? null;
  return Boolean(
    parentName === GLOBAL_LOG_CATEGORY_NAME || parentName?.startsWith(UNIVERSITY_CATEGORY_PREFIX),
  );
}

export function assertBotCommandChannel(interaction) {
  assertUser(
    isBotCommandChannel(interaction.channel),
    'Bot commands can only be used in a university #bot-log channel or the global #bot-log under LOGS.',
  );
}
