export {
  CATEGORY_NAMES,
  GLOBAL_CHANNELS,
  LOG_CHANNELS,
  START_CHANNELS,
  UNIVERSITY_CHANNELS,
  normalizePlan,
  mergePersistedDivisionsIntoPlan,
  roleSpecs,
  globalForumTags,
  universityForumTags,
  legacyChannelAliasesForUniversity,
  legacyDivisionTextAliases,
  legacyDivisionVoiceAliases,
} from './plan.js';
export {
  stripDangerousHumanPermissions,
  startHereOverwrites,
  privateBaseOverwrites,
  globalGeneralOverwrites,
  globalAnnouncementOverwrites,
  globalBotLogOverwrites,
  globalBoardOverwrites,
  memberForumOverwrites,
  showcaseForumOverwrites,
  universityGeneralOverwrites,
  universityAnnouncementOverwrites,
  universityBoardOverwrites,
  universityBotLogOverwrites,
  universityExecutiveOverwrites,
  universityShowcaseOverwrites,
  divisionTextOverwrites,
  divisionVoiceOverwrites,
  logsOverwrites,
} from './permissions.js';
export { normalizeComparableName, ignoredLegacyWarnings } from './legacy.js';
export { reconcileExistingMembers, recognizeMemberFromRoles } from './members.js';
export { provisionDiscord, createProvisionClient, DiscordProvisioner } from './discord.js';
