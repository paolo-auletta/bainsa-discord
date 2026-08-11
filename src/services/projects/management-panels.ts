import { escapeMarkdown } from 'discord.js';

import { formatBoardActivity } from '../../activity/formatters.js';
import {
  OPEN_PROJECT_STATUSES,
  PROJECT_PERSON_ROLES,
  PROJECT_STATUSES,
} from '../../constants.js';
import { assertUser, UserFacingError } from '../../errors.js';
import { flowCustomId, parseFlowCustomId } from '../../flows/custom-id.js';
import { createFlowSessionStore, type FlowSessionBase } from '../../flows/session-store.js';
import { logger } from '../../logger.js';
import {
  ephemeralReplyPayload,
  interactionEditPayload,
  interactionOutcome,
  renderInteractionModal,
  renderInteractionPanel,
} from '../../messages/index.js';
import { projectCommandChannelScope } from '../../runtime/command-channels.js';
import {
  closeProject,
  getProjectManagementContext,
  searchVisibleProjects,
  updateProjectWithPeople,
} from './index.js';
import {
  formatPeopleLine,
  projectRecordSummary,
} from './formatters.js';
import {
  normalizeProjectLongText,
  normalizeProjectName,
  validateExpectedEndUpdate,
} from './validation.js';

const PREFIX = 'pm';

const ACTIONS = Object.freeze({
  UPDATE_PROJECT: 'up',
  UPDATE_PROJECT_CONTINUE: 'upc',
  UPDATE_SEARCH_OPEN: 'uso',
  UPDATE_SEARCH_MODAL: 'usm',
  UPDATE_STATUS: 'ust',
  UPDATE_DETAILS_OPEN: 'udo',
  UPDATE_DETAILS_MODAL: 'udm',
  UPDATE_TEAM_OPEN: 'uto',
  UPDATE_TEAM_MEMBERS: 'utm',
  UPDATE_TEAM_SUPERVISORS: 'uts',
  UPDATE_REVIEW: 'urv',
  UPDATE_BACK_SELECT: 'ubs',
  UPDATE_BACK_OVERVIEW: 'ubo',
  UPDATE_SAVE: 'usv',
  UPDATE_CANCEL: 'ucx',
  CLOSE_PROJECT: 'cp',
  CLOSE_PROJECT_CONTINUE: 'cpc',
  CLOSE_SEARCH_OPEN: 'cso',
  CLOSE_SEARCH_MODAL: 'csm',
  CLOSE_DETAILS_OPEN: 'cdo',
  CLOSE_DETAILS_MODAL: 'cdm',
  CLOSE_BACK_DETAILS: 'cbd',
  CLOSE_SAVE: 'csv',
  CLOSE_CANCEL: 'ccx',
});

const ACTION_VALUES = new Set<string>(Object.values(ACTIONS));

interface ProjectChoice {
  name: string;
  value: string;
}

interface ProjectPerson {
  discord_user_id: string;
  role: string;
}

interface ProjectRecord {
  id: string | number;
  name: string;
  university_name: string;
  division_name: string;
  division_color?: string;
  start_date: string;
  expected_end: string;
  summary: string;
  notes?: string | null;
  status: string;
  updated_at?: string;
  discord_channel_id?: string | null;
  reconciliation_pending?: boolean;
}

interface ProjectUpdateSession extends FlowSessionBase {
  kind: 'project-update';
  fixedProject: boolean;
  choices: ProjectChoice[];
  selectedProjectId: string | null;
  searchQuery: string;
  project: ProjectRecord | null;
  initialPeople: ProjectPerson[];
  people: Map<string, string>;
  name: string | null;
  expectedEnd: string | null;
  summary: string | null;
  notes: string | null;
  status: string | null;
  screen: 'select' | 'overview' | 'team' | 'review';
}

interface ProjectCloseSession extends FlowSessionBase {
  kind: 'project-close';
  fixedProject: boolean;
  choices: ProjectChoice[];
  selectedProjectId: string | null;
  searchQuery: string;
  project: ProjectRecord | null;
  people: ProjectPerson[];
  outcome: string | null;
  finalNotes: string | null;
  screen: 'select' | 'details' | 'review';
}

type ProjectPanelSession = ProjectUpdateSession | ProjectCloseSession;

function id(session: ProjectPanelSession, action: string) {
  return flowCustomId(PREFIX, session.id, action);
}

function statusLabel(status: string) {
  return status === PROJECT_STATUSES.PAUSED ? 'Paused' : 'Active';
}

function peopleArray(session: ProjectUpdateSession): ProjectPerson[] {
  return [...session.people.entries()]
    .map(([discord_user_id, role]) => ({ discord_user_id, role }))
    .sort((left, right) => left.role.localeCompare(right.role) || left.discord_user_id.localeCompare(right.discord_user_id));
}

function peopleSnapshot(people: ProjectPerson[]) {
  return people.map((person) => `${person.discord_user_id}:${person.role}`).sort();
}

function samePeople(left: ProjectPerson[], right: ProjectPerson[]) {
  const a = peopleSnapshot(left);
  const b = peopleSnapshot(right);
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function metadataChanges(session: ProjectUpdateSession) {
  if (!session.project) return [];
  return [
    session.name !== session.project.name ? `Name: ${session.project.name} → ${session.name}` : null,
    session.expectedEnd !== session.project.expected_end
      ? `Expected end: ${session.project.expected_end} → ${session.expectedEnd}`
      : null,
    session.summary !== session.project.summary ? 'Public summary updated' : null,
    String(session.notes ?? '') !== String(session.project.notes ?? '') ? 'Internal notes updated' : null,
    session.status !== session.project.status
      ? `Status: ${statusLabel(session.project.status)} → ${statusLabel(session.status ?? '')}`
      : null,
  ].filter(Boolean) as string[];
}

function hasProjectChanges(session: ProjectUpdateSession) {
  return metadataChanges(session).length > 0 || !samePeople(session.initialPeople, peopleArray(session));
}

function choiceControl(session: ProjectPanelSession, action: string) {
  if (session.choices.length === 0) return null;
  return {
    kind: 'string-select' as const,
    id: id(session, action),
    placeholder: 'Choose a project',
    label: 'Project',
    options: session.choices.slice(0, 25).map((choice) => ({
      label: choice.name,
      value: choice.value,
      selected: choice.value === session.selectedProjectId,
    })),
  };
}

function projectSelectionPayload(session: ProjectPanelSession, { loading = false } = {}) {
  const update = session.kind === 'project-update';
  const control = choiceControl(session, update ? ACTIONS.UPDATE_PROJECT : ACTIONS.CLOSE_PROJECT);
  const selected = session.choices.find((choice) => choice.value === session.selectedProjectId);
  return renderInteractionPanel({
    kind: 'interaction-panel',
    tone: update ? 'brand' : 'warning',
    title: update ? 'Choose a project to update' : 'Choose a project to close',
    description: update
      ? 'Select a recent visible project or search by project name, university, division, or ID.'
      : 'Only active and paused projects are available. Select one or search by name or ID.',
    progress: { label: update ? 'Project update' : 'Project closure', current: 1, total: update ? 3 : 2 },
    facts: [
      ...(session.searchQuery ? [{ label: 'Search', value: session.searchQuery }] : []),
      ...(selected ? [{ label: 'Selected project', value: selected.name }] : []),
    ],
    controls: control ? [{ ...control, disabled: loading }] : [],
    sections: !control
      ? [{ body: 'No matching projects are available in your scope. Try a different search.' }]
      : [],
    contentActions: [
      {
        id: id(session, update ? ACTIONS.UPDATE_SEARCH_OPEN : ACTIONS.CLOSE_SEARCH_OPEN),
        label: 'Search projects',
        style: 'secondary',
        disabled: loading,
      },
    ],
    actions: [
      {
        id: id(session, update ? ACTIONS.UPDATE_PROJECT_CONTINUE : ACTIONS.CLOSE_PROJECT_CONTINUE),
        label: 'Continue',
        style: 'primary',
        disabled: !session.selectedProjectId,
        loading,
      },
      {
        id: id(session, update ? ACTIONS.UPDATE_CANCEL : ACTIONS.CLOSE_CANCEL),
        label: update ? 'Cancel update' : 'Cancel closure',
        style: 'danger',
        disabled: loading,
      },
    ],
    audience: 'actor',
  });
}

function projectSearchModal(session: ProjectPanelSession) {
  return renderInteractionModal({
    id: id(session, session.kind === 'project-update' ? ACTIONS.UPDATE_SEARCH_MODAL : ACTIONS.CLOSE_SEARCH_MODAL),
    title: 'Find a project',
    fields: [{
      id: 'query',
      label: 'Name, scope, or project ID',
      placeholder: 'e.g. Signals, Bocconi, or 42',
      value: session.searchQuery,
      required: false,
      maxLength: 100,
    }],
  });
}

function projectScope(project: ProjectRecord) {
  return `${escapeMarkdown(project.university_name)} · ${escapeMarkdown(project.division_name)}`;
}

function teamCounts(people: ProjectPerson[]) {
  const counts = new Map<string, number>();
  for (const person of people) counts.set(person.role, (counts.get(person.role) ?? 0) + 1);
  return [
    `${counts.get(PROJECT_PERSON_ROLES.MEMBER) ?? 0} member(s)`,
    `${counts.get(PROJECT_PERSON_ROLES.SUPERVISOR) ?? 0} supervisor(s)`,
    `${counts.get(PROJECT_PERSON_ROLES.BOARD_LIAISON) ?? 0} board liaison(s)`,
  ].join(' · ');
}

function changedValue(current: string, next: string) {
  return current === next ? current : `${current} → ${next}`;
}

function proposedProject(session: ProjectUpdateSession): ProjectRecord {
  return {
    ...session.project,
    name: session.name ?? session.project.name,
    expected_end: session.expectedEnd ?? session.project.expected_end,
    summary: session.summary ?? session.project.summary,
    notes: session.notes,
    status: session.status ?? session.project.status,
  } as ProjectRecord;
}

function rolePeople(people: ProjectPerson[], role: string) {
  return formatPeopleLine(people, role, 900);
}

function rolePeopleChanged(before: ProjectPerson[], after: ProjectPerson[], role: string) {
  const ids = (people) => people
    .filter((person) => person.role === role)
    .map((person) => String(person.discord_user_id))
    .sort();
  return JSON.stringify(ids(before)) !== JSON.stringify(ids(after));
}

function projectUpdateSummary(session: ProjectUpdateSession) {
  const beforePeople = session.initialPeople;
  const afterPeople = peopleArray(session);
  const before = projectRecordSummary(session.project, beforePeople);
  const after = projectRecordSummary(proposedProject(session), afterPeople);
  const beforeMetadata = new Map(before.metadata.map((field) => [field.label, field.value]));
  const afterMetadata = new Map(after.metadata.map((field) => [field.label, field.value]));
  const primaryMetadataLabels = ['University', 'Status', 'Division', 'Timeline'];
  const facts = [
    { label: 'Project', value: changedValue(before.title, after.title) },
    ...primaryMetadataLabels
      .filter((label) => beforeMetadata.has(label) || afterMetadata.has(label))
      .map((label) => ({
      label,
      value: changedValue(
        String(beforeMetadata.get(label) ?? 'Not provided'),
        String(afterMetadata.get(label) ?? 'Not provided'),
      ),
      })),
  ];

  const beforeSections = new Map(before.sections.map((section) => [section.heading, section.body]));
  const afterSections = new Map(after.sections.map((section) => [section.heading, section.body]));
  const sectionValue = (sections, heading, fallback = 'Not provided') => {
    const body = sections.get(heading);
    if (Array.isArray(body)) return body.join('\n');
    return String(body ?? fallback);
  };
  const changedSectionLine = (label, sourceHeading = label) => {
    const current = sectionValue(beforeSections, sourceHeading);
    const next = sectionValue(afterSections, sourceHeading);
    return `**${label}:** ${changedValue(current, next)}`;
  };

  const linkLabels = ['Workspace', 'Shareable record'];
  const links = linkLabels
    .filter((label) => beforeMetadata.has(label) || afterMetadata.has(label))
    .map((label) => `**${label}:** ${changedValue(
      String(beforeMetadata.get(label) ?? 'Not provided'),
      String(afterMetadata.get(label) ?? 'Not provided'),
    )}`);

  const roles = [
    [PROJECT_PERSON_ROLES.MEMBER, 'Members'],
    [PROJECT_PERSON_ROLES.SUPERVISOR, 'Supervisors'],
    [PROJECT_PERSON_ROLES.BOARD_LIAISON, 'Board liaisons'],
  ];
  const team = roles
    .filter(([role]) => role === PROJECT_PERSON_ROLES.MEMBER
      || role === PROJECT_PERSON_ROLES.SUPERVISOR
      || beforePeople.some((person) => person.role === role)
      || afterPeople.some((person) => person.role === role))
    .map(([role, label]) => {
      const current = rolePeople(beforePeople, role);
      const next = rolePeople(afterPeople, role);
      return `**${label}:** ${rolePeopleChanged(beforePeople, afterPeople, role) ? `${current} → ${next}` : current}`;
    });

  const narrative = [
    changedSectionLine('Internal notes', 'Internal working notes'),
    changedSectionLine('Summary'),
  ];
  for (const heading of ['Conclusion', 'Internal handover notes']) {
    if (!beforeSections.has(heading) && !afterSections.has(heading)) continue;
    const current = sectionValue(beforeSections, heading);
    const next = sectionValue(afterSections, heading);
    narrative.push(`**${heading}:** ${changedValue(current, next)}`);
  }

  const sections = [
    ...(links.length ? [{ body: links }] : []),
    { body: team },
    { body: narrative },
  ];
  return { facts, sections };
}

function projectUpdateOverviewPayload(session: ProjectUpdateSession) {
  const summary = projectUpdateSummary(session);
  return renderInteractionPanel({
    kind: 'interaction-panel',
    tone: 'brand',
    title: `Update ${escapeMarkdown(session.project?.name ?? 'project')}`,
    description: 'Edit project details and team access in one staged update. Nothing changes until the final review is confirmed.',
    progress: { label: 'Project update', current: 2, total: 3 },
    facts: summary.facts,
    sections: summary.sections,
    detailsDensity: 'compact-groups',
    controls: [
      {
        kind: 'string-select',
        id: id(session, ACTIONS.UPDATE_STATUS),
        placeholder: 'Choose the project status',
        label: 'Status',
        options: [
          { label: 'Active', value: PROJECT_STATUSES.ACTIVE, selected: session.status === PROJECT_STATUSES.ACTIVE },
          { label: 'Paused', value: PROJECT_STATUSES.PAUSED, selected: session.status === PROJECT_STATUSES.PAUSED },
        ],
      },
      {
        kind: 'button',
        id: id(session, ACTIONS.UPDATE_DETAILS_OPEN),
        label: 'Edit project details',
        fieldLabel: 'Project details',
        description: 'Change the name, expected end, public summary, or internal notes.',
        style: 'primary',
      },
      {
        kind: 'button',
        id: id(session, ACTIONS.UPDATE_TEAM_OPEN),
        label: 'Manage project team',
        fieldLabel: 'Project team',
        description: 'Change the complete member and supervisor lists.',
        style: 'secondary',
      },
    ],
    actions: [
      {
        id: id(session, ACTIONS.UPDATE_REVIEW),
        label: 'Continue to review',
        style: 'primary',
        disabled: !hasProjectChanges(session),
      },
      ...(!session.fixedProject ? [{
        id: id(session, ACTIONS.UPDATE_BACK_SELECT),
        label: 'Back to projects',
        style: 'secondary' as const,
      }] : []),
      { id: id(session, ACTIONS.UPDATE_CANCEL), label: 'Cancel update', style: 'danger' },
    ],
    audience: 'actor',
  });
}

function projectDetailsModal(session: ProjectUpdateSession) {
  return renderInteractionModal({
    id: id(session, ACTIONS.UPDATE_DETAILS_MODAL),
    title: 'Project update · Details',
    fields: [
      {
        id: 'name',
        label: 'Project name',
        value: session.name,
        minLength: 1,
        maxLength: 80,
      },
      {
        id: 'expected_end',
        label: 'Expected end date',
        placeholder: 'YYYY-MM-DD',
        value: session.expectedEnd,
        minLength: 10,
        maxLength: 10,
      },
      {
        id: 'summary',
        label: 'Public project summary',
        value: session.summary,
        style: 'paragraph',
        maxLength: 1_000,
      },
      {
        id: 'notes',
        label: 'Internal working notes',
        value: session.notes,
        required: false,
        style: 'paragraph',
        maxLength: 1_000,
      },
    ],
  });
}

function projectTeamPayload(session: ProjectUpdateSession) {
  const summary = projectUpdateSummary(session);
  const members = peopleArray(session)
    .filter((person) => person.role === PROJECT_PERSON_ROLES.MEMBER)
    .map((person) => person.discord_user_id);
  const supervisors = peopleArray(session)
    .filter((person) => person.role === PROJECT_PERSON_ROLES.SUPERVISOR)
    .map((person) => person.discord_user_id);
  return renderInteractionPanel({
    kind: 'interaction-panel',
    tone: 'brand',
    title: 'Manage the project team',
    description: 'Edit the complete project team. Eligibility and permissions are checked again when the update is saved.',
    progress: { label: 'Project update', current: 2, total: 3 },
    facts: summary.facts,
    sections: summary.sections,
    detailsDensity: 'compact-groups',
    controls: [
      {
        kind: 'user-select',
        id: id(session, ACTIONS.UPDATE_TEAM_MEMBERS),
        placeholder: 'Choose all project members',
        label: 'Members',
        description: 'Select the complete final member list.',
        selectedUserIds: members,
        min: 0,
        max: 25,
      },
      {
        kind: 'user-select',
        id: id(session, ACTIONS.UPDATE_TEAM_SUPERVISORS),
        placeholder: 'Choose all project supervisors',
        label: 'Supervisors',
        description: 'Select the complete final supervisor list.',
        selectedUserIds: supervisors,
        min: 0,
        max: 25,
      },
    ],
    actions: [
      {
        id: id(session, ACTIONS.UPDATE_REVIEW),
        label: 'Continue to review',
        style: 'primary',
        disabled: !hasProjectChanges(session),
      },
      { id: id(session, ACTIONS.UPDATE_BACK_OVERVIEW), label: 'Back to project', style: 'secondary' },
      { id: id(session, ACTIONS.UPDATE_CANCEL), label: 'Cancel update', style: 'danger' },
    ],
    audience: 'actor',
  });
}

function projectUpdateReviewPayload(session: ProjectUpdateSession) {
  const summary = projectUpdateSummary(session);
  return renderInteractionPanel({
    kind: 'interaction-panel',
    tone: 'changed',
    title: 'Review the project update',
    description: 'The database record and project team will be committed together, then Discord access and durable project messages will reconcile.',
    progress: { label: 'Project update', current: 3, total: 3 },
    facts: summary.facts,
    sections: [
      ...summary.sections,
      { heading: 'Privacy', body: 'Internal notes remain private and never appear in the board activity card.' },
    ],
    detailsDensity: 'compact-groups',
    actions: [
      { id: id(session, ACTIONS.UPDATE_SAVE), label: 'Save project update', style: 'success' },
      { id: id(session, ACTIONS.UPDATE_BACK_OVERVIEW), label: 'Back to project', style: 'secondary' },
      { id: id(session, ACTIONS.UPDATE_CANCEL), label: 'Cancel update', style: 'danger' },
    ],
    audience: 'actor',
  });
}

function projectCloseDetailsPayload(session: ProjectCloseSession) {
  return renderInteractionPanel({
    kind: 'interaction-panel',
    tone: 'warning',
    title: `Close ${escapeMarkdown(session.project?.name ?? 'project')}`,
    description: 'Add the public conclusion and private handover notes before reviewing this consequential change.',
    progress: { label: 'Project closure', current: 1, total: 2 },
    facts: [
      { label: 'Project', value: `${session.project?.name} (#${session.project?.id})` },
      { label: 'Scope', value: session.project ? projectScope(session.project) : 'Unknown' },
      { label: 'Current status', value: statusLabel(session.project?.status ?? '') },
      { label: 'Team', value: teamCounts(session.people) },
    ],
    sections: [{
      heading: 'What closure changes',
      body: [
        'The project becomes completed.',
        'The project channel moves to archive/history with read-only member access.',
        'The public conclusion updates the showcase; private handover notes stay in the workspace record.',
      ],
    }],
    actions: [
      { id: id(session, ACTIONS.CLOSE_DETAILS_OPEN), label: 'Add conclusion and handover', style: 'primary' },
      ...(!session.fixedProject ? [{
        id: id(session, ACTIONS.CLOSE_SEARCH_OPEN),
        label: 'Choose another project',
        style: 'secondary' as const,
      }] : []),
      { id: id(session, ACTIONS.CLOSE_CANCEL), label: 'Cancel closure', style: 'danger' },
    ],
    audience: 'actor',
  });
}

function projectCloseDetailsModal(session: ProjectCloseSession) {
  return renderInteractionModal({
    id: id(session, ACTIONS.CLOSE_DETAILS_MODAL),
    title: 'Project closure · Conclusion',
    fields: [
      {
        id: 'outcome',
        label: 'Public project conclusion',
        placeholder: 'What did the project deliver or learn?',
        value: session.outcome,
        style: 'paragraph',
        maxLength: 1_000,
      },
      {
        id: 'final_notes',
        label: 'Private handover notes',
        placeholder: 'Internal context retained in the project workspace',
        value: session.finalNotes,
        style: 'paragraph',
        maxLength: 1_000,
      },
    ],
  });
}

function projectCloseReviewPayload(session: ProjectCloseSession) {
  return renderInteractionPanel({
    kind: 'interaction-panel',
    tone: 'danger',
    title: 'Review project closure',
    description: 'Confirm only when the project is complete and the public conclusion is ready to share.',
    progress: { label: 'Project closure', current: 2, total: 2 },
    facts: [
      { label: 'Project', value: `${session.project?.name} (#${session.project?.id})` },
      { label: 'Scope', value: session.project ? projectScope(session.project) : 'Unknown' },
      { label: 'Resulting status', value: 'Completed' },
    ],
    sections: [
      { heading: 'Public conclusion', body: session.outcome ?? 'Missing' },
      { heading: 'Private handover notes', body: session.finalNotes ?? 'Missing' },
      { heading: 'Access', body: 'Members keep read-only history access after the project channel moves to archive/history.' },
    ],
    actions: [
      { id: id(session, ACTIONS.CLOSE_SAVE), label: 'Close project', style: 'danger' },
      { id: id(session, ACTIONS.CLOSE_BACK_DETAILS), label: 'Edit conclusion', style: 'secondary' },
      { id: id(session, ACTIONS.CLOSE_CANCEL), label: 'Cancel closure', style: 'secondary' },
    ],
    audience: 'actor',
  });
}

function pendingPayload(title: string, description: string) {
  return renderInteractionPanel({
    kind: 'interaction-panel',
    tone: 'pending',
    title,
    description,
    status: 'This panel will update when the operation finishes. Do not submit it again.',
    audience: 'actor',
  });
}

function cancelledPayload(title: string) {
  return renderInteractionPanel(interactionOutcome({
    outcome: 'cancelled',
    title,
    description: 'Nothing was changed.',
  }));
}

function completedPayload(title: string, description: string, reconciliationPending = false) {
  return renderInteractionPanel(interactionOutcome({
    outcome: reconciliationPending ? 'reconciliation-pending' : 'success',
    title,
    description,
  }));
}

function failurePayload(session: ProjectPanelSession, message: string) {
  const update = session.kind === 'project-update';
  return renderInteractionPanel({
    kind: 'interaction-panel',
    tone: 'danger',
    title: update ? 'Project update not saved' : 'Project not closed',
    description: update
      ? 'Your staged project update is still available.'
      : 'The project remains open and the closure details are still available.',
    sections: [{ heading: 'What happened', body: escapeMarkdown(message) }],
    actions: update
      ? [
          { id: id(session, ACTIONS.UPDATE_SAVE), label: 'Try saving again', style: 'primary' },
          { id: id(session, ACTIONS.UPDATE_BACK_OVERVIEW), label: 'Back to project', style: 'secondary' },
          { id: id(session, ACTIONS.UPDATE_CANCEL), label: 'Cancel update', style: 'danger' },
        ]
      : [
          { id: id(session, ACTIONS.CLOSE_SAVE), label: 'Try closing again', style: 'danger' },
          { id: id(session, ACTIONS.CLOSE_BACK_DETAILS), label: 'Edit conclusion', style: 'secondary' },
          { id: id(session, ACTIONS.CLOSE_CANCEL), label: 'Cancel closure', style: 'secondary' },
        ],
    audience: 'actor',
  });
}

async function respondToModal(interaction, payload) {
  if (interaction.isFromMessage?.()) return interaction.update(payload);
  return interaction.reply(ephemeralReplyPayload(payload));
}

async function updateAfterLookup(interaction, session: ProjectPanelSession, loadingPayload, work) {
  session.busy = true;
  try {
    await interaction.update(loadingPayload);
    const payload = await work();
    session.busy = false;
    await interaction.editReply(interactionEditPayload(payload));
  } catch (error) {
    session.busy = false;
    throw error;
  }
}

function activityChannel(interaction, result) {
  if (!projectCommandChannelScope(interaction.channel)) return interaction.channel;
  const universityName = result?.project?.university_name;
  if (!universityName) return null;
  return interaction.guild?.channels?.cache?.find?.(
    (channel) => channel.name === 'bot-log'
      && channel.parent?.name === `BAINSA ${universityName.toUpperCase()}`,
  ) ?? null;
}

async function publishActivity(interaction, commandName: string, result) {
  const activity = formatBoardActivity(commandName, {
    actorId: interaction.user.id,
    result,
  });
  if (!activity) return false;
  const channel = activityChannel(interaction, result);
  if (!channel) return false;
  try {
    await channel.send(activity);
    return true;
  } catch (error) {
    logger.warn('Project panel activity could not be posted', {
      command: commandName,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

export function createProjectManagementPanelService({
  updateProjectOperation = updateProjectWithPeople,
  closeProjectOperation = closeProject,
  loadProjectContext = getProjectManagementContext,
  searchProjects = searchVisibleProjects,
  now = () => Date.now(),
} = {}) {
  const store = createFlowSessionStore<ProjectPanelSession>({
    now,
    expiredMessage: 'This project panel has expired. Run the command again.',
  });

  async function choicesFor(interaction, query: string, closeOnly = false) {
    return await searchProjects({
      interaction,
      query,
      statuses: closeOnly ? OPEN_PROJECT_STATUSES : OPEN_PROJECT_STATUSES,
    }) as ProjectChoice[];
  }

  function hydrateUpdate(session: ProjectUpdateSession, context) {
    session.project = context.project;
    session.selectedProjectId = String(context.project.id);
    session.initialPeople = context.people.map((person) => ({
      discord_user_id: String(person.discord_user_id),
      role: String(person.role),
    }));
    session.people = new Map(session.initialPeople.map((person) => [person.discord_user_id, person.role]));
    session.name = context.project.name;
    session.expectedEnd = context.project.expected_end;
    session.summary = context.project.summary;
    session.notes = context.project.notes ?? null;
    session.status = context.project.status;
    session.screen = 'overview';
  }

  function hydrateClose(session: ProjectCloseSession, context) {
    session.project = context.project;
    session.selectedProjectId = String(context.project.id);
    session.people = context.people.map((person) => ({
      discord_user_id: String(person.discord_user_id),
      role: String(person.role),
    }));
    session.screen = 'details';
  }

  async function startProjectUpdate(interaction) {
    const channelProject = projectCommandChannelScope(interaction.channel);
    const choices = channelProject ? [] : await choicesFor(interaction, '', false);
    const session = store.start(interaction, (base) => ({
      ...base,
      kind: 'project-update' as const,
      fixedProject: Boolean(channelProject),
      choices,
      selectedProjectId: channelProject?.projectId ?? null,
      searchQuery: '',
      project: null,
      initialPeople: [],
      people: new Map<string, string>(),
      name: null,
      expectedEnd: null,
      summary: null,
      notes: null,
      status: null,
      screen: channelProject ? 'overview' as const : 'select' as const,
    })) as ProjectUpdateSession;

    if (channelProject) {
      hydrateUpdate(session, await loadProjectContext({ interaction, project: null }));
      await interaction.reply(ephemeralReplyPayload(projectUpdateOverviewPayload(session)));
      return;
    }
    await interaction.reply(ephemeralReplyPayload(projectSelectionPayload(session)));
  }

  async function startProjectClose(interaction) {
    const channelProject = projectCommandChannelScope(interaction.channel);
    const choices = channelProject ? [] : await choicesFor(interaction, '', true);
    const session = store.start(interaction, (base) => ({
      ...base,
      kind: 'project-close' as const,
      fixedProject: Boolean(channelProject),
      choices,
      selectedProjectId: channelProject?.projectId ?? null,
      searchQuery: '',
      project: null,
      people: [],
      outcome: null,
      finalNotes: null,
      screen: channelProject ? 'details' as const : 'select' as const,
    })) as ProjectCloseSession;

    if (channelProject) {
      hydrateClose(session, await loadProjectContext({ interaction, project: null }));
      await interaction.reply(ephemeralReplyPayload(projectCloseDetailsPayload(session)));
      return;
    }
    await interaction.reply(ephemeralReplyPayload(projectSelectionPayload(session)));
  }

  function requireParsed(interaction) {
    const parsed = parseFlowCustomId(interaction.customId, PREFIX, ACTION_VALUES);
    if (!parsed) return null;
    return { parsed, session: store.require(interaction, parsed.sessionId) };
  }

  async function saveProjectUpdate(interaction, session: ProjectUpdateSession) {
    assertUser(session.project && hasProjectChanges(session), 'Choose at least one real project change before saving.');
    session.busy = true;
    await interaction.update(pendingPayload(
      `Saving ${escapeMarkdown(session.name ?? session.project.name)}`,
      'BAINSA is validating the final project record and team, committing them together, and reconciling Discord access.',
    ));
    let result;
    try {
      result = await updateProjectOperation({
        interaction,
        project: String(session.project.id),
        name: session.name,
        expectedEnd: session.expectedEnd,
        summary: session.summary,
        notes: String(session.notes ?? '').trim() ? session.notes : null,
        status: session.status,
        people: peopleArray(session),
        expectedUpdatedAt: session.project.updated_at,
        expectedPeople: session.initialPeople,
        removalReasons: {},
      });
    } catch (error) {
      session.busy = false;
      await interaction.editReply(interactionEditPayload(failurePayload(
        session,
        error instanceof UserFacingError ? error.message : 'BAINSA could not save this project update. Try again.',
      )));
      return;
    }
    store.remove(session);
    const posted = await publishActivity(interaction, 'project-update', result);
    await interaction.editReply(interactionEditPayload(completedPayload(
      result.project.reconciliation_pending ? 'Project saved; Discord is catching up' : 'Project updated',
      `${escapeMarkdown(result.project.name)} now has the reviewed details and participant set.${posted ? ' Activity was posted to the university bot-log.' : ' No board-visible activity was needed, or the activity card could not be posted.'}`,
      Boolean(result.project.reconciliation_pending),
    )));
  }

  async function saveProjectClose(interaction, session: ProjectCloseSession) {
    assertUser(session.project && session.outcome && session.finalNotes, 'Add the public conclusion and private handover notes before closing the project.');
    session.busy = true;
    await interaction.update(pendingPayload(
      `Closing ${escapeMarkdown(session.project.name)}`,
      'BAINSA is saving the conclusion, updating the durable project record, and moving the workspace to archive/history.',
    ));
    let result;
    try {
      result = await closeProjectOperation({
        interaction,
        project: String(session.project.id),
        outcome: session.outcome,
        finalNotes: session.finalNotes,
      });
    } catch (error) {
      session.busy = false;
      await interaction.editReply(interactionEditPayload(failurePayload(
        session,
        error instanceof UserFacingError ? error.message : 'BAINSA could not close this project. Try again.',
      )));
      return;
    }
    store.remove(session);
    const posted = await publishActivity(interaction, 'project-close', result);
    await interaction.editReply(interactionEditPayload(completedPayload(
      result.project.reconciliation_pending ? 'Project completed; Discord is catching up' : 'Project completed',
      `${escapeMarkdown(result.project.name)} is completed and its conclusion is saved.${posted ? ' Activity was posted to the university bot-log.' : ' The closure is saved, but the activity card could not be posted.'}`,
      Boolean(result.project.reconciliation_pending),
    )));
  }

  async function handleButton(interaction) {
    const matched = requireParsed(interaction);
    if (!matched) return;
    const { parsed, session } = matched;
    const action = parsed.action;

    if (action === ACTIONS.UPDATE_CANCEL || action === ACTIONS.CLOSE_CANCEL) {
      store.remove(session);
      await interaction.update(cancelledPayload(
        session.kind === 'project-update' ? 'Project update cancelled' : 'Project closure cancelled',
      ));
      return;
    }

    if (action === ACTIONS.UPDATE_SEARCH_OPEN || action === ACTIONS.CLOSE_SEARCH_OPEN) {
      if (
        action === ACTIONS.CLOSE_SEARCH_OPEN
        && session.kind === 'project-close'
        && session.project
        && !session.fixedProject
        && session.screen === 'details'
      ) {
        session.project = null;
        session.screen = 'select';
        await interaction.update(projectSelectionPayload(session));
        return;
      }
      await interaction.showModal(projectSearchModal(session));
      return;
    }

    if (action === ACTIONS.UPDATE_PROJECT_CONTINUE || action === ACTIONS.CLOSE_PROJECT_CONTINUE) {
      assertUser(session.selectedProjectId, 'Choose a project before continuing.');
      const loadingPayload = session.kind === 'project-update'
        ? projectSelectionPayload(session, { loading: true })
        : pendingPayload(
            'Loading project for closure',
            'BAINSA is checking your access and loading the current project record and complete team.',
          );
      await updateAfterLookup(interaction, session, loadingPayload, async () => {
        const context = await loadProjectContext({
          interaction,
          project: session.selectedProjectId,
        });
        if (session.kind === 'project-update') {
          hydrateUpdate(session, context);
          return projectUpdateOverviewPayload(session);
        }
        hydrateClose(session, context);
        return projectCloseDetailsPayload(session);
      });
      return;
    }

    if (session.kind === 'project-update') {
      if (action === ACTIONS.UPDATE_DETAILS_OPEN) {
        await interaction.showModal(projectDetailsModal(session));
        return;
      }
      if (action === ACTIONS.UPDATE_TEAM_OPEN) {
        session.screen = 'team';
        await interaction.update(projectTeamPayload(session));
        return;
      }
      if (action === ACTIONS.UPDATE_BACK_OVERVIEW) {
        session.screen = 'overview';
        await interaction.update(projectUpdateOverviewPayload(session));
        return;
      }
      if (action === ACTIONS.UPDATE_BACK_SELECT) {
        session.screen = 'select';
        await interaction.update(projectSelectionPayload(session));
        return;
      }
      if (action === ACTIONS.UPDATE_REVIEW) {
        assertUser(hasProjectChanges(session), 'Choose at least one real project change before continuing.');
        session.screen = 'review';
        await interaction.update(projectUpdateReviewPayload(session));
        return;
      }
      if (action === ACTIONS.UPDATE_SAVE) await saveProjectUpdate(interaction, session);
      return;
    }

    if (action === ACTIONS.CLOSE_DETAILS_OPEN || action === ACTIONS.CLOSE_BACK_DETAILS) {
      await interaction.showModal(projectCloseDetailsModal(session));
      return;
    }
    if (action === ACTIONS.CLOSE_SAVE) await saveProjectClose(interaction, session);
  }

  async function handleStringSelect(interaction) {
    const matched = requireParsed(interaction);
    if (!matched) return;
    const { parsed, session } = matched;
    const value = String(interaction.values?.[0] ?? '');

    if (parsed.action === ACTIONS.UPDATE_PROJECT || parsed.action === ACTIONS.CLOSE_PROJECT) {
      session.selectedProjectId = value;
      await interaction.update(projectSelectionPayload(session));
      return;
    }

    if (session.kind !== 'project-update') return;
    if (parsed.action === ACTIONS.UPDATE_STATUS) {
      session.status = value;
      await interaction.update(projectUpdateOverviewPayload(session));
      return;
    }
  }

  async function handleUserSelect(interaction) {
    const matched = requireParsed(interaction);
    if (!matched || matched.session.kind !== 'project-update') return;
    const values = [...new Set<string>((interaction.values ?? []).map((value) => String(value)))];
    const role = matched.parsed.action === ACTIONS.UPDATE_TEAM_MEMBERS
      ? PROJECT_PERSON_ROLES.MEMBER
      : matched.parsed.action === ACTIONS.UPDATE_TEAM_SUPERVISORS
        ? PROJECT_PERSON_ROLES.SUPERVISOR
        : null;
    if (!role) return;
    for (const [userId, currentRole] of matched.session.people) {
      if (currentRole === role) matched.session.people.delete(userId);
    }
    for (const userId of values) matched.session.people.set(userId, role);
    await interaction.update(projectTeamPayload(matched.session));
  }

  async function handleModalSubmit(interaction) {
    const matched = requireParsed(interaction);
    if (!matched) return;
    const { parsed, session } = matched;

    if (parsed.action === ACTIONS.UPDATE_SEARCH_MODAL || parsed.action === ACTIONS.CLOSE_SEARCH_MODAL) {
      session.searchQuery = interaction.fields.getTextInputValue('query').trim();
      session.choices = await choicesFor(
        interaction,
        session.searchQuery,
        session.kind === 'project-close',
      );
      session.selectedProjectId = null;
      session.screen = 'select';
      await respondToModal(interaction, projectSelectionPayload(session));
      return;
    }

    if (session.kind === 'project-update' && parsed.action === ACTIONS.UPDATE_DETAILS_MODAL) {
      session.name = normalizeProjectName(interaction.fields.getTextInputValue('name'));
      session.expectedEnd = validateExpectedEndUpdate(
        session.project?.start_date,
        interaction.fields.getTextInputValue('expected_end'),
      );
      session.summary = normalizeProjectLongText(
        interaction.fields.getTextInputValue('summary'),
        'summary',
      );
      const notes = interaction.fields.getTextInputValue('notes');
      session.notes = notes.trim()
        ? normalizeProjectLongText(notes, 'notes')
        : session.project?.notes ?? null;
      session.screen = 'overview';
      await respondToModal(interaction, projectUpdateOverviewPayload(session));
      return;
    }

    if (session.kind === 'project-close' && parsed.action === ACTIONS.CLOSE_DETAILS_MODAL) {
      session.outcome = normalizeProjectLongText(
        interaction.fields.getTextInputValue('outcome'),
        'outcome',
      );
      session.finalNotes = normalizeProjectLongText(
        interaction.fields.getTextInputValue('final_notes'),
        'final_notes',
      );
      session.screen = 'review';
      await respondToModal(interaction, projectCloseReviewPayload(session));
    }
  }

  return {
    startProjectUpdate,
    startProjectClose,
    canHandle(customId: string) {
      return Boolean(parseFlowCustomId(customId, PREFIX, ACTION_VALUES));
    },
    handleButton,
    handleStringSelect,
    handleUserSelect,
    handleModalSubmit,
  };
}

export const projectManagementPanels = createProjectManagementPanelService();

export { ACTIONS as PROJECT_MANAGEMENT_ACTIONS };
