import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Client,
  ForumLayoutType,
  GatewayIntentBits,
  PermissionFlagsBits,
} from 'discord.js';

import {
  FORUM_GUIDE_THREAD_NAME,
  divisionSeed,
  globalSeeds,
  seedMarker,
  startHereSeeds,
  universitySeeds,
} from '../content/seeds.js';
import { divisionColorDetails, ROLE_NAMES, universityRoleColor } from '../constants.js';
import {
  divisionHeadRoleName,
  divisionRoleName,
  divisionTextChannelName,
  divisionVoiceChannelName,
  slugify,
} from '../naming.js';
import { PROFILE_CUSTOM_IDS } from '../profiles/custom-ids.js';
import { upsertProvisionedResources } from './db.js';
import {
  globalForumTags,
  legacyChannelAliasesForUniversity,
  legacyDivisionTextAliases,
  legacyDivisionVoiceAliases,
  mergePersistedDivisionsIntoPlan,
  normalizePlan,
  peopleDirectoryForumTags,
  roleSpecs,
  universityForumTags,
  CATEGORY_NAMES,
  GLOBAL_CHANNELS,
  LOG_CHANNELS,
  START_CHANNELS,
  UNIVERSITY_CHANNELS,
} from './plan.js';
import {
  collectRoleIds,
  divisionTextOverwrites,
  divisionVoiceOverwrites,
  globalAnnouncementOverwrites,
  globalBotLogOverwrites,
  globalBoardOverwrites,
  globalGeneralOverwrites,
  globalVoiceOverwrites,
  globalReadOnlyOverwrites,
  logsOverwrites,
  memberForumOverwrites,
  peopleDirectoryForumOverwrites,
  privateBaseOverwrites,
  showcaseForumOverwrites,
  startHereOverwrites,
  universityAnnouncementOverwrites,
  universityBoardOverwrites,
  universityBotLogOverwrites,
  universityExecutiveOverwrites,
  universityGeneralOverwrites,
  universityVoiceOverwrites,
  universityShowcaseOverwrites,
} from './permissions.js';
import { ignoredLegacyWarnings } from './legacy.js';
import { reconcileExistingMembers } from './members.js';

type ForumTagInput = {
  id?: string;
  name: string;
  moderated?: boolean;
  emoji?: unknown;
};

type ChannelProvisionOptions = {
  type: ChannelType;
  parent?: { id?: string } | null;
  overwrites?: unknown[];
  aliases?: string[];
  tags?: ForumTagInput[];
  exactTags?: boolean;
  defaultForumLayout?: ForumLayoutType;
  defaultAutoArchiveDuration?: number;
};

type ForumProvisionOptions = Omit<ChannelProvisionOptions, 'type'>;

type SeedMessageOptions = {
  components?: readonly unknown[];
  pin?: boolean;
  legacyKeys?: readonly string[];
  legacyHeadings?: readonly string[];
};

export function createProvisionClient() {
  return new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
  });
}

export async function provisionDiscord({
  client,
  config,
  db,
  dryRun = false,
  plan: rawPlan,
  logger = console,
}) {
  const provisioner = new DiscordProvisioner({ client, config, db, dryRun, plan: rawPlan, logger });
  return provisioner.run();
}

export class DiscordProvisioner {
  client;
  config;
  db;
  dryRun;
  plan;
  logger;
  summary;
  guildId;
  persistedDivisionPlanAvailable;
  colorSyncAvailable;
  divisionPermissionSyncAvailable;
  seedTrackingAvailable;

  constructor({ client, config, db, dryRun, plan, logger }) {
    this.client = client;
    this.config = config;
    this.db = db;
    this.dryRun = dryRun;
    this.plan = normalizePlan(plan);
    this.logger = logger;
    this.summary = {
      dryRun,
      roles: { created: 0, adopted: 0, updated: 0, unchanged: 0 },
      channels: { created: 0, adopted: 0, updated: 0, deleted: 0, unchanged: 0 },
      seeds: { created: 0, updated: 0, unchanged: 0 },
      database: null,
      warnings: [],
      actions: [],
    };
  }

  async run() {
    const guild = await this.fetchGuild();
    this.guildId = guild.id;
    await this.validateAuthority(guild);
    await this.loadPersistedDivisionsIntoPlan();

    const rolesByName = await this.ensureRoles(guild);
    await this.syncPersistedRoleColors(guild);
    const roleIds = collectRoleIds(guild, rolesByName, this.plan);
    const resources = await this.ensureStructure(guild, roleIds);
    this.summary.database = await upsertProvisionedResources(this.db, resources, {
      dryRun: this.dryRun,
    });
    await this.syncPersistedDivisionChannelPermissions(guild, this.plan);
    this.summary.warnings.push(...ignoredLegacyWarnings(guild));
    this.summary.members = await reconcileExistingMembers({
      guild,
      rolesByName,
      plan: this.plan,
      db: this.db,
      resources,
      dryRun: this.dryRun,
    });
    this.logSummary();
    return this.summary;
  }

  async fetchGuild() {
    const guild = await this.client.guilds.fetch(this.config.discordGuildId);
    await guild.roles.fetch();
    await guild.channels.fetch();
    await guild.members.fetchMe();
    return guild;
  }

  async loadPersistedDivisionsIntoPlan() {
    if (!this.db || this.persistedDivisionPlanAvailable === false) return;
    try {
      const result = await this.db.query(
        `SELECT u.name AS university_name,
                u.active AS university_active,
                d.name AS division_name,
                d.color AS division_color,
                d.active AS division_active
           FROM universities u
           JOIN divisions d ON d.university_id = u.id
          WHERE u.active = true
            AND d.active = true
          ORDER BY lower(u.name), lower(d.name)`,
      );
      const merged = mergePersistedDivisionsIntoPlan(this.plan, result.rows);
      this.plan = merged.plan;
      if (merged.added > 0) {
        this.summary.actions.push({ action: 'plan.updated', label: `persisted-divisions:${merged.added}` });
      }
      for (const universityName of merged.skippedUnknownUniversities) {
        this.summary.warnings.push({
          type: 'persisted_division_university_skipped',
          university: universityName,
          reason: 'University is not present in the provisioning plan.',
        });
      }
      this.persistedDivisionPlanAvailable = true;
    } catch (error) {
      if (this.persistedDivisionPlanAvailable !== false) {
        this.persistedDivisionPlanAvailable = false;
        this.summary.warnings.push({ type: 'persisted_division_plan_unavailable', reason: error.message });
      }
    }
  }

  async validateAuthority(guild) {
    const me = guild.members.me;
    if (!me) throw new Error('Could not resolve the bot guild member.');
    const required = [PermissionFlagsBits.ManageRoles, PermissionFlagsBits.ManageChannels];
    const missing = required.filter((permission) => !me.permissions.has(permission));
    if (missing.length > 0) {
      throw new Error('Bot is missing ManageRoles or ManageChannels in the target guild.');
    }
  }

  async ensureRoles(guild) {
    const rolesByName = new Map();
    for (const spec of roleSpecs({ universities: this.plan.universities })) {
      const role = await this.ensureRole(guild, spec);
      rolesByName.set(spec.name, role);
    }
    await this.tryAttachBotRole(guild, rolesByName.get(ROLE_NAMES.BOT));
    return rolesByName;
  }

  async ensureRole(guild, spec) {
    const match = findRole(guild, spec.name, spec.legacyAliases);
    if (!match.role) {
      this.record('roles', 'created', `role:${spec.name}`);
      if (this.dryRun) return dryRole(spec.name);
      return guild.roles.create({
        name: spec.name,
        permissions: spec.permissions,
        ...(spec.color ? { colors: { primaryColor: spec.color } } : {}),
        hoist: spec.hoist,
        mentionable: spec.mentionable,
        reason: 'BAINSA v1 provisioning',
      });
    }

    const role = match.role;
    if (match.legacy) this.record('roles', 'adopted', `role:${role.name}->${spec.name}`);

    const edits: Record<string, unknown> = {};
    if (role.name !== spec.name && role.editable) edits.name = spec.name;
    const desiredPermissions = permissionBitfield(spec.permissions);
    if (role.permissions?.bitfield !== desiredPermissions && role.editable) {
      edits.permissions = desiredPermissions;
    }
    if (role.hoist !== spec.hoist && role.editable) edits.hoist = spec.hoist;
    if (role.mentionable !== spec.mentionable && role.editable) edits.mentionable = spec.mentionable;
    if (spec.color && normalizeRoleColor(role) !== normalizeRoleColor(spec.color) && role.editable) {
      edits.colors = { primaryColor: spec.color };
    }

    if (Object.keys(edits).length === 0) {
      if (!match.legacy) this.record('roles', 'unchanged', `role:${spec.name}`);
      return role;
    }

    this.record('roles', 'updated', `role:${role.name}`);
    if (this.dryRun) return role;
    return role.edit({ ...edits, reason: 'BAINSA v1 provisioning' });
  }

  async tryAttachBotRole(guild, botRole) {
    if (!botRole || this.dryRun) return;
    const me = guild.members.me;
    if (!me) return;
    const highestBefore = me.roles.highest;
    try {
      if (!me.roles.cache.has(botRole.id)) {
        await me.roles.add(botRole, 'BAINSA bot role assignment');
      }
      const targetPosition = Math.max(1, highestBefore.position - 1);
      if (botRole.editable && botRole.position < targetPosition && highestBefore.id !== botRole.id) {
        await botRole.setPosition(targetPosition, 'BAINSA bot role hierarchy');
      }
    } catch (error) {
      this.summary.warnings.push({
        type: 'bot_role_assignment_skipped',
        reason: error.message,
      });
    }
  }

  async syncPersistedRoleColors(guild) {
    if (!this.db || this.colorSyncAvailable === false) return;
    try {
      const result = await this.db.query(
        `SELECT u.name AS university_name,
                d.name AS division_name,
                d.color AS division_color,
                d.member_role_id,
                d.head_role_id
           FROM universities u
           LEFT JOIN divisions d
             ON d.university_id = u.id
            AND d.active = true
          WHERE u.active = true`,
      );
      const desiredRoleColors = [];
      const pushRoleColor = (name, color, id = null) => {
        if (!name || !color) return;
        if (desiredRoleColors.some((entry) => entry.name === name && entry.id === id)) return;
        desiredRoleColors.push({ name, color, id });
      };
      for (const row of result.rows) {
        const universityColor = universityRoleColor(row.university_name);
        pushRoleColor(row.university_name, universityColor);
        pushRoleColor(`${row.university_name} - President`, universityColor);
        pushRoleColor(`${row.university_name} - Vice President`, universityColor);
        if (row.division_name) {
          const divisionColor = divisionColorDetails(row.division_color)?.hex;
          pushRoleColor(divisionRoleName(row.university_name, row.division_name), divisionColor, row.member_role_id);
          pushRoleColor(divisionHeadRoleName(row.university_name, row.division_name), divisionColor, row.head_role_id);
        }
      }
      for (const { name, color, id } of desiredRoleColors) {
        const role = (id ? guild.roles.cache.get(id) : null) ?? guild.roles.cache.find((candidate) => candidate.name === name);
        if (!role || !role.editable || normalizeRoleColor(role) === normalizeRoleColor(color)) continue;
        if (this.dryRun) {
          this.record('roles', 'updated', `role:${name}`);
          continue;
        }
        await role.edit({ colors: { primaryColor: color }, reason: 'BAINSA university role color sync' });
        this.record('roles', 'updated', `role:${name}`);
      }
      this.colorSyncAvailable = true;
    } catch (error) {
      if (this.colorSyncAvailable !== false) {
        this.colorSyncAvailable = false;
        this.summary.warnings.push({ type: 'role_color_sync_unavailable', reason: error.message });
      }
    }
  }

  async syncPersistedDivisionChannelPermissions(guild, plan) {
    if (!this.db || this.dryRun || this.divisionPermissionSyncAvailable === false) return;
    try {
      const result = await this.db.query(
        `SELECT u.name AS university_name,
                d.name AS division_name,
                d.color AS division_color,
                d.text_channel_id,
                d.voice_channel_id
           FROM universities u
           JOIN divisions d ON d.university_id = u.id
          WHERE u.active = true AND d.active = true`,
      );
      const allRoles = new Map([...guild.roles.cache.values()].map((role) => [role.name, role]));
      const roleIds = collectRoleIds(guild, allRoles, plan);
      for (const row of result.rows) {
        const university = {
          name: row.university_name,
          presidentRole: `${row.university_name} - President`,
          vicePresidentRole: `${row.university_name} - Vice President`,
        };
        const division = { name: row.division_name, color: row.division_color };
        const text = row.text_channel_id
          ? await guild.channels.fetch(row.text_channel_id).catch(() => null)
          : null;
        const voice = row.voice_channel_id
          ? await guild.channels.fetch(row.voice_channel_id).catch(() => null)
          : null;
        if (text?.permissionOverwrites && text.type === ChannelType.GuildText) {
          const desired = divisionTextOverwrites(roleIds, university, division);
          if (!samePermissionOverwrites(text, desired)) {
            await text.permissionOverwrites.set(desired, 'BAINSA division permission reconciliation');
          }
          await renamePersistedDivisionChannel(
            text,
            divisionTextChannelName(row.division_name, row.division_color),
            'BAINSA division channel name reconciliation',
          );
        }
        if (voice?.permissionOverwrites && voice.type === ChannelType.GuildVoice) {
          const desired = divisionVoiceOverwrites(roleIds, university, division);
          if (!samePermissionOverwrites(voice, desired)) {
            await voice.permissionOverwrites.set(desired, 'BAINSA division permission reconciliation');
          }
          await renamePersistedDivisionChannel(
            voice,
            divisionVoiceChannelName(row.division_name, row.division_color),
            'BAINSA division channel name reconciliation',
          );
        }
      }
      this.divisionPermissionSyncAvailable = true;
    } catch (error) {
      if (this.divisionPermissionSyncAvailable !== false) {
        this.divisionPermissionSyncAvailable = false;
        this.summary.warnings.push({ type: 'division_permission_sync_unavailable', reason: error.message });
      }
    }
  }

  async ensureStructure(guild, roleIds) {
    const startSeeds = startHereSeeds();
    const globalSeedContent = globalSeeds({
      anonymousFeedbackUrl: this.config.anonymousFeedbackUrl,
    });
    const resources = { universities: [] };

    const startCategory = await this.ensureCategory(guild, CATEGORY_NAMES.START, {
      overwrites: startHereOverwrites(roleIds),
    });
    const welcome = await this.ensureTextChannel(guild, START_CHANNELS.WELCOME, {
      parent: startCategory,
      overwrites: startHereOverwrites(roleIds),
    });
    const onboarding = await this.ensureTextChannel(guild, START_CHANNELS.ONBOARDING, {
      parent: startCategory,
      overwrites: startHereOverwrites(roleIds),
    });
    await this.seedMessage(welcome, 'start:welcome', startSeeds.welcome);
    await this.seedMessage(onboarding, 'start:onboarding', startSeeds.onboarding, {
      components: onboardingButtonRows(),
    });
    await this.retireStartHereChannels(guild, startCategory);

    const globalCategory = await this.ensureCategory(guild, CATEGORY_NAMES.GLOBAL, {
      overwrites: privateBaseOverwrites(roleIds),
    });
    const globalGeneral = await this.ensureTextChannel(guild, GLOBAL_CHANNELS.GENERAL, {
      parent: globalCategory,
      aliases: ['general'],
      overwrites: globalGeneralOverwrites(roleIds),
    });
    await this.ensureVoiceChannel(guild, GLOBAL_CHANNELS.VOICE, {
      parent: globalCategory,
      overwrites: globalVoiceOverwrites(roleIds),
    });
    const globalAnnouncements = await this.ensureTextChannel(guild, GLOBAL_CHANNELS.ANNOUNCEMENTS, {
      parent: globalCategory,
      type: ChannelType.GuildText,
      aliases: ['announcements'],
      overwrites: globalAnnouncementOverwrites(roleIds),
    });
    const globalBoard = await this.ensureTextChannel(guild, GLOBAL_CHANNELS.BOARD, {
      parent: globalCategory,
      aliases: ['global-admins', 'all-university-management'],
      overwrites: globalBoardOverwrites(roleIds),
    });
    const globalShowcase = await this.ensureForumChannel(guild, GLOBAL_CHANNELS.SHOWCASE, {
      parent: globalCategory,
      aliases: ['bainsa-work-overview'],
      overwrites: showcaseForumOverwrites(roleIds, [
        roleIds.researcher,
        roleIds.alumni,
        roleIds.globalPresident,
        ...roleIds.universityPresidents,
      ].filter(Boolean)),
      tags: globalForumTags(),
    });
    const resourcesForum = await this.ensureForumChannel(guild, GLOBAL_CHANNELS.RESOURCES, {
      parent: globalCategory,
      overwrites: memberForumOverwrites(roleIds),
      tags: globalForumTags(),
    });
    const peopleDirectoryForum = await this.ensureForumChannel(guild, GLOBAL_CHANNELS.PEOPLE_DIRECTORY, {
      parent: globalCategory,
      overwrites: peopleDirectoryForumOverwrites(roleIds),
      tags: peopleDirectoryForumTags(),
      exactTags: true,
      defaultForumLayout: ForumLayoutType.ListView,
      defaultAutoArchiveDuration: 10080,
    });
    const channelProposalsForum = await this.ensureForumChannel(guild, GLOBAL_CHANNELS.CHANNEL_PROPOSALS, {
      parent: globalCategory,
      aliases: ['topic-proposals'],
      overwrites: memberForumOverwrites(roleIds),
      tags: globalForumTags(),
    });
    const feedback = await this.ensureTextChannel(guild, GLOBAL_CHANNELS.ANONYMOUS_FEEDBACK, {
      parent: globalCategory,
      overwrites: globalReadOnlyOverwrites(roleIds),
    });
    await this.seedMessage(globalGeneral, 'global:general', globalSeedContent.general);
    await this.seedMessage(globalAnnouncements, 'global:announcements', globalSeedContent.announcements);
    await this.seedMessage(globalBoard, 'global:board', globalSeedContent.board);
    await this.seedForumGuide(globalShowcase, 'global:showcase', globalSeedContent.showcase);
    await this.seedForumGuide(resourcesForum, 'global:resources', globalSeedContent.resources);
    await this.seedForumGuide(
      peopleDirectoryForum,
      'global:people-directory',
      globalSeedContent.peopleDirectory,
      { components: [peopleDirectoryButtonRow()] },
    );
    await this.seedForumGuide(
      channelProposalsForum,
      'global:channel-proposals',
      globalSeedContent.channelProposals,
      {
        legacyKeys: ['global:topic-proposals'],
        legacyHeadings: ['# Topic Proposals'],
      },
    );
    await this.seedMessage(feedback, 'global:anonymous-feedback', globalSeedContent.anonymousFeedback);

    for (const university of this.plan.universities) {
      const universityRecord = await this.ensureUniversity(guild, roleIds, university);
      resources.universities.push(universityRecord);
    }

    await this.ensureCategory(guild, CATEGORY_NAMES.ARCHIVE, {
      overwrites: logsOverwrites(roleIds),
    });
    const logsCategory = await this.ensureCategory(guild, CATEGORY_NAMES.LOGS, {
      aliases: ['ADMIN / LOGS'],
      overwrites: logsOverwrites(roleIds),
    });
    await this.ensureTextChannel(guild, LOG_CHANNELS.ADMIN, {
      parent: logsCategory,
      overwrites: logsOverwrites(roleIds),
    });
    const globalBotLog = await this.ensureTextChannel(guild, LOG_CHANNELS.BOT, {
      parent: logsCategory,
      overwrites: globalBotLogOverwrites(roleIds),
    });
    await this.seedMessage(globalBotLog, 'global:bot-log', globalSeedContent.botLog, { pin: true });

    return resources;
  }

  async ensureUniversity(guild, roleIds, university) {
    const seeds = universitySeeds(university.name);
    const aliases = legacyChannelAliasesForUniversity(university);
    const category = await this.ensureCategory(guild, university.categoryName, {
      overwrites: privateBaseOverwrites(roleIds),
    });
    const general = await this.ensureTextChannel(guild, UNIVERSITY_CHANNELS.GENERAL, {
      parent: category,
      aliases: aliases.general,
      overwrites: universityGeneralOverwrites(roleIds, university),
    });
    const voice = await this.ensureVoiceChannel(guild, UNIVERSITY_CHANNELS.VOICE, {
      parent: category,
      overwrites: universityVoiceOverwrites(roleIds, university),
    });
    const announcements = await this.ensureTextChannel(guild, UNIVERSITY_CHANNELS.ANNOUNCEMENTS, {
      parent: category,
      type: ChannelType.GuildText,
      aliases: aliases.announcements,
      overwrites: universityAnnouncementOverwrites(roleIds, university),
    });
    const board = await this.ensureTextChannel(guild, UNIVERSITY_CHANNELS.BOARD, {
      parent: category,
      aliases: aliases.board,
      overwrites: universityBoardOverwrites(roleIds, university),
    });
    const botLog = await this.ensureTextChannel(guild, UNIVERSITY_CHANNELS.BOT_LOG, {
      parent: category,
      overwrites: universityBotLogOverwrites(roleIds, university),
    });
    const showcase = await this.ensureForumChannel(guild, UNIVERSITY_CHANNELS.SHOWCASE, {
      parent: category,
      overwrites: universityShowcaseOverwrites(roleIds, university),
      tags: universityForumTags(university),
    });
    const onboardingReview = await this.ensureTextChannel(guild, UNIVERSITY_CHANNELS.ONBOARDING_REVIEW, {
      parent: category,
      aliases: aliases.onboardingReview,
      overwrites: universityExecutiveOverwrites(roleIds, university),
    });

    await this.seedMessage(general, `university:${university.name}:general`, seeds.general);
    await this.seedMessage(announcements, `university:${university.name}:announcements`, seeds.announcements);
    await this.seedMessage(board, `university:${university.name}:board`, seeds.board);
    await this.seedMessage(
      botLog,
      `university:${university.name}:bot-log`,
      seeds.botLog,
      { pin: true },
    );
    await this.seedForumGuide(showcase, `university:${university.name}:showcase`, seeds.showcase);
    await this.seedMessage(
      onboardingReview,
      `university:${university.name}:onboarding-review`,
      seeds.onboardingReview,
    );

    const divisionRecords = [];
    for (const division of university.divisions) {
      const textChannel = await this.ensureTextChannel(guild, divisionTextChannelName(division.name, division.color), {
        parent: category,
        aliases: legacyDivisionTextAliases(university, division),
        overwrites: divisionTextOverwrites(roleIds, university, division),
      });
      const voiceChannel = await this.ensureVoiceChannel(guild, divisionVoiceChannelName(division.name, division.color), {
        parent: category,
        aliases: legacyDivisionVoiceAliases(university, division),
        overwrites: divisionVoiceOverwrites(roleIds, university, division),
      });
      await this.seedMessage(
        textChannel,
        `division:${university.name}:${division.name}`,
        divisionSeed(university.name, division.name, division.icon),
      );
      divisionRecords.push({
        name: division.name,
        slug: division.slug,
        color: division.color,
        colorHex: division.colorHex,
        icon: division.icon,
        roleId: roleIds.roles.get(divisionRoleName(university.name, division.name)),
        headRoleId: roleIds.roles.get(divisionHeadRoleName(university.name, division.name)),
        textChannelId: textChannel.id,
        voiceChannelId: voiceChannel.id,
      });
    }

    return {
      name: university.name,
      slug: university.slug,
      roleId: roleIds.roles.get(university.universityRole),
      categoryId: category.id,
      generalChannelId: general.id,
      voiceChannelId: voice.id,
      announcementsChannelId: announcements.id,
      boardChannelId: board.id,
      showcaseChannelId: showcase.id,
      onboardingReviewChannelId: onboardingReview.id,
      divisions: divisionRecords,
    };
  }

  async ensureCategory(guild, name, { overwrites = [], aliases = [] } = {}) {
    return this.ensureChannel(guild, name, {
      type: ChannelType.GuildCategory,
      overwrites,
      aliases,
    });
  }

  async ensureTextChannel(guild, name, {
    parent = null,
    type = ChannelType.GuildText,
    overwrites = [],
    aliases = [],
  } = {}) {
    return this.ensureChannel(guild, name, { parent, type, overwrites, aliases });
  }

  async ensureVoiceChannel(guild, name, { parent = null, overwrites = [], aliases = [] } = {}) {
    return this.ensureChannel(guild, name, {
      parent,
      type: ChannelType.GuildVoice,
      overwrites,
      aliases,
    });
  }

  async retireStartHereChannels(guild, startCategory) {
    const retiredNames = new Set(['rules', 'discord-structure', 'how-discord-works']);
    const retiredChannels = [...guild.channels.cache.values()].filter(
      (channel) =>
        channel.type === ChannelType.GuildText &&
        channel.parentId === startCategory.id &&
        retiredNames.has(channel.name),
    );

    for (const channel of retiredChannels) {
      this.record('channels', 'deleted', `channel:${channel.name}`);
      if (!this.dryRun) {
        await channel.delete('BAINSA member guidance was consolidated into #welcome');
      }
    }
  }

  async ensureForumChannel(guild, name, options: ForumProvisionOptions = {}) {
    const {
      parent = null,
      overwrites = [],
      aliases = [],
      tags = [],
      exactTags = false,
      defaultForumLayout,
      defaultAutoArchiveDuration,
    } = options;
    return this.ensureChannel(guild, name, {
      parent,
      type: ChannelType.GuildForum,
      overwrites,
      aliases,
      tags,
      exactTags,
      defaultForumLayout,
      defaultAutoArchiveDuration,
    });
  }

  async ensureChannel(guild, name, options: ChannelProvisionOptions) {
    const {
      type,
      parent = null,
      overwrites = [],
      aliases = [],
      tags = [],
      exactTags = false,
      defaultForumLayout,
      defaultAutoArchiveDuration,
    } = options;
    const match = findChannel(guild, { name, type, parent, aliases });
    if (!match.channel) {
      this.record('channels', 'created', `channel:${name}`);
      if (this.dryRun) return dryChannel(name, type, parent?.id);
      const extra = type === ChannelType.GuildForum
        ? {
          availableTags: normalizeForumTags(tags),
          ...(defaultForumLayout === undefined ? {} : { defaultForumLayout }),
          ...(defaultAutoArchiveDuration === undefined ? {} : { defaultAutoArchiveDuration }),
        }
        : {};
      return guild.channels.create({
        name,
        type,
        parent: parent?.id,
        permissionOverwrites: overwrites,
        reason: 'BAINSA v1 provisioning',
        ...extra,
      });
    }

    const channel = match.channel;
    if (match.legacy) this.record('channels', 'adopted', `channel:${channel.name}->${name}`);

    const edits: Record<string, unknown> = {};
    if (channel.name !== name) edits.name = name;
    if (parent?.id && channel.parentId !== parent.id) edits.parent = parent.id;
    if (type === ChannelType.GuildForum) {
      const desiredTags = exactTags
        ? exactForumTags(channel.availableTags ?? [], tags)
        : mergeForumTags(channel.availableTags ?? [], tags);
      if (!sameForumTags(channel.availableTags ?? [], desiredTags)) edits.availableTags = desiredTags;
      if (defaultForumLayout !== undefined && channel.defaultForumLayout !== defaultForumLayout) {
        edits.defaultForumLayout = defaultForumLayout;
      }
      if (
        defaultAutoArchiveDuration !== undefined
        && channel.defaultAutoArchiveDuration !== defaultAutoArchiveDuration
      ) {
        edits.defaultAutoArchiveDuration = defaultAutoArchiveDuration;
      }
    }
    if (overwrites.length > 0 && !samePermissionOverwrites(channel, overwrites)) {
      edits.permissionOverwrites = overwrites;
    }

    if (Object.keys(edits).length === 0) {
      if (!match.legacy) this.record('channels', 'unchanged', `channel:${name}`);
      return channel;
    }

    this.record('channels', 'updated', `channel:${channel.name}`);
    if (this.dryRun) return channel;
    return channel.edit({ ...edits, reason: 'BAINSA v1 provisioning' });
  }

  async seedMessage(
    channel,
    key,
    content,
    options: SeedMessageOptions = {},
  ) {
    if (!channel?.messages?.fetch) return;
    let message = await this.findTrackedSeedMessage(channel, key);
    let matchedLegacyKey = null;
    if (!message) {
      for (const legacyKey of options.legacyKeys ?? []) {
        message = await this.findTrackedSeedMessage(channel, legacyKey);
        if (message) {
          matchedLegacyKey = legacyKey;
          break;
        }
      }
    }
    if (!message) message = await this.findSeedMessage(channel, key, content, options.legacyHeadings);
    if (!message) {
      this.record('seeds', 'created', `seed:${key}`);
      if (this.dryRun) return null;
      message = await channel.send({ content, components: options.components ?? [] });
      await this.pinSeedMessage(message, key, options.pin);
      await this.trackSeedMessage(channel, key, message);
      if (matchedLegacyKey) await this.untrackSeedMessage(channel, matchedLegacyKey);
      return message;
    }
    const sameContent = message.content === content;
    const desiredComponents = options.components ?? [];
    const sameComponents = sameMessageComponents(message.components ?? [], desiredComponents);
    const samePin = !options.pin || message.pinned === true;
    if (sameContent && sameComponents && samePin) {
      this.record('seeds', 'unchanged', `seed:${key}`);
      await this.trackSeedMessage(channel, key, message);
      if (matchedLegacyKey) await this.untrackSeedMessage(channel, matchedLegacyKey);
      return message;
    }
    this.record('seeds', 'updated', `seed:${key}`);
    if (this.dryRun) return message;
    if (!sameContent || !sameComponents) {
      message = await message.edit({ content, components: options.components ?? [] });
    }
    await this.pinSeedMessage(message, key, options.pin);
    await this.trackSeedMessage(channel, key, message);
    if (matchedLegacyKey) await this.untrackSeedMessage(channel, matchedLegacyKey);
    return message;
  }

  async pinSeedMessage(message, key, shouldPin) {
    if (!shouldPin || message?.pinned || typeof message?.pin !== 'function') return;
    try {
      await message.pin();
    } catch (error) {
      this.summary.warnings.push({
        type: 'seed_pin_failed',
        seed: key,
        reason: error.message,
      });
    }
  }

  async seedForumGuide(forum, key, content, options: SeedMessageOptions = {}) {
    if (!forum?.threads) return;
    let thread = await this.findTrackedForumGuide(forum, key);
    if (thread) {
      await this.unarchiveForumGuide(thread);
      await this.seedMessage(thread, key, content, options);
      return thread;
    }
    const activeThreads = await forum.threads.fetchActive().catch(() => null);
    thread = findThreadByName(activeThreads?.threads, FORUM_GUIDE_THREAD_NAME);
    if (!thread && typeof forum.threads.fetchArchived === 'function') {
      const archivedThreads = await forum.threads.fetchArchived().catch(() => null);
      thread = findThreadByName(archivedThreads?.threads, FORUM_GUIDE_THREAD_NAME);
    }
    if (thread) {
      await this.unarchiveForumGuide(thread);
      await this.seedMessage(thread, key, content, options);
      return thread;
    }
    this.record('seeds', 'created', `forum-seed:${key}`);
    if (this.dryRun) return null;
    thread = await forum.threads.create({
      name: FORUM_GUIDE_THREAD_NAME,
      message: { content, components: options.components ?? [] },
      reason: 'BAINSA v1 forum guide',
    });
    await this.seedForumGuideStarter(thread, key, options);
    return thread;
  }

  async findTrackedForumGuide(forum, key) {
    if (!this.db || !this.guildId || this.seedTrackingAvailable === false) return null;
    try {
      const result = await this.db.query(
        `SELECT channel_id
           FROM provisioned_messages
          WHERE guild_id = $1 AND content_key = $2
          LIMIT 1`,
        [this.guildId, key],
      );
      const channelId = result.rows[0]?.channel_id;
      if (!channelId) {
        this.seedTrackingAvailable = true;
        return null;
      }
      const thread = await forum.guild?.channels?.fetch(channelId).catch(() => null);
      if (thread?.parentId === forum.id && thread.name === FORUM_GUIDE_THREAD_NAME) {
        this.seedTrackingAvailable = true;
        return thread;
      }
      await this.db.query(
        'DELETE FROM provisioned_messages WHERE guild_id = $1 AND content_key = $2',
        [this.guildId, key],
      );
      this.seedTrackingAvailable = true;
      return null;
    } catch (error) {
      if (this.seedTrackingAvailable !== false) {
        this.seedTrackingAvailable = false;
        this.summary.warnings.push({ type: 'seed_tracking_unavailable', reason: error.message });
      }
      return null;
    }
  }

  async unarchiveForumGuide(thread) {
    if (thread?.archived && typeof thread.setArchived === 'function') {
      await thread.setArchived(false, 'BAINSA forum guide reconciliation');
    }
  }

  async seedForumGuideStarter(thread, key, options) {
    if (!thread?.fetchStarterMessage) return;
    const message = await thread.fetchStarterMessage().catch(() => null);
    if (!message) return;
    await this.pinSeedMessage(message, key, options.pin);
    await this.trackSeedMessage(thread, key, message);
  }

  async findSeedMessage(channel, key, content, legacyHeadings: readonly string[] = []) {
    const messages = await channel.messages.fetch({ limit: 100 }).catch(() => null);
    if (!messages) return null;

    const botMessages = [...messages.values()]
      .filter((message) => message.author?.id === this.client.user?.id);
    const marker = seedMarker(key);
    const headings = [content.split('\n', 1)[0], ...(legacyHeadings ?? [])];

    return (
      oldestMessage(botMessages.filter((message) => message.content === content))
      ?? oldestMessage(botMessages.filter((message) => message.content.includes(marker)))
      ?? oldestMessage(botMessages.filter((message) =>
        headings.some((heading) => message.content.startsWith(`${heading}\n`)),
      ))
      ?? null
    );
  }

  async findTrackedSeedMessage(channel, key) {
    if (!this.db || !this.guildId || this.seedTrackingAvailable === false) return null;
    try {
      const result = await this.db.query(
        `SELECT message_id
           FROM provisioned_messages
          WHERE guild_id = $1 AND channel_id = $2 AND content_key = $3
          LIMIT 1`,
        [this.guildId, channel.id, key],
      );
      const messageId = result.rows[0]?.message_id;
      if (!messageId) {
        this.seedTrackingAvailable = true;
        return null;
      }
      const message = await channel.messages.fetch(messageId).catch(() => null);
      if (message && message.author?.id === this.client.user?.id) {
        this.seedTrackingAvailable = true;
        return message;
      }
      await this.db.query(
        'DELETE FROM provisioned_messages WHERE guild_id = $1 AND channel_id = $2 AND content_key = $3',
        [this.guildId, channel.id, key],
      );
      this.seedTrackingAvailable = true;
      return null;
    } catch (error) {
      if (this.seedTrackingAvailable !== false) {
        this.seedTrackingAvailable = false;
        this.summary.warnings.push({ type: 'seed_tracking_unavailable', reason: error.message });
      }
      return null;
    }
  }

  async trackSeedMessage(channel, key, message) {
    if (this.dryRun || !this.db || !this.guildId || !message?.id || this.seedTrackingAvailable === false) return;
    try {
      await this.db.query(
        `INSERT INTO provisioned_messages (guild_id, channel_id, content_key, message_id)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (guild_id, channel_id, content_key)
         DO UPDATE SET message_id = EXCLUDED.message_id, updated_at = now()`,
        [this.guildId, channel.id, key, message.id],
      );
      this.seedTrackingAvailable = true;
    } catch (error) {
      if (this.seedTrackingAvailable !== false) {
        this.seedTrackingAvailable = false;
        this.summary.warnings.push({ type: 'seed_tracking_unavailable', reason: error.message });
      }
    }
  }

  async untrackSeedMessage(channel, key) {
    if (this.dryRun || !this.db || !this.guildId || this.seedTrackingAvailable === false) return;
    try {
      await this.db.query(
        'DELETE FROM provisioned_messages WHERE guild_id = $1 AND channel_id = $2 AND content_key = $3',
        [this.guildId, channel.id, key],
      );
      this.seedTrackingAvailable = true;
    } catch (error) {
      if (this.seedTrackingAvailable !== false) {
        this.seedTrackingAvailable = false;
        this.summary.warnings.push({ type: 'seed_tracking_unavailable', reason: error.message });
      }
    }
  }

  record(bucket, action, label) {
    if (this.summary[bucket]?.[action] !== undefined) this.summary[bucket][action] += 1;
    this.summary.actions.push({ action: `${bucket}.${action}`, label });
  }

  logSummary() {
    this.logger.info?.('Discord provisioning summary', this.summary);
  }
}

function onboardingButtonRows() {
  return [
    new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('onboarding:start')
      .setEmoji('🚀')
      .setLabel('Begin onboarding')
      .setStyle(ButtonStyle.Primary),
    ),
    new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('onboarding:status')
      .setEmoji('🔎')
      .setLabel('Check application status')
      .setStyle(ButtonStyle.Secondary),
    ),
  ];
}

function peopleDirectoryButtonRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(PROFILE_CUSTOM_IDS.START)
      .setEmoji('🪪')
      .setLabel('Create or update my profile')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(PROFILE_CUSTOM_IDS.UNPUBLISH)
      .setLabel('Unpublish my profile')
      .setStyle(ButtonStyle.Danger),
  );
}

function findRole(guild, targetName, aliases = []) {
  const role = guild.roles.cache.find((candidate) => candidate.name === targetName);
  if (role) return { role, legacy: false };
  for (const aliasName of aliases) {
    const alias = guild.roles.cache.find((candidate) => candidate.name === aliasName);
    if (alias) return { role: alias, legacy: true };
  }
  return { role: null, legacy: false };
}

function findChannel(guild, { name, type, parent, aliases = [] }) {
  const exact = guild.channels.cache.find(
    (channel) =>
      channel.name === name &&
      channelTypeMatches(channel.type, type) &&
      (!parent || channel.parentId === parent.id),
  );
  if (exact) return { channel: exact, legacy: false };

  if (!parent) {
    const exactOutsideParent = guild.channels.cache.find(
      (channel) => channelTypeMatches(channel.type, type) && channel.name === name,
    );
    if (exactOutsideParent) return { channel: exactOutsideParent, legacy: true };
  }

  const normalizedAliases = aliases.map((alias) => slugify(alias));
  const alias = guild.channels.cache.find((channel) => {
    if (!channelTypeMatches(channel.type, type)) return false;
    if (parent && channel.parentId !== parent.id) return false;
    return normalizedAliases.includes(slugify(channel.name));
  });
  return { channel: alias ?? null, legacy: Boolean(alias) };
}

function channelTypeMatches(actualType, desiredType) {
  return actualType === desiredType;
}

function oldestMessage(messages) {
  return messages.reduce((oldest, message) => {
    if (!oldest) return message;
    return (message.createdTimestamp ?? Number.MAX_SAFE_INTEGER) < (oldest.createdTimestamp ?? Number.MAX_SAFE_INTEGER)
      ? message
      : oldest;
  }, null);
}

function findThreadByName(threads, name) {
  if (!threads) return null;
  if (typeof threads.find === 'function') return threads.find((candidate) => candidate.name === name) ?? null;
  return [...threads.values?.() ?? []].find((candidate) => candidate.name === name) ?? null;
}

function sameMessageComponents(currentComponents, desiredComponents) {
  if (currentComponents.length !== desiredComponents.length) return false;
  return currentComponents.every((component, index) => (
    JSON.stringify(component?.toJSON?.() ?? component)
      === JSON.stringify(desiredComponents[index]?.toJSON?.() ?? desiredComponents[index])
  ));
}

function normalizeForumTags(tags) {
  return tags.map((tag) => compactTag({
    name: tag.name,
    moderated: Boolean(tag.moderated),
    emoji: tag.emoji,
  }));
}

function mergeForumTags(existingTags, requiredTags) {
  const merged = existingTags.map((tag) => ({
    id: tag.id,
    name: tag.name,
    moderated: Boolean(tag.moderated),
    emoji: tag.emoji,
  })).map(compactTag);
  const names = new Set(merged.map((tag) => tag.name.toLowerCase()));
  for (const tag of requiredTags) {
    if (!names.has(tag.name.toLowerCase())) {
      merged.push(compactTag({ name: tag.name, moderated: Boolean(tag.moderated), emoji: tag.emoji }));
    }
  }
  return merged;
}

function exactForumTags(existingTags: readonly ForumTagInput[], requiredTags: readonly ForumTagInput[]) {
  const existingByName = new Map(
    existingTags.map((tag) => [tag.name.toLowerCase(), tag]),
  );
  return requiredTags.map((tag) => {
    const existing = existingByName.get(tag.name.toLowerCase());
    return compactTag({
      ...(existing?.id ? { id: existing.id } : {}),
      name: tag.name,
      moderated: Boolean(tag.moderated),
      emoji: tag.emoji,
    });
  });
}

function compactTag(tag) {
  return Object.fromEntries(Object.entries(tag).filter(([, value]) => value !== undefined));
}

function sameForumTags(currentTags, desiredTags) {
  if (currentTags.length !== desiredTags.length) return false;
  return desiredTags.every((desired, index) => {
    const current = currentTags[index];
    return (
      current?.name === desired.name &&
      Boolean(current?.moderated) === Boolean(desired.moderated) &&
      emojiKey(current?.emoji) === emojiKey(desired.emoji)
    );
  });
}

function emojiKey(emoji) {
  if (!emoji) return '';
  return emoji.id ? `id:${emoji.id}` : `name:${emoji.name ?? ''}`;
}

function samePermissionOverwrites(channel, desiredOverwrites) {
  if (!channel.permissionOverwrites?.cache) return false;
  if (channel.permissionOverwrites.cache.size !== desiredOverwrites.length) return false;
  return desiredOverwrites.every((desired) => {
    const current = channel.permissionOverwrites.cache.get(desired.id);
    if (!current) return false;
    return (
      BigInt(current.allow?.bitfield ?? 0n) === permissionBitfield(desired.allow) &&
      BigInt(current.deny?.bitfield ?? 0n) === permissionBitfield(desired.deny)
    );
  });
}

function permissionBitfield(permissions = []) {
  if (!Array.isArray(permissions)) return BigInt(permissions ?? 0n);
  return permissions.reduce((bits, permission) => bits | BigInt(permission), 0n);
}

async function renamePersistedDivisionChannel(channel, name, reason) {
  if (!channel || channel.name === name) return;
  await channel.setName(name, reason);
}

function normalizeRoleColor(roleOrColor) {
  if (typeof roleOrColor === 'string') return roleOrColor.toLowerCase();
  return roleOrColor?.hexColor?.toLowerCase?.() ?? null;
}

function dryRole(name) {
  return {
    id: `dry-role-${slugify(name)}`,
    name,
    editable: true,
    permissions: { bitfield: 0n },
    hoist: false,
    mentionable: false,
  };
}

function dryChannel(name, type, parentId) {
  const messages = {
    // MessageManager#fetch returns a Collection, which is Map-like. Keep the
    // dry-run stub shape-compatible with it because seed discovery iterates
    // the collection through .values().
    fetch: async () => new Map(),
  };
  const threads = {
    fetchActive: async () => ({ threads: { find: () => null } }),
    create: async () => null,
  };
  return {
    id: `dry-channel-${slugify(name)}`,
    name,
    type,
    parentId,
    messages,
    threads,
    edit: async () => dryChannel(name, type, parentId),
  };
}
