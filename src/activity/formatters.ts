import { EmbedBuilder } from 'discord.js';

import { BOARD_ROLES, divisionColorDetails, PROJECT_PERSON_ROLES } from '../constants.js';
import { boardRoleLabel, memberTypeLabel } from '../services/governance/policy.js';
import { formatPeopleLine } from '../services/projects/formatters.js';

const ACTIVITY_COLORS = Object.freeze({
  add: 0x27ae60,
  update: 0xf2994a,
  remove: 0xd7263d,
  close: 0x5865f2,
});

const ACTIVITY_STYLES = Object.freeze({
  add: Object.freeze({ icon: '🟢', color: ACTIVITY_COLORS.add }),
  update: Object.freeze({ icon: '🟠', color: ACTIVITY_COLORS.update }),
  remove: Object.freeze({ icon: '🔴', color: ACTIVITY_COLORS.remove }),
  close: Object.freeze({ icon: '🔵', color: ACTIVITY_COLORS.close }),
});

const FIELD_VALUE_LIMIT = 1_024;
const OUTCOME_LIMIT = 900;

function truncate(value, limit = FIELD_VALUE_LIMIT) {
  const text = String(value ?? '').trim();
  if (text.length <= limit) return text || 'None';
  return `${text.slice(0, limit - 1).trimEnd()}…`;
}

function mention(userOrId) {
  const id = typeof userOrId === 'object' ? userOrId?.id : userOrId;
  return id ? `<@${id}>` : 'Unknown member';
}

function channelMention(channelOrId, fallback = 'Not provisioned') {
  const id = typeof channelOrId === 'object' ? channelOrId?.id : channelOrId;
  return id ? `<#${id}>` : fallback;
}

function scope(universityName, divisionName = null) {
  return divisionName ? `${universityName} › ${divisionName}` : universityName;
}

function names(values = []) {
  return values.map((value) => value?.name ?? value).filter(Boolean);
}

function list(values = []) {
  return values.length ? values.join(', ') : 'None';
}

function sameList(left, right) {
  const normalize = (values) => [...new Set(values.map((value) => String(value).toLowerCase()))].sort();
  return JSON.stringify(normalize(left)) === JSON.stringify(normalize(right));
}

function projectRoleLabel(role) {
  return String(role ?? '')
    .split('_')
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(' ');
}

function boardRoleDescription(role, division = null) {
  if (role === BOARD_ROLES.HEAD) {
    return division ? `Head of ${division.name ?? division}` : 'All Head roles';
  }
  return boardRoleLabel(role);
}

function field(name, value, inline = false) {
  return { name, value: truncate(value), inline };
}

function activity({
  kind,
  title,
  subjectLabel,
  subject,
  universityName,
  divisionName = null,
  fields = [],
  actorId,
}) {
  const style = ACTIVITY_STYLES[kind];
  const embed = new EmbedBuilder()
    .setColor(style.color)
    .setTitle(`${style.icon} ${title}`)
    .addFields(
      field(subjectLabel, subject),
      field('Scope', scope(universityName, divisionName)),
      ...fields.filter(Boolean),
      field('Performed by', mention(actorId)),
    );
  return { embeds: [embed] };
}

function reconciliationField(project, successText) {
  return project.reconciliation_pending
    ? field('Discord state', 'Reconciliation is in progress; the Discord change will complete automatically.')
    : field('Discord state', successText);
}

function memberUpdate({ actorId, result }) {
  const before = result.previousRecord ?? {};
  const previousDivisions = names(result.previousDivisions);
  const nextDivisions = names(result.divisions);
  const changes = [];
  if (before.member_type && before.member_type !== result.memberType) {
    changes.push(`• Member type: ${memberTypeLabel(before.member_type)} → ${memberTypeLabel(result.memberType)}`);
  }
  if (before.university_name && before.university_name !== result.university.name) {
    changes.push(`• University: ${before.university_name} → ${result.university.name}`);
  }
  if (!sameList(previousDivisions, nextDivisions)) {
    changes.push(`• Divisions: ${list(previousDivisions)} → ${list(nextDivisions)}`);
  }
  if (changes.length === 0) return null;

  return activity({
    kind: 'update',
    title: 'Member updated',
    subjectLabel: 'Member',
    subject: mention(result.target),
    universityName: result.university.name,
    fields: [field('Changes', changes.join('\n'))],
    actorId,
  });
}

function memberRemove({ actorId, result }) {
  const cleanupWarning = result.overwriteCleanup?.failures?.length
    ? 'The member was removed. Some project-channel access cleanup requires review.'
    : 'The member was removed from the server.';
  return activity({
    kind: 'remove',
    title: 'Member removed',
    subjectLabel: 'Member',
    subject: mention(result.target),
    universityName: result.universityName,
    fields: [field('Result', cleanupWarning)],
    actorId,
  });
}

function divisionCreate({ actorId, result }) {
  return activity({
    kind: 'add',
    title: 'Division created',
    subjectLabel: 'Division',
    subject: result.divisionName,
    universityName: result.university.name,
    fields: [
      field('Initial Head', mention(result.head)),
      field(
        'Channels created',
        `Text: ${result.textChannel ? channelMention(result.textChannel) : 'No'}\nVoice: ${
          result.voiceChannel ? channelMention(result.voiceChannel) : 'No'
        }`,
      ),
    ],
    actorId,
  });
}

function divisionUpdate({ actorId, result }) {
  const nameChanged = result.oldName !== result.newName;
  const colorChanged = result.oldColor !== result.newColor;
  const oldColor = divisionColorDetails(result.oldColor);
  const newColor = divisionColorDetails(result.newColor);
  return activity({
    kind: 'update',
    title: 'Division updated',
    subjectLabel: 'Division',
    subject: nameChanged ? `${result.oldName} → ${result.newName}` : result.newName,
    universityName: result.university.name,
    fields: colorChanged
      ? [field('Color', `${oldColor?.label ?? result.oldColor} → ${newColor?.label ?? result.newColor}`)]
      : [],
    actorId,
  });
}

function divisionMember({ actorId, result }, kind) {
  return activity({
    kind,
    title: kind === 'add' ? 'Division member added' : 'Division member removed',
    subjectLabel: 'Member',
    subject: mention(result.target),
    universityName: result.university.name,
    divisionName: result.division.name,
    fields: [],
    actorId,
  });
}

function boardRole({ actorId, result }, kind) {
  return activity({
    kind,
    title: kind === 'add' ? 'Board role assigned' : 'Board role removed',
    subjectLabel: 'Member',
    subject: mention(result.target),
    universityName: result.university.name,
    divisionName: result.division?.name ?? null,
    fields: [field('Role', boardRoleDescription(result.role, result.division))],
    actorId,
  });
}

function projectCreate({ actorId, result }) {
  const project = result;
  return activity({
    kind: 'add',
    title: 'Project created',
    subjectLabel: 'Project',
    subject: project.name,
    universityName: project.university_name,
    divisionName: project.division_name,
    fields: [
      field('Members', formatPeopleLine(project.people ?? [], PROJECT_PERSON_ROLES.MEMBER, 900)),
      field('Supervisors', formatPeopleLine(project.people ?? [], PROJECT_PERSON_ROLES.SUPERVISOR, 900)),
      field('Timeline', `${project.start_date} → ${project.expected_end}`),
      reconciliationField(
        project,
        `Project channel: ${channelMention(project.discord_channel_id)}`,
      ),
    ],
    actorId,
  });
}

function projectParticipant({ actorId, result }, kind) {
  const project = result.project;
  const participant = result.participant;
  if (kind === 'add' && participant.previousRole === participant.role) return null;
  const roleChanged = kind === 'add'
    && participant.previousRole
    && participant.previousRole !== participant.role;
  const title = kind === 'remove'
    ? 'Project participant removed'
    : roleChanged
      ? 'Project participant updated'
      : 'Project participant added';
  const activityKind = roleChanged ? 'update' : kind;
  const details = roleChanged
    ? `${mention(participant.userId)}\nRole: ${projectRoleLabel(participant.previousRole)} → ${projectRoleLabel(participant.role)}`
    : kind === 'remove'
      ? mention(participant.userId)
      : `${mention(participant.userId)} · ${projectRoleLabel(participant.role)}`;

  return activity({
    kind: activityKind,
    title,
    subjectLabel: 'Project',
    subject: project.name,
    universityName: project.university_name,
    divisionName: project.division_name,
    fields: [
      field('Participant', details),
      ...(project.reconciliation_pending
        ? [reconciliationField(project, 'Project access updated.')]
        : []),
    ],
    actorId,
  });
}

function projectUpdate({ actorId, result }) {
  const project = result.project;
  const before = result.before;
  const changes = [];
  if (before.name !== project.name) changes.push(`• Name: ${before.name} → ${project.name}`);
  if (before.expected_end !== project.expected_end) {
    changes.push(`• Expected end: ${before.expected_end} → ${project.expected_end}`);
  }
  if (before.status !== project.status) changes.push(`• Status: ${before.status} → ${project.status}`);
  if (changes.length === 0) return null;

  return activity({
    kind: 'update',
    title: 'Project updated',
    subjectLabel: 'Project',
    subject: project.name,
    universityName: project.university_name,
    divisionName: project.division_name,
    fields: [
      field('Changes', changes.join('\n')),
      ...(project.reconciliation_pending
        ? [reconciliationField(project, 'Project Discord state updated.')]
        : []),
    ],
    actorId,
  });
}

function projectClose({ actorId, result }) {
  const project = result.project;
  return activity({
    kind: 'close',
    title: 'Project closed',
    subjectLabel: 'Project',
    subject: project.name,
    universityName: project.university_name,
    divisionName: project.division_name,
    fields: [
      field('Outcome', truncate(result.outcome, OUTCOME_LIMIT)),
      reconciliationField(
        project,
        `Completed and moved to archive/history: ${channelMention(project.discord_channel_id)}`,
      ),
    ],
    actorId,
  });
}

const FORMATTERS = Object.freeze({
  'member-update': memberUpdate,
  'member-remove': memberRemove,
  'division-create': divisionCreate,
  'division-update': divisionUpdate,
  'division-add-member': (input) => divisionMember(input, 'add'),
  'division-remove-member': (input) => divisionMember(input, 'remove'),
  'board-assign': (input) => boardRole(input, 'add'),
  'board-remove': (input) => boardRole(input, 'remove'),
  'project-create': projectCreate,
  'project-add-member': (input) => projectParticipant(input, 'add'),
  'project-remove-member': (input) => projectParticipant(input, 'remove'),
  'project-update': projectUpdate,
  'project-close': projectClose,
});

export const BOARD_ACTIVITY_COMMANDS = Object.freeze(Object.keys(FORMATTERS));

export function formatBoardActivity(commandName, { actorId, result }) {
  const formatter = FORMATTERS[commandName];
  if (!formatter) return null;
  return formatter({ actorId, result });
}
