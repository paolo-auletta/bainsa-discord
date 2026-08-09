import { ChannelType } from 'discord.js';

import { assertNoBotUserIds } from '../../authorization.js';
import { PROJECT_MEMBER_FETCH_CONCURRENCY } from '../../constants.js';
import { assertUser } from '../../errors.js';
import { universityCategoryName } from '../../naming.js';
import { mapWithConcurrency } from './concurrency.js';
import { formatProjectIntro, formatShowcasePost } from './formatters.js';
import { formatDiscordUserReferences } from './validation.js';

const PROJECT_HISTORY_ALLOWED_MENTIONS = Object.freeze({ parse: [] as string[] });

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

export async function createShowcaseThread(guild, project, people) {
  if (!project.showcase_channel_id) return null;
  const forum = await guild.channels.fetch(project.showcase_channel_id).catch(() => null);
  if (!forum || forum.type !== ChannelType.GuildForum) return null;
  const existing = forum.availableTags.find((tag) => tag.name.toLowerCase() === project.division_name.toLowerCase());
  const tags = existing
    ? forum.availableTags
    : (await forum.setAvailableTags([...forum.availableTags.map((tag) => ({ id: tag.id, name: tag.name, moderated: tag.moderated })), { name: project.division_name }], `Create ${project.division_name} project tag`)).availableTags;
  const tagId = tags.find((tag) => tag.name.toLowerCase() === project.division_name.toLowerCase())?.id ?? null;
  return forum.threads.create({
    name: project.name,
    appliedTags: tagId ? [tagId] : [],
    message: {
      content: formatShowcasePost(project, people),
      allowedMentions: PROJECT_HISTORY_ALLOWED_MENTIONS,
    },
    reason: `Project ${project.id} showcase post`,
  });
}

export async function updateShowcaseThread(guild, project, people, extra = '') {
  if (!project.showcase_thread_id) return;
  const thread = await guild.channels.fetch(project.showcase_thread_id).catch(() => null);
  if (!thread) return;
  await thread.setName(project.name, `Update project ${project.id} showcase`).catch(() => undefined);
  await thread.send({
    content: formatShowcasePost(project, people, extra),
    allowedMentions: PROJECT_HISTORY_ALLOWED_MENTIONS,
  }).catch(() => undefined);
}

export async function updateProjectChannel(guild, project, people, extra = '') {
  if (!project.discord_channel_id) return;
  const channel = await guild.channels.fetch(project.discord_channel_id).catch(() => null);
  if (!channel) return;
  await channel.send({
    content: formatProjectIntro(project, people, extra),
    allowedMentions: PROJECT_HISTORY_ALLOWED_MENTIONS,
  }).catch(() => undefined);
}
