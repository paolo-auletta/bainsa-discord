import { randomUUID } from 'node:crypto';

import { assertUser } from '../errors.js';

export interface FlowSessionBase {
  id: string;
  actorId: string;
  guildId: string;
  expiresAt: number;
  busy: boolean;
}

export function createFlowSessionStore<T extends FlowSessionBase>({
  ttlMs = 15 * 60 * 1_000,
  now = () => Date.now(),
  expiredMessage = 'This setup has expired. Run the command again.',
} = {}) {
  const sessions = new Map<string, T>();
  const actorSessions = new Map<string, string>();

  function actorKey(guildId: unknown, actorId: unknown) {
    return `${String(guildId)}:${String(actorId)}`;
  }

  function remove(session: T) {
    sessions.delete(session.id);
    const key = actorKey(session.guildId, session.actorId);
    if (actorSessions.get(key) === session.id) actorSessions.delete(key);
  }

  function sweep() {
    const currentTime = now();
    for (const session of sessions.values()) {
      if (session.expiresAt <= currentTime) remove(session);
    }
  }

  function start(
    interaction: { guildId?: unknown; user?: { id?: unknown } },
    build: (base: FlowSessionBase) => T,
  ) {
    sweep();
    const guildId = String(interaction.guildId ?? '');
    const actorId = String(interaction.user?.id ?? '');
    assertUser(Boolean(guildId && actorId), 'Could not start this private setup.');

    const key = actorKey(guildId, actorId);
    const previousId = actorSessions.get(key);
    const previous = previousId ? sessions.get(previousId) : null;
    if (previous) remove(previous);

    const base: FlowSessionBase = {
      id: randomUUID(),
      actorId,
      guildId,
      expiresAt: now() + ttlMs,
      busy: false,
    };
    const session = build(base);
    sessions.set(session.id, session);
    actorSessions.set(key, session.id);
    return session;
  }

  function require(
    interaction: { guildId?: unknown; user?: { id?: unknown } },
    sessionId: string,
  ) {
    sweep();
    const session = sessions.get(sessionId);
    assertUser(session, expiredMessage);
    assertUser(
      session.actorId === String(interaction.user?.id ?? ''),
      'Only the person who started this setup can use it.',
    );
    assertUser(
      session.guildId === String(interaction.guildId ?? ''),
      'This setup belongs to another server.',
    );
    assertUser(!session.busy, 'This change is already being saved.');
    session.expiresAt = now() + ttlMs;
    return session;
  }

  return {
    start,
    require,
    remove,
    has: (sessionId: string) => sessions.has(sessionId),
  };
}
