import { ChannelType, PermissionFlagsBits } from 'discord.js';

import { assertNotBotUser } from '../../authorization.mjs';
import { ROLE_NAMES } from '../../constants.mjs';
import { assertUser, UserFacingError } from '../../errors.mjs';
import { logger } from '../../logger.mjs';
import {
  divisionTextChannelName,
  divisionVoiceChannelName,
  universityBoardRoleName,
} from '../../naming.mjs';
import { projectChannelCleanupTargets } from './formatters.mjs';

const TEXT_WRITE = Object.freeze([
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.ReadMessageHistory,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.SendMessagesInThreads,
  PermissionFlagsBits.CreatePublicThreads,
  PermissionFlagsBits.AttachFiles,
  PermissionFlagsBits.EmbedLinks,
  PermissionFlagsBits.AddReactions,
]);
const VOICE_ACCESS = Object.freeze([
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.Connect,
  PermissionFlagsBits.Speak,
]);
const BOT_CHANNEL_ACCESS = Object.freeze([
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.ReadMessageHistory,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.SendMessagesInThreads,
  PermissionFlagsBits.CreatePublicThreads,
  PermissionFlagsBits.CreatePrivateThreads,
  PermissionFlagsBits.AttachFiles,
  PermissionFlagsBits.EmbedLinks,
  PermissionFlagsBits.AddReactions,
  PermissionFlagsBits.UseApplicationCommands,
  PermissionFlagsBits.ManageMessages,
  PermissionFlagsBits.ManageThreads,
  PermissionFlagsBits.ManageChannels,
  PermissionFlagsBits.Connect,
  PermissionFlagsBits.Speak,
]);

export async function targetGuildMember(interaction, user) {
  assertUser(interaction.guild, 'This command can only be used inside the BAINSA server.');
  assertNotBotUser(interaction, user.id);
  try {
    return await interaction.guild.members.fetch(user.id);
  } catch {
    throw new UserFacingError('That user is not currently in this server.');
  }
}

export function roleByName(guild, roleName) {
  return guild.roles.cache.find((role) => role.name === roleName) ?? null;
}

export function divisionChannelName(divisionName, type, color) {
  return type === ChannelType.GuildVoice
    ? divisionVoiceChannelName(divisionName, color)
    : divisionTextChannelName(divisionName, color);
}

function requireRole(guild, roleName) {
  const role = roleByName(guild, roleName);
  assertUser(role, `Required role is missing: ${roleName}. Run provisioning first.`);
  return role;
}

function channelOverwrite(id, { allow = [], deny = [] }) {
  return { id, allow, deny };
}

export function divisionChannelOverwrites(guild, roles, type) {
  const memberPermissions = type === ChannelType.GuildVoice ? VOICE_ACCESS : TEXT_WRITE;
  const boardPermissions =
    type === ChannelType.GuildVoice
      ? [...VOICE_ACCESS, PermissionFlagsBits.CreateEvents]
      : TEXT_WRITE;

  return [
    channelOverwrite(guild.roles.everyone.id, { deny: [PermissionFlagsBits.ViewChannel] }),
    channelOverwrite(roles.accessRole.id, { allow: memberPermissions }),
    channelOverwrite(roles.headRole.id, { allow: boardPermissions }),
    channelOverwrite(roles.presidentRole.id, { allow: boardPermissions }),
    channelOverwrite(roles.vicePresidentRole.id, { allow: boardPermissions }),
    channelOverwrite(roles.globalPresidentRole.id, { allow: boardPermissions }),
    channelOverwrite(roles.botRole.id, { allow: BOT_CHANNEL_ACCESS }),
  ];
}

export function divisionOverwriteRoles(guild, universityName, _divisionName, accessRole, headRole) {
  return {
    accessRole,
    headRole,
    presidentRole: requireRole(guild, universityBoardRoleName(universityName, 'President')),
    vicePresidentRole: requireRole(guild, universityBoardRoleName(universityName, 'Vice President')),
    globalPresidentRole: requireRole(guild, ROLE_NAMES.GLOBAL_PRESIDENT),
    botRole: requireRole(guild, ROLE_NAMES.BOT),
  };
}

export async function persistedUniversityCategory(guild, university) {
  assertUser(
    university.category_id,
    `No persisted category is recorded for ${university.name}. Run provisioning before creating divisions.`,
  );
  const category = await guild.channels.fetch(university.category_id).catch(() => null);
  assertUser(
    category?.type === ChannelType.GuildCategory,
    `The persisted category for ${university.name} could not be found. Run provisioning again.`,
  );
  return category;
}

export async function removeProjectPermissionOverwrites(guild, userId, projects) {
  const failures = [];
  const cleanedChannelIds = [];

  for (const channelId of projectChannelCleanupTargets(projects)) {
    try {
      const channel = await guild.channels.fetch(channelId);
      if (!channel?.permissionOverwrites) {
        throw new Error('channel not found or does not support permission overwrites');
      }
      if (channel.permissionOverwrites.cache?.has(String(userId))) {
        await channel.permissionOverwrites.delete(
          String(userId),
          'BAINSA member removal: clearing direct project access',
        );
      }
      cleanedChannelIds.push(channelId);
    } catch (error) {
      failures.push({
        channelId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (failures.length > 0) {
    logger.warn('Member removal project overwrite cleanup partially failed', {
      userId: String(userId),
      failures,
    });
  }

  return { cleanedChannelIds, failures };
}

export async function createDivisionChannel(guild, divisionName, color, type, parent, overwriteRoles, reason) {
  const name = divisionChannelName(divisionName, type, color).slice(0, 100);
  const parentId = String(parent.id);
  const existing = guild.channels.cache.find(
    (channel) =>
      channel.name === name &&
      channel.type === type &&
      String(channel.parentId ?? channel.parent?.id ?? '') === parentId,
  );
  if (existing) return { channel: existing, created: false };
  const channel = await guild.channels.create({
    name,
    type,
    parent: parent.id,
    permissionOverwrites: divisionChannelOverwrites(guild, overwriteRoles, type),
    reason,
  });
  return { channel, created: true };
}

export async function renameChannelById(guild, channelId, newName, reason) {
  if (!channelId) return null;
  const channel = await guild.channels.fetch(channelId).catch(() => null);
  if (!channel) return null;
  if (channel.name === newName) return channel;
  return channel.setName(newName, reason);
}
