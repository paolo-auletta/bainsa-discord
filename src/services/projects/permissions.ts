import { OverwriteType, PermissionFlagsBits } from 'discord.js';

import { PROJECT_PERSON_ROLES } from '../../constants.js';

export const PROJECT_MEMBER_PERMISSIONS = Object.freeze([
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.ReadMessageHistory,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.SendMessagesInThreads,
  PermissionFlagsBits.EmbedLinks,
  PermissionFlagsBits.AttachFiles,
  PermissionFlagsBits.AddReactions,
  PermissionFlagsBits.CreatePublicThreads,
]);

export const PROJECT_BOARD_PERMISSIONS = Object.freeze([
  ...PROJECT_MEMBER_PERMISSIONS,
]);

const WRITE_PERMISSIONS = Object.freeze([
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.SendMessagesInThreads,
]);

interface ProjectPermissionOverwrite {
  id: string;
  type: OverwriteType;
  allow?: readonly bigint[];
  deny?: readonly bigint[];
}

export function uniqueIds(values: readonly unknown[]): string[] {
  return [...new Set(values.filter(Boolean).map(String))];
}

export function buildProjectPermissionOverwrites({
  guildId,
  memberIds = [],
  supervisorIds = [],
  boardLiaisonIds = [],
  boardRoleIds = [],
  globalPresidentRoleId = null,
  botRoleId = null,
  locked = false,
  archived = false,
}) {
  const canSendMembers = !locked && !archived;
  const projectPeople = [
    ...memberIds.map((id) => ({ id, role: PROJECT_PERSON_ROLES.MEMBER })),
    ...supervisorIds.map((id) => ({ id, role: PROJECT_PERSON_ROLES.SUPERVISOR })),
    ...boardLiaisonIds.map((id) => ({ id, role: PROJECT_PERSON_ROLES.BOARD_LIAISON })),
  ];
  const peopleById = new Map();
  for (const person of projectPeople) {
    const existing = peopleById.get(String(person.id));
    if (!existing || existing === PROJECT_PERSON_ROLES.MEMBER) peopleById.set(String(person.id), person.role);
  }

  const overwrites: ProjectPermissionOverwrite[] = [
    {
      id: String(guildId),
      type: OverwriteType.Role,
      deny: archived ? [PermissionFlagsBits.ViewChannel, ...WRITE_PERMISSIONS] : [PermissionFlagsBits.ViewChannel],
    },
  ];

  for (const [id, role] of peopleById) {
    const canSend =
      role === PROJECT_PERSON_ROLES.SUPERVISOR || role === PROJECT_PERSON_ROLES.BOARD_LIAISON
        ? !archived
        : canSendMembers;
    overwrites.push({
      id,
      type: OverwriteType.Member,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.EmbedLinks,
        PermissionFlagsBits.AttachFiles,
        PermissionFlagsBits.AddReactions,
        PermissionFlagsBits.CreatePublicThreads,
        ...(canSend ? WRITE_PERMISSIONS : []),
      ],
      deny: canSend ? [] : WRITE_PERMISSIONS,
    });
  }

  for (const id of uniqueIds([...boardRoleIds, globalPresidentRoleId ? [globalPresidentRoleId] : []])) {
    overwrites.push({
      id,
      type: OverwriteType.Role,
      allow: archived ? PROJECT_BOARD_PERMISSIONS.filter((permission) => !WRITE_PERMISSIONS.includes(permission)) : PROJECT_BOARD_PERMISSIONS,
      deny: archived ? WRITE_PERMISSIONS : [],
    });
  }

  if (botRoleId) {
    overwrites.push({
      id: botRoleId,
      type: OverwriteType.Role,
      allow: PROJECT_BOARD_PERMISSIONS,
    });
  }

  return overwrites;
}

export function projectPersonIdsByRole(people) {
  return {
    memberIds: people.filter((person) => person.role === PROJECT_PERSON_ROLES.MEMBER).map((person) => person.discord_user_id),
    supervisorIds: people
      .filter((person) => person.role === PROJECT_PERSON_ROLES.SUPERVISOR)
      .map((person) => person.discord_user_id),
    boardLiaisonIds: people
      .filter((person) => person.role === PROJECT_PERSON_ROLES.BOARD_LIAISON)
      .map((person) => person.discord_user_id),
  };
}
