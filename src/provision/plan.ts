import { PermissionFlagsBits } from 'discord.js';

import {
  defaultDivisionColorKey,
  divisionColorDetails,
  INITIAL_SERVER_PLAN,
  ROLE_COLORS,
  ROLE_NAMES,
  universityRoleColor,
} from '../constants.js';
import { PROFILE_TAGS } from '../profiles/state.js';
import {
  divisionHeadRoleName,
  divisionRoleName,
  slugify,
  universityBoardRoleName,
  universityCategoryName,
} from '../naming.js';

export const CATEGORY_NAMES = Object.freeze({
  START: 'START HERE',
  GLOBAL: 'GLOBAL BAINSA',
  ARCHIVE: 'ARCHIVE / HISTORY',
  LOGS: 'LOGS',
});

export const GLOBAL_CHANNELS = Object.freeze({
  GENERAL: 'bainsa-general',
  VOICE: 'bainsa-general-room',
  ANNOUNCEMENTS: 'bainsa-announcements',
  BOARD: 'bainsa-board',
  SHOWCASE: 'projects-showcase',
  RESOURCES: 'resources',
  PEOPLE_DIRECTORY: 'people-directory',
  CHANNEL_PROPOSALS: 'channel-proposals',
  ANONYMOUS_FEEDBACK: 'anonymous-feedback',
});

export const START_CHANNELS = Object.freeze({
  WELCOME: 'welcome',
  ONBOARDING: 'onboarding',
});

export const UNIVERSITY_CHANNELS = Object.freeze({
  GENERAL: 'general',
  VOICE: 'general-room',
  ANNOUNCEMENTS: 'announcements',
  BOARD: 'board',
  BOT_LOG: 'bot-log',
  SHOWCASE: 'projects-showcase',
  ONBOARDING_REVIEW: 'onboarding-review',
});

export const LOG_CHANNELS = Object.freeze({
  ADMIN: 'admin-log',
  BOT: 'bot-log',
});

export const DANGEROUS_HUMAN_PERMISSIONS = Object.freeze([
  PermissionFlagsBits.Administrator,
  PermissionFlagsBits.ManageRoles,
  PermissionFlagsBits.ManageChannels,
  PermissionFlagsBits.KickMembers,
  PermissionFlagsBits.BanMembers,
  PermissionFlagsBits.ManageMessages,
  PermissionFlagsBits.ManageThreads,
  PermissionFlagsBits.ManageEvents,
]);

export const BOT_ROLE_PERMISSIONS = Object.freeze([
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.SendMessagesInThreads,
  PermissionFlagsBits.CreatePublicThreads,
  PermissionFlagsBits.CreatePrivateThreads,
  PermissionFlagsBits.ManageRoles,
  PermissionFlagsBits.ManageChannels,
  PermissionFlagsBits.ManageMessages,
  PermissionFlagsBits.ManageThreads,
  PermissionFlagsBits.ManageEvents,
  PermissionFlagsBits.ReadMessageHistory,
  PermissionFlagsBits.Connect,
  PermissionFlagsBits.Speak,
]);

export const TEXT_READ = Object.freeze([
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.ReadMessageHistory,
]);

export const TEXT_WRITE = Object.freeze([
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.ReadMessageHistory,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.SendMessagesInThreads,
  PermissionFlagsBits.CreatePublicThreads,
  PermissionFlagsBits.AttachFiles,
  PermissionFlagsBits.EmbedLinks,
  PermissionFlagsBits.AddReactions,
]);

export const BOT_COMMAND_WRITE = Object.freeze([
  ...TEXT_WRITE,
  PermissionFlagsBits.UseApplicationCommands,
]);

export const VOICE_ACCESS = Object.freeze([
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.Connect,
  PermissionFlagsBits.Speak,
]);

export const FORUM_READ_ONLY = Object.freeze([
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.ReadMessageHistory,
]);

export const FORUM_POST = Object.freeze([
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.ReadMessageHistory,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.SendMessagesInThreads,
  PermissionFlagsBits.CreatePublicThreads,
  PermissionFlagsBits.AttachFiles,
  PermissionFlagsBits.EmbedLinks,
  PermissionFlagsBits.AddReactions,
]);

export const FORUM_DENY_POST = Object.freeze([
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.SendMessagesInThreads,
  PermissionFlagsBits.CreatePublicThreads,
  PermissionFlagsBits.CreatePrivateThreads,
]);

interface ProvisionPlanInput {
  universities?: readonly {
    name?: string;
    divisions?: readonly (string | { name?: string; color?: string })[];
  }[];
}

export function normalizePlan(plan: ProvisionPlanInput = INITIAL_SERVER_PLAN) {
  const universities = [];
  const seenUniversities = new Set();

  for (const university of plan.universities ?? []) {
    const name = university.name?.trim();
    if (!name) continue;
    const universityKey = name.toLowerCase();
    if (seenUniversities.has(universityKey)) continue;
    seenUniversities.add(universityKey);

    const divisions = [];
    const seenDivisions = new Set();
    for (const division of university.divisions ?? []) {
      const divisionName = typeof division === 'string' ? division.trim() : division?.name?.trim();
      if (!divisionName) continue;
      const divisionKey = divisionName.toLowerCase();
      if (seenDivisions.has(divisionKey)) continue;
      seenDivisions.add(divisionKey);
      const color = divisionColorDetails(
        typeof division === 'string' ? defaultDivisionColorKey(divisionName) : division?.color,
      ) ?? divisionColorDetails(defaultDivisionColorKey(divisionName));
      divisions.push({
        name: divisionName,
        slug: slugify(divisionName),
        color: color.key,
        colorHex: color.hex,
        icon: color.icon,
      });
    }

    universities.push({
      name,
      slug: slugify(name),
      categoryName: universityCategoryName(name),
      universityRole: name,
      presidentRole: universityBoardRoleName(name, 'President'),
      vicePresidentRole: universityBoardRoleName(name, 'Vice President'),
      divisions,
    });
  }

  return Object.freeze({ universities });
}

export function mergePersistedDivisionsIntoPlan(plan = INITIAL_SERVER_PLAN, persistedDivisions = []) {
  const normalized = normalizePlan(plan);
  const merged = {
    universities: normalized.universities.map((university) => ({
      name: university.name,
      divisions: university.divisions.map((division) => ({
        name: division.name,
        color: division.color,
      })),
    })),
  };
  const universitiesByName = new Map(
    merged.universities.map((university) => [university.name.toLowerCase(), university]),
  );
  const seenByUniversity = new Map(
    merged.universities.map((university) => [
      university.name.toLowerCase(),
      new Set(university.divisions.flatMap((division) => [
        division.name.toLowerCase(),
        slugify(division.name),
      ])),
    ]),
  );
  const skippedUnknownUniversities = new Set();
  let added = 0;

  for (const row of persistedDivisions ?? []) {
    if (row?.university_active === false || row?.division_active === false || row?.active === false) continue;

    const universityName = String(row?.university_name ?? '').trim();
    const divisionName = String(row?.division_name ?? row?.name ?? '').trim();
    if (!universityName || !divisionName) continue;

    const universityKey = universityName.toLowerCase();
    const university = universitiesByName.get(universityKey);
    if (!university) {
      skippedUnknownUniversities.add(universityName);
      continue;
    }

    const divisionKey = divisionName.toLowerCase();
    const divisionSlug = slugify(divisionName);
    const seenDivisions = seenByUniversity.get(universityKey);
    if (seenDivisions.has(divisionKey) || seenDivisions.has(divisionSlug)) continue;

    const color = divisionColorDetails(row?.division_color ?? row?.color)
      ?? divisionColorDetails(defaultDivisionColorKey(divisionName));
    university.divisions.push({ name: divisionName, color: color.key });
    seenDivisions.add(divisionKey);
    seenDivisions.add(divisionSlug);
    added += 1;
  }

  return {
    plan: normalizePlan(merged),
    added,
    skippedUnknownUniversities: [...skippedUnknownUniversities],
  };
}

export function roleSpecs(plan = INITIAL_SERVER_PLAN) {
  const normalized = normalizePlan(plan);
  const specs = [
    humanRole(ROLE_NAMES.RESEARCHER, { color: ROLE_COLORS.RESEARCHER }),
    humanRole(ROLE_NAMES.ALUMNI, { color: ROLE_COLORS.ALUMNI }),
    humanRole(ROLE_NAMES.GLOBAL_PRESIDENT, {
      color: ROLE_COLORS.GLOBAL_PRESIDENT,
      permissions: PermissionFlagsBits.CreateEvents,
      legacyAliases: ['Global Admin', 'Global President'],
    }),
    {
      name: ROLE_NAMES.BOT,
      permissions: BOT_ROLE_PERMISSIONS,
      hoist: true,
      mentionable: false,
      legacyAliases: ['BAINSA Bot', 'Bot'],
      human: false,
    },
  ];

  for (const university of normalized.universities) {
    specs.push(
      humanRole(university.universityRole, {
        color: universityRoleColor(university.name),
        legacyAliases: [`${university.name} | Member`, `${university.name} | Alumni`, university.name],
      }),
      humanRole(university.presidentRole, {
        color: universityRoleColor(university.name),
        permissions: PermissionFlagsBits.CreateEvents,
        legacyAliases: [`${university.name} | President`, `${university.name} President`],
      }),
      humanRole(university.vicePresidentRole, {
        color: universityRoleColor(university.name),
        legacyAliases: [
          `${university.name} | Vice-President`,
          `${university.name} | Vice President`,
          `${university.name} Vice-President`,
          `${university.name} Vice President`,
        ],
      }),
    );

    for (const division of university.divisions) {
      specs.push(
        humanRole(divisionRoleName(university.name, division.name), {
          color: division.colorHex,
          legacyAliases: [
            `${university.name} | ${division.name}`,
            `${university.name} ${division.name}`,
          ],
        }),
        humanRole(divisionHeadRoleName(university.name, division.name), {
          color: division.colorHex,
          legacyAliases: [
            `${university.name} | ${division.name} Head`,
            `${university.name} ${division.name} Head`,
            `${university.name} - ${division.name} Head`,
          ],
        }),
      );
    }
  }

  return specs;
}

function humanRole(name, extra = {}) {
  return {
    name,
    permissions: 0n,
    hoist: false,
    mentionable: false,
    color: null,
    human: true,
    legacyAliases: [],
    ...extra,
  };
}

export function globalForumTags() {
  return [
    { name: 'Projects' },
    { name: 'Research' },
    { name: 'Events' },
    { name: 'Resources' },
    { name: 'Question' },
  ];
}

/**
 * The people-directory taxonomy is deliberately supplied by the profile
 * domain. Keeping the provisioning boundary as a small adapter ensures the
 * Discord labels and the persisted profile keys cannot drift apart.
 */
export function peopleDirectoryForumTags() {
  if (PROFILE_TAGS.length !== 14) {
    throw new Error('The people-directory taxonomy must contain exactly 14 managed tags.');
  }
  const labels = PROFILE_TAGS.map((tag) => String(tag.label ?? '').trim());
  if (labels.some((label) => !label || label.length > 20)) {
    throw new Error('People-directory tag labels must be non-empty and at most 20 characters.');
  }
  if (new Set(labels.map((label) => label.toLowerCase())).size !== labels.length) {
    throw new Error('People-directory tag labels must be unique.');
  }
  return labels.map((name) => ({ name }));
}

export function universityForumTags(university) {
  return [
    ...university.divisions.map((division) => ({ name: division.name })),
    { name: 'Active' },
    { name: 'Completed' },
  ];
}

export function legacyChannelAliasesForUniversity(university) {
  return {
    general: [`${university.slug}-general`],
    announcements: [`${university.slug}-announcements`],
    board: [`${university.slug}-board`],
    onboardingReview: [`${university.slug}-onboarding-review`],
  };
}

export function legacyDivisionTextAliases(university, division) {
  return [
    division.slug,
    `${university.slug}-${division.slug}`,
    `${university.slug}-${division.slug}-general`,
    `${division.slug}-general`,
    `${division.name} General`,
    `${division.name} Registry`,
    `${division.slug}-registry`,
  ];
}

export function legacyDivisionVoiceAliases(university, division) {
  return [
    `${division.slug}-room`,
    `${university.slug}-${division.slug}-room`,
    `${university.slug}-${division.slug}-voice`,
    `${division.name} Room`,
  ];
}
