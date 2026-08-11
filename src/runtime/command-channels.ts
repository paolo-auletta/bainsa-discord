import { assertUser } from '../errors.js';
import { commandScopePolicy } from './command-scope.js';

const BOT_LOG_CHANNEL_NAME = 'bot-log';
const GLOBAL_LOG_CATEGORY_NAME = 'LOGS';
const UNIVERSITY_CATEGORY_PREFIX = 'BAINSA ';
const PROJECT_TOPIC_PATTERN = /(?:^|\s)project\s+(\d+)$/i;

export type BotCommandChannelScope =
  | { kind: 'global' }
  | { kind: 'university'; universityName: string };
export type ProjectCommandChannelScope = { kind: 'project'; projectId: string };

export const PROJECT_CHANNEL_COMMANDS = Object.freeze(new Set([
  'project-update',
  'project-close',
  'project-info',
]));

export function botCommandChannelScope(channel): BotCommandChannelScope | null {
  if (!channel || channel.name !== BOT_LOG_CHANNEL_NAME) return null;

  const parentName = channel.parent?.name ?? channel.parent?.parent?.name ?? null;
  if (parentName === GLOBAL_LOG_CATEGORY_NAME) return { kind: 'global' };
  if (!parentName?.startsWith(UNIVERSITY_CATEGORY_PREFIX)) return null;

  const universityName = parentName.slice(UNIVERSITY_CATEGORY_PREFIX.length).trim();
  return universityName ? { kind: 'university', universityName } : null;
}

export function projectCommandChannelScope(channel): ProjectCommandChannelScope | null {
  const match = String(channel?.topic ?? '').trim().match(PROJECT_TOPIC_PATTERN);
  if (!match) return null;
  return { kind: 'project', projectId: match[1] };
}

export function commandChannelScope(channel): BotCommandChannelScope | ProjectCommandChannelScope | null {
  return botCommandChannelScope(channel) ?? projectCommandChannelScope(channel);
}

export function isBotCommandChannel(channel) {
  return Boolean(botCommandChannelScope(channel));
}

export function assertCommandChannel(interaction, commandName) {
  const scope = commandChannelScope(interaction.channel);
  const policy = commandScopePolicy(commandName);
  if (scope && policy?.channels.includes(scope.kind)) return scope;
  assertUser(
    false,
    PROJECT_CHANNEL_COMMANDS.has(commandName)
      ? 'Use this command in its project channel, a university #bot-log, or the global #bot-log under LOGS.'
      : 'Use this command in a university #bot-log or the global #bot-log under LOGS.',
  );
}

export function assertBotCommandChannel(interaction) {
  assertUser(
    isBotCommandChannel(interaction.channel),
    'Bot commands can only be used in a university #bot-log channel or the global #bot-log under LOGS.',
  );
}
