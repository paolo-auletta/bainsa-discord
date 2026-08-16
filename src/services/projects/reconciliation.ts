import { ChannelType } from 'discord.js';

import { PROJECT_STATUSES, ROLE_NAMES } from '../../constants.js';
import { logger } from '../../logger.js';
import { divisionHeadRoleName, projectChannelName, universityBoardRoleName, universityCategoryName } from '../../naming.js';
import { syncProjectHome, syncProjectWorkspaceGuide, syncShowcaseThread } from './gateway.js';
import { buildProjectPermissionOverwrites, projectPersonIdsByRole, uniqueIds } from './permissions.js';
import {
  claimProjectReconciliation,
  completeProjectReconciliation,
  enqueueProjectReconciliation,
  failProjectReconciliation,
  listProjectReconciliationCandidates,
  loadProjectReconciliationState,
  markProjectReconciliationProcessing,
  persistProjectChannelId,
  persistProjectHomeMessageId,
  persistProjectShowcaseThreadId,
  persistProjectWorkspaceGuideMessageId,
} from './repository.js';
import {
  prepareAndDeliverProjectNotifications,
  preparePendingProjectNotifications,
} from './notifications.js';
const REPAIR_LIMIT = 10;

interface ReconciliationWorkerOptions {
  guild: object;
  db: object;
  intervalMs?: number;
  limit?: number;
}

function projectChannelTopic(project) {
  return `Private ${project.name} workspace · ${project.university_name} / ${project.division_name} · BAINSA project ${project.id}`;
}

function roleByName(guild, name) {
  return guild.roles.cache.find((role) => role.name === name) ?? null;
}

function resolveRoleId(guild, preferredId, fallbackName) {
  if (preferredId && guild.roles.cache.has(String(preferredId))) return String(preferredId);
  return roleByName(guild, fallbackName)?.id ?? null;
}

function resolveBoardRoleIds(guild, project) {
  return uniqueIds([
    resolveRoleId(guild, project.division_head_role_id, divisionHeadRoleName(project.university_name, project.division_name)),
    resolveRoleId(guild, null, universityBoardRoleName(project.university_name, 'Vice President')),
    resolveRoleId(guild, null, universityBoardRoleName(project.university_name, 'President')),
  ]);
}

function findCategoryId(guild, preferredId, fallbackName) {
  if (preferredId && guild.channels.cache.has(String(preferredId))) return String(preferredId);
  return guild.channels.cache.find((channel) => channel.type === ChannelType.GuildCategory && channel.name === fallbackName)?.id ?? null;
}

function desiredOverwrites(guild, project, people) {
  return buildProjectPermissionOverwrites({
    guildId: guild.id,
    ...projectPersonIdsByRole(people),
    boardRoleIds: resolveBoardRoleIds(guild, project),
    globalPresidentRoleId: roleByName(guild, ROLE_NAMES.GLOBAL_PRESIDENT)?.id ?? null,
    botRoleId: roleByName(guild, ROLE_NAMES.BOT)?.id ?? null,
    locked: project.status === PROJECT_STATUSES.COMPLETED,
    archived: project.status === PROJECT_STATUSES.ARCHIVED,
  });
}

async function loadDesiredState(client, projectId, options = {}) {
  const state = await loadProjectReconciliationState(client, projectId, options);
  if (!state.project) throw new Error(`Project ${projectId} no longer exists.`);
  return state;
}

async function ensureProjectChannel(client, guild, project, people) {
  if (project.discord_channel_id) {
    const channel = await guild.channels.fetch(project.discord_channel_id).catch(() => null);
    if (channel) return channel;
  }

  const topic = projectChannelTopic(project);
  const legacyTopic = `${project.university_name} / ${project.division_name} project ${project.id}`;
  const fetchedChannels = typeof guild.channels.fetch === 'function' ? await guild.channels.fetch() : null;
  const channels = fetchedChannels?.values ? [...fetchedChannels.values()] : [];
  const matches = channels.filter(
    (channel) =>
      channel.type === ChannelType.GuildText
      && (channel.topic === topic || channel.topic === legacyTopic),
  );
  if (matches.length > 1) throw new Error(`Multiple Discord channels match project ${project.id}'s reconciliation marker.`);
  if (matches.length === 1) {
    await persistProjectChannelId(client, project.id, matches[0].id);
    project.discord_channel_id = matches[0].id;
    return matches[0];
  }

  const channel = await guild.channels.create({
    name: projectChannelName(project.id, project.name),
    type: ChannelType.GuildText,
    parent: findCategoryId(guild, project.category_id, universityCategoryName(project.university_name)) ?? undefined,
    topic,
    permissionOverwrites: desiredOverwrites(guild, project, people),
    reason: `Reconcile project ${project.id}`,
  });
  // Persist the external identity before any later Discord call can fail.  A
  // retry will therefore repair this channel rather than create a duplicate.
  await persistProjectChannelId(client, project.id, channel.id);
  project.discord_channel_id = channel.id;
  return channel;
}

async function applyDesiredDiscordState(client, guild, project, people) {
  const channel = await ensureProjectChannel(client, guild, project, people);
  const desiredName = projectChannelName(project.id, project.name);
  if (channel.name !== desiredName && typeof channel.setName === 'function') {
    await channel.setName(desiredName, `Reconcile project ${project.id} name`);
  }
  const desiredTopic = projectChannelTopic(project);
  if (channel.topic !== desiredTopic && typeof channel.setTopic === 'function') {
    await channel.setTopic(desiredTopic, `Reconcile project ${project.id} topic`);
  }

  const parentId = project.status === PROJECT_STATUSES.COMPLETED || project.status === PROJECT_STATUSES.ARCHIVED
    ? findCategoryId(guild, null, 'ARCHIVE / HISTORY')
    : findCategoryId(guild, project.category_id, universityCategoryName(project.university_name));
  if (parentId && String(channel.parentId ?? '') !== String(parentId)) {
    if (typeof channel.setParent === 'function') await channel.setParent(parentId, { lockPermissions: false });
  }
  await channel.permissionOverwrites.set(desiredOverwrites(guild, project, people), `Reconcile project ${project.id} access`);

  const showcaseThread = await syncShowcaseThread(guild, project, people);
  if (showcaseThread && String(showcaseThread.id) !== String(project.showcase_thread_id ?? '')) {
    await persistProjectShowcaseThreadId(client, project.id, showcaseThread.id);
    project.showcase_thread_id = showcaseThread.id;
  }

  const homeMessage = await syncProjectHome(guild, project, people);
  if (homeMessage && String(homeMessage.id) !== String(project.home_message_id ?? '')) {
    await persistProjectHomeMessageId(client, project.id, homeMessage.id);
    project.home_message_id = homeMessage.id;
  }

  const workspaceGuide = await syncProjectWorkspaceGuide(guild, project);
  if (workspaceGuide && String(workspaceGuide.id) !== String(project.workspace_guide_message_id ?? '')) {
    await persistProjectWorkspaceGuideMessageId(client, project.id, workspaceGuide.id);
    project.workspace_guide_message_id = workspaceGuide.id;
  }
}

export { enqueueProjectReconciliation };

export async function reconcileProject({ projectId, guild, db, allowStaleProcessing = false }) {
  if (!guild) return { status: 'failed', projectId, error: new Error('Guild is unavailable for reconciliation.') };
  const claimed = await db.transaction(async (client) => {
    // Project mutations lock the project row before incrementing the
    // reconciliation generation. Use the same order here to avoid a cycle
    // between a project update and a worker claim.
    const { project, people } = await loadDesiredState(client, projectId, { forUpdate: true });
    const generation = await claimProjectReconciliation(client, projectId, allowStaleProcessing);
    if (generation == null) return null;
    await markProjectReconciliationProcessing(client, projectId, generation);
    return { generation, project, people };
  });
  if (!claimed) return { status: 'skipped', projectId };

  const { generation, project, people } = claimed;
  try {
    // Discord calls intentionally run after the claim transaction commits.
    // Durable identity writes are individual repository operations, so no
    // PostgreSQL row lock is held while waiting on Discord.
    await applyDesiredDiscordState(db, guild, project, people);
    if (!await completeProjectReconciliation(db, projectId, generation)) {
      return { status: 'superseded', projectId, generation };
    }
    try {
      await prepareAndDeliverProjectNotifications({ db, guild, project });
    } catch (notificationError) {
      // Project state is already reconciled. The worker separately discovers
      // unprepared handoffs for succeeded projects, so this failure remains a
      // notification concern and never rewrites canonical project truth.
      logger.warn('Project reconciliation completed but handoff preparation remains queued', {
        projectId: String(projectId),
        error: notificationError instanceof Error ? notificationError.message : String(notificationError),
      });
    }
    logger.info('Project reconciliation succeeded', { projectId: String(projectId), generation: String(generation) });
    return { status: 'succeeded', projectId, generation, project, people };
  } catch (error) {
    await failProjectReconciliation(db, projectId, generation, error);
    logger.warn('Project reconciliation failed', {
      projectId: String(projectId), generation: String(generation), error: error instanceof Error ? error.message : String(error),
    });
    return { status: 'failed', projectId, generation, error };
  }
}

export async function retryProjectReconciliations({ guild, db, limit = REPAIR_LIMIT }) {
  const candidates = await listProjectReconciliationCandidates(db, Math.min(Math.max(Number(limit) || REPAIR_LIMIT, 1), REPAIR_LIMIT));
  const results = [];
  for (const projectId of candidates) {
    const result = await reconcileProject({ projectId, guild, db, allowStaleProcessing: true });
    results.push(result);
    if (result.status === 'failed') {
      logger.warn('Project reconciliation retry failed', {
        projectId: String(projectId), error: result.error instanceof Error ? result.error.message : String(result.error),
      });
    }
  }
  return results;
}

export function createProjectReconciliationWorker({
  guild,
  db,
  intervalMs = 60_000,
  limit = REPAIR_LIMIT,
}: ReconciliationWorkerOptions) {
  let running = false;
  let stopped = false;
  let activeRun = null;
  const run = async () => {
    if (running || stopped) return [];
    running = true;
    try {
      const reconciliations = await retryProjectReconciliations({ guild, db, limit });
      await preparePendingProjectNotifications({ guild, db, limit });
      return reconciliations;
    } catch (error) {
      logger.error('Project reconciliation worker failed', { error: error instanceof Error ? error.message : String(error) });
      return [];
    } finally {
      running = false;
    }
  };
  const scheduleRun = () => {
    if (running) return activeRun ?? Promise.resolve([]);
    activeRun = run().finally(() => {
      activeRun = null;
    });
    return activeRun;
  };
  const timer = setInterval(() => void scheduleRun(), intervalMs);
  timer.unref?.();
  void scheduleRun();
  return {
    run: scheduleRun,
    async stop() {
      stopped = true;
      clearInterval(timer);
      await activeRun;
    },
  };
}
