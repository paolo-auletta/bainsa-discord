import { escapeMarkdown } from 'discord.js';

import {
  assertNotBotUser,
  hasRole,
  isDivisionHead,
  isUniversityPresident,
  isUniversityDivisionHead,
  isUniversityVicePresident,
} from '../../authorization.js';
import { formatBoardActivity } from '../../activity/formatters.js';
import {
  BOARD_ROLES,
  MEMBER_TYPES,
  PROJECT_PERSON_ROLES,
  ROLE_NAMES,
  divisionLabel,
} from '../../constants.js';
import { postBoardActivity } from '../../discord/reply.js';
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
  truncateText,
  userReference,
} from '../../messages/index.js';
import type { InteractionActionSpec, InteractionControlSpec } from '../../messages/types.js';
import { botCommandChannelScope } from '../../runtime/command-channels.js';
import {
  formatBoardAssignmentHandoff,
  formatBoardRemovalHandoff,
  formatDivisionMemberHandoff,
  memberRecordSummary,
} from './formatters.js';
import {
  assertCanManageMember,
  boardRoleLabel,
  memberRequiresDivision,
} from './policy.js';
import {
  addDivisionMember,
  assignBoardRole,
  getBoardInfo,
  getMemberInfo,
  listDivisions,
  listUniversities,
  removeBoardRole,
  removeDivisionMember,
} from './service.js';

const PREFIX = 'gmm';
const PAGE_SIZE = 25;

const ACTIONS = Object.freeze({
  TARGET: 't',
  TARGET_CONTINUE: 'tc',
  ROLE: 'r',
  ASSIGNMENT: 'a',
  DIVISION: 'd',
  PREVIOUS: 'p',
  NEXT: 'n',
  REASON_OPEN: 'ro',
  REASON_MODAL: 'rm',
  REVIEW: 'rv',
  BACK_TARGET: 'bt',
  BACK_CHOICE: 'bc',
  SAVE: 's',
  CANCEL: 'x',
});

const ACTION_VALUES = new Set<string>(Object.values(ACTIONS));

type MembershipPanelKind =
  | 'board-add-member'
  | 'board-remove-member'
  | 'division-add-member'
  | 'division-remove-member';

interface UniversityRow {
  id?: unknown;
  name: string;
}

interface DivisionRow {
  id?: unknown;
  name: string;
  color?: string;
  university_id?: unknown;
  university_name?: string;
}

interface DiscordUserReference {
  id: string;
  username?: string;
  globalName?: string;
}

interface DiscordMemberReference {
  id: string;
  displayName?: string;
  user?: DiscordUserReference;
  send?: (payload: unknown) => Promise<unknown>;
}

interface BoardRoleRow {
  role: string;
  university_id?: unknown;
  university_name?: string | null;
  division_id?: unknown;
  division_name?: string | null;
}

interface ProjectRow {
  id?: unknown;
  name?: string;
  role?: string;
  university_id?: unknown;
  university_name?: string;
  division_id?: unknown;
  division_name?: string | null;
  status?: string;
}

interface MemberContext {
  target: DiscordMemberReference;
  member: {
    discord_user_id?: string;
    full_name?: string | null;
    member_type: string;
    university_id: unknown;
    university_name: string;
    status?: string;
  };
  divisions: DivisionRow[];
  boardRoles: BoardRoleRow[];
  projects: ProjectRow[];
}

interface BoardRosterRow {
  discord_user_id: string;
  role: string;
  division_id?: unknown;
  division_name?: string | null;
}

interface MembershipPanelSession extends FlowSessionBase {
  kind: MembershipPanelKind;
  university: UniversityRow;
  targetUser: DiscordUserReference | null;
  context: MemberContext | null;
  divisions: DivisionRow[];
  boardRoster: BoardRosterRow[];
  actorPresident: boolean;
  actorVicePresident: boolean;
  manageableDivisionIds: string[];
  selectedRole: string | null;
  selectedDivisionId: string | null;
  selectedAssignment: string | null;
  reason: string;
  choicePage: number;
  screen: 'target' | 'choice' | 'review';
}

interface BoardRemovalChoice {
  key: string;
  label: string;
  description: string;
  role: string;
  division: DivisionRow | null;
  rows: BoardRoleRow[];
}

function id(session: MembershipPanelSession, action: string) {
  return flowCustomId(PREFIX, session.id, action);
}

function rowValue(row: UniversityRow | DivisionRow | null | undefined) {
  return String(row?.id ?? row?.name ?? '');
}

function sameText(left: unknown, right: unknown) {
  return String(left ?? '').trim().toLowerCase() === String(right ?? '').trim().toLowerCase();
}

function page<T>(items: T[], currentPage: number) {
  const pageCount = Math.max(1, Math.ceil(items.length / PAGE_SIZE));
  const selectedPage = Math.min(pageCount - 1, Math.max(0, currentPage));
  const start = selectedPage * PAGE_SIZE;
  return {
    items: items.slice(start, start + PAGE_SIZE),
    page: selectedPage,
    pageCount,
  };
}

function panelLabel(kind: MembershipPanelKind) {
  if (kind === 'board-add-member') return 'Board appointment';
  if (kind === 'board-remove-member') return 'Board role removal';
  if (kind === 'division-add-member') return 'Division membership';
  return 'Division role removal';
}

function panelTitle(kind: MembershipPanelKind) {
  if (kind === 'board-add-member') return 'Add a board member';
  if (kind === 'board-remove-member') return 'Remove a board member role';
  if (kind === 'division-add-member') return 'Add a division member';
  return 'Remove a division member';
}

function targetDescription(kind: MembershipPanelKind, universityName: string) {
  if (kind === 'board-add-member') {
    return `Choose an active ${universityName} member. BAINSA will load their current assignments before offering eligible board roles.`;
  }
  if (kind === 'board-remove-member') {
    return `Choose a ${universityName} board member. BAINSA will show every current role and make only roles within your authority removable.`;
  }
  if (kind === 'division-add-member') {
    return `Choose an active ${universityName} Researcher. Existing memberships and divisions outside your authority will not be offered.`;
  }
  return `Choose an active ${universityName} member. Every current division will remain visible, but only safe in-scope removals will be actionable.`;
}

function targetPayload(
  session: MembershipPanelSession,
  { loading = false, problem = null }: { loading?: boolean; problem?: string | null } = {},
) {
  return renderInteractionPanel({
    kind: 'interaction-panel',
    tone: problem ? 'danger' : 'brand',
    title: panelTitle(session.kind),
    description: targetDescription(session.kind, session.university.name),
    progress: { label: panelLabel(session.kind), current: 1, total: 3 },
    facts: [
      { label: 'University', value: session.university.name },
      ...(session.targetUser
        ? [{ label: 'Selected member', value: userReference(session.targetUser) }]
        : []),
    ],
    detailsDensity: 'compact',
    controls: [{
      kind: 'user-select',
      id: id(session, ACTIONS.TARGET),
      placeholder: 'Choose a member',
      label: 'Member',
      selectedUserIds: session.targetUser ? [session.targetUser.id] : [],
      disabled: loading,
    }],
    actions: [
      {
        id: id(session, ACTIONS.TARGET_CONTINUE),
        label: 'Continue',
        style: 'primary',
        disabled: !session.targetUser,
        loading,
      },
      {
        id: id(session, ACTIONS.CANCEL),
        label: 'Cancel',
        style: 'danger',
        disabled: loading,
      },
    ],
    status: problem ?? undefined,
    audience: 'actor',
  });
}

function memberFacts(session: MembershipPanelSession) {
  if (!session.context) return [];
  return memberRecordSummary(session.context).metadata;
}

function localBoardRoles(session: MembershipPanelSession) {
  return (session.context?.boardRoles ?? []).filter((role) =>
    sameText(role.university_name, session.university.name),
  );
}

function roleDescription(role: BoardRoleRow) {
  if (role.role === BOARD_ROLES.HEAD) {
    return role.division_name ? `Head of ${role.division_name}` : 'Head of an unavailable division';
  }
  return boardRoleLabel(role.role);
}

function scopedRoleDescription(session: MembershipPanelSession, role: BoardRoleRow) {
  const label = roleDescription(role);
  return role.university_name && !sameText(role.university_name, session.university.name)
    ? `${label} · ${role.university_name}`
    : label;
}

function scopedDivisionLabel(session: MembershipPanelSession, division: DivisionRow) {
  const label = divisionLabel(division.name, division.color);
  return division.university_name && !sameText(division.university_name, session.university.name)
    ? `${label} · ${division.university_name}`
    : label;
}

function divisionForRole(session: MembershipPanelSession, role: BoardRoleRow) {
  return session.divisions.find((division) =>
    (role.division_id != null && rowValue(division) === String(role.division_id))
    || sameText(division.name, role.division_name),
  ) ?? (role.division_name ? { id: role.division_id, name: role.division_name } : null);
}

function targetHasRole(session: MembershipPanelSession, role: string) {
  return localBoardRoles(session).some((assignment) => assignment.role === role);
}

function boardHeadDivisions(session: MembershipPanelSession) {
  if (targetHasRole(session, BOARD_ROLES.PRESIDENT) || targetHasRole(session, BOARD_ROLES.VICE_PRESIDENT)) {
    return [];
  }
  const targetId = String(session.context?.target.id ?? '');
  return session.divisions.filter((division) => {
    const occupied = session.boardRoster.some((assignment) =>
      assignment.role === BOARD_ROLES.HEAD
      && sameText(assignment.division_name, division.name)
      && String(assignment.discord_user_id) !== targetId,
    );
    const alreadyAssigned = localBoardRoles(session).some((assignment) =>
      assignment.role === BOARD_ROLES.HEAD && sameText(assignment.division_name, division.name),
    );
    return !occupied && !alreadyAssigned;
  });
}

function boardAddRoleOptions(session: MembershipPanelSession) {
  const options = [];
  if (boardHeadDivisions(session).length > 0) {
    options.push({
      label: 'Head',
      value: BOARD_ROLES.HEAD,
      description: 'Choose one eligible division next.',
    });
  }
  const vicePresidentOccupied = session.boardRoster.some((assignment) =>
    assignment.role === BOARD_ROLES.VICE_PRESIDENT
    && String(assignment.discord_user_id) !== String(session.context?.target.id),
  );
  if (!targetHasRole(session, BOARD_ROLES.VICE_PRESIDENT) && !vicePresidentOccupied) {
    options.push({
      label: 'Vice President',
      value: BOARD_ROLES.VICE_PRESIDENT,
      description: 'Clears university division and Head access.',
    });
  }
  if (session.actorPresident && !targetHasRole(session, BOARD_ROLES.PRESIDENT)) {
    options.push({
      label: 'President',
      value: BOARD_ROLES.PRESIDENT,
      description: 'Adds a co-President and clears division access.',
    });
  }
  return options;
}

function boardRemovalChoices(session: MembershipPanelSession): BoardRemovalChoice[] {
  const choices: BoardRemovalChoice[] = [];
  for (const [index, role] of (session.context?.boardRoles ?? []).entries()) {
    if (!sameText(role.university_name, session.university.name)) continue;
    const manageable = role.role === BOARD_ROLES.PRESIDENT
      ? session.actorPresident
      : (role.role === BOARD_ROLES.HEAD || role.role === BOARD_ROLES.VICE_PRESIDENT)
        && (session.actorPresident || session.actorVicePresident);
    if (!manageable) continue;
    const division = divisionForRole(session, role);
    choices.push({
      key: `b${index}`,
      label: roleDescription(role),
      description: role.role === BOARD_ROLES.HEAD
        ? `Remove only ${role.division_name ?? 'this'} Head access.`
        : `Remove the ${boardRoleLabel(role.role)} appointment.`,
      role: role.role,
      division,
      rows: [role],
    });
  }
  const heads = choices.filter((choice) => choice.role === BOARD_ROLES.HEAD);
  if (heads.length > 1) {
    choices.unshift({
      key: 'hall',
      label: 'All Head roles',
      description: `Remove ${heads.length} Head assignments in ${session.university.name}.`,
      role: BOARD_ROLES.HEAD,
      division: null,
      rows: heads.flatMap((choice) => choice.rows),
    });
  }
  return choices;
}

function selectedBoardRemoval(session: MembershipPanelSession) {
  return boardRemovalChoices(session).find((choice) => choice.key === session.selectedAssignment) ?? null;
}

function canManageDivision(session: MembershipPanelSession, division: DivisionRow) {
  return session.manageableDivisionIds.includes(rowValue(division));
}

function targetIsLocalExecutive(session: MembershipPanelSession) {
  return localBoardRoles(session).some((role) =>
    role.role === BOARD_ROLES.PRESIDENT || role.role === BOARD_ROLES.VICE_PRESIDENT,
  );
}

function divisionAddChoices(session: MembershipPanelSession) {
  if (session.context?.member.member_type !== MEMBER_TYPES.RESEARCHER || targetIsLocalExecutive(session)) return [];
  const existing = new Set((session.context?.divisions ?? []).map(rowValue));
  return session.divisions.filter((division) =>
    canManageDivision(session, division) && !existing.has(rowValue(division)),
  );
}

function hasLocalBoardAccess(session: MembershipPanelSession) {
  return localBoardRoles(session).length > 0;
}

function matchingDivisionProjects(session: MembershipPanelSession, division: DivisionRow) {
  return (session.context?.projects ?? []).filter((project) =>
    project.role === PROJECT_PERSON_ROLES.MEMBER
    && (
      (project.division_id != null && rowValue(division) === String(project.division_id))
      || sameText(project.division_name, division.name)
    ),
  );
}

function divisionRemovalBlocker(session: MembershipPanelSession, division: DivisionRow) {
  const headAssignment = localBoardRoles(session).find((role) =>
    role.role === BOARD_ROLES.HEAD
    && (
      (role.division_id != null && rowValue(division) === String(role.division_id))
      || sameText(role.division_name, division.name)
    ),
  );
  if (headAssignment) return 'Required by the member’s active Head role.';

  const remaining = (session.context?.divisions ?? []).filter((candidate) =>
    rowValue(candidate) !== rowValue(division),
  );
  if (
    session.context
    && memberRequiresDivision(
      session.context.member.member_type,
      session.context.boardRoles,
      session.context.member.university_name,
    )
    && remaining.length === 0
  ) {
    return 'Researchers without executive access must keep at least one division.';
  }

  const projects = matchingDivisionProjects(session, division);
  if (!hasLocalBoardAccess(session) && projects.length > 0) {
    const names = projects.map((project) => project.name ?? `Project #${project.id}`).slice(0, 3);
    return `Required by active project membership: ${names.join(', ')}${projects.length > 3 ? '…' : ''}.`;
  }
  return null;
}

function divisionRemoveChoices(session: MembershipPanelSession) {
  return (session.context?.divisions ?? []).filter((division) =>
    canManageDivision(session, division) && !divisionRemovalBlocker(session, division),
  );
}

function selectedDivision(session: MembershipPanelSession) {
  const candidates = session.kind === 'board-add-member'
    ? boardHeadDivisions(session)
    : session.kind === 'division-add-member'
      ? divisionAddChoices(session)
      : session.kind === 'division-remove-member'
        ? divisionRemoveChoices(session)
        : [];
  return candidates.find((division) => rowValue(division) === session.selectedDivisionId) ?? null;
}

function boundedLines(lines: string[]) {
  if (lines.length === 0) return 'None';
  const rendered = [];
  for (let index = 0; index < lines.length; index += 1) {
    const remaining = lines.length - index - 1;
    const suffix = remaining > 0 ? `\n… (+${remaining} more)` : '';
    const candidate = [...rendered, lines[index]].join('\n');
    if (`${candidate}${suffix}`.length > 2_800) {
      return `${rendered.join('\n')}\n… (+${lines.length - index} more)`;
    }
    rendered.push(lines[index]);
  }
  return rendered.join('\n');
}

function currentBoardState(session: MembershipPanelSession, mode: 'add' | 'remove') {
  const lines = (session.context?.boardRoles ?? []).map((role) => {
    const label = scopedRoleDescription(session, role);
    if (mode === 'add') return `• ${label}`;
    const local = sameText(role.university_name, session.university.name);
    const manageable = local && (role.role === BOARD_ROLES.PRESIDENT
      ? session.actorPresident
      : session.actorPresident || session.actorVicePresident);
    return `• ${label} — ${manageable ? 'Removable' : 'Read only'}`;
  });
  return boundedLines(lines);
}

function currentDivisionState(session: MembershipPanelSession, mode: 'add' | 'remove') {
  const lines = (session.context?.divisions ?? []).map((division) => {
    const label = scopedDivisionLabel(session, division);
    if (mode === 'add') return `• ${label} — Current`;
    if (!canManageDivision(session, division)) return `• ${label} — Read only outside your scope`;
    const blocker = divisionRemovalBlocker(session, division);
    return `• ${label} — ${blocker ? `Blocked: ${blocker}` : 'Removable'}`;
  });
  return boundedLines(lines);
}

function paginationActions(session: MembershipPanelSession, count: number): InteractionActionSpec[] {
  const pageCount = Math.ceil(count / PAGE_SIZE);
  if (pageCount <= 1) return [];
  return [
    {
      id: id(session, ACTIONS.PREVIOUS),
      label: 'Previous choices',
      style: 'secondary',
      disabled: session.choicePage <= 0,
    },
    {
      id: id(session, ACTIONS.NEXT),
      label: 'Next choices',
      style: 'secondary',
      disabled: session.choicePage >= pageCount - 1,
    },
  ];
}

function removalReasonActions(session: MembershipPanelSession): InteractionActionSpec[] {
  if (!['board-remove-member', 'division-remove-member'].includes(session.kind)) return [];
  return [{
    id: id(session, ACTIONS.REASON_OPEN),
    label: session.reason ? 'Edit private reason' : 'Add private reason',
    style: 'primary',
  }];
}

function boardAddControls(session: MembershipPanelSession) {
  const controls: InteractionControlSpec[] = [];
  const roles = boardAddRoleOptions(session);
  if (roles.length > 0) {
    controls.push({
      kind: 'string-select',
      id: id(session, ACTIONS.ROLE),
      placeholder: 'Choose a board role',
      label: 'Board role',
      options: roles.map((role) => ({ ...role, selected: role.value === session.selectedRole })),
    });
  }
  if (session.selectedRole === BOARD_ROLES.HEAD) {
    const divisions = page(boardHeadDivisions(session), session.choicePage);
    if (divisions.items.length > 0) {
      controls.push({
        kind: 'string-select',
        id: id(session, ACTIONS.DIVISION),
        placeholder: 'Choose the Head division',
        label: 'Division',
        options: divisions.items.map((division) => ({
          label: divisionLabel(division.name, division.color),
          value: rowValue(division),
          selected: rowValue(division) === session.selectedDivisionId,
        })),
      });
    }
  }
  return controls;
}

function boardRemoveControls(session: MembershipPanelSession) {
  const choices = page(boardRemovalChoices(session), session.choicePage);
  if (choices.items.length === 0) return [];
  return [{
    kind: 'string-select' as const,
    id: id(session, ACTIONS.ASSIGNMENT),
    placeholder: 'Choose the board role to remove',
    label: 'Role to remove',
    options: choices.items.map((choice) => ({
      label: choice.label,
      value: choice.key,
      description: choice.description,
      selected: choice.key === session.selectedAssignment,
    })),
  }];
}

function divisionControls(session: MembershipPanelSession, mode: 'add' | 'remove') {
  const available = mode === 'add' ? divisionAddChoices(session) : divisionRemoveChoices(session);
  const choices = page(available, session.choicePage);
  if (choices.items.length === 0) return [];
  return [{
    kind: 'string-select' as const,
    id: id(session, ACTIONS.DIVISION),
    placeholder: mode === 'add' ? 'Choose a division to add' : 'Choose a division to remove',
    label: mode === 'add' ? 'Division to add' : 'Division to remove',
    options: choices.items.map((division) => ({
      label: divisionLabel(division.name, division.color),
      value: rowValue(division),
      selected: rowValue(division) === session.selectedDivisionId,
    })),
  }];
}

function choiceCount(session: MembershipPanelSession) {
  if (session.kind === 'board-add-member') {
    return session.selectedRole === BOARD_ROLES.HEAD ? boardHeadDivisions(session).length : 0;
  }
  if (session.kind === 'board-remove-member') return boardRemovalChoices(session).length;
  if (session.kind === 'division-add-member') return divisionAddChoices(session).length;
  return divisionRemoveChoices(session).length;
}

function hasSelection(session: MembershipPanelSession) {
  if (session.kind === 'board-add-member') {
    return Boolean(
      session.selectedRole
      && (session.selectedRole !== BOARD_ROLES.HEAD || selectedDivision(session)),
    );
  }
  if (session.kind === 'board-remove-member') return Boolean(selectedBoardRemoval(session));
  return Boolean(selectedDivision(session));
}

function emptyChoiceStatus(session: MembershipPanelSession) {
  if (session.kind === 'board-add-member') {
    return boardAddRoleOptions(session).length > 0
      ? undefined
      : 'No board role can be added. The member already holds the available role, the role is occupied, or the appointment conflicts with current executive access.';
  }
  if (session.kind === 'board-remove-member') {
    return boardRemovalChoices(session).length > 0
      ? undefined
      : 'This member has no board role in your university that your current role may remove.';
  }
  if (session.kind === 'division-add-member') {
    if (session.context?.member.member_type !== MEMBER_TYPES.RESEARCHER) {
      return 'Only active Researchers can join a division. Use `/member-update` to change the member type first.';
    }
    if (targetIsLocalExecutive(session)) {
      return 'Presidents and Vice Presidents do not hold university division memberships.';
    }
    return divisionAddChoices(session).length > 0
      ? undefined
      : 'There is no additional division in your scope that this member can join.';
  }
  return divisionRemoveChoices(session).length > 0
    ? undefined
    : 'No current division can be removed by you. Read-only and blocked memberships remain visible above.';
}

function choicePayload(session: MembershipPanelSession) {
  const controls = session.kind === 'board-add-member'
    ? boardAddControls(session)
    : session.kind === 'board-remove-member'
      ? boardRemoveControls(session)
      : divisionControls(session, session.kind === 'division-add-member' ? 'add' : 'remove');
  const sections = session.kind === 'board-add-member'
    ? [{ heading: 'Current board roles', body: currentBoardState(session, 'add') }]
    : session.kind === 'board-remove-member'
      ? [{ heading: 'Current board roles', body: currentBoardState(session, 'remove') }]
      : [{
          heading: 'Current divisions',
          body: currentDivisionState(session, session.kind === 'division-add-member' ? 'add' : 'remove'),
        }];
  const contentActions = [
    ...paginationActions(session, choiceCount(session)),
    ...removalReasonActions(session),
  ];
  return renderInteractionPanel({
    kind: 'interaction-panel',
    tone: session.kind.includes('remove') ? 'warning' : 'brand',
    title: panelTitle(session.kind),
    description: session.kind.includes('remove')
      ? 'Review the complete current state. Only choices that your role may safely remove appear in the control.'
      : 'Current assignments remain visible while the control offers only eligible additions in your scope.',
    progress: { label: panelLabel(session.kind), current: 2, total: 3 },
    facts: memberFacts(session),
    sections,
    detailsDensity: 'compact-groups',
    controls,
    contentActions: contentActions.length ? contentActions : undefined,
    actions: [
      {
        id: id(session, ACTIONS.REVIEW),
        label: 'Continue to review',
        style: 'primary',
        disabled: !hasSelection(session),
      },
      { id: id(session, ACTIONS.BACK_TARGET), label: 'Back to member', style: 'secondary' },
      { id: id(session, ACTIONS.CANCEL), label: 'Cancel', style: 'danger' },
    ],
    status: emptyChoiceStatus(session),
    audience: 'actor',
  });
}

function boardRolesAfterAdd(session: MembershipPanelSession) {
  const selectedDivisionRow = selectedDivision(session);
  const retained = (session.context?.boardRoles ?? []).filter((role) => {
    if (!sameText(role.university_name, session.university.name)) return true;
    if (session.selectedRole === BOARD_ROLES.HEAD) return role.role !== BOARD_ROLES.HEAD;
    return role.role !== BOARD_ROLES.HEAD && role.role !== session.selectedRole;
  });
  const added: BoardRoleRow = {
    role: session.selectedRole,
    university_name: session.university.name,
    division_id: selectedDivisionRow?.id,
    division_name: selectedDivisionRow?.name,
  };
  return [...retained, added];
}

function boardRolesAfterRemoval(session: MembershipPanelSession, choice: BoardRemovalChoice) {
  const removed = new Set(choice.rows);
  return (session.context?.boardRoles ?? []).filter((role) => !removed.has(role));
}

function renderedBoardRoles(session: MembershipPanelSession, roles: BoardRoleRow[]) {
  return boundedLines(roles.map((role) => `• ${scopedRoleDescription(session, role)}`));
}

function divisionsAfterChange(session: MembershipPanelSession, division: DivisionRow, add: boolean) {
  const current = session.context?.divisions ?? [];
  return add
    ? [...current, division]
    : current.filter((candidate) => rowValue(candidate) !== rowValue(division));
}

function renderedDivisions(session: MembershipPanelSession, divisions: DivisionRow[]) {
  return divisions.length
    ? divisions.map((division) => scopedDivisionLabel(session, division)).join(', ')
    : 'None';
}

function reviewPayload(session: MembershipPanelSession) {
  assertUser(session.context, 'Reload the selected member before reviewing this change.');
  const facts = [...memberFacts(session), { label: 'University', value: session.university.name }];
  const sections = [];
  let description = 'BAINSA will re-check authority and current database state immediately before saving.';

  if (session.kind === 'board-add-member') {
    const division = selectedDivision(session);
    const role = session.selectedRole === BOARD_ROLES.HEAD
      ? `Head of ${division?.name ?? 'Unknown division'}`
      : boardRoleLabel(session.selectedRole);
    const displacedHeads = localBoardRoles(session).filter((assignment) => assignment.role === BOARD_ROLES.HEAD);
    facts.push({ label: 'Role to add', value: role });
    sections.push(
      { heading: 'Board roles after confirmation', body: renderedBoardRoles(session, boardRolesAfterAdd(session)) },
      {
        heading: 'Division access after confirmation',
        body: session.selectedRole === BOARD_ROLES.HEAD && division
          ? renderedDivisions(session, [division])
          : 'None for this university executive role',
      },
      {
        heading: 'Displaced assignments',
        body: displacedHeads.length
          ? renderedBoardRoles(session, displacedHeads)
          : 'None',
      },
    );
  } else if (session.kind === 'board-remove-member') {
    const choice = selectedBoardRemoval(session);
    assertUser(choice, 'Choose a current board role before reviewing.');
    description = 'This removes board authority while preserving the member’s base BAINSA membership.';
    facts.push({ label: 'Role to remove', value: choice.label });
    sections.push(
      { heading: 'Board roles after confirmation', body: renderedBoardRoles(session, boardRolesAfterRemoval(session, choice)) },
      { heading: 'Preserved access', body: `${session.context.member.member_type === MEMBER_TYPES.ALUMNI ? 'Alumni' : 'Researcher'} · ${session.university.name}` },
      { heading: 'Private reason', body: session.reason ? 'Added for the affected member and audit record' : 'Not added' },
    );
  } else {
    const division = selectedDivision(session);
    assertUser(division, 'Choose a current in-scope division before reviewing.');
    const add = session.kind === 'division-add-member';
    facts.push({ label: add ? 'Division to add' : 'Division to remove', value: divisionLabel(division.name, division.color) });
    sections.push({
      heading: 'Divisions after confirmation',
      body: renderedDivisions(session, divisionsAfterChange(session, division, add)),
    });
    if (!add) {
      description = 'This removes only the selected division access. University membership remains unchanged.';
      sections.push({
        heading: 'Private reason',
        body: session.reason ? 'Added for the affected member and audit record' : 'Not added',
      });
    }
  }

  return renderInteractionPanel({
    kind: 'interaction-panel',
    tone: session.kind.includes('remove') ? 'warning' : 'changed',
    title: `Review · ${panelTitle(session.kind)}`,
    description,
    progress: { label: panelLabel(session.kind), current: 3, total: 3 },
    facts,
    sections,
    detailsDensity: 'compact-groups',
    actions: [
      {
        id: id(session, ACTIONS.SAVE),
        label: session.kind.includes('remove') ? 'Confirm removal' : 'Confirm addition',
        style: session.kind.includes('remove') ? 'danger' : 'success',
      },
      { id: id(session, ACTIONS.BACK_CHOICE), label: 'Back to choices', style: 'secondary' },
      { id: id(session, ACTIONS.CANCEL), label: 'Cancel', style: 'secondary' },
    ],
    audience: 'actor',
  });
}

function reasonModal(session: MembershipPanelSession) {
  return renderInteractionModal({
    id: id(session, ACTIONS.REASON_MODAL),
    title: `${panelLabel(session.kind)} · Reason`,
    fields: [{
      id: 'reason',
      label: 'Private reason',
      placeholder: 'Optional context for the affected member and audit record',
      value: session.reason,
      required: false,
      style: 'paragraph',
      maxLength: 1_000,
    }],
  });
}

function pendingPayload(session: MembershipPanelSession) {
  return renderInteractionPanel({
    kind: 'interaction-panel',
    tone: 'pending',
    title: session.kind.includes('remove') ? 'Removing access' : 'Adding access',
    description: 'BAINSA is re-checking authority, current assignments, eligibility, and managed Discord roles.',
    status: 'This panel will update when the operation finishes. Do not submit it again.',
    audience: 'actor',
  });
}

function failurePayload(session: MembershipPanelSession, message: string) {
  return renderInteractionPanel({
    kind: 'interaction-panel',
    tone: 'danger',
    title: 'Change not saved',
    description: 'The current setup is still available. Review the problem before trying again.',
    sections: [{ heading: 'What happened', body: escapeMarkdown(message) }],
    actions: [
      { id: id(session, ACTIONS.SAVE), label: 'Try again', style: 'primary' },
      { id: id(session, ACTIONS.BACK_CHOICE), label: 'Back to choices', style: 'secondary' },
      { id: id(session, ACTIONS.CANCEL), label: 'Cancel', style: 'danger' },
    ],
    audience: 'actor',
  });
}

function completedPayload(session: MembershipPanelSession, activityStatus: string, handoffSent: boolean) {
  const warnings = [
    activityStatus !== 'posted' ? 'The governance activity card could not be posted.' : null,
    !handoffSent ? 'The affected member could not be reached by DM.' : null,
  ].filter(Boolean);
  return renderInteractionPanel(interactionOutcome({
    outcome: warnings.length ? 'delivery-failed' : 'success',
    title: session.kind.includes('remove') ? 'Access removed' : 'Access added',
    description: warnings.length
      ? `The governance change was saved. ${warnings.join(' ')}`
      : 'The governance change was saved, activity was posted, and the affected member received a private handoff.',
  }));
}

async function respondToModal(interaction, payload) {
  if (interaction.isFromMessage?.()) return interaction.update(payload);
  return interaction.reply(ephemeralReplyPayload(payload));
}

async function defaultBoardAssignments(interaction, universityName: string) {
  return (await getBoardInfo(interaction, { university: universityName })).rows;
}

async function defaultSendHandoff(target: DiscordMemberReference, payload: unknown) {
  assertUser(target.send, 'The affected member could not be reached by DM.');
  await target.send(payload);
}

export function createGovernanceMembershipPanelService({
  addBoardMemberOperation = assignBoardRole,
  removeBoardMemberOperation = removeBoardRole,
  addDivisionMemberOperation = addDivisionMember,
  removeDivisionMemberOperation = removeDivisionMember,
  loadMemberContext = getMemberInfo,
  loadBoardAssignments = defaultBoardAssignments,
  loadUniversities = listUniversities,
  loadDivisions = listDivisions,
  formatActivity = formatBoardActivity,
  postActivity = postBoardActivity,
  sendHandoff = defaultSendHandoff,
  now = () => Date.now(),
} = {}) {
  const store = createFlowSessionStore<MembershipPanelSession>({
    now,
    expiredMessage: 'This governance panel has expired. Run the command again.',
  });

  async function universityFromChannel(interaction) {
    const scope = botCommandChannelScope(interaction.channel);
    assertUser(
      scope?.kind === 'university',
      'Use this command in a university #bot-log. Global-scope governance will be added in the dedicated global workflow.',
    );
    const universities = await loadUniversities();
    const university = universities.find((candidate) => sameText(candidate.name, scope.universityName));
    assertUser(university, `The ${scope.universityName} bot-log is not linked to an active university.`);
    return university;
  }

  function actorScope(interaction, universityName: string) {
    return {
      president: isUniversityPresident(interaction.member, universityName),
      vicePresident: isUniversityVicePresident(interaction.member, universityName),
    };
  }

  async function start(interaction, kind: MembershipPanelKind) {
    const university = await universityFromChannel(interaction);
    const actor = actorScope(interaction, university.name);
    if (kind.startsWith('board-')) {
      assertUser(
        actor.president || actor.vicePresident,
        `Only the President or Vice President of ${university.name} can manage board appointments here.`,
      );
    } else {
      assertUser(
        actor.president
          || actor.vicePresident
          || isUniversityDivisionHead(interaction.member, university.name),
        `Only a board member of ${university.name} can manage division memberships here.`,
      );
    }
    const session = store.start(interaction, (base) => ({
      ...base,
      kind,
      university,
      targetUser: null,
      context: null,
      divisions: [],
      boardRoster: [],
      actorPresident: actor.president,
      actorVicePresident: actor.vicePresident,
      manageableDivisionIds: [],
      selectedRole: null,
      selectedDivisionId: null,
      selectedAssignment: null,
      reason: '',
      choicePage: 0,
      screen: 'target',
    })) as MembershipPanelSession;
    await interaction.reply(ephemeralReplyPayload(targetPayload(session)));
  }

  async function loadSelectedMember(interaction, session: MembershipPanelSession) {
    assertUser(session.targetUser, 'Choose a member before continuing.');
    assertNotBotUser(interaction, session.targetUser.id);
    session.busy = true;
    try {
      await interaction.update(targetPayload(session, { loading: true }));
      const context = await loadMemberContext(interaction, { user: session.targetUser });
      assertUser(!hasRole(context.target, ROLE_NAMES.BOT), 'The Bot member cannot be managed.');
      assertUser(
        context.member.status === 'active' && sameText(context.member.university_name, session.university.name),
        `Choose an active member of ${session.university.name}.`,
      );
      const actor = actorScope(interaction, session.university.name);
      if (session.kind.startsWith('board-')) {
        assertUser(actor.president || actor.vicePresident, 'Your board-management access changed. Run the command again.');
        assertCanManageMember(interaction.member, session.university.name, context.target);
        if (
          actor.vicePresident
          && !actor.president
          && context.boardRoles.some((role) =>
            role.role === BOARD_ROLES.PRESIDENT && sameText(role.university_name, session.university.name),
          )
        ) {
          assertUser(false, 'A Vice President cannot manage their university President.');
        }
      }
      const [divisions, boardRoster] = await Promise.all([
        loadDivisions(session.university.name) as Promise<DivisionRow[]>,
        session.kind === 'board-add-member'
          ? loadBoardAssignments(interaction, session.university.name) as Promise<BoardRosterRow[]>
          : Promise.resolve([]),
      ]);
      session.context = context;
      session.targetUser = context.target.user ?? session.targetUser;
      session.divisions = divisions;
      session.boardRoster = boardRoster;
      session.actorPresident = actor.president;
      session.actorVicePresident = actor.vicePresident;
      session.manageableDivisionIds = divisions
        .filter((division) =>
          actor.president
          || actor.vicePresident
          || isDivisionHead(interaction.member, session.university.name, division.name),
        )
        .map(rowValue);
      session.selectedRole = null;
      session.selectedDivisionId = null;
      session.selectedAssignment = null;
      session.choicePage = 0;
      session.screen = 'choice';
      session.busy = false;
      await interaction.editReply(interactionEditPayload(choicePayload(session)));
    } catch (error) {
      session.busy = false;
      const message = error instanceof UserFacingError
        ? error.message
        : 'BAINSA could not load that member. Review your selection and try again.';
      if (!(error instanceof UserFacingError)) {
        logger.error('Governance membership context could not be loaded', {
          command: session.kind,
          actorId: interaction.user?.id,
          targetId: session.targetUser?.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      await interaction.editReply(interactionEditPayload(targetPayload(session, { problem: message })));
    }
  }

  function requireParsed(interaction) {
    const parsed = parseFlowCustomId(interaction.customId, PREFIX, ACTION_VALUES);
    if (!parsed) return null;
    return { parsed, session: store.require(interaction, parsed.sessionId) };
  }

  async function deliverHandoff(session: MembershipPanelSession, result) {
    const payload = session.kind === 'board-add-member'
      ? formatBoardAssignmentHandoff(result)
      : session.kind === 'board-remove-member'
        ? formatBoardRemovalHandoff(result, session.reason || null)
        : formatDivisionMemberHandoff(result, {
            removed: session.kind === 'division-remove-member',
            reason: session.reason || null,
          });
    try {
      await sendHandoff(result.target, payload);
      return true;
    } catch (error) {
      logger.warn('Governance membership handoff could not be delivered', {
        command: session.kind,
        userId: String(result.target?.id ?? ''),
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  async function save(interaction, session: MembershipPanelSession) {
    assertUser(session.context && hasSelection(session), 'Choose a valid current action before confirming.');
    session.busy = true;
    await interaction.update(pendingPayload(session));
    let result;
    try {
      const user = session.targetUser ?? { id: session.context.target.id };
      if (session.kind === 'board-add-member') {
        const division = selectedDivision(session);
        result = await addBoardMemberOperation(interaction, {
          user,
          university: session.university.name,
          role: session.selectedRole,
          division: division?.name ?? null,
        });
      } else if (session.kind === 'board-remove-member') {
        const choice = selectedBoardRemoval(session);
        assertUser(choice, 'Choose a current board role before confirming.');
        result = await removeBoardMemberOperation(interaction, {
          user,
          university: session.university.name,
          role: choice.role,
          division: choice.division?.name ?? null,
          reason: session.reason || null,
        });
      } else {
        const division = selectedDivision(session);
        assertUser(division, 'Choose a current in-scope division before confirming.');
        const operation = session.kind === 'division-add-member'
          ? addDivisionMemberOperation
          : removeDivisionMemberOperation;
        result = await operation(interaction, {
          user,
          university: session.university.name,
          division: division.name,
          ...(session.kind === 'division-remove-member' ? { reason: session.reason || null } : {}),
        });
      }
    } catch (error) {
      session.busy = false;
      await interaction.editReply(interactionEditPayload(failurePayload(
        session,
        error instanceof UserFacingError ? error.message : 'BAINSA could not save this governance change. Try again.',
      )));
      return;
    }

    store.remove(session);
    const activity = formatActivity(session.kind, { actorId: interaction.user.id, result });
    const [activityDelivery, handoffSent] = await Promise.all([
      postActivity(interaction, activity),
      deliverHandoff(session, result),
    ]);
    await interaction.editReply(interactionEditPayload(completedPayload(
      session,
      activityDelivery.status,
      handoffSent,
    )));
  }

  async function handleButton(interaction) {
    const matched = requireParsed(interaction);
    if (!matched) return;
    const { parsed, session } = matched;
    const action = parsed.action;

    if (action === ACTIONS.CANCEL) {
      store.remove(session);
      await interaction.update(renderInteractionPanel(interactionOutcome({
        outcome: 'cancelled',
        title: `${panelLabel(session.kind)} cancelled`,
        description: 'Nothing was changed.',
      })));
      return;
    }
    if (action === ACTIONS.TARGET_CONTINUE) {
      await loadSelectedMember(interaction, session);
      return;
    }
    if (action === ACTIONS.BACK_TARGET) {
      session.context = null;
      session.divisions = [];
      session.boardRoster = [];
      session.selectedRole = null;
      session.selectedDivisionId = null;
      session.selectedAssignment = null;
      session.choicePage = 0;
      session.screen = 'target';
      await interaction.update(targetPayload(session));
      return;
    }
    if (action === ACTIONS.PREVIOUS || action === ACTIONS.NEXT) {
      session.choicePage += action === ACTIONS.PREVIOUS ? -1 : 1;
      await interaction.update(choicePayload(session));
      return;
    }
    if (action === ACTIONS.REASON_OPEN) {
      await interaction.showModal(reasonModal(session));
      return;
    }
    if (action === ACTIONS.REVIEW) {
      assertUser(hasSelection(session), 'Choose a valid current action before continuing.');
      session.screen = 'review';
      await interaction.update(reviewPayload(session));
      return;
    }
    if (action === ACTIONS.BACK_CHOICE) {
      session.screen = 'choice';
      await interaction.update(choicePayload(session));
      return;
    }
    if (action === ACTIONS.SAVE) await save(interaction, session);
  }

  async function handleStringSelect(interaction) {
    const matched = requireParsed(interaction);
    if (!matched) return;
    const { parsed, session } = matched;
    const value = String(interaction.values?.[0] ?? '');

    if (parsed.action === ACTIONS.ROLE && session.kind === 'board-add-member') {
      session.selectedRole = value;
      session.selectedDivisionId = null;
      session.choicePage = 0;
    } else if (parsed.action === ACTIONS.ASSIGNMENT && session.kind === 'board-remove-member') {
      session.selectedAssignment = value;
    } else if (parsed.action === ACTIONS.DIVISION) {
      session.selectedDivisionId = value;
    }
    await interaction.update(choicePayload(session));
  }

  async function handleUserSelect(interaction) {
    const matched = requireParsed(interaction);
    if (!matched) return;
    const { parsed, session } = matched;
    if (parsed.action !== ACTIONS.TARGET) return;
    const selectedId = String(interaction.values?.[0] ?? '');
    assertUser(selectedId, 'Choose one member from the list.');
    session.targetUser = interaction.users?.get?.(selectedId) ?? { id: selectedId };
    session.context = null;
    session.selectedRole = null;
    session.selectedDivisionId = null;
    session.selectedAssignment = null;
    session.choicePage = 0;
    session.screen = 'target';
    await interaction.update(targetPayload(session));
  }

  async function handleModalSubmit(interaction) {
    const matched = requireParsed(interaction);
    if (!matched) return;
    const { parsed, session } = matched;
    if (parsed.action !== ACTIONS.REASON_MODAL) return;
    session.reason = truncateText(interaction.fields.getTextInputValue('reason').trim(), 1_000, '');
    session.screen = 'choice';
    await respondToModal(interaction, choicePayload(session));
  }

  return {
    startBoardAddMember: (interaction) => start(interaction, 'board-add-member'),
    startBoardRemoveMember: (interaction) => start(interaction, 'board-remove-member'),
    startDivisionAddMember: (interaction) => start(interaction, 'division-add-member'),
    startDivisionRemoveMember: (interaction) => start(interaction, 'division-remove-member'),
    canHandle(customId: string) {
      return Boolean(parseFlowCustomId(customId, PREFIX, ACTION_VALUES));
    },
    handleButton,
    handleStringSelect,
    handleUserSelect,
    handleModalSubmit,
  };
}

export const governanceMembershipPanels = createGovernanceMembershipPanelService();

export { ACTIONS as GOVERNANCE_MEMBERSHIP_PANEL_ACTIONS };
