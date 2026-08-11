import { randomUUID } from 'node:crypto';

import type { InteractionEditReplyOptions, InteractionReplyOptions } from 'discord.js';

import { formatBoardActivity } from '../../activity/formatters.js';
import { postBoardActivity } from '../../discord/reply.js';
import { UserFacingError } from '../../errors.js';
import { logger } from '../../logger.js';
import {
  ephemeralReplyPayload,
  escapeUserText,
  interactionEditPayload,
  interactionOutcome,
  renderInteractionPanel,
  userReference,
} from '../../messages/index.js';
import { formatBoardRemovalHandoff } from './formatters.js';
import { boardRoleLabel } from './policy.js';
import { removeBoardRole } from './service.js';

const CONFIRMATION_PREFIX = 'board-remove:v1';
const SESSION_TTL_MS = 15 * 60 * 1_000;

type BoardRemovalInput = {
  user: { id: string };
  university: string;
  role: string;
  division: string | null;
  reason: string | null;
};

type BoardRemovalResult = {
  target: {
    id: string;
    displayName?: string;
    user?: { globalName?: string; username?: string };
    send: (payload: unknown) => Promise<unknown>;
  };
  university: { name: string };
  role: string;
  division: { name: string } | null;
};

type StartInteraction = {
  guildId?: string;
  guild?: { id?: string };
  user: { id: string };
  reply: (payload: InteractionReplyOptions) => Promise<unknown>;
};

type ConfirmationInteraction = {
  customId: string;
  guildId?: string;
  guild?: { id?: string };
  user: { id: string };
  channel?: unknown;
  commandName?: string;
  update: (payload: InteractionEditReplyOptions) => Promise<unknown>;
  editReply: (payload: InteractionEditReplyOptions) => Promise<unknown>;
};

type ConfirmationDependencies = {
  removeRole?: (
    interaction: ConfirmationInteraction,
    input: BoardRemovalInput,
  ) => Promise<BoardRemovalResult>;
  formatActivity?: (commandName: string, input: { actorId: string; result: BoardRemovalResult }) => unknown;
  postActivity?: (
    interaction: ConfirmationInteraction,
    payload: unknown,
  ) => Promise<{ status: string; channel?: unknown }>;
  now?: () => number;
  id?: () => string;
};

type ConfirmationSession = {
  id: string;
  actorId: string;
  guildId: string;
  input: BoardRemovalInput;
  expiresAt: number;
  busy: boolean;
};

function confirmationId(sessionId: string, action: 'confirm' | 'cancel') {
  return `${CONFIRMATION_PREFIX}:${sessionId}:${action}`;
}

export function parseBoardRemovalConfirmationId(customId: unknown) {
  const text = String(customId ?? '');
  const prefix = `${CONFIRMATION_PREFIX}:`;
  if (!text.startsWith(prefix)) return null;
  const [sessionId, action, ...extra] = text.slice(prefix.length).split(':');
  if (!sessionId || !['confirm', 'cancel'].includes(action) || extra.length > 0) return null;
  return { sessionId, action: action as 'confirm' | 'cancel' };
}

function actorKey(guildId: string, actorId: string) {
  return `${guildId}:${actorId}`;
}

function roleDescription(role: string, division: string | null) {
  if (role === 'head') return division ? `Head of ${escapeUserText(division)}` : 'All division Head roles';
  return boardRoleLabel(role);
}

function scopeDescription(university: string, division: string | null) {
  return division
    ? `${escapeUserText(university)} › ${escapeUserText(division)}`
    : escapeUserText(university);
}

function confirmationActions(session: ConfirmationSession, confirmLabel = 'Remove board role') {
  return [
    {
      id: confirmationId(session.id, 'confirm'),
      label: confirmLabel,
      style: 'danger' as const,
    },
    {
      id: confirmationId(session.id, 'cancel'),
      label: 'Keep role',
      style: 'secondary' as const,
    },
  ];
}

function confirmationPayload(session: ConfirmationSession) {
  return renderInteractionPanel({
    kind: 'interaction-panel',
    tone: 'warning',
    title: 'Remove board role?',
    description: 'This changes the member’s board authority immediately. Their base BAINSA membership remains unchanged.',
    facts: [
      { label: 'Member', value: userReference(session.input.user) },
      { label: 'Role', value: roleDescription(session.input.role, session.input.division) },
      { label: 'Scope', value: scopeDescription(session.input.university, session.input.division) },
    ],
    status: session.input.reason
      ? 'The private reason will be sent only to the affected member and retained in the audit record.'
      : 'No removal reason was provided.',
    actions: confirmationActions(session),
    audience: 'actor',
  });
}

export function createBoardRoleRemovalConfirmationService({
  removeRole = removeBoardRole,
  formatActivity = formatBoardActivity,
  postActivity = postBoardActivity,
  now = () => Date.now(),
  id = () => randomUUID(),
}: ConfirmationDependencies = {}) {
  const sessions = new Map<string, ConfirmationSession>();
  const actorSessions = new Map<string, string>();

  function deleteSession(session: ConfirmationSession) {
    sessions.delete(session.id);
    const key = actorKey(session.guildId, session.actorId);
    if (actorSessions.get(key) === session.id) actorSessions.delete(key);
  }

  function pruneExpired() {
    const current = now();
    for (const session of sessions.values()) {
      if (session.expiresAt <= current) deleteSession(session);
    }
  }

  function requireSession(interaction: ConfirmationInteraction, sessionId: string) {
    pruneExpired();
    const session = sessions.get(sessionId);
    if (!session) throw new UserFacingError('This confirmation expired. Run `/board-remove` again.');
    if (String(interaction.user?.id) !== session.actorId) {
      throw new UserFacingError('This private confirmation belongs to another member.');
    }
    if (String(interaction.guildId ?? interaction.guild?.id) !== session.guildId) {
      throw new UserFacingError('This confirmation belongs to another server.');
    }
    if (session.busy) throw new UserFacingError('This board role removal is already in progress.');
    return session;
  }

  async function start(interaction: StartInteraction, input: BoardRemovalInput) {
    pruneExpired();
    const guildId = String(interaction.guildId ?? interaction.guild?.id);
    const actorId = String(interaction.user.id);
    const key = actorKey(guildId, actorId);
    const previousId = actorSessions.get(key);
    const previous = previousId ? sessions.get(previousId) : null;
    if (previous) deleteSession(previous);

    const session: ConfirmationSession = {
      id: id(),
      actorId,
      guildId,
      input,
      expiresAt: now() + SESSION_TTL_MS,
      busy: false,
    };
    sessions.set(session.id, session);
    actorSessions.set(key, session.id);
    await interaction.reply(ephemeralReplyPayload(confirmationPayload(session)));
  }

  async function handleButtonInteraction(interaction: ConfirmationInteraction) {
    const parsed = parseBoardRemovalConfirmationId(interaction.customId);
    if (!parsed) return;
    const session = requireSession(interaction, parsed.sessionId);

    if (parsed.action === 'cancel') {
      deleteSession(session);
      await interaction.update(interactionEditPayload(renderInteractionPanel(interactionOutcome({
        outcome: 'cancelled',
        title: 'Board role kept',
        description: 'Nothing was changed.',
      }))));
      return;
    }

    session.busy = true;
    await interaction.update(interactionEditPayload(renderInteractionPanel({
      kind: 'interaction-panel',
      tone: 'pending',
      title: 'Removing board role',
      description: `Updating ${userReference(session.input.user)} in ${scopeDescription(session.input.university, session.input.division)}.`,
      status: 'This message will update when the change and its activity record are ready.',
      audience: 'actor',
    })));

    try {
      const result = await removeRole(interaction, session.input);
      const activity = formatActivity('board-remove', {
        actorId: interaction.user.id,
        result,
      });
      const [activityDelivery, handoffDelivery] = await Promise.all([
        postActivity(interaction, activity),
        result.target.send(formatBoardRemovalHandoff(result, session.input.reason))
          .then(() => ({ status: 'sent' as const }))
          .catch((error: unknown) => {
            logger.warn('Board role removal DM could not be delivered', {
              userId: String(result.target.id),
              error: error instanceof Error ? error.message : String(error),
            });
            return { status: 'failed' as const };
          }),
      ]);
      deleteSession(session);

      const deliveryWarnings = [
        activityDelivery.status !== 'posted' ? 'The board activity card could not be posted.' : null,
        handoffDelivery.status !== 'sent' ? 'The affected member could not be reached by DM.' : null,
      ].filter(Boolean);
      await interaction.editReply(interactionEditPayload(renderInteractionPanel(interactionOutcome({
        outcome: deliveryWarnings.length ? 'delivery-failed' : 'success',
        title: 'Board role removed',
        description: `${userReference(result.target)} no longer has ${roleDescription(result.role, result.division?.name ?? null)} in ${result.university.name}.`,
        status: deliveryWarnings.length
          ? `The role change was saved. ${deliveryWarnings.join(' ')}`
          : 'The activity card was posted and the affected member received a private handoff.',
      }))));
    } catch (error) {
      session.busy = false;
      logger[error instanceof UserFacingError ? 'warn' : 'error']('Confirmed board role removal failed', {
        actorId: session.actorId,
        targetId: String(session.input.user.id),
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof UserFacingError ? undefined : error instanceof Error ? error.stack : undefined,
      });
      const message = error instanceof UserFacingError
        ? error.message
        : 'Something went wrong before the board role could be removed.';
      await interaction.editReply(interactionEditPayload(renderInteractionPanel({
        kind: 'interaction-panel',
        tone: 'danger',
        title: 'Board role not removed',
        description: message,
        status: 'Review the details, then try again or keep the role.',
        actions: confirmationActions(session, 'Try removal again'),
        audience: 'actor',
      })));
    }
  }

  return {
    canHandle(customId: string) {
      return Boolean(parseBoardRemovalConfirmationId(customId));
    },
    handleButton(interaction: unknown) {
      return handleButtonInteraction(interaction as ConfirmationInteraction);
    },
    start,
    activeSessionCount() {
      pruneExpired();
      return sessions.size;
    },
  };
}

export const boardRoleRemovalConfirmation = createBoardRoleRemovalConfirmationService();
