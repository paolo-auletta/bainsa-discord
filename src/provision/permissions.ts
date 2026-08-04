import { PermissionFlagsBits } from 'discord.js';

import { ROLE_NAMES } from '../constants.js';
import { divisionHeadRoleName, divisionRoleName } from '../naming.js';
import {
  DANGEROUS_HUMAN_PERMISSIONS,
  FORUM_DENY_POST,
  FORUM_POST,
  FORUM_READ_ONLY,
  BOT_COMMAND_WRITE,
  TEXT_READ,
  TEXT_WRITE,
  VOICE_ACCESS,
} from './plan.js';

interface OverwriteSpec {
  allow?: readonly bigint[];
  deny?: readonly bigint[];
}

export function stripDangerousHumanPermissions(permissions) {
  let bitfield = BigInt(permissions ?? 0n);
  for (const permission of DANGEROUS_HUMAN_PERMISSIONS) {
    bitfield &= ~BigInt(permission);
  }
  return bitfield;
}

export function overwrite(id, { allow = [], deny = [] }: OverwriteSpec = {}) {
  return { id, allow, deny };
}

export function botOverwrite(roleIds) {
  return overwrite(roleIds.bot, {
    allow: [
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
    ],
  });
}

export function startHereOverwrites(roleIds) {
  return [
    overwrite(roleIds.everyone, {
      allow: TEXT_READ,
      deny: [
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.CreatePublicThreads,
        PermissionFlagsBits.CreatePrivateThreads,
        PermissionFlagsBits.SendMessagesInThreads,
      ],
    }),
    botOverwrite(roleIds),
  ];
}

export function privateBaseOverwrites(roleIds) {
  return [
    overwrite(roleIds.everyone, { deny: [PermissionFlagsBits.ViewChannel] }),
    botOverwrite(roleIds),
  ];
}

export function globalGeneralOverwrites(roleIds) {
  return [
    overwrite(roleIds.everyone, { deny: [PermissionFlagsBits.ViewChannel] }),
    overwrite(roleIds.researcher, { allow: TEXT_WRITE }),
    overwrite(roleIds.alumni, { allow: TEXT_WRITE }),
    overwrite(roleIds.globalPresident, { allow: TEXT_WRITE }),
    ...roleIds.universityPresidents.map((id) => overwrite(id, { allow: TEXT_WRITE })),
    botOverwrite(roleIds),
  ];
}

export function globalVoiceOverwrites(roleIds) {
  return [
    overwrite(roleIds.everyone, { deny: [PermissionFlagsBits.ViewChannel] }),
    overwrite(roleIds.researcher, { allow: VOICE_ACCESS }),
    overwrite(roleIds.alumni, { allow: VOICE_ACCESS }),
    overwrite(roleIds.globalPresident, {
      allow: [...VOICE_ACCESS, PermissionFlagsBits.CreateEvents],
    }),
    ...roleIds.universityPresidents.map((id) =>
      overwrite(id, { allow: [...VOICE_ACCESS, PermissionFlagsBits.CreateEvents] }),
    ),
    botOverwrite(roleIds),
  ];
}

export function globalBotLogOverwrites(roleIds) {
  return [
    overwrite(roleIds.everyone, { deny: [PermissionFlagsBits.ViewChannel] }),
    overwrite(roleIds.globalPresident, { allow: BOT_COMMAND_WRITE }),
    botOverwrite(roleIds),
  ];
}

export function globalAnnouncementOverwrites(roleIds) {
  return [
    overwrite(roleIds.everyone, { deny: [PermissionFlagsBits.ViewChannel] }),
    overwrite(roleIds.researcher, { allow: TEXT_READ, deny: [PermissionFlagsBits.SendMessages] }),
    overwrite(roleIds.alumni, { allow: TEXT_READ, deny: [PermissionFlagsBits.SendMessages] }),
    overwrite(roleIds.globalPresident, { allow: TEXT_WRITE }),
    ...roleIds.universityPresidents.map((id) => overwrite(id, { allow: TEXT_WRITE })),
    botOverwrite(roleIds),
  ];
}

export function globalReadOnlyOverwrites(roleIds) {
  const denyWrite = [
    PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.CreatePublicThreads,
    PermissionFlagsBits.CreatePrivateThreads,
    PermissionFlagsBits.SendMessagesInThreads,
  ];
  return [
    overwrite(roleIds.everyone, { deny: [PermissionFlagsBits.ViewChannel] }),
    overwrite(roleIds.researcher, { allow: TEXT_READ, deny: denyWrite }),
    overwrite(roleIds.alumni, { allow: TEXT_READ, deny: denyWrite }),
    overwrite(roleIds.globalPresident, { allow: TEXT_READ, deny: denyWrite }),
    ...roleIds.universityPresidents.map((id) => overwrite(id, { allow: TEXT_READ, deny: denyWrite })),
    botOverwrite(roleIds),
  ];
}

export function globalBoardOverwrites(roleIds) {
  return [
    overwrite(roleIds.everyone, { deny: [PermissionFlagsBits.ViewChannel] }),
    overwrite(roleIds.globalPresident, { allow: TEXT_WRITE }),
    ...roleIds.universityPresidents.map((id) => overwrite(id, { allow: TEXT_WRITE })),
    botOverwrite(roleIds),
  ];
}

export function memberForumOverwrites(roleIds) {
  return [
    overwrite(roleIds.everyone, { deny: [PermissionFlagsBits.ViewChannel] }),
    overwrite(roleIds.researcher, { allow: FORUM_POST }),
    overwrite(roleIds.alumni, { allow: FORUM_POST }),
    overwrite(roleIds.globalPresident, { allow: FORUM_POST }),
    ...roleIds.universityPresidents.map((id) => overwrite(id, { allow: FORUM_POST })),
    botOverwrite(roleIds),
  ];
}

export function showcaseForumOverwrites(roleIds, viewerRoleIds) {
  return [
    overwrite(roleIds.everyone, { deny: [PermissionFlagsBits.ViewChannel] }),
    ...viewerRoleIds.map((id) => overwrite(id, { allow: FORUM_READ_ONLY, deny: FORUM_DENY_POST })),
    botOverwrite(roleIds),
  ];
}

export function universityGeneralOverwrites(roleIds, university) {
  return [
    overwrite(roleIds.everyone, { deny: [PermissionFlagsBits.ViewChannel] }),
    overwrite(roleIds.roles.get(university.universityRole), { allow: TEXT_WRITE }),
    ...universityBoardRoleIds(roleIds, university).map((id) => overwrite(id, { allow: TEXT_WRITE })),
    botOverwrite(roleIds),
  ];
}

export function universityVoiceOverwrites(roleIds, university) {
  return [
    overwrite(roleIds.everyone, { deny: [PermissionFlagsBits.ViewChannel] }),
    overwrite(roleIds.roles.get(university.universityRole), { allow: VOICE_ACCESS }),
    ...universityBoardRoleIds(roleIds, university).map((id) =>
      overwrite(id, { allow: [...VOICE_ACCESS, PermissionFlagsBits.CreateEvents] }),
    ),
    botOverwrite(roleIds),
  ];
}

export function universityAnnouncementOverwrites(roleIds, university) {
  // Local announcements are writable by every board role scoped to this
  // university, including division Heads. Global announcements intentionally
  // use a separate President-only policy above.
  return [
    overwrite(roleIds.everyone, { deny: [PermissionFlagsBits.ViewChannel] }),
    overwrite(roleIds.roles.get(university.universityRole), {
      allow: TEXT_READ,
      deny: [PermissionFlagsBits.SendMessages],
    }),
    ...universityBoardRoleIds(roleIds, university).map((id) => overwrite(id, { allow: TEXT_WRITE })),
    botOverwrite(roleIds),
  ];
}

export function universityBoardOverwrites(roleIds, university) {
  return [
    overwrite(roleIds.everyone, { deny: [PermissionFlagsBits.ViewChannel] }),
    ...universityBoardRoleIds(roleIds, university).map((id) => overwrite(id, { allow: TEXT_WRITE })),
    botOverwrite(roleIds),
  ];
}

export function universityBotLogOverwrites(roleIds, university) {
  return [
    overwrite(roleIds.everyone, { deny: [PermissionFlagsBits.ViewChannel] }),
    ...universityBoardRoleIds(roleIds, university).map((id) => overwrite(id, { allow: BOT_COMMAND_WRITE })),
    botOverwrite(roleIds),
  ];
}

export function universityExecutiveOverwrites(roleIds, university) {
  return [
    overwrite(roleIds.everyone, { deny: [PermissionFlagsBits.ViewChannel] }),
    ...universityBoardRoleIds(roleIds, university).map((id) => overwrite(id, { allow: TEXT_WRITE })),
    botOverwrite(roleIds),
  ];
}

export function universityShowcaseOverwrites(roleIds, university) {
  return [
    overwrite(roleIds.everyone, { deny: [PermissionFlagsBits.ViewChannel] }),
    overwrite(roleIds.roles.get(university.universityRole), {
      allow: FORUM_READ_ONLY,
      deny: FORUM_DENY_POST,
    }),
    ...universityBoardRoleIds(roleIds, university).map((id) =>
      overwrite(id, { allow: FORUM_READ_ONLY, deny: FORUM_DENY_POST }),
    ),
    botOverwrite(roleIds),
  ];
}

export function divisionTextOverwrites(roleIds, university, division) {
  return [
    overwrite(roleIds.everyone, { deny: [PermissionFlagsBits.ViewChannel] }),
    overwrite(roleIds.roles.get(divisionRoleName(university.name, division.name)), { allow: TEXT_WRITE }),
    overwrite(roleIds.roles.get(divisionHeadRoleName(university.name, division.name)), { allow: TEXT_WRITE }),
    overwrite(roleIds.roles.get(university.presidentRole), { allow: TEXT_WRITE }),
    overwrite(roleIds.roles.get(university.vicePresidentRole), { allow: TEXT_WRITE }),
    overwrite(roleIds.globalPresident, { allow: TEXT_WRITE }),
    botOverwrite(roleIds),
  ];
}

export function divisionVoiceOverwrites(roleIds, university, division) {
  return [
    overwrite(roleIds.everyone, { deny: [PermissionFlagsBits.ViewChannel] }),
    overwrite(roleIds.roles.get(divisionRoleName(university.name, division.name)), { allow: VOICE_ACCESS }),
    overwrite(roleIds.roles.get(divisionHeadRoleName(university.name, division.name)), {
      allow: [...VOICE_ACCESS, PermissionFlagsBits.CreateEvents],
    }),
    overwrite(roleIds.roles.get(university.presidentRole), {
      allow: [...VOICE_ACCESS, PermissionFlagsBits.CreateEvents],
    }),
    overwrite(roleIds.roles.get(university.vicePresidentRole), {
      allow: [...VOICE_ACCESS, PermissionFlagsBits.CreateEvents],
    }),
    overwrite(roleIds.globalPresident, { allow: [...VOICE_ACCESS, PermissionFlagsBits.CreateEvents] }),
    botOverwrite(roleIds),
  ];
}

export function logsOverwrites(roleIds) {
  return [
    overwrite(roleIds.everyone, { deny: [PermissionFlagsBits.ViewChannel] }),
    overwrite(roleIds.globalPresident, { allow: TEXT_READ }),
    botOverwrite(roleIds),
  ];
}

export function collectRoleIds(guild, rolesByName, plan) {
  const roles = new Map();
  for (const [name, role] of rolesByName.entries()) roles.set(name, role.id);
  const universityHeadRoleIds = new Map();
  for (const university of plan.universities) {
    const prefix = `${university.name} - Head of `;
    universityHeadRoleIds.set(
      university.name,
      [...guild.roles.cache.values()]
        .filter((role) => role.name.startsWith(prefix))
        .map((role) => role.id),
    );
  }
  return {
    everyone: guild.roles.everyone.id,
    bot: roles.get(ROLE_NAMES.BOT),
    researcher: roles.get(ROLE_NAMES.RESEARCHER),
    alumni: roles.get(ROLE_NAMES.ALUMNI),
    globalPresident: roles.get(ROLE_NAMES.GLOBAL_PRESIDENT),
    universityPresidents: plan.universities
      .map((university) => roles.get(university.presidentRole))
      .filter(Boolean),
    universityHeadRoleIds,
    roles,
  };
}

function universityBoardRoleIds(roleIds, university) {
  return [...new Set([
    roleIds.roles.get(university.presidentRole),
    roleIds.roles.get(university.vicePresidentRole),
    roleIds.globalPresident,
    ...university.divisions.map((division) =>
      roleIds.roles.get(divisionHeadRoleName(university.name, division.name)),
    ),
    ...(roleIds.universityHeadRoleIds?.get(university.name) ?? []),
  ].filter(Boolean))];
}
