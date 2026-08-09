import { ChannelType } from 'discord.js';

import { assertNoBotUserIds } from '../../authorization.js';
import { PROJECT_MEMBER_FETCH_CONCURRENCY } from '../../constants.js';
import { assertUser } from '../../errors.js';
import { universityCategoryName } from '../../naming.js';
import { mapWithConcurrency } from './concurrency.js';
import {
  projectAssignmentMessage,
  projectHomePayload,
  projectRemovalMessage,
  projectStatusLabel,
  showcasePostPayload,
} from './formatters.js';
import { formatDiscordUserReferences } from './validation.js';

const PROJECT_HISTORY_ALLOWED_MENTIONS = Object.freeze({ parse: [] as string[] });
const UNKNOWN_CHANNEL = 10_003;
const UNKNOWN_MESSAGE = 10_008;

function isDiscordError(error, code) {
  return Number(error?.code) === code;
}

async function fetchChannelIfPresent(guild, channelId) {
  try {
    return await guild.channels.fetch(channelId);
  } catch (error) {
    if (isDiscordError(error, UNKNOWN_CHANNEL)) return null;
    throw error;
  }
}

async function fetchStarterIfPresent(thread) {
  if (!thread?.fetchStarterMessage) return null;
  try {
    return await thread.fetchStarterMessage();
  } catch (error) {
    if (isDiscordError(error, UNKNOWN_CHANNEL) || isDiscordError(error, UNKNOWN_MESSAGE)) return null;
    throw error;
  }
}

async function fetchMessageIfPresent(channel, messageId) {
  if (!messageId || !channel.messages?.fetch) return null;
  try {
    return await channel.messages.fetch(messageId);
  } catch (error) {
    if (isDiscordError(error, UNKNOWN_MESSAGE)) return null;
    throw error;
  }
}

async function fetchGuildMember(guild, userId) {
  try {
    return await guild.members.fetch(userId);
  } catch (error) {
    if (Number(error?.code) === 10_007) return null;
    throw error;
  }
}

export async function assertGuildMembers(guild, userIds) {
  assertNoBotUserIds(guild, userIds);
  const fetched = await mapWithConcurrency(userIds, PROJECT_MEMBER_FETCH_CONCURRENCY, (id) =>
    fetchGuildMember(guild, id),
  );
  const missing = userIds.filter((_, index) => !fetched[index]);
  assertUser(missing.length === 0, `These users are not in the server: ${formatDiscordUserReferences(missing)}.`);
  const bots = userIds.filter((_, index) => fetched[index]?.user?.bot === true);
  assertUser(bots.length === 0, `Bots cannot be assigned to projects: ${formatDiscordUserReferences(bots)}.`);
}

function findCategoryId(guild, preferredId, fallbackName) {
  if (preferredId && guild.channels.cache.has(String(preferredId))) return String(preferredId);
  const category = guild.channels.cache.find(
    (channel) => channel.type === ChannelType.GuildCategory && channel.name === fallbackName,
  );
  return category?.id ?? null;
}

export function findProjectParentId(guild, project) {
  return findCategoryId(guild, project.category_id, universityCategoryName(project.university_name));
}

function forumTagPayload(tag) {
  return { id: tag.id, name: tag.name, moderated: tag.moderated };
}

function lifecycleTagName(status) {
  return status === 'archived' ? 'Completed' : projectStatusLabel(status);
}

async function ensureShowcaseTags(forum, project) {
  const desiredNames = [project.division_name, 'Active', 'Paused', 'Completed'];
  let tags = forum.availableTags ?? [];
  const existingNames = new Set(tags.map((tag) => tag.name.toLowerCase()));
  const missing = desiredNames.filter((name) => !existingNames.has(name.toLowerCase()));
  if (missing.length > 0 && typeof forum.setAvailableTags === 'function') {
    const updated = await forum.setAvailableTags(
      [...tags.map(forumTagPayload), ...missing.map((name) => ({ name }))],
      `Reconcile project ${project.id} showcase tags`,
    );
    tags = updated.availableTags ?? tags;
  }
  return tags;
}

function showcaseAppliedTagIds(tags, project) {
  const desired = new Set([
    project.division_name.toLowerCase(),
    lifecycleTagName(project.status).toLowerCase(),
  ]);
  return tags.filter((tag) => desired.has(tag.name.toLowerCase())).map((tag) => tag.id);
}

async function createShowcaseThread(forum, project, people, tags) {
  const appliedTags = showcaseAppliedTagIds(tags, project);
  const payload = showcasePostPayload(project, people);
  return forum.threads.create({
    name: project.name,
    appliedTags,
    message: {
      ...payload,
      allowedMentions: PROJECT_HISTORY_ALLOWED_MENTIONS,
    },
    reason: `Project ${project.id} showcase post`,
  });
}

export async function syncShowcaseThread(guild, project, people) {
  if (!project.showcase_channel_id) {
    throw new Error(`Project ${project.id} has no configured university showcase forum.`);
  }
  const forum = await fetchChannelIfPresent(guild, project.showcase_channel_id);
  if (!forum) throw new Error(`Project ${project.id}'s university showcase forum is missing.`);
  if (forum.type !== ChannelType.GuildForum) {
    throw new Error(`Project ${project.id}'s configured showcase channel is not a forum.`);
  }
  const tags = await ensureShowcaseTags(forum, project);
  let thread = project.showcase_thread_id
    ? await fetchChannelIfPresent(guild, project.showcase_thread_id)
    : null;
  let starter = await fetchStarterIfPresent(thread);

  if (!thread || !starter) {
    if (thread?.setArchived) await thread.setArchived(true, `Replace incomplete project ${project.id} showcase`).catch(() => undefined);
    thread = await createShowcaseThread(forum, project, people, tags);
    starter = await fetchStarterIfPresent(thread);
    return thread;
  }

  if (thread.archived && typeof thread.setArchived === 'function') {
    await thread.setArchived(false, `Refresh project ${project.id} showcase`);
  }
  if (thread.locked && typeof thread.setLocked === 'function') {
    await thread.setLocked(false, `Refresh project ${project.id} showcase`);
  }
  if (thread.name !== project.name && typeof thread.setName === 'function') {
    await thread.setName(project.name, `Update project ${project.id} showcase`);
  }
  if (typeof thread.setAppliedTags === 'function') {
    await thread.setAppliedTags(showcaseAppliedTagIds(tags, project), `Update project ${project.id} showcase tags`);
  }
  await starter.edit({
    ...showcasePostPayload(project, people),
    allowedMentions: PROJECT_HISTORY_ALLOWED_MENTIONS,
  });
  return thread;
}

function projectHomeMarker(projectId) {
  return `-# Project #${projectId} ·`;
}

function matchingProjectHome(messages, channel, projectId) {
  const botUserId = channel.client?.user?.id;
  return messages.find(
    (message) =>
      message.content?.startsWith(projectHomeMarker(projectId))
      && (!botUserId || !message.author?.id || String(message.author.id) === String(botUserId)),
  ) ?? null;
}

async function findProjectHome(channel, projectId) {
  if (channel.messages?.fetchPins) {
    const response = await channel.messages.fetchPins();
    const pinned = response?.items
    ?.map((item) => item.message)
      ?? [];
    const match = matchingProjectHome(pinned, channel, projectId);
    if (match) return match;
  }
  if (!channel.messages?.fetch) return null;
  const recent = await channel.messages.fetch({ limit: 100 });
  return matchingProjectHome([...recent.values()], channel, projectId);
}

export async function syncProjectHome(guild, project, people) {
  if (!project.discord_channel_id) return;
  const channel = await fetchChannelIfPresent(guild, project.discord_channel_id);
  if (!channel) return;
  let message = await fetchMessageIfPresent(channel, project.home_message_id);
  if (!message) message = await findProjectHome(channel, project.id);
  const payload = {
    ...projectHomePayload(project, people),
    allowedMentions: PROJECT_HISTORY_ALLOWED_MENTIONS,
  };
  if (!message) {
    message = await channel.send(payload);
  } else {
    await message.edit(payload);
  }
  if (!message.pinned && typeof message.pin === 'function') {
    await message.pin(`Pin canonical project ${project.id} overview`);
  }
  return message;
}

export async function sendProjectTransition(guild, project, payload) {
  if (!project.discord_channel_id) return null;
  const channel = await guild.channels.fetch(project.discord_channel_id).catch(() => null);
  if (!channel) return null;
  return channel.send({
    ...payload,
    allowedMentions: PROJECT_HISTORY_ALLOWED_MENTIONS,
  });
}

export async function notifyProjectAssignment(guild, project, person, previousRole = null) {
  const member = await guild.members.fetch(String(person.discord_user_id));
  await member.send(projectAssignmentMessage(guild.id, project, person.role, previousRole));
}

export async function notifyProjectRemoval(guild, project, userId, reason = null) {
  const member = await guild.members.fetch(String(userId));
  await member.send(projectRemovalMessage(guild.id, project, reason));
}
