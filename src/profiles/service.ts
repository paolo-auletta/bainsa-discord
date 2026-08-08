import { randomUUID } from 'node:crypto';

import { MessageFlags } from 'discord.js';

import { writeAudit } from '../audit.js';
import { query, transaction } from '../db.js';
import { assertUser, UserFacingError } from '../errors.js';
import { logger } from '../logger.js';
import {
  hideProfileAndEnqueue,
  loadActiveMemberProfile,
  loadCanonicalActiveMember,
  publishProfileAndEnqueue,
} from './repository.js';
import { reconcileProfile } from './reconciliation.js';
import {
  profileCancelledPayload,
  profileContactModal,
  profileCurrentModal,
  profileCurrentPayload,
  profileIdentityModal,
  profileMutationFailedPayload,
  profilePublishedPayload,
  profileReviewPayload,
  profileTagsPayload,
  profileUnpublishedPayload,
  profileUnpublishConfirmationPayload,
} from './components.js';
import { parseProfileId, PROFILE_ACTIONS } from './custom-ids.js';
import { assertPublishableProfile, normalizeSelectedProfileTags } from './state.js';

export const PROFILE_SESSION_TTL_MS = 30 * 60 * 1_000;

const BUTTON_ACTIONS = new Set<string>([
  PROFILE_ACTIONS.START,
  PROFILE_ACTIONS.UNPUBLISH,
  PROFILE_ACTIONS.UNPUBLISH_CONFIRM,
  PROFILE_ACTIONS.IDENTITY,
  PROFILE_ACTIONS.CURRENT,
  PROFILE_ACTIONS.TAGS,
  PROFILE_ACTIONS.CONTACT,
  PROFILE_ACTIONS.REVIEW,
  PROFILE_ACTIONS.PUBLISH,
  PROFILE_ACTIONS.CANCEL,
]);
const MODAL_ACTIONS = new Set<string>([
  PROFILE_ACTIONS.IDENTITY_MODAL,
  PROFILE_ACTIONS.CURRENT_MODAL,
  PROFILE_ACTIONS.CONTACT_MODAL,
]);

interface ProfileSession {
  id: string;
  guildId: string;
  actorId: string;
  profile: ReturnType<typeof profileDraft>;
  previousVisibility: unknown;
  mode: string;
  screen: string;
  busy: boolean;
  expiresAt: number;
}

function actorKey(guildId: unknown, actorId: unknown) {
  return `${String(guildId)}:${String(actorId)}`;
}

function profileDraft(row: Record<string, unknown> | null | undefined) {
  return {
    headline: row?.headline ?? '',
    about: row?.about ?? '',
    current_role: row?.current_role ?? '',
    goals: row?.goals ?? '',
    selected_tags: Array.isArray(row?.selected_tags) ? row.selected_tags.map(String) : [],
    current_organization: row?.current_organization ?? '',
    location: row?.location ?? '',
    email: row?.email ?? '',
    linkedin_url: row?.linkedin_url ?? '',
    research_profile_url: row?.research_profile_url ?? '',
  };
}

function messageEditPayload(payload) {
  const editableFlags = Number(payload?.flags ?? 0) & ~MessageFlags.Ephemeral;
  if (editableFlags) return { ...payload, flags: editableFlags };
  const editable = { ...payload };
  delete editable.flags;
  return editable;
}

function profileMutationError(error) {
  return error instanceof UserFacingError
    ? error.message
    : 'Something went wrong. Your profile was not changed; you can try again.';
}

async function respondToModal(interaction, payload) {
  const fromMessage = interaction.isFromMessage?.() === true;
  const originIsEphemeral = interaction.message?.flags?.has?.(MessageFlags.Ephemeral);
  // The first modal is opened from the public directory guide. Updating that
  // message would replace the shared guide with one member's draft. Modals
  // opened from the ephemeral wizard should continue updating that private
  // response in place. Test doubles without a message retain the legacy update
  // path when they explicitly report that they came from a message.
  if (fromMessage && originIsEphemeral !== false) {
    return interaction.update(messageEditPayload(payload));
  }
  return interaction.reply({ ...payload, flags: MessageFlags.Ephemeral | MessageFlags.IsComponentsV2 });
}

/**
 * Private, actor-bound profile editing. It deliberately keeps all drafts in
 * memory; only a confirmed publication uses the database write boundary.
 */
export function createProfileService({
  db = { query, transaction },
  runTransaction = transaction,
  loadProfile = loadActiveMemberProfile,
  loadActiveMember = loadCanonicalActiveMember,
  publish = publishProfileAndEnqueue,
  hide = hideProfileAndEnqueue,
  audit = writeAudit,
  reconcile = reconcileProfile,
  now = () => Date.now(),
} = {}) {
  const sessions = new Map<string, ProfileSession>();
  const actorSessions = new Map<string, string>();

  function deleteSession(session) {
    sessions.delete(session.id);
    const key = actorKey(session.guildId, session.actorId);
    if (actorSessions.get(key) === session.id) actorSessions.delete(key);
  }

  function sweepExpiredSessions() {
    const current = now();
    for (const session of sessions.values()) {
      if (session.expiresAt <= current) deleteSession(session);
    }
  }

  function touch(session) {
    session.expiresAt = now() + PROFILE_SESSION_TTL_MS;
  }

  function createSession({ interaction, profile, mode = 'edit' }) {
    const key = actorKey(interaction.guildId, interaction.user.id);
    const existingId = actorSessions.get(key);
    if (existingId) {
      const existing = sessions.get(existingId);
      if (existing) deleteSession(existing);
    }
    const session = {
      id: randomUUID(),
      guildId: String(interaction.guildId),
      actorId: String(interaction.user.id),
      profile: profileDraft(profile),
      previousVisibility: profile?.visibility ?? null,
      mode,
      screen: mode === 'unpublish' ? 'unpublish' : 'identity',
      busy: false,
      expiresAt: now() + PROFILE_SESSION_TTL_MS,
    };
    sessions.set(session.id, session);
    actorSessions.set(key, session.id);
    return session;
  }

  async function requireActiveMember(interaction) {
    assertUser(interaction.guildId, 'Profiles can only be managed inside the BAINSA server.');
    const member = await loadActiveMember(db, interaction.user.id);
    assertUser(member, 'Only active members can manage a directory profile.');
    return member;
  }

  async function requireSession(interaction, parsed, { allowBusy = false } = {}) {
    sweepExpiredSessions();
    assertUser(parsed.kind === 'session', 'This profile control is no longer available.');
    assertUser(parsed.ownerId === String(interaction.user.id), 'Only the person who started this profile can use it.');
    const session = sessions.get(parsed.sessionId);
    assertUser(session, 'This profile editing session has expired. Start again from the directory guide.');
    assertUser(session.actorId === String(interaction.user.id), 'Only the person who started this profile can use it.');
    assertUser(session.guildId === String(interaction.guildId), 'This profile belongs to another server.');
    assertUser(allowBusy || !session.busy, 'This profile is already being published.');
    const member = await requireActiveMember(interaction);
    touch(session);
    return { session, member };
  }

  // Reserve before the active-member lookup below. That lookup is asynchronous,
  // so checking busy only after it would admit two simultaneous Publish clicks.
  function reserveMutation(interaction, parsed) {
    sweepExpiredSessions();
    assertUser(parsed.kind === 'session', 'This profile control is no longer available.');
    assertUser(parsed.ownerId === String(interaction.user.id), 'Only the person who started this profile can use it.');
    const session = sessions.get(parsed.sessionId);
    assertUser(session, 'This profile editing session has expired. Start again from the directory guide.');
    assertUser(session.actorId === String(interaction.user.id), 'Only the person who started this profile can use it.');
    assertUser(session.guildId === String(interaction.guildId), 'This profile belongs to another server.');
    assertUser(!session.busy, 'This profile is already being published.');
    session.busy = true;
    return session;
  }

  async function start(interaction) {
    sweepExpiredSessions();
    assertUser(interaction.guildId, 'Profiles can only be managed inside the BAINSA server.');
    const profile = await loadProfile(db, interaction.user.id);
    assertUser(profile, 'Only active members can create a directory profile.');
    const session = createSession({ interaction, profile });
    try {
      await interaction.showModal(profileIdentityModal(session));
    } catch (error) {
      deleteSession(session);
      throw error;
    }
  }

  async function startUnpublish(interaction) {
    sweepExpiredSessions();
    assertUser(interaction.guildId, 'Profiles can only be managed inside the BAINSA server.');
    const profile = await loadProfile(db, interaction.user.id);
    assertUser(profile, 'Only active members can manage a directory profile.');
    const session = createSession({ interaction, profile, mode: 'unpublish' });
    await interaction.reply(profileUnpublishConfirmationPayload(session));
  }

  async function attemptReconciliation(ownerId, guild) {
    try {
      const result = await reconcile({ discordUserId: ownerId, guild, db });
      if (result?.status !== 'succeeded') return { pending: true, forumThreadId: null };
      const refreshed = await loadProfile(db, ownerId);
      return { pending: false, forumThreadId: refreshed?.forum_thread_id ?? null };
    } catch {
      // The durable desired state has already committed. A worker will retry.
      return { pending: true, forumThreadId: null };
    }
  }

  async function publishSession(interaction, session, reserved = false) {
    let saved;
    let deferred = false;
    try {
      const profile = assertPublishableProfile(session.profile);
      if (!reserved) {
        assertUser(!session.busy, 'This profile is already being published.');
        session.busy = true;
      }
      await interaction.deferUpdate();
      deferred = true;
      saved = await runTransaction(async (client) => {
        const result = await publish(client, interaction.user.id, profile);
        await audit(client, {
          actorId: interaction.user.id,
          action: 'profile.publish',
          targetType: 'member_profile',
          targetId: interaction.user.id,
          before: { visibility: session.previousVisibility },
          after: {
            visibility: 'published',
            selectedTagKeys: profile.selected_tags,
            desiredGeneration: String(result.desiredGeneration),
          },
        });
        return result;
      });
    } catch (error) {
      session.busy = false;
      touch(session);
      if (!deferred) throw error;
      logger[error instanceof UserFacingError ? 'warn' : 'error']('Profile publication failed', {
        discordUserId: String(interaction.user.id),
        error: error instanceof UserFacingError ? error.message : 'Profile database operation failed.',
      });
      await interaction.editReply(messageEditPayload(profileMutationFailedPayload(session, {
        action: PROFILE_ACTIONS.PUBLISH,
        message: profileMutationError(error),
      })));
      return;
    }
    deleteSession(session);
    const sync = await attemptReconciliation(interaction.user.id, interaction.guild);
    await interaction.editReply(messageEditPayload(profilePublishedPayload({
      pending: sync.pending,
      forumThreadId: sync.forumThreadId ?? saved.profile?.forum_thread_id,
    })));
  }

  async function unpublishSession(interaction, session, reserved = false) {
    let hidden;
    let deferred = false;
    try {
      if (!reserved) {
        assertUser(!session.busy, 'This profile is already being published.');
        session.busy = true;
      }
      await interaction.deferUpdate();
      deferred = true;
      hidden = await runTransaction(async (client) => {
        const active = await loadActiveMember(client, interaction.user.id);
        assertUser(active, 'Only active members can manage a directory profile.');
        const result = await hide(client, interaction.user.id);
        if (result) {
          await audit(client, {
            actorId: interaction.user.id,
            action: 'profile.unpublish',
            targetType: 'member_profile',
            targetId: interaction.user.id,
            before: { visibility: session.previousVisibility },
            after: { visibility: 'hidden', desiredGeneration: String(result.desiredGeneration) },
          });
        }
        return result;
      });
    } catch (error) {
      session.busy = false;
      touch(session);
      if (!deferred) throw error;
      logger[error instanceof UserFacingError ? 'warn' : 'error']('Profile unpublish failed', {
        discordUserId: String(interaction.user.id),
        error: error instanceof UserFacingError ? error.message : 'Profile database operation failed.',
      });
      await interaction.editReply(messageEditPayload(profileMutationFailedPayload(session, {
        action: PROFILE_ACTIONS.UNPUBLISH_CONFIRM,
        message: profileMutationError(error),
      })));
      return;
    }
    deleteSession(session);
    if (hidden) await attemptReconciliation(interaction.user.id, interaction.guild);
    await interaction.editReply(messageEditPayload(profileUnpublishedPayload({ alreadyHidden: !hidden })));
  }

  async function handleButton(interaction) {
    const parsed = parseProfileId(interaction.customId);
    if (!parsed || !BUTTON_ACTIONS.has(parsed.action)) return;
    if (parsed.kind === 'persistent') {
      if (parsed.action === PROFILE_ACTIONS.START) return start(interaction);
      if (parsed.action === PROFILE_ACTIONS.UNPUBLISH) return startUnpublish(interaction);
      return;
    }
    const mutating = parsed.action === PROFILE_ACTIONS.PUBLISH || parsed.action === PROFILE_ACTIONS.UNPUBLISH_CONFIRM;
    let reserved = null;
    if (mutating) reserved = reserveMutation(interaction, parsed);
    let required;
    try {
      required = await requireSession(interaction, parsed, { allowBusy: Boolean(reserved) });
    } catch (error) {
      if (reserved) {
        reserved.busy = false;
        touch(reserved);
      }
      throw error;
    }
    const { session, member } = required;
    if (parsed.action === PROFILE_ACTIONS.CANCEL) {
      deleteSession(session);
      await interaction.update(messageEditPayload(profileCancelledPayload()));
      return;
    }
    if (parsed.action === PROFILE_ACTIONS.IDENTITY) return interaction.showModal(profileIdentityModal(session));
    if (parsed.action === PROFILE_ACTIONS.CURRENT) return interaction.showModal(profileCurrentModal(session));
    if (parsed.action === PROFILE_ACTIONS.TAGS) {
      return interaction.update(messageEditPayload(profileTagsPayload(session)));
    }
    if (parsed.action === PROFILE_ACTIONS.CONTACT) return interaction.showModal(profileContactModal(session));
    if (parsed.action === PROFILE_ACTIONS.REVIEW) {
      assertPublishableProfile(session.profile, member.member_type);
      session.screen = 'review';
      await interaction.update(messageEditPayload(profileReviewPayload(session)));
      return;
    }
    if (parsed.action === PROFILE_ACTIONS.PUBLISH) return publishSession(interaction, session, Boolean(reserved));
    if (parsed.action === PROFILE_ACTIONS.UNPUBLISH_CONFIRM) return unpublishSession(interaction, session, Boolean(reserved));
  }

  async function handleStringSelect(interaction) {
    const parsed = parseProfileId(interaction.customId);
    if (!parsed || parsed.kind !== 'session' || parsed.action !== PROFILE_ACTIONS.TAGS) return;
    const { session } = await requireSession(interaction, parsed);
    session.profile.selected_tags = normalizeSelectedProfileTags(interaction.values);
    session.screen = 'tags';
    await interaction.update(messageEditPayload(profileTagsPayload(session)));
  }

  async function handleModalSubmit(interaction) {
    const parsed = parseProfileId(interaction.customId);
    if (!parsed || parsed.kind !== 'session' || !MODAL_ACTIONS.has(parsed.action)) return;
    const { session, member } = await requireSession(interaction, parsed);
    const fields = interaction.fields;
    if (parsed.action === PROFILE_ACTIONS.IDENTITY_MODAL) {
      session.profile.headline = fields.getTextInputValue('headline');
      session.profile.about = fields.getTextInputValue('about');
      session.screen = 'current';
      await respondToModal(interaction, profileCurrentPayload(session));
      return;
    }
    if (parsed.action === PROFILE_ACTIONS.CURRENT_MODAL) {
      session.profile.current_role = fields.getTextInputValue('current_role');
      session.profile.current_organization = fields.getTextInputValue('current_organization');
      session.profile.location = fields.getTextInputValue('location');
      session.profile.goals = fields.getTextInputValue('goals');
      session.screen = 'tags';
      await respondToModal(interaction, profileTagsPayload(session));
      return;
    }
    session.profile.email = fields.getTextInputValue('email');
    session.profile.linkedin_url = fields.getTextInputValue('linkedin_url');
    session.profile.research_profile_url = fields.getTextInputValue('research_profile_url');
    assertPublishableProfile(session.profile, member.member_type);
    session.screen = 'review';
    await respondToModal(interaction, profileReviewPayload(session));
  }

  return {
    canHandle: (customId) => parseProfileId(customId) != null,
    handleButton,
    handleStringSelect,
    handleModalSubmit,
    start,
  };
}

export function isProfileServiceCustomId(customId) {
  return parseProfileId(customId) != null;
}
