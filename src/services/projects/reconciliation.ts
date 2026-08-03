import { ChannelType } from 'discord.js';

import { PROJECT_STATUSES, ROLE_NAMES } from '../../constants.js';
import { logger } from '../../logger.js';
import { divisionHeadRoleName, projectChannelName, universityBoardRoleName, universityCategoryName } from '../../naming.js';
import { buildProjectPermissionOverwrites, projectPersonIdsByRole, uniqueIds } from './permissions.js';

const PROJECT_SELECT = `
  p.id, p.name, p.university_id, p.division_id, p.start_date::text AS start_date,
  p.expected_end::text AS expected_end, p.notes, p.status, p.channel_id AS discord_channel_id, p.showcase_thread_id,
  u.name AS university_name, u.category_id, u.showcase_channel_id, d.name AS division_name, d.color AS division_color,
  d.head_role_id AS division_head_role_id
`;
const REPAIR_LIMIT = 10;

interface ReconciliationWorkerOptions {
  guild: object;
  db: object;
  intervalMs?: number;
  limit?: number;
}

function projectChannelTopic(project) {
  return `${project.university_name} / ${project.division_name} project ${project.id}`;
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

async function loadDesiredState(client, projectId) {
  const projectResult = await client.query(
    `SELECT ${PROJECT_SELECT}
       FROM projects p JOIN universities u ON u.id = p.university_id
       JOIN divisions d ON d.id = p.division_id
      WHERE p.id = $1`,
    [projectId],
  );
  if (projectResult.rowCount !== 1) throw new Error(`Project ${projectId} no longer exists.`);
  const peopleResult = await client.query(
    `SELECT discord_user_id, role FROM project_people WHERE project_id = $1 ORDER BY role, discord_user_id`,
    [projectId],
  );
  return { project: projectResult.rows[0], people: peopleResult.rows };
}

async function ensureProjectChannel(client, guild, project, people) {
  if (project.discord_channel_id) {
    const channel = await guild.channels.fetch(project.discord_channel_id).catch(() => null);
    if (channel) return channel;
  }

  const topic = projectChannelTopic(project);
  const fetchedChannels = typeof guild.channels.fetch === 'function' ? await guild.channels.fetch() : null;
  const channels = fetchedChannels?.values ? [...fetchedChannels.values()] : [];
  const matches = channels.filter((channel) => channel.type === ChannelType.GuildText && channel.topic === topic);
  if (matches.length > 1) throw new Error(`Multiple Discord channels match project ${project.id}'s reconciliation marker.`);
  if (matches.length === 1) {
    await client.query('UPDATE projects SET channel_id = $1, updated_at = now() WHERE id = $2', [matches[0].id, project.id]);
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
  await client.query('UPDATE projects SET channel_id = $1, updated_at = now() WHERE id = $2', [channel.id, project.id]);
  project.discord_channel_id = channel.id;
  return channel;
}

async function applyDesiredDiscordState(client, guild, project, people) {
  const channel = await ensureProjectChannel(client, guild, project, people);
  const desiredName = projectChannelName(project.id, project.name);
  if (channel.name !== desiredName && typeof channel.setName === 'function') {
    await channel.setName(desiredName, `Reconcile project ${project.id} name`);
  }

  const parentId = project.status === PROJECT_STATUSES.COMPLETED || project.status === PROJECT_STATUSES.ARCHIVED
    ? findCategoryId(guild, null, 'ARCHIVE / HISTORY')
    : findCategoryId(guild, project.category_id, universityCategoryName(project.university_name));
  if (parentId && String(channel.parentId ?? '') !== String(parentId)) {
    if (typeof channel.setParent === 'function') await channel.setParent(parentId, { lockPermissions: false });
  }
  await channel.permissionOverwrites.set(desiredOverwrites(guild, project, people), `Reconcile project ${project.id} access`);
}

export async function enqueueProjectReconciliation(client, projectId) {
  const result = await client.query(
    `INSERT INTO project_reconciliation (project_id, desired_generation, status, requested_at, last_error)
     VALUES ($1, 1, 'pending', now(), NULL)
     ON CONFLICT (project_id) DO UPDATE
       SET desired_generation = project_reconciliation.desired_generation + 1,
           status = 'pending', requested_at = now(), last_error = NULL
     RETURNING desired_generation`,
    [projectId],
  );
  return result.rows[0].desired_generation;
}

async function markFailure(client, projectId, generation, error) {
  const message = error instanceof Error ? error.message : String(error);
  await client.query(
    `UPDATE project_reconciliation
        SET status = 'failed', failed_at = now(), last_error = left($3, 2000)
      WHERE project_id = $1 AND desired_generation = $2`,
    [projectId, generation, message],
  );
}

export async function reconcileProject({ projectId, guild, db, allowStaleProcessing = false }) {
  if (!guild) return { status: 'failed', projectId, error: new Error('Guild is unavailable for reconciliation.') };
  return db.transaction(async (client) => {
    const claim = await client.query(
      `SELECT desired_generation
         FROM project_reconciliation
        WHERE project_id = $1
          AND (status IN ('pending', 'failed')
            OR ($2::boolean AND status = 'processing' AND started_at < now() - interval '5 minutes'))
        FOR UPDATE SKIP LOCKED`,
      [projectId, allowStaleProcessing],
    );
    if (claim.rowCount !== 1) return { status: 'skipped', projectId };
    const generation = claim.rows[0].desired_generation;
    await client.query(
      `UPDATE project_reconciliation
          SET status = 'processing', attempts = attempts + 1, started_at = now(), last_error = NULL
        WHERE project_id = $1 AND desired_generation = $2`,
      [projectId, generation],
    );
    try {
      const { project, people } = await loadDesiredState(client, projectId);
      await applyDesiredDiscordState(client, guild, project, people);
      const completed = await client.query(
        `UPDATE project_reconciliation
            SET status = 'succeeded', succeeded_at = now(), last_error = NULL
          WHERE project_id = $1 AND desired_generation = $2
          RETURNING desired_generation`,
        [projectId, generation],
      );
      if (completed.rowCount !== 1) return { status: 'superseded', projectId, generation };
      logger.info('Project reconciliation succeeded', { projectId: String(projectId), generation: String(generation) });
      return { status: 'succeeded', projectId, generation, project, people };
    } catch (error) {
      await markFailure(client, projectId, generation, error);
      logger.warn('Project reconciliation failed', {
        projectId: String(projectId), generation: String(generation), error: error instanceof Error ? error.message : String(error),
      });
      return { status: 'failed', projectId, generation, error };
    }
  });
}

export async function retryProjectReconciliations({ guild, db, limit = REPAIR_LIMIT }) {
  const candidates = await db.query(
    `SELECT project_id FROM project_reconciliation
      WHERE status IN ('pending', 'failed')
         OR (status = 'processing' AND started_at < now() - interval '5 minutes')
      ORDER BY requested_at, project_id LIMIT $1`,
    [Math.min(Math.max(Number(limit) || REPAIR_LIMIT, 1), REPAIR_LIMIT)],
  );
  const results = [];
  for (const row of candidates.rows) {
    const result = await reconcileProject({ projectId: row.project_id, guild, db, allowStaleProcessing: true });
    results.push(result);
    if (result.status === 'failed') {
      logger.warn('Project reconciliation retry failed', {
        projectId: String(row.project_id), error: result.error instanceof Error ? result.error.message : String(result.error),
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
      return await retryProjectReconciliations({ guild, db, limit });
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
