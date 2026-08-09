import {
  ChannelType,
  ContainerBuilder,
  MessageFlags,
  TextDisplayBuilder,
} from 'discord.js';

import { GLOBAL_CHANNELS } from '../provision/plan.js';

const DIRECTORY_AUTO_ARCHIVE_MINUTES = 10_080;
const PROFILE_CARD_COLOR = 0x5865f2;
const LEGACY_PROFILE_SECTION_HEADINGS = Object.freeze([
  '## 🔭 What I’d like to explore next',
  '## 🧭 Discover & connect',
]);

function valuesOf(collection) {
  if (!collection) return [];
  if (typeof collection.values === 'function') return [...collection.values()];
  return Array.isArray(collection) ? collection : [];
}

function sameIds(current, desired) {
  const left = [...(current ?? [])].map(String).sort();
  const right = [...(desired ?? [])].map(String).sort();
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function botUserId(guild, explicitBotUserId) {
  return explicitBotUserId ?? guild?.client?.user?.id ?? guild?.members?.me?.user?.id ?? null;
}

function discordErrorCode(error) {
  const code = Number(error?.code ?? error?.rawError?.code);
  return Number.isFinite(code) ? code : null;
}

function isMissingDiscordResource(error) {
  return [10_003, 10_008].includes(discordErrorCode(error));
}

async function fetchChannel(guild, channelId) {
  if (!channelId || typeof guild?.channels?.fetch !== 'function') return null;
  try {
    return await guild.channels.fetch(String(channelId));
  } catch (error) {
    if (isMissingDiscordResource(error)) return null;
    throw error;
  }
}

export async function resolvePeopleDirectoryForum(guild) {
  const cached = guild?.channels?.cache?.find?.(
    (channel) => channel.type === ChannelType.GuildForum && channel.name === GLOBAL_CHANNELS.PEOPLE_DIRECTORY,
  );
  if (cached) return cached;
  if (typeof guild?.channels?.fetch !== 'function') return null;
  const fetched = await guild.channels.fetch();
  return valuesOf(fetched).find(
    (channel) => channel.type === ChannelType.GuildForum && channel.name === GLOBAL_CHANNELS.PEOPLE_DIRECTORY,
  ) ?? null;
}

function appliedTagIds(forum, labels) {
  const available = valuesOf(forum?.availableTags);
  return labels.map((label) => {
    const tag = available.find((candidate) => String(candidate.name).toLowerCase() === String(label).toLowerCase());
    if (!tag?.id) throw new Error(`People-directory forum is missing the managed tag ${label}.`);
    return String(tag.id);
  });
}

async function starterMessage(thread) {
  if (typeof thread?.fetchStarterMessage !== 'function') return null;
  try {
    return await thread.fetchStarterMessage();
  } catch (error) {
    if (isMissingDiscordResource(error)) return null;
    throw error;
  }
}

async function unarchive(thread, reason) {
  if (thread?.archived && typeof thread.setArchived === 'function') {
    await thread.setArchived(false, reason);
  }
}

async function isOwnedProfileThread(thread, ownerId, expectedBotUserId) {
  const message = await starterMessage(thread);
  if (!message) return null;
  const componentText = JSON.stringify(
    valuesOf(message.components).map((component) => component?.toJSON?.() ?? component),
  );
  if (!String(message.content ?? '').includes(`<@${ownerId}>`) && !componentText.includes(`<@${ownerId}>`)) return null;
  if (!expectedBotUserId || String(message.author?.id ?? '') !== String(expectedBotUserId)) return null;
  return { thread, message };
}

async function profileThreadCandidates({ forum, ownerId, botId }) {
  const candidates = [];
  const active = await forum?.threads?.fetchActive?.();
  const archivedThreads = [];
  let before;
  let hasMore = typeof forum?.threads?.fetchArchived === 'function';
  while (hasMore) {
    const archived = await forum.threads.fetchArchived({
      limit: 100,
      ...(before ? { before } : {}),
    });
    const page = valuesOf(archived?.threads);
    archivedThreads.push(...page);
    hasMore = archived?.hasMore === true && page.length > 0;
    before = page.at(-1);
  }
  const seen = new Set<string>();
  for (const thread of [...valuesOf(active?.threads), ...archivedThreads]) {
    if (!thread?.id || seen.has(String(thread.id))) continue;
    seen.add(String(thread.id));
    const candidate = await isOwnedProfileThread(thread, ownerId, botId);
    if (candidate) candidates.push(candidate);
  }
  return candidates.sort((left, right) => Number(left.thread.createdTimestamp ?? 0) - Number(right.thread.createdTimestamp ?? 0));
}

async function deleteThread(thread, reason) {
  if (!thread || typeof thread.delete !== 'function') return;
  try {
    await thread.delete(reason);
  } catch (error) {
    if (!isMissingDiscordResource(error)) throw error;
  }
}

async function recoverOwnedThread({ forum, ownerId, botId }) {
  const matches = await profileThreadCandidates({ forum, ownerId, botId });
  if (matches.length === 0) return null;
  const [adopted, ...duplicates] = matches;
  await Promise.all(duplicates.map(({ thread }) => deleteThread(thread, 'Remove duplicate BAINSA directory profile')));
  return adopted;
}

function profileCard(post) {
  return new ContainerBuilder()
    .setAccentColor(PROFILE_CARD_COLOR)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(post.content));
}

function starterPayload(post) {
  return {
    components: [profileCard(post)],
    flags: MessageFlags.IsComponentsV2,
    allowedMentions: post.allowedMentions,
  };
}

function hasComponentsV2(message) {
  if (typeof message?.flags?.has === 'function') return message.flags.has(MessageFlags.IsComponentsV2);
  const bitfield = Number(message?.flags?.bitfield ?? message?.flags ?? 0);
  return (bitfield & MessageFlags.IsComponentsV2) === MessageFlags.IsComponentsV2;
}

async function editStarter(message, post) {
  if (!hasComponentsV2(message)) {
    await message.edit({ content: null, embeds: [], components: [] });
  }
  return message.edit(starterPayload(post));
}

async function deleteMessage(message) {
  if (typeof message?.delete !== 'function') return;
  try {
    await message.delete();
  } catch (error) {
    if (!isMissingDiscordResource(error)) throw error;
  }
}

async function removeLegacyProfileSections({ thread, starter, expectedBotUserId }) {
  if (typeof thread?.messages?.fetch !== 'function') {
    throw new Error('The profile thread cannot remove legacy section messages.');
  }
  const fetched = await thread.messages.fetch({ limit: 100 });
  const legacySections = valuesOf(fetched).filter((message) => (
    String(message?.id ?? '') !== String(starter?.id ?? '')
    && (!expectedBotUserId || String(message?.author?.id ?? '') === String(expectedBotUserId))
    && LEGACY_PROFILE_SECTION_HEADINGS.some((heading) => String(message?.content ?? '').startsWith(heading))
  ));
  await Promise.all(legacySections.map(deleteMessage));
}

/**
 * Applies a desired profile post without consulting PostgreSQL. The starter is
 * the sole desired message; legacy managed follow-ups are removed on update.
 */
export async function upsertProfileForumPost({
  guild,
  ownerId,
  post,
  forumThreadId = null,
  forumMessageId = null,
  botUserId: explicitBotUserId = null,
}) {
  const forum = await resolvePeopleDirectoryForum(guild);
  if (!forum) throw new Error('The people-directory forum is unavailable.');
  const tagIds = appliedTagIds(forum, post.appliedTagLabels);
  const resolvedBotUserId = botUserId(guild, explicitBotUserId);
  let thread = await fetchChannel(guild, forumThreadId);
  let message = null;
  if (thread?.parentId !== forum.id) thread = null;
  if (thread) {
    const stored = await isOwnedProfileThread(thread, String(ownerId), resolvedBotUserId);
    if (stored) message = stored.message;
    else thread = null;
  }
  if (!thread || !message) {
    if (thread && !message) await deleteThread(thread, 'Replace directory post with a missing starter message');
    const recovered = await recoverOwnedThread({ forum, ownerId: String(ownerId), botId: resolvedBotUserId });
    thread = recovered?.thread ?? null;
    message = recovered?.message ?? null;
  }

  if (!thread) {
    thread = await forum.threads.create({
      name: post.threadName,
      autoArchiveDuration: DIRECTORY_AUTO_ARCHIVE_MINUTES,
      appliedTags: tagIds,
      message: starterPayload(post),
      reason: 'Create BAINSA directory profile',
    });
    message = await starterMessage(thread);
    // Discord forum post starter-message IDs are currently the thread IDs.
    // Persist both fields nevertheless so the schema remains explicit.
    return { forumThreadId: String(thread.id), forumMessageId: String(message?.id ?? thread.id), created: true };
  }

  await unarchive(thread, 'Reconcile BAINSA directory profile');
  if (thread.name !== post.threadName && typeof thread.setName === 'function') {
    await thread.setName(post.threadName, 'Reconcile BAINSA directory profile');
  }
  if (!sameIds(thread.appliedTags, tagIds) && typeof thread.setAppliedTags === 'function') {
    await thread.setAppliedTags(tagIds, 'Reconcile BAINSA directory profile');
  }
  // A stale stored message ID is deliberately ignored in favour of the
  // starter-message API identity.
  await editStarter(message, post);
  await removeLegacyProfileSections({ thread, starter: message, expectedBotUserId: resolvedBotUserId });
  return {
    forumThreadId: String(thread.id),
    forumMessageId: String(message.id ?? forumMessageId ?? thread.id),
    created: false,
  };
}

/** Deletes stored and recovery-identifiable profile posts; missing posts are success. */
export async function deleteProfileForumPosts({ guild, ownerId, forumThreadId = null, botUserId: explicitBotUserId = null }) {
  const resolvedBotUserId = botUserId(guild, explicitBotUserId);
  const stored = await fetchChannel(guild, forumThreadId);
  const forum = await resolvePeopleDirectoryForum(guild);
  const targets = new Map<string, unknown>();
  if (stored) {
    const ownedStored = await isOwnedProfileThread(stored, String(ownerId), resolvedBotUserId);
    if (ownedStored) targets.set(String(stored.id), stored);
  }
  if (forum) {
    const matches = await profileThreadCandidates({ forum, ownerId: String(ownerId), botId: resolvedBotUserId });
    for (const { thread } of matches) targets.set(String(thread.id), thread);
  }
  await Promise.all([...targets.values()].map((thread) => deleteThread(thread, 'Delete hidden BAINSA directory profile')));
  // Without the forum we cannot scan for a duplicate or legacy post. Keep the
  // durable reconciliation row pending even when a stored thread was deleted.
  if (!forum) throw new Error('The people-directory forum is unavailable.');
  return { deletedThreadIds: [...targets.keys()] };
}

/** Reopens a tracked thread at the maintenance boundary without posting a message. */
export async function refreshProfileForumThread({ guild, forumThreadId }) {
  const thread = await fetchChannel(guild, forumThreadId);
  if (!thread) return { refreshed: false, missing: true };
  await unarchive(thread, 'Refresh BAINSA directory profile visibility');
  return { refreshed: true, missing: false };
}

export async function unarchiveDirectoryGuideThread({ guild, guideThreadId }) {
  const thread = await fetchChannel(guild, guideThreadId);
  if (!thread) return { refreshed: false, missing: true };
  await unarchive(thread, 'Refresh BAINSA people-directory guide visibility');
  return { refreshed: true, missing: false };
}

export { DIRECTORY_AUTO_ARCHIVE_MINUTES };
