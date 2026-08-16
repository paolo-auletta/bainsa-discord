import { logger } from '../../logger.js';
import {
  enqueueTransitionNotification,
  listReconciledProjectsWithUnreadyNotifications,
  listTargetTransitionNotifications,
  prepareTransitionNotification,
} from '../../notifications/repository.js';
import { deliverTransitionNotifications } from '../../notifications/service.js';
import { projectAssignmentMessage, projectRemovalMessage } from './formatters.js';
import { getProject } from './repository.js';

export async function queueProjectAssignmentNotification(
  db,
  { auditId, guildId, project, person, previousRole = null },
) {
  return enqueueTransitionNotification(db, {
    auditId,
    recipientId: String(person.discord_user_id),
    kind: previousRole ? 'project.role_changed' : 'project.assigned',
    universityId: project.university_id,
    relatedEntityType: 'project',
    relatedEntityId: project.id,
    payload: projectAssignmentMessage(guildId, project, person.role, previousRole),
    metadata: {
      action: 'assignment',
      role: person.role,
      previousRole,
    },
    ready: false,
  });
}

export async function queueProjectRemovalNotification(
  db,
  { auditId, guildId, project, userId, previousRole = null, reason = null },
) {
  return enqueueTransitionNotification(db, {
    auditId,
    recipientId: String(userId),
    kind: 'project.removed',
    universityId: project.university_id,
    relatedEntityType: 'project',
    relatedEntityId: project.id,
    payload: projectRemovalMessage(guildId, project, reason, previousRole),
    metadata: {
      action: 'removal',
      previousRole,
      reason,
    },
    ready: false,
  });
}

export async function prepareAndDeliverProjectNotifications({ db, guild, project }) {
  const records = await listTargetTransitionNotifications(db, 'project', project.id);
  const ids = [];
  for (const record of records) {
    const metadata = record.metadata ?? {};
    const payload = metadata.action === 'removal'
      ? projectRemovalMessage(
        guild.id,
        project,
        metadata.reason ?? null,
        metadata.previousRole ?? null,
      )
      : projectAssignmentMessage(
        guild.id,
        project,
        metadata.role,
        metadata.previousRole ?? null,
      );
    await prepareTransitionNotification(db, record.id, payload);
    ids.push(record.id);
  }
  const results = await deliverTransitionNotifications({ db, guild, notificationIds: ids });
  const failed = results.filter((result) => result?.status === 'failed').length;
  if (failed) {
    logger.warn('Project access changed but some private handoffs remain undelivered', {
      projectId: String(project.id),
      failed,
    });
  }
  return results;
}

export async function preparePendingProjectNotifications({ db, guild, limit = 25 }) {
  const projectIds = await listReconciledProjectsWithUnreadyNotifications(db, limit);
  const results = [];
  for (const projectId of projectIds) {
    try {
      const project = await getProject(db, projectId);
      results.push(...await prepareAndDeliverProjectNotifications({ db, guild, project }));
    } catch (error) {
      logger.warn('Queued project handoff preparation failed', {
        projectId: String(projectId),
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return results;
}
