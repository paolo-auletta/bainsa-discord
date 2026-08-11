import { escapeMarkdown } from 'discord.js';

import { formatBoardActivity } from '../../activity/formatters.js';
import { postUniversityBoardActivity } from '../../activity/router.js';
import { hasGlobalAuthority } from '../../authorization.js';
import { DIVISION_COLORS, MEMBER_TYPES, divisionLabel } from '../../constants.js';
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
import type { InteractionControlSpec } from '../../messages/types.js';
import { botCommandChannelScope } from '../../runtime/command-channels.js';
import { resolveCommandContext } from '../../runtime/command-scope.js';
import { normalizeDisplayName } from '../../naming.js';
import { memberRecordSummary } from './formatters.js';
import { boardRoleLabel, memberRequiresDivision } from './policy.js';
import {
  createDivision,
  getMemberUpdateContext,
  listDivisions,
  listUniversities,
  updateDivision,
  updateMember,
} from './service.js';

const PREFIX = 'gm';
const PAGE_SIZE = 25;

const ACTIONS = Object.freeze({
  DIVISION_CREATE_UNIVERSITY: 'dcu',
  DIVISION_CREATE_UNIVERSITY_PREVIOUS: 'dcup',
  DIVISION_CREATE_UNIVERSITY_NEXT: 'dcun',
  DIVISION_CREATE_NAME_OPEN: 'dcno',
  DIVISION_CREATE_NAME_MODAL: 'dcnm',
  DIVISION_CREATE_COLOR: 'dcc',
  DIVISION_CREATE_HEAD: 'dch',
  DIVISION_CREATE_CHANNELS: 'dccl',
  DIVISION_CREATE_REVIEW: 'dcr',
  DIVISION_CREATE_BACK_SCOPE: 'dcbs',
  DIVISION_CREATE_BACK_SETTINGS: 'dcbe',
  DIVISION_CREATE_SAVE: 'dcs',
  DIVISION_CREATE_CANCEL: 'dcx',
  DIVISION_UPDATE_UNIVERSITY: 'duu',
  DIVISION_UPDATE_UNIVERSITY_PREVIOUS: 'duup',
  DIVISION_UPDATE_UNIVERSITY_NEXT: 'duun',
  DIVISION_UPDATE_UNIVERSITY_CONTINUE: 'duuc',
  DIVISION_UPDATE_DIVISION: 'dud',
  DIVISION_UPDATE_DIVISION_CONTINUE: 'dudc',
  DIVISION_UPDATE_DIVISION_PREVIOUS: 'dudp',
  DIVISION_UPDATE_DIVISION_NEXT: 'dudn',
  DIVISION_UPDATE_NAME_OPEN: 'duno',
  DIVISION_UPDATE_NAME_MODAL: 'dunm',
  DIVISION_UPDATE_COLOR: 'duc',
  DIVISION_UPDATE_REVIEW: 'dur',
  DIVISION_UPDATE_BACK_SELECT: 'dubs',
  DIVISION_UPDATE_BACK_DETAILS: 'dube',
  DIVISION_UPDATE_SAVE: 'dus',
  DIVISION_UPDATE_CANCEL: 'dux',
  MEMBER_UPDATE_TARGET: 'mut',
  MEMBER_UPDATE_TARGET_CONTINUE: 'mutc',
  MEMBER_UPDATE_TYPE: 'muty',
  MEMBER_UPDATE_UNIVERSITY: 'muu',
  MEMBER_UPDATE_UNIVERSITY_PREVIOUS: 'muup',
  MEMBER_UPDATE_UNIVERSITY_NEXT: 'muun',
  MEMBER_UPDATE_DIVISIONS: 'mud',
  MEMBER_UPDATE_DIVISIONS_PREVIOUS: 'mudp',
  MEMBER_UPDATE_DIVISIONS_NEXT: 'mudn',
  MEMBER_UPDATE_NOTES_OPEN: 'muno',
  MEMBER_UPDATE_NOTES_MODAL: 'munm',
  MEMBER_UPDATE_REVIEW: 'mur',
  MEMBER_UPDATE_BACK_TARGET: 'mubt',
  MEMBER_UPDATE_BACK_DETAILS: 'mubd',
  MEMBER_UPDATE_SAVE: 'mus',
  MEMBER_UPDATE_CANCEL: 'mux',
});

const ACTION_VALUES = new Set<string>(Object.values(ACTIONS));

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
}

interface DiscordMemberReference {
  id: string;
  user?: DiscordUserReference;
}

interface BoardRoleRow {
  role?: string;
  university_name?: string | null;
  division_name?: string | null;
}

interface MemberUpdateContext {
  target: DiscordMemberReference;
  member: {
    discord_user_id?: string;
    full_name?: string;
    member_type: string;
    university_id: unknown;
    university_name: string;
    notes?: string | null;
    status?: string;
  };
  divisions: DivisionRow[];
  boardRoles: BoardRoleRow[];
  projects: unknown[];
}

interface DivisionCreateSession extends FlowSessionBase {
  kind: 'division-create';
  fixedUniversity: boolean;
  universities: UniversityRow[];
  universityPage: number;
  university: UniversityRow | null;
  divisionName: string | null;
  color: string;
  headId: string | null;
  headUser: DiscordUserReference | null;
  channels: string[];
  screen: 'scope' | 'settings' | 'review';
}

interface DivisionUpdateSession extends FlowSessionBase {
  kind: 'division-update';
  fixedUniversity: boolean;
  universities: UniversityRow[];
  universityPage: number;
  university: UniversityRow | null;
  universityConfirmed: boolean;
  divisions: DivisionRow[];
  divisionPage: number;
  division: DivisionRow | null;
  newName: string | null;
  color: string | null;
  screen: 'select' | 'details' | 'review';
}

interface MemberUpdateSession extends FlowSessionBase {
  kind: 'member-update';
  target: DiscordMemberReference | null;
  targetUser: DiscordUserReference | null;
  context: MemberUpdateContext | null;
  universities: UniversityRow[];
  universityPage: number;
  university: UniversityRow | null;
  divisions: DivisionRow[];
  divisionPage: number;
  memberType: string | null;
  divisionIds: string[];
  notes: string | null;
  canChangeUniversity: boolean;
  screen: 'target' | 'details' | 'review';
}

type GovernancePanelSession = DivisionCreateSession | DivisionUpdateSession | MemberUpdateSession;

function id(session: GovernancePanelSession, action: string) {
  return flowCustomId(PREFIX, session.id, action);
}

function rowValue(row: UniversityRow | DivisionRow | null | undefined) {
  return String(row?.id ?? row?.name ?? '');
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

function pageActions(
  session: GovernancePanelSession,
  previous: string,
  next: string,
  currentPage: number,
  count: number,
  label: string,
) {
  const pageCount = Math.ceil(count / PAGE_SIZE);
  if (pageCount <= 1) return [];
  return [
    {
      id: id(session, previous),
      label: `Previous ${label}`,
      style: 'secondary' as const,
      disabled: currentPage <= 0,
    },
    {
      id: id(session, next),
      label: `Next ${label}`,
      style: 'secondary' as const,
      disabled: currentPage >= pageCount - 1,
    },
  ];
}

function universityControl(session: GovernancePanelSession, action: string) {
  const current = page(session.universities, session.universityPage);
  if (current.items.length === 0) return null;
  return {
    kind: 'string-select' as const,
    id: id(session, action),
    placeholder: 'Choose a university',
    label: 'University',
    options: current.items.map((university) => ({
      label: String(university.name),
      value: rowValue(university),
      selected: rowValue(university) === rowValue(session.university),
    })),
  };
}

function divisionControl(
  session: DivisionUpdateSession | MemberUpdateSession,
  action: string,
  { multiple = false } = {},
) {
  const current = page(session.divisions, session.divisionPage);
  if (current.items.length === 0) return null;
  const selected = session.kind === 'division-update'
    ? new Set(session.division ? [rowValue(session.division)] : [])
    : new Set(session.divisionIds.map(String));
  return {
    kind: 'string-select' as const,
    id: id(session, action),
    placeholder: multiple ? 'Choose the member divisions' : 'Choose a division',
    label: multiple ? 'Divisions' : 'Division',
    options: current.items.map((division) => ({
      label: divisionLabel(division.name, division.color),
      value: rowValue(division),
      selected: selected.has(rowValue(division)),
    })),
    min: multiple ? 0 : 1,
    max: multiple ? current.items.length : 1,
  };
}

function changedValue(current: string, next: string, changed: boolean) {
  return changed ? `${current} → ${next}` : current;
}

function divisionCreateScopePayload(session: DivisionCreateSession) {
  const controls = session.fixedUniversity
    ? []
    : [universityControl(session, ACTIONS.DIVISION_CREATE_UNIVERSITY)].filter(Boolean);
  return renderInteractionPanel({
    kind: 'interaction-panel',
    tone: 'brand',
    title: 'Create a division',
    description: 'Choose the owning university and give the division a clear, durable name.',
    progress: { label: 'Division setup', current: 1, total: 3 },
    facts: [
      { label: 'University', value: session.university?.name ?? 'Not selected yet' },
      { label: 'Division name', value: session.divisionName ?? 'Not entered yet' },
    ],
    controls,
    actions: [
      ...pageActions(
        session,
        ACTIONS.DIVISION_CREATE_UNIVERSITY_PREVIOUS,
        ACTIONS.DIVISION_CREATE_UNIVERSITY_NEXT,
        session.universityPage,
        session.universities.length,
        'universities',
      ),
      {
        id: id(session, ACTIONS.DIVISION_CREATE_NAME_OPEN),
        label: session.divisionName ? 'Edit division name' : 'Enter division name',
        style: 'primary',
        disabled: !session.university,
      },
      { id: id(session, ACTIONS.DIVISION_CREATE_CANCEL), label: 'Cancel setup', style: 'danger' },
    ],
    audience: 'actor',
  });
}

function divisionCreateNameModal(session: DivisionCreateSession) {
  return renderInteractionModal({
    id: id(session, ACTIONS.DIVISION_CREATE_NAME_MODAL),
    title: 'Division setup · Name',
    fields: [{
      id: 'division_name',
      label: 'Division name',
      placeholder: 'e.g. Research and Insights',
      value: session.divisionName,
      minLength: 1,
      maxLength: 80,
    }],
  });
}

function divisionCreateSettingsPayload(session: DivisionCreateSession) {
  const colorOptions = Object.values(DIVISION_COLORS).map((color) => ({
    label: `${color.label} ${color.icon}`,
    value: color.key,
    selected: color.key === session.color,
  }));
  return renderInteractionPanel({
    kind: 'interaction-panel',
    tone: 'brand',
    title: 'Set division access and spaces',
    description: 'Choose the initial Head and which working spaces BAINSA should create.',
    progress: { label: 'Division setup', current: 2, total: 3 },
    facts: [
      { label: 'Division', value: session.divisionName ?? 'Not entered yet' },
      { label: 'University', value: session.university?.name ?? 'Not selected yet' },
    ],
    controls: [
      {
        kind: 'string-select',
        id: id(session, ACTIONS.DIVISION_CREATE_COLOR),
        placeholder: 'Choose the division color',
        label: 'Division color',
        description: 'Identifies the division across its managed role and channels.',
        options: colorOptions,
      },
      {
        kind: 'user-select',
        id: id(session, ACTIONS.DIVISION_CREATE_HEAD),
        placeholder: 'Choose the initial division Head',
        label: 'Initial Head',
        description: 'Receives responsibility and access for this division.',
        selectedUserIds: session.headId ? [session.headId] : [],
      },
      {
        kind: 'string-select',
        id: id(session, ACTIONS.DIVISION_CREATE_CHANNELS),
        placeholder: 'Choose the division spaces',
        label: 'Division spaces',
        description: 'Choose whether to create managed text and voice channels.',
        min: 0,
        max: 2,
        options: [
          { label: 'Text channel', value: 'text', selected: session.channels.includes('text') },
          { label: 'Voice channel', value: 'voice', selected: session.channels.includes('voice') },
        ],
      },
    ],
    actions: [
      {
        id: id(session, ACTIONS.DIVISION_CREATE_REVIEW),
        label: 'Continue to review',
        style: 'primary',
        disabled: !session.headId,
      },
      {
        id: id(session, ACTIONS.DIVISION_CREATE_NAME_OPEN),
        label: 'Edit name',
        style: 'secondary',
      },
      ...(!session.fixedUniversity ? [{
        id: id(session, ACTIONS.DIVISION_CREATE_BACK_SCOPE),
        label: 'Back to university',
        style: 'secondary' as const,
      }] : []),
      { id: id(session, ACTIONS.DIVISION_CREATE_CANCEL), label: 'Cancel setup', style: 'danger' },
    ],
    audience: 'actor',
  });
}

function divisionCreateReviewPayload(session: DivisionCreateSession) {
  const color = Object.values(DIVISION_COLORS).find((candidate) => candidate.key === session.color);
  const channels = [
    session.channels.includes('text') ? 'Text channel' : null,
    session.channels.includes('voice') ? 'Voice channel' : null,
  ].filter(Boolean).join(', ') || 'No division channels';
  return renderInteractionPanel({
    kind: 'interaction-panel',
    tone: 'brand',
    title: 'Review the new division',
    description: 'Nothing is created until you confirm this review.',
    progress: { label: 'Division setup', current: 3, total: 3 },
    facts: [
      { label: 'Division', value: session.divisionName ?? 'Not entered' },
      { label: 'University', value: session.university?.name ?? 'Not selected' },
      { label: 'Color', value: color ? `${color.icon} ${color.label}` : session.color },
      { label: 'Initial Head', value: session.headId ? `<@${session.headId}>` : 'Not selected' },
      { label: 'Spaces', value: channels },
    ],
    actions: [
      { id: id(session, ACTIONS.DIVISION_CREATE_SAVE), label: 'Create division', style: 'success' },
      { id: id(session, ACTIONS.DIVISION_CREATE_BACK_SETTINGS), label: 'Back to setup', style: 'secondary' },
      { id: id(session, ACTIONS.DIVISION_CREATE_CANCEL), label: 'Cancel setup', style: 'danger' },
    ],
    audience: 'actor',
  });
}

function divisionUpdateSelectPayload(session: DivisionUpdateSession) {
  const controls = [
    ...(!session.fixedUniversity && !session.universityConfirmed
      ? [universityControl(session, ACTIONS.DIVISION_UPDATE_UNIVERSITY)]
      : []),
    ...(session.universityConfirmed ? [divisionControl(session, ACTIONS.DIVISION_UPDATE_DIVISION)] : []),
  ].filter(Boolean);
  return renderInteractionPanel({
    kind: 'interaction-panel',
    tone: 'brand',
    title: 'Update a division',
    description: 'Choose the division whose managed roles and channels should change.',
    progress: { label: 'Division update', current: 1, total: 3 },
    facts: [
      { label: 'University', value: session.university?.name ?? 'Not selected yet' },
      ...(session.division ? [{ label: 'Selected division', value: divisionLabel(session.division.name, session.division.color) }] : []),
    ],
    detailsDensity: 'compact',
    controls,
    actions: [
      {
        id: id(session, session.universityConfirmed
          ? ACTIONS.DIVISION_UPDATE_DIVISION_CONTINUE
          : ACTIONS.DIVISION_UPDATE_UNIVERSITY_CONTINUE),
        label: 'Continue',
        style: 'primary',
        disabled: session.universityConfirmed ? !session.division : !session.university,
      },
      ...pageActions(
        session,
        ACTIONS.DIVISION_UPDATE_UNIVERSITY_PREVIOUS,
        ACTIONS.DIVISION_UPDATE_UNIVERSITY_NEXT,
        session.universityPage,
        session.universities.length,
        'universities',
      ),
      ...pageActions(
        session,
        ACTIONS.DIVISION_UPDATE_DIVISION_PREVIOUS,
        ACTIONS.DIVISION_UPDATE_DIVISION_NEXT,
        session.divisionPage,
        session.divisions.length,
        'divisions',
      ),
      { id: id(session, ACTIONS.DIVISION_UPDATE_CANCEL), label: 'Cancel update', style: 'danger' },
    ],
    sections: session.university && session.divisions.length === 0
      ? [{ body: 'This university has no active divisions to update.' }]
      : [],
    audience: 'actor',
  });
}

function divisionUpdateNameModal(session: DivisionUpdateSession) {
  return renderInteractionModal({
    id: id(session, ACTIONS.DIVISION_UPDATE_NAME_MODAL),
    title: 'Division update · Name',
    fields: [{
      id: 'division_name',
      label: 'Division name',
      value: session.newName ?? session.division?.name,
      minLength: 1,
      maxLength: 80,
    }],
  });
}

function hasDivisionUpdateChanges(session: DivisionUpdateSession) {
  if (!session.division) return false;
  return (
    String(session.newName ?? session.division.name) !== String(session.division.name)
    || String(session.color ?? session.division.color) !== String(session.division.color)
  );
}

function divisionUpdateSummaryFacts(session: DivisionUpdateSession) {
  const currentColor = Object.values(DIVISION_COLORS)
    .find((candidate) => candidate.key === session.division?.color);
  const nextColor = Object.values(DIVISION_COLORS)
    .find((candidate) => candidate.key === (session.color ?? session.division?.color));
  const currentName = escapeMarkdown(session.division?.name ?? 'Unknown');
  const nextName = escapeMarkdown(session.newName ?? session.division?.name ?? 'Unknown');
  const currentColorLabel = currentColor ? `${currentColor.icon} ${currentColor.label}` : 'Unknown';
  const nextColorLabel = nextColor ? `${nextColor.icon} ${nextColor.label}` : 'Unknown';
  const nameChanged = currentName !== nextName;
  const colorChanged = String(session.division?.color) !== String(session.color ?? session.division?.color);
  return [
    { label: 'Current name', value: changedValue(currentName, nextName, nameChanged) },
    { label: 'Current color', value: changedValue(currentColorLabel, nextColorLabel, colorChanged) },
  ];
}

function divisionUpdateDetailsPayload(session: DivisionUpdateSession) {
  return renderInteractionPanel({
    kind: 'interaction-panel',
    tone: 'brand',
    title: `Edit ${escapeMarkdown(session.division?.name ?? 'division')}`,
    description: 'Changes are staged here and applied to the database, roles, and managed channels together.',
    progress: { label: 'Division update', current: 2, total: 3 },
    facts: [
      { label: 'University', value: session.university?.name ?? 'Unknown' },
      ...divisionUpdateSummaryFacts(session),
    ],
    detailsDensity: 'compact',
    controls: [
      {
        kind: 'button',
        id: id(session, ACTIONS.DIVISION_UPDATE_NAME_OPEN),
        label: `New name · ${session.newName ?? session.division?.name ?? 'Enter a name'}`,
        fieldLabel: 'New name',
        style: 'primary',
      },
      {
        kind: 'string-select',
        id: id(session, ACTIONS.DIVISION_UPDATE_COLOR),
        placeholder: 'Choose the new division color',
        label: 'New color',
        options: Object.values(DIVISION_COLORS).map((color) => ({
          label: `${color.label} ${color.icon}`,
          value: color.key,
          selected: color.key === (session.color ?? session.division?.color),
        })),
      },
    ],
    actions: [
      {
        id: id(session, ACTIONS.DIVISION_UPDATE_REVIEW),
        label: 'Continue to review',
        style: 'primary',
        disabled: !hasDivisionUpdateChanges(session),
      },
      { id: id(session, ACTIONS.DIVISION_UPDATE_BACK_SELECT), label: 'Back to division', style: 'secondary' },
      { id: id(session, ACTIONS.DIVISION_UPDATE_CANCEL), label: 'Cancel update', style: 'danger' },
    ],
    audience: 'actor',
  });
}

function divisionUpdateReviewPayload(session: DivisionUpdateSession) {
  return renderInteractionPanel({
    kind: 'interaction-panel',
    tone: 'changed',
    title: 'Review the division update',
    description: 'The division role names, colors, and managed channel names will be reconciled after confirmation.',
    progress: { label: 'Division update', current: 3, total: 3 },
    facts: [
      { label: 'University', value: session.university?.name ?? 'Unknown' },
      ...divisionUpdateSummaryFacts(session),
    ],
    detailsDensity: 'compact',
    actions: [
      { id: id(session, ACTIONS.DIVISION_UPDATE_SAVE), label: 'Save division update', style: 'success' },
      { id: id(session, ACTIONS.DIVISION_UPDATE_BACK_DETAILS), label: 'Back to changes', style: 'secondary' },
      { id: id(session, ACTIONS.DIVISION_UPDATE_CANCEL), label: 'Cancel update', style: 'danger' },
    ],
    audience: 'actor',
  });
}

function memberTargetPayload(session: MemberUpdateSession, { loading = false } = {}) {
  return renderInteractionPanel({
    kind: 'interaction-panel',
    tone: 'brand',
    title: 'Update a member',
    description: 'Choose the member first. BAINSA will load their current record and show only the fields you can manage.',
    progress: { label: 'Member update', current: 1, total: 3 },
    facts: session.targetUser
      ? [{ label: 'Selected member', value: `<@${session.targetUser.id}>` }]
      : [],
    controls: [{
      kind: 'user-select',
      id: id(session, ACTIONS.MEMBER_UPDATE_TARGET),
      placeholder: 'Choose the member to update',
      label: 'Member',
      selectedUserIds: session.targetUser ? [session.targetUser.id] : [],
      disabled: loading,
    }],
    actions: [
      {
        id: id(session, ACTIONS.MEMBER_UPDATE_TARGET_CONTINUE),
        label: 'Continue',
        style: 'primary',
        disabled: !session.targetUser,
        loading,
      },
      {
        id: id(session, ACTIONS.MEMBER_UPDATE_CANCEL),
        label: 'Cancel update',
        style: 'danger',
        disabled: loading,
      },
    ],
    audience: 'actor',
  });
}

function selectedMemberDivisions(session: MemberUpdateSession) {
  const selected = new Set(session.divisionIds.map(String));
  return session.divisions.filter((division) => selected.has(rowValue(division)));
}

function sameStringSet(left: unknown[], right: unknown[]) {
  const a = [...new Set(left.map(String))].sort();
  const b = [...new Set(right.map(String))].sort();
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function hasMemberChanges(session: MemberUpdateSession) {
  if (!session.context || !session.university || !session.memberType) return false;
  return (
    session.memberType !== session.context.member.member_type
    || rowValue(session.university) !== String(session.context.member.university_id)
    || !sameStringSet(session.divisionIds, session.context.divisions.map(rowValue))
    || String(session.notes ?? '') !== String(session.context.member.notes ?? '')
  );
}

function hasValidMemberDivisions(session: MemberUpdateSession) {
  if (!session.context || !session.memberType || !session.university) return false;
  return (
    !memberRequiresDivision(session.memberType, session.context.boardRoles, session.university.name)
    || session.divisionIds.length > 0
  );
}

function memberUniversityMoveBlocker(session: MemberUpdateSession) {
  if (!session.context || !session.university) return null;
  if (rowValue(session.university) === String(session.context.member.university_id)) return null;
  const scopedBoardRoles = session.context.boardRoles.filter((role) => role.university_name);
  if (scopedBoardRoles.length > 0) {
    const roles = scopedBoardRoles
      .map((role) => role.division_name ? `Head of ${role.division_name}` : boardRoleLabel(role.role))
      .join(', ');
    return `Remove the member’s current board assignments first: ${roles}. Then reopen this panel.`;
  }
  if (session.context.projects.length > 0) {
    return `Remove or reassign the member from ${session.context.projects.length} active or paused project(s) before changing university.`;
  }
  return null;
}

const MEMBER_DIVISION_REQUIREMENT = 'Choose at least one division. Only Global Presidents, Presidents, and Vice Presidents can be Researchers without one.';

function summaryBody(body: string | readonly string[]) {
  return Array.isArray(body) ? body.join('\n') : String(body ?? '');
}

function memberUpdateSummary(session: MemberUpdateSession) {
  if (!session.context) return { facts: [], sections: [] };
  const before = memberRecordSummary(session.context);
  const after = memberRecordSummary({
    ...session.context,
    target: session.target ?? session.context.target,
    member: {
      ...session.context.member,
      member_type: session.memberType,
      university_id: session.university?.id ?? session.context.member.university_id,
      university_name: session.university?.name ?? session.context.member.university_name,
    },
    divisions: selectedMemberDivisions(session),
  });
  const beforeMetadata = new Map(before.metadata.map((field) => [field.label, field.value]));
  const afterMetadata = new Map(after.metadata.map((field) => [field.label, field.value]));
  const facts = [...new Set([...beforeMetadata.keys(), ...afterMetadata.keys()])].map((label) => {
    const current = String(beforeMetadata.get(label) ?? 'Not provided');
    const next = String(afterMetadata.get(label) ?? 'Not provided');
    return { label, value: changedValue(current, next, current !== next) };
  });
  const beforeSections = new Map(before.sections.map((section) => [section.heading, section.body]));
  const afterSections = new Map(after.sections.map((section) => [section.heading, section.body]));
  const sections = [...new Set([...beforeSections.keys(), ...afterSections.keys()])].map((heading) => {
    const current = summaryBody(beforeSections.get(heading) ?? 'None');
    const next = summaryBody(afterSections.get(heading) ?? 'None');
    return { heading, body: changedValue(current, next, current !== next) };
  });
  return { facts, sections };
}

function privateNotesState(session: MemberUpdateSession) {
  const current = String(session.context?.member.notes ?? '').trim();
  const next = String(session.notes ?? '').trim();
  if (current === next) return current ? 'Added' : 'Not added';
  if (!current && next) return 'Added';
  if (current && !next) return 'Removed';
  return 'Edited';
}

function memberDetailsPayload(session: MemberUpdateSession) {
  const summary = memberUpdateSummary(session);
  const controls: InteractionControlSpec[] = [];
  if (session.canChangeUniversity) {
    const control = universityControl(session, ACTIONS.MEMBER_UPDATE_UNIVERSITY);
    if (control) controls.push(control);
  }
  controls.push({
    kind: 'string-select',
    id: id(session, ACTIONS.MEMBER_UPDATE_TYPE),
    placeholder: 'Choose the member type',
    label: 'Type',
    options: [
      { label: 'Researcher', value: MEMBER_TYPES.RESEARCHER, selected: session.memberType === MEMBER_TYPES.RESEARCHER },
      { label: 'Alumni', value: MEMBER_TYPES.ALUMNI, selected: session.memberType === MEMBER_TYPES.ALUMNI },
    ],
  });
  if (session.memberType === MEMBER_TYPES.RESEARCHER) {
    const control = divisionControl(session, ACTIONS.MEMBER_UPDATE_DIVISIONS, { multiple: true });
    if (control) controls.push({ ...control, label: 'Divisions' });
  }

  return renderInteractionPanel({
    kind: 'interaction-panel',
    tone: 'brand',
    title: `Edit ${escapeMarkdown(session.context?.member?.full_name ?? session.targetUser?.username ?? 'member')}`,
    description: 'Current values stay selected. Change only what should be different, then review the complete result.',
    progress: { label: 'Member update', current: 2, total: 3 },
    facts: summary.facts,
    sections: summary.sections,
    detailsDensity: 'compact',
    controls,
    contentActionsLabel: {
      label: 'Private notes',
    },
    contentActions: [
      ...(session.canChangeUniversity ? pageActions(
        session,
        ACTIONS.MEMBER_UPDATE_UNIVERSITY_PREVIOUS,
        ACTIONS.MEMBER_UPDATE_UNIVERSITY_NEXT,
        session.universityPage,
        session.universities.length,
        'universities',
      ) : []),
      ...pageActions(
        session,
        ACTIONS.MEMBER_UPDATE_DIVISIONS_PREVIOUS,
        ACTIONS.MEMBER_UPDATE_DIVISIONS_NEXT,
        session.divisionPage,
        session.divisions.length,
        'divisions',
      ),
      { id: id(session, ACTIONS.MEMBER_UPDATE_NOTES_OPEN), label: 'Edit private notes', style: 'primary' },
    ],
    actions: [
      {
        id: id(session, ACTIONS.MEMBER_UPDATE_REVIEW),
        label: 'Continue to review',
        style: 'primary',
        disabled: !hasMemberChanges(session) || !hasValidMemberDivisions(session) || Boolean(memberUniversityMoveBlocker(session)),
      },
      { id: id(session, ACTIONS.MEMBER_UPDATE_BACK_TARGET), label: 'Back to users', style: 'secondary' },
      { id: id(session, ACTIONS.MEMBER_UPDATE_CANCEL), label: 'Cancel update', style: 'danger' },
    ],
    status: memberUniversityMoveBlocker(session)
      ?? (hasValidMemberDivisions(session) ? undefined : MEMBER_DIVISION_REQUIREMENT),
    audience: 'actor',
  });
}

function memberNotesModal(session: MemberUpdateSession) {
  return renderInteractionModal({
    id: id(session, ACTIONS.MEMBER_UPDATE_NOTES_MODAL),
    title: 'Member update · Private notes',
    fields: [{
      id: 'notes',
      label: 'Internal notes',
      placeholder: 'Optional context visible only to authorized governance workflows',
      value: session.notes,
      required: false,
      style: 'paragraph',
      maxLength: 1_000,
    }],
  });
}

function memberReviewPayload(session: MemberUpdateSession) {
  const summary = memberUpdateSummary(session);
  return renderInteractionPanel({
    kind: 'interaction-panel',
    tone: 'changed',
    title: 'Review the member update',
    description: 'BAINSA will re-check your scope and the member’s active project eligibility before saving.',
    progress: { label: 'Member update', current: 3, total: 3 },
    facts: summary.facts,
    sections: [
      ...summary.sections,
      ...(session.context.projects?.length > 0 ? [{
          heading: 'Active project check',
          body: `${session.context.projects.length} active or paused project assignment(s) will be validated before saving.`,
        }] : []),
      { heading: 'Private notes', body: privateNotesState(session) },
    ],
    detailsDensity: 'compact',
    actions: [
      { id: id(session, ACTIONS.MEMBER_UPDATE_SAVE), label: 'Save member update', style: 'success' },
      { id: id(session, ACTIONS.MEMBER_UPDATE_BACK_DETAILS), label: 'Back to changes', style: 'secondary' },
      { id: id(session, ACTIONS.MEMBER_UPDATE_CANCEL), label: 'Cancel update', style: 'danger' },
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

function cancelledPayload(noun: string) {
  return renderInteractionPanel(interactionOutcome({
    outcome: 'cancelled',
    title: `${noun} cancelled`,
    description: 'Nothing was changed.',
  }));
}

function completedPayload(title: string, description: string, pending = false) {
  return renderInteractionPanel(interactionOutcome({
    outcome: pending ? 'reconciliation-pending' : 'success',
    title,
    description,
  }));
}

function failurePayload(session: GovernancePanelSession, message: string) {
  const actions = session.kind === 'division-create'
    ? [
        { id: id(session, ACTIONS.DIVISION_CREATE_SAVE), label: 'Try creating again', style: 'primary' as const },
        { id: id(session, ACTIONS.DIVISION_CREATE_BACK_SETTINGS), label: 'Back to setup', style: 'secondary' as const },
        { id: id(session, ACTIONS.DIVISION_CREATE_CANCEL), label: 'Cancel setup', style: 'danger' as const },
      ]
    : session.kind === 'division-update'
      ? [
          { id: id(session, ACTIONS.DIVISION_UPDATE_SAVE), label: 'Try saving again', style: 'primary' as const },
          { id: id(session, ACTIONS.DIVISION_UPDATE_BACK_DETAILS), label: 'Back to changes', style: 'secondary' as const },
          { id: id(session, ACTIONS.DIVISION_UPDATE_CANCEL), label: 'Cancel update', style: 'danger' as const },
        ]
      : [
          { id: id(session, ACTIONS.MEMBER_UPDATE_SAVE), label: 'Try saving again', style: 'primary' as const },
          { id: id(session, ACTIONS.MEMBER_UPDATE_BACK_DETAILS), label: 'Back to changes', style: 'secondary' as const },
          { id: id(session, ACTIONS.MEMBER_UPDATE_CANCEL), label: 'Cancel update', style: 'danger' as const },
        ];
  return renderInteractionPanel({
    kind: 'interaction-panel',
    tone: 'danger',
    title: 'Change not saved',
    description: 'Review the problem below. Your setup is still available.',
    sections: [{ heading: 'What happened', body: escapeMarkdown(message) }],
    actions,
    audience: 'actor',
  });
}

async function respondToModal(interaction, payload) {
  if (interaction.isFromMessage?.()) return interaction.update(payload);
  return interaction.reply(ephemeralReplyPayload(payload));
}

async function updateAfterLookup(interaction, session: GovernancePanelSession, loadingPayload, work) {
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

async function publishActivity(interaction, commandName: string, result) {
  const activity = formatBoardActivity(commandName, {
    actorId: interaction.user.id,
    result,
  });
  if (!activity) return false;
  try {
    const universityName = result.university?.name ?? result.universityName;
    const delivery = await postUniversityBoardActivity(interaction, activity, universityName);
    return delivery.status === 'posted';
  } catch (error) {
    logger.warn('Governance panel activity could not be posted', {
      command: commandName,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

export function createGovernancePanelService({
  createDivisionOperation = createDivision,
  updateDivisionOperation = updateDivision,
  updateMemberOperation = updateMember,
  loadMemberContext = getMemberUpdateContext,
  loadUniversities = listUniversities,
  loadDivisions = listDivisions,
  now = () => Date.now(),
} = {}) {
  const store = createFlowSessionStore<GovernancePanelSession>({
    now,
    expiredMessage: 'This governance setup has expired. Run the command again.',
  });

  async function scopedUniversity(interaction, universities: UniversityRow[], commandName: string) {
    const scope = botCommandChannelScope(interaction.channel);
    const resolved = resolveCommandContext({
      commandName,
      channelScope: scope,
      requireUniversity: false,
    });
    if (!resolved.universityName) return { fixed: false, university: null };
    const university = universities.find(
      (candidate) => candidate.name.toLowerCase() === resolved.universityName.toLowerCase(),
    );
    assertUser(university, `The ${resolved.universityName} bot-log is not linked to an active university.`);
    return { fixed: true, university };
  }

  async function startDivisionCreate(interaction) {
    const universities = await loadUniversities();
    const scoped = await scopedUniversity(interaction, universities, 'division-create');
    const session = store.start(interaction, (base) => ({
      ...base,
      kind: 'division-create' as const,
      fixedUniversity: scoped.fixed,
      universities,
      universityPage: 0,
      university: scoped.university,
      divisionName: null,
      color: DIVISION_COLORS.BLUE.key,
      headId: null,
      headUser: null,
      channels: ['text', 'voice'],
      screen: 'scope' as const,
    })) as DivisionCreateSession;
    if (session.fixedUniversity) {
      await interaction.showModal(divisionCreateNameModal(session));
      return;
    }
    await interaction.reply(ephemeralReplyPayload(divisionCreateScopePayload(session)));
  }

  async function startDivisionUpdate(interaction) {
    const universities = await loadUniversities();
    const scoped = await scopedUniversity(interaction, universities, 'division-update');
    const divisions = scoped.university
      ? await loadDivisions(scoped.university.name) as DivisionRow[]
      : [];
    const session = store.start(interaction, (base) => ({
      ...base,
      kind: 'division-update' as const,
      fixedUniversity: scoped.fixed,
      universities,
      universityPage: 0,
      university: scoped.university,
      universityConfirmed: scoped.fixed,
      divisions,
      divisionPage: 0,
      division: null,
      newName: null,
      color: null,
      screen: 'select' as const,
    })) as DivisionUpdateSession;
    await interaction.reply(ephemeralReplyPayload(divisionUpdateSelectPayload(session)));
  }

  async function startMemberUpdate(interaction) {
    const universities = await loadUniversities();
    const session = store.start(interaction, (base) => ({
      ...base,
      kind: 'member-update' as const,
      target: null,
      targetUser: null,
      context: null,
      universities,
      universityPage: 0,
      university: null,
      divisions: [],
      divisionPage: 0,
      memberType: null,
      divisionIds: [],
      notes: null,
      canChangeUniversity: hasGlobalAuthority(interaction.member),
      screen: 'target' as const,
    })) as MemberUpdateSession;
    await interaction.reply(ephemeralReplyPayload(memberTargetPayload(session)));
  }

  async function loadSelectedMember(interaction, session: MemberUpdateSession) {
    assertUser(session.targetUser, 'Choose a member before continuing.');
    await updateAfterLookup(interaction, session, memberTargetPayload(session, { loading: true }), async () => {
      const context = await loadMemberContext(interaction, { user: session.targetUser });
      resolveCommandContext({
        commandName: 'member-update',
        channelScope: botCommandChannelScope(interaction.channel),
        targetUniversity: context.member.university_name,
      });
      session.target = context.target;
      session.targetUser = context.target.user ?? session.targetUser;
      session.context = context;
      session.memberType = context.member.member_type;
      session.notes = context.member.notes ?? '';
      session.university = session.universities.find(
        (university) => String(university.id) === String(context.member.university_id),
      ) ?? { id: context.member.university_id, name: context.member.university_name };
      session.divisions = await loadDivisions(session.university.name) as DivisionRow[];
      session.divisionIds = context.divisions.map(rowValue);
      session.screen = 'details';
      return memberDetailsPayload(session);
    });
  }

  function requireParsed(interaction) {
    const parsed = parseFlowCustomId(interaction.customId, PREFIX, ACTION_VALUES);
    if (!parsed) return null;
    return { parsed, session: store.require(interaction, parsed.sessionId) };
  }

  async function saveDivisionCreate(interaction, session: DivisionCreateSession) {
    assertUser(session.university && session.divisionName && session.headId, 'Complete the division setup before creating it.');
    resolveCommandContext({
      commandName: 'division-create',
      channelScope: botCommandChannelScope(interaction.channel),
      selectedUniversity: session.university,
    });
    session.busy = true;
    await interaction.update(pendingPayload(
      `Creating ${escapeMarkdown(session.divisionName)}`,
      'BAINSA is checking authority, creating managed roles and spaces, and saving the canonical division record.',
    ));
    let result;
    try {
      result = await createDivisionOperation(interaction, {
        university: session.university.name,
        divisionName: session.divisionName,
        color: session.color,
        head: session.headUser ?? { id: session.headId },
        createTextChannel: session.channels.includes('text'),
        createVoiceChannel: session.channels.includes('voice'),
      });
    } catch (error) {
      session.busy = false;
      await interaction.editReply(interactionEditPayload(failurePayload(
        session,
        error instanceof UserFacingError ? error.message : 'BAINSA could not create the division. Try again.',
      )));
      return;
    }
    store.remove(session);
    const posted = await publishActivity(interaction, 'division-create', result);
    await interaction.editReply(interactionEditPayload(completedPayload(
      'Division created',
      `${escapeMarkdown(result.divisionName)} is ready at ${escapeMarkdown(result.university.name)}.${posted ? ' Activity was posted in the university bot-log.' : ' The division is saved, but the activity card could not be posted.'}`,
    )));
  }

  async function saveDivisionUpdate(interaction, session: DivisionUpdateSession) {
    assertUser(session.university && session.division && hasDivisionUpdateChanges(session), 'Choose at least one real division change before saving.');
    resolveCommandContext({
      commandName: 'division-update',
      channelScope: botCommandChannelScope(interaction.channel),
      selectedUniversity: session.university,
    });
    session.busy = true;
    await interaction.update(pendingPayload(
      `Updating ${escapeMarkdown(session.division.name)}`,
      'BAINSA is reconciling the canonical division record with its managed roles and channels.',
    ));
    let result;
    try {
      result = await updateDivisionOperation(interaction, {
        university: session.university.name,
        currentName: session.division.name,
        newName: session.newName ?? session.division.name,
        color: session.color ?? session.division.color,
      });
    } catch (error) {
      session.busy = false;
      await interaction.editReply(interactionEditPayload(failurePayload(
        session,
        error instanceof UserFacingError ? error.message : 'BAINSA could not update the division. Try again.',
      )));
      return;
    }
    store.remove(session);
    const posted = await publishActivity(interaction, 'division-update', result);
    await interaction.editReply(interactionEditPayload(completedPayload(
      'Division updated',
      `${escapeMarkdown(result.newName)} now uses the saved name, color, roles, and channel labels.${posted ? ' Activity was posted in the university bot-log.' : ' The update is saved, but the activity card could not be posted.'}`,
    )));
  }

  async function saveMemberUpdate(interaction, session: MemberUpdateSession) {
    assertUser(hasMemberChanges(session), 'Choose at least one real member change before saving.');
    assertUser(hasValidMemberDivisions(session), MEMBER_DIVISION_REQUIREMENT);
    assertUser(!memberUniversityMoveBlocker(session), memberUniversityMoveBlocker(session));
    resolveCommandContext({
      commandName: 'member-update',
      channelScope: botCommandChannelScope(interaction.channel),
      targetUniversity: session.context.member.university_name,
    });
    session.busy = true;
    await interaction.update(pendingPayload(
      'Saving the member update',
      'BAINSA is re-checking scope, active project eligibility, member roles, and the canonical member record.',
    ));
    let result;
    try {
      const selectedDivisions = selectedMemberDivisions(session);
      result = await updateMemberOperation(interaction, {
        user: session.targetUser ?? { id: session.target.id },
        memberType: session.memberType,
        university: session.university.name,
        divisionsText: selectedDivisions.map((division) => division.name).join(', '),
        notes: String(session.notes ?? '') === String(session.context.member.notes ?? '')
          ? undefined
          : session.notes ?? '',
      });
    } catch (error) {
      session.busy = false;
      await interaction.editReply(interactionEditPayload(failurePayload(
        session,
        error instanceof UserFacingError ? error.message : 'BAINSA could not update the member. Try again.',
      )));
      return;
    }
    store.remove(session);
    const posted = await publishActivity(interaction, 'member-update', result);
    await interaction.editReply(interactionEditPayload(completedPayload(
      'Member updated',
      posted
        ? 'The member record, roles, and divisions are current. Activity was posted in the university bot-log.'
        : 'The member record, roles, and divisions are current. No board-visible activity was needed for private-only changes.',
    )));
  }

  async function handleButton(interaction) {
    const matched = requireParsed(interaction);
    if (!matched) return;
    const { parsed, session } = matched;
    const action = parsed.action;

    if (
      action === ACTIONS.DIVISION_CREATE_CANCEL
      || action === ACTIONS.DIVISION_UPDATE_CANCEL
      || action === ACTIONS.MEMBER_UPDATE_CANCEL
    ) {
      store.remove(session);
      const noun = session.kind === 'division-create' ? 'Division setup' : session.kind === 'division-update' ? 'Division update' : 'Member update';
      await interaction.update(cancelledPayload(noun));
      return;
    }

    if (session.kind === 'division-create') {
      if (action === ACTIONS.DIVISION_CREATE_NAME_OPEN) {
        await interaction.showModal(divisionCreateNameModal(session));
        return;
      }
      if (action === ACTIONS.DIVISION_CREATE_UNIVERSITY_PREVIOUS) session.universityPage -= 1;
      if (action === ACTIONS.DIVISION_CREATE_UNIVERSITY_NEXT) session.universityPage += 1;
      if (new Set<string>([
        ACTIONS.DIVISION_CREATE_UNIVERSITY_PREVIOUS,
        ACTIONS.DIVISION_CREATE_UNIVERSITY_NEXT,
      ]).has(action)) {
        await interaction.update(divisionCreateScopePayload(session));
        return;
      }
      if (action === ACTIONS.DIVISION_CREATE_BACK_SCOPE) {
        session.screen = 'scope';
        await interaction.update(divisionCreateScopePayload(session));
        return;
      }
      if (action === ACTIONS.DIVISION_CREATE_REVIEW) {
        assertUser(session.headId, 'Choose an initial division Head before continuing.');
        session.screen = 'review';
        await interaction.update(divisionCreateReviewPayload(session));
        return;
      }
      if (action === ACTIONS.DIVISION_CREATE_BACK_SETTINGS) {
        session.screen = 'settings';
        await interaction.update(divisionCreateSettingsPayload(session));
        return;
      }
      if (action === ACTIONS.DIVISION_CREATE_SAVE) {
        await saveDivisionCreate(interaction, session);
      }
      return;
    }

    if (session.kind === 'division-update') {
      if (action === ACTIONS.DIVISION_UPDATE_UNIVERSITY_PREVIOUS) session.universityPage -= 1;
      if (action === ACTIONS.DIVISION_UPDATE_UNIVERSITY_NEXT) session.universityPage += 1;
      if (action === ACTIONS.DIVISION_UPDATE_DIVISION_PREVIOUS) session.divisionPage -= 1;
      if (action === ACTIONS.DIVISION_UPDATE_DIVISION_NEXT) session.divisionPage += 1;
      if (new Set<string>([
        ACTIONS.DIVISION_UPDATE_UNIVERSITY_PREVIOUS,
        ACTIONS.DIVISION_UPDATE_UNIVERSITY_NEXT,
        ACTIONS.DIVISION_UPDATE_DIVISION_PREVIOUS,
        ACTIONS.DIVISION_UPDATE_DIVISION_NEXT,
      ]).has(action)) {
        await interaction.update(divisionUpdateSelectPayload(session));
        return;
      }
      if (action === ACTIONS.DIVISION_UPDATE_DIVISION_CONTINUE) {
        assertUser(session.division, 'Choose a division before continuing.');
        session.screen = 'details';
        await interaction.update(divisionUpdateDetailsPayload(session));
        return;
      }
      if (action === ACTIONS.DIVISION_UPDATE_UNIVERSITY_CONTINUE) {
        assertUser(session.university, 'Choose a university before continuing.');
        session.busy = true;
        await interaction.update(pendingPayload(
          `Loading ${escapeMarkdown(session.university.name)} divisions`,
          'BAINSA is confirming your scope before loading active divisions.',
        ));
        try {
          session.divisions = await loadDivisions(session.university.name) as DivisionRow[];
          session.universityConfirmed = true;
          session.division = null;
          session.divisionPage = 0;
          session.busy = false;
          await interaction.editReply(interactionEditPayload(divisionUpdateSelectPayload(session)));
        } catch (error) {
          session.busy = false;
          throw error;
        }
        return;
      }
      if (action === ACTIONS.DIVISION_UPDATE_NAME_OPEN) {
        await interaction.showModal(divisionUpdateNameModal(session));
        return;
      }
      if (action === ACTIONS.DIVISION_UPDATE_BACK_SELECT) {
        session.screen = 'select';
        await interaction.update(divisionUpdateSelectPayload(session));
        return;
      }
      if (action === ACTIONS.DIVISION_UPDATE_REVIEW) {
        assertUser(hasDivisionUpdateChanges(session), 'Choose at least one real division change before continuing.');
        session.screen = 'review';
        await interaction.update(divisionUpdateReviewPayload(session));
        return;
      }
      if (action === ACTIONS.DIVISION_UPDATE_BACK_DETAILS) {
        session.screen = 'details';
        await interaction.update(divisionUpdateDetailsPayload(session));
        return;
      }
      if (action === ACTIONS.DIVISION_UPDATE_SAVE) await saveDivisionUpdate(interaction, session);
      return;
    }

    if (action === ACTIONS.MEMBER_UPDATE_UNIVERSITY_PREVIOUS) session.universityPage -= 1;
    if (action === ACTIONS.MEMBER_UPDATE_UNIVERSITY_NEXT) session.universityPage += 1;
    if (action === ACTIONS.MEMBER_UPDATE_DIVISIONS_PREVIOUS) session.divisionPage -= 1;
    if (action === ACTIONS.MEMBER_UPDATE_DIVISIONS_NEXT) session.divisionPage += 1;
    if (new Set<string>([
      ACTIONS.MEMBER_UPDATE_UNIVERSITY_PREVIOUS,
      ACTIONS.MEMBER_UPDATE_UNIVERSITY_NEXT,
      ACTIONS.MEMBER_UPDATE_DIVISIONS_PREVIOUS,
      ACTIONS.MEMBER_UPDATE_DIVISIONS_NEXT,
    ]).has(action)) {
      await interaction.update(memberDetailsPayload(session));
      return;
    }
    if (action === ACTIONS.MEMBER_UPDATE_TARGET_CONTINUE) {
      await loadSelectedMember(interaction, session);
      return;
    }
    if (action === ACTIONS.MEMBER_UPDATE_BACK_TARGET) {
      session.target = null;
      session.context = null;
      session.university = null;
      session.divisions = [];
      session.memberType = null;
      session.divisionIds = [];
      session.notes = null;
      session.screen = 'target';
      await interaction.update(memberTargetPayload(session));
      return;
    }
    if (action === ACTIONS.MEMBER_UPDATE_NOTES_OPEN) {
      await interaction.showModal(memberNotesModal(session));
      return;
    }
    if (action === ACTIONS.MEMBER_UPDATE_REVIEW) {
      assertUser(hasMemberChanges(session), 'Choose at least one real member change before continuing.');
      assertUser(hasValidMemberDivisions(session), MEMBER_DIVISION_REQUIREMENT);
      assertUser(!memberUniversityMoveBlocker(session), memberUniversityMoveBlocker(session));
      session.screen = 'review';
      await interaction.update(memberReviewPayload(session));
      return;
    }
    if (action === ACTIONS.MEMBER_UPDATE_BACK_DETAILS) {
      session.screen = 'details';
      await interaction.update(memberDetailsPayload(session));
      return;
    }
    if (action === ACTIONS.MEMBER_UPDATE_SAVE) await saveMemberUpdate(interaction, session);
  }

  async function handleStringSelect(interaction) {
    const matched = requireParsed(interaction);
    if (!matched) return;
    const { parsed, session } = matched;
    const action = parsed.action;
    const values = interaction.values.map(String);

    if (session.kind === 'division-create') {
      if (action === ACTIONS.DIVISION_CREATE_UNIVERSITY) {
        assertUser(!session.fixedUniversity, 'The university is fixed by this command channel.');
        session.university = session.universities.find((row) => rowValue(row) === values[0]) ?? null;
        await interaction.update(divisionCreateScopePayload(session));
        return;
      }
      if (action === ACTIONS.DIVISION_CREATE_COLOR) session.color = values[0];
      if (action === ACTIONS.DIVISION_CREATE_CHANNELS) session.channels = values;
      await interaction.update(divisionCreateSettingsPayload(session));
      return;
    }

    if (session.kind === 'division-update') {
      if (action === ACTIONS.DIVISION_UPDATE_UNIVERSITY) {
        assertUser(!session.fixedUniversity, 'The university is fixed by this command channel.');
        session.university = session.universities.find((row) => rowValue(row) === values[0]) ?? null;
        session.universityConfirmed = false;
        session.divisions = [];
        session.division = null;
        session.divisionPage = 0;
        session.newName = null;
        session.color = null;
        await interaction.update(divisionUpdateSelectPayload(session));
        return;
      }
      if (action === ACTIONS.DIVISION_UPDATE_DIVISION) {
        session.division = session.divisions.find((row) => rowValue(row) === values[0]) ?? null;
        assertUser(session.division, 'Choose a division from the current list.');
        session.newName = session.division.name;
        session.color = session.division.color;
        session.screen = 'select';
        await interaction.update(divisionUpdateSelectPayload(session));
        return;
      }
      if (action === ACTIONS.DIVISION_UPDATE_COLOR) {
        session.color = values[0];
        await interaction.update(divisionUpdateDetailsPayload(session));
      }
      return;
    }

    if (action === ACTIONS.MEMBER_UPDATE_TYPE) {
      session.memberType = values[0];
      if (session.memberType === MEMBER_TYPES.ALUMNI) session.divisionIds = [];
    } else if (action === ACTIONS.MEMBER_UPDATE_UNIVERSITY) {
      assertUser(session.canChangeUniversity && hasGlobalAuthority(interaction.member), 'Only a Global President can change a member’s university.');
      session.university = session.universities.find((row) => rowValue(row) === values[0]) ?? null;
      session.divisions = session.university
        ? await loadDivisions(session.university.name) as DivisionRow[]
        : [];
      session.divisionIds = [];
      session.divisionPage = 0;
    } else if (action === ACTIONS.MEMBER_UPDATE_DIVISIONS) {
      const current = page(session.divisions, session.divisionPage);
      const pageIds = new Set(current.items.map(rowValue));
      session.divisionIds = [
        ...session.divisionIds.filter((divisionId) => !pageIds.has(String(divisionId))),
        ...values,
      ];
    }
    await interaction.update(memberDetailsPayload(session));
  }

  async function handleUserSelect(interaction) {
    const matched = requireParsed(interaction);
    if (!matched) return;
    const { parsed, session } = matched;
    const selectedId = String(interaction.values?.[0] ?? '');
    assertUser(selectedId, 'Choose one member from the list.');

    if (session.kind === 'division-create' && parsed.action === ACTIONS.DIVISION_CREATE_HEAD) {
      session.headId = selectedId;
      session.headUser = interaction.users?.get?.(selectedId) ?? { id: selectedId };
      await interaction.update(divisionCreateSettingsPayload(session));
      return;
    }

    if (session.kind === 'member-update' && parsed.action === ACTIONS.MEMBER_UPDATE_TARGET) {
      session.target = null;
      session.targetUser = interaction.users?.get?.(selectedId) ?? { id: selectedId };
      session.context = null;
      session.university = null;
      session.divisions = [];
      session.memberType = null;
      session.divisionIds = [];
      session.notes = null;
      session.screen = 'target';
      await interaction.update(memberTargetPayload(session));
    }
  }

  async function handleModalSubmit(interaction) {
    const matched = requireParsed(interaction);
    if (!matched) return;
    const { parsed, session } = matched;

    if (session.kind === 'division-create' && parsed.action === ACTIONS.DIVISION_CREATE_NAME_MODAL) {
      session.divisionName = normalizeDisplayName(
        interaction.fields.getTextInputValue('division_name'),
        'division_name',
      );
      assertUser(session.university, 'Choose a university before continuing.');
      session.screen = 'settings';
      await respondToModal(interaction, divisionCreateSettingsPayload(session));
      return;
    }

    if (session.kind === 'division-update' && parsed.action === ACTIONS.DIVISION_UPDATE_NAME_MODAL) {
      session.newName = normalizeDisplayName(
        interaction.fields.getTextInputValue('division_name'),
        'division_name',
      );
      session.screen = 'details';
      await respondToModal(interaction, divisionUpdateDetailsPayload(session));
      return;
    }

    if (session.kind === 'member-update' && parsed.action === ACTIONS.MEMBER_UPDATE_NOTES_MODAL) {
      session.notes = interaction.fields.getTextInputValue('notes').trim();
      session.screen = 'details';
      await respondToModal(interaction, memberDetailsPayload(session));
    }
  }

  return {
    startDivisionCreate,
    startDivisionUpdate,
    startMemberUpdate,
    canHandle(customId: string) {
      return Boolean(parseFlowCustomId(customId, PREFIX, ACTION_VALUES));
    },
    handleButton,
    handleStringSelect,
    handleUserSelect,
    handleModalSubmit,
  };
}

export const governanceCommandPanels = createGovernancePanelService();

export { ACTIONS as GOVERNANCE_PANEL_ACTIONS };
