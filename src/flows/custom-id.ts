import { DISCORD_LIMITS } from '../messages/limits.js';

export function flowCustomId(prefix: string, sessionId: string, action: string) {
  const customId = [prefix, sessionId, action].join(':');
  if (customId.length > DISCORD_LIMITS.customId) {
    throw new Error(`Flow custom id is too long: ${customId.length}`);
  }
  return customId;
}

export function parseFlowCustomId(
  customId: unknown,
  prefix: string,
  actions: ReadonlySet<string>,
) {
  const [candidatePrefix, sessionId, action, ...extra] = String(customId ?? '').split(':');
  if (
    candidatePrefix !== prefix
    || !sessionId
    || !actions.has(action)
    || extra.length > 0
  ) {
    return null;
  }
  return { sessionId, action };
}
