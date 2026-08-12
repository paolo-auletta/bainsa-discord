import { divisionColorDetails, PROJECT_PERSON_ROLES } from '../constants.js';
import {
  channelReference,
  renderEventCard,
  truncateText,
  userReference,
} from '../messages/index.js';
import { memberTypeLabel } from '../services/governance/policy.js';
import { formatPeopleLine, projectStatusLabel } from '../services/projects/formatters.js';

const ACTIVITY_TONES = Object.freeze({
  add: 'success',
  update: 'changed',
  remove: 'danger',
  close: 'brand',
});

const FIELD_VALUE_LIMIT = 1_024;
const OUTCOME_LIMIT = 900;

function truncate(value, limit = FIELD_VALUE_LIMIT) {
  return truncateText(value, limit, 'Not recorded');
}

function mention(userOrId) {
  return userReference(userOrId);
}

function channelMention(channelOrId, fallback = 'Not provisioned') {
  return channelReference(channelOrId, fallback);
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

function activityPeopleLine(people, role) {
  return formatPeopleLine(
    people,
    role,
    900,
    (person) => mention({ ...(person.user ?? {}), id: person.discord_user_id }),
  );
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

function field(name, value, inline = false) {
  return { label: name, value: truncate(value), inline };
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
  const normalizedFields = fields.filter(Boolean);
  const result = normalizedFields.find((item) => item.label === 'Result' || item.label === 'Outcome');
  const discordState = normalizedFields.find((item) => item.label === 'Discord state');
  const details = normalizedFields.filter((item) => item !== result && item !== discordState);

  return renderEventCard({
    kind: 'event-card',
    tone: ACTIVITY_TONES[kind],
    title,
    subject: field(subjectLabel, subject),
    scope: scope(universityName, divisionName),
    details,
    result,
    discordState: discordState?.value,
    actor: mention(actorId),
    audience: 'board',
  });
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
  const discordState = result.discordRemoval?.status === 'pending_recovery'
    ? result.discordRemoval.managedRolesRemoved
      ? 'Canonical membership is removed. The server kick is pending recovery; managed roles were removed.'
      : 'Canonical membership is removed. The server kick and some managed-role cleanup need immediate recovery.'
    : 'The server removal completed.';
  const handoffState = result.notificationDelivery?.status === 'delivered'
    ? 'Private policy-safe handoff delivered before server removal.'
    : result.notificationDelivery
      ? 'Private handoff was not confirmed; review notification health in `/board-info`.'
      : 'No new handoff delivery record was created for this repair attempt.';
  return activity({
    kind: 'remove',
    title: 'Member removed',
    subjectLabel: 'Member',
    subject: mention(result.target),
    universityName: result.universityName,
    fields: [
      field('Result', cleanupWarning),
      field('Member handoff', handoffState),
      field('Discord state', discordState),
    ],
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

function boardUpdate({ actorId, result }) {
  const changes = (result.positionChanges ?? []).map((change) => {
    const current = change.currentUserIds?.length
      ? change.currentUserIds.map((userId) => mention(userId)).join(', ')
      : 'Vacant';
    const next = change.nextUserIds?.length
      ? change.nextUserIds.map((userId) => mention(userId)).join(', ')
      : 'Vacant';
    return `• ${change.label}: ${current} → ${next}`;
  });
  if (changes.length === 0) return null;
  return activity({
    kind: 'update',
    title: 'Board updated',
    subjectLabel: 'University',
    subject: result.university.name,
    universityName: result.university.name,
    fields: [field('Position changes', changes.join('\n'))],
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
      field('Members', activityPeopleLine(project.people ?? [], PROJECT_PERSON_ROLES.MEMBER)),
      field('Supervisors', activityPeopleLine(project.people ?? [], PROJECT_PERSON_ROLES.SUPERVISOR)),
      field('Timeline', `${project.start_date} → ${project.expected_end}`),
      reconciliationField(
        project,
        `Project channel: ${channelMention(project.discord_channel_id)}`,
      ),
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
  if (before.summary !== project.summary) changes.push('• Public summary updated');
  if (before.status !== project.status) {
    changes.push(`• Status: ${projectStatusLabel(before.status)} → ${projectStatusLabel(project.status)}`);
  }
  const participantChanges = result.participantChanges ?? {};
  const teamChanges = [
    ...(participantChanges.added ?? []).map(
      (person) => `• Added <@${person.userId}> · ${projectRoleLabel(person.role)}`,
    ),
    ...(participantChanges.roleChanged ?? []).map(
      (person) => `• <@${person.userId}>: ${projectRoleLabel(person.previousRole)} → ${projectRoleLabel(person.role)}`,
    ),
    ...(participantChanges.removed ?? []).map(
      (person) => `• Removed <@${person.userId}> · ${projectRoleLabel(person.role)}`,
    ),
  ];
  if (changes.length === 0 && teamChanges.length === 0) return null;

  return activity({
    kind: 'update',
    title: 'Project updated',
    subjectLabel: 'Project',
    subject: project.name,
    universityName: project.university_name,
    divisionName: project.division_name,
    fields: [
      ...(changes.length > 0 ? [field('Project changes', changes.join('\n'))] : []),
      ...(teamChanges.length > 0 ? [field('Team changes', teamChanges.join('\n'))] : []),
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
  'board-update': boardUpdate,
  'project-create': projectCreate,
  'project-update': projectUpdate,
  'project-close': projectClose,
});

export const BOARD_ACTIVITY_COMMANDS = Object.freeze(Object.keys(FORMATTERS));

export function formatBoardActivity(commandName, { actorId, result }) {
  const formatter = FORMATTERS[commandName];
  if (!formatter) return null;
  return formatter({ actorId, result });
}
