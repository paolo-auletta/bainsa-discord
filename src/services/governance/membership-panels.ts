import { escapeMarkdown } from 'discord.js';

import {
  assertNotBotUser,
  hasGlobalAuthority,
  hasRole,
  isDivisionHead,
  isUniversityDivisionHead,
  isUniversityPresident,
  isUniversityVicePresident,
} from '../../authorization.js';
import { formatBoardActivity } from '../../activity/formatters.js';
import { postUniversityBoardActivity } from '../../activity/router.js';
import { config } from '../../config.js';
import { MEMBER_TYPES, PROJECT_PERSON_ROLES, ROLE_NAMES, divisionLabel } from '../../constants.js';
import { assertUser, UserFacingError } from '../../errors.js';
import { flowCustomId, parseFlowCustomId } from '../../flows/custom-id.js';
import { createFlowSessionStore, type FlowSessionBase } from '../../flows/session-store.js';
import { logger } from '../../logger.js';
import {
  ephemeralReplyPayload,
  interactionEditPayload,
  interactionOutcome,
  interactionRecovery,
  renderInteractionModal,
  renderInteractionPanel,
  recoveryKindForMessage,
  truncateText,
  userReference,
} from '../../messages/index.js';
import type { InteractionActionSpec } from '../../messages/types.js';
import { botCommandChannelScope } from '../../runtime/command-channels.js';
import { resolveCommandContext } from '../../runtime/command-scope.js';
import { formatDivisionMemberHandoff, memberRecordSummary } from './formatters.js';
import { memberRequiresDivision } from './policy.js';
import {
  addDivisionMember,
  getMemberInfo,
  listDivisions,
  listUniversities,
  removeDivisionMember,
} from './service.js';

const PREFIX = 'gmm';
const PAGE_SIZE = 25;

const ACTIONS = Object.freeze({
  TARGET: 't',
  TARGET_CONTINUE: 'tc',
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

type MembershipPanelKind = 'division-add-member' | 'division-remove-member';

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
  roles?: { cache?: { some?: (predicate: (role: { name?: string }) => boolean) => boolean } };
  send?: (payload: unknown) => Promise<unknown>;
}

interface BoardRoleRow {
  role: string;
  university_name?: string | null;
  division_id?: unknown;
  division_name?: string | null;
}

interface ProjectRow {
  id?: unknown;
  name?: string;
  role?: string;
  division_id?: unknown;
  division_name?: string | null;
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

interface MembershipPanelSession extends FlowSessionBase {
  kind: MembershipPanelKind;
  universities: UniversityRow[];
  university: UniversityRow | null;
  targetUser: DiscordUserReference | null;
  context: MemberContext | null;
  divisions: DivisionRow[];
  manageableDivisionIds: string[];
  selectedDivisionId: string | null;
  reason: string;
  choicePage: number;
  screen: 'target' | 'choice' | 'review';
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
  return { items: items.slice(start, start + PAGE_SIZE), page: selectedPage, pageCount };
}

function panelLabel() {
  return 'Division membership';
}

function panelTitle(kind: MembershipPanelKind) {
  return kind === 'division-add-member' ? 'Add member to a division' : 'Remove member from a division';
}

function memberName(session: MembershipPanelSession) {
  return escapeMarkdown(
    session.context?.member.full_name
      ?? session.context?.target.user?.username
      ?? session.targetUser?.username
      ?? 'member',
  );
}

function targetPayload(
  session: MembershipPanelSession,
  { loading = false, problem = null }: { loading?: boolean; problem?: string | null } = {},
) {
  const remove = session.kind === 'division-remove-member';
  return renderInteractionPanel({
    kind: 'interaction-panel',
    tone: problem ? 'danger' : 'brand',
    title: panelTitle(session.kind),
    description: remove
      ? `Choose an active${session.university ? ` ${session.university.name}` : ''} member. ${config.botName} will derive their university and show only safe in-scope removals.`
      : `Choose an active${session.university ? ` ${session.university.name}` : ''} Researcher. ${config.botName} will derive their university before loading eligible divisions.`,
    progress: { label: panelLabel(), current: 1, total: 3 },
    facts: [
      ...(session.university ? [{ label: 'University', value: session.university.name }] : []),
      ...(session.targetUser ? [{ label: 'Selected member', value: userReference(session.targetUser) }] : []),
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
      { id: id(session, ACTIONS.CANCEL), label: 'Cancel', style: 'danger', disabled: loading },
    ],
    status: problem ?? undefined,
    audience: 'actor',
  });
}

function canManageDivision(session: MembershipPanelSession, division: DivisionRow) {
  return session.manageableDivisionIds.includes(rowValue(division));
}

function localBoardRoles(session: MembershipPanelSession) {
  if (!session.university) return [];
  return (session.context?.boardRoles ?? []).filter((role) =>
    sameText(role.university_name, session.university.name),
  );
}

function targetIsLocalExecutive(session: MembershipPanelSession) {
  return localBoardRoles(session).some((role) => ['president', 'vice_president'].includes(role.role));
}

function divisionAddChoices(session: MembershipPanelSession) {
  if (session.context?.member.member_type !== MEMBER_TYPES.RESEARCHER || targetIsLocalExecutive(session)) return [];
  const existing = new Set((session.context?.divisions ?? []).map(rowValue));
  return session.divisions.filter((division) => canManageDivision(session, division) && !existing.has(rowValue(division)));
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
    role.role === 'head'
    && (
      (role.division_id != null && rowValue(division) === String(role.division_id))
      || sameText(role.division_name, division.name)
    ),
  );
  if (headAssignment) return 'Required by the member’s active Head role.';

  const remaining = (session.context?.divisions ?? []).filter((candidate) => rowValue(candidate) !== rowValue(division));
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
  if (localBoardRoles(session).length === 0 && projects.length > 0) {
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
  const candidates = session.kind === 'division-add-member'
    ? divisionAddChoices(session)
    : divisionRemoveChoices(session);
  return candidates.find((division) => rowValue(division) === session.selectedDivisionId) ?? null;
}

function divisionsAfterChange(session: MembershipPanelSession, division: DivisionRow, add: boolean) {
  const current = session.context?.divisions ?? [];
  return add ? [...current, division] : current.filter((candidate) => rowValue(candidate) !== rowValue(division));
}

function changedValue(current: string, next: string, changed: boolean) {
  return changed ? `${current} → ${next}` : current;
}

function summaryBody(body: string | readonly string[]) {
  return Array.isArray(body) ? body.join('\n') : String(body ?? '');
}

function divisionChangeSummary(session: MembershipPanelSession) {
  if (!session.context) return { facts: [], sections: [] };
  const selected = selectedDivision(session);
  const before = memberRecordSummary(session.context);
  const after = memberRecordSummary({
    ...session.context,
    divisions: selected
      ? divisionsAfterChange(session, selected, session.kind === 'division-add-member')
      : session.context.divisions,
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

function boundedLines(lines: string[]) {
  if (lines.length === 0) return 'None';
  return lines.join('\n').slice(0, 2_800);
}

function membershipAvailability(session: MembershipPanelSession) {
  const remove = session.kind === 'division-remove-member';
  return boundedLines((session.context?.divisions ?? []).map((division) => {
    const label = divisionLabel(division.name, division.color);
    if (!remove) return `• ${label}`;
    if (!canManageDivision(session, division)) return `• ${label} · Outside your scope`;
    const blocker = divisionRemovalBlocker(session, division);
    return blocker
      ? `• ${label} · Cannot remove — ${blocker}`
      : `• ${label} · Can remove`;
  }));
}

function paginationActions(session: MembershipPanelSession, count: number): InteractionActionSpec[] {
  const pageCount = Math.ceil(count / PAGE_SIZE);
  if (pageCount <= 1) return [];
  return [
    { id: id(session, ACTIONS.PREVIOUS), label: 'Previous divisions', style: 'secondary', disabled: session.choicePage <= 0 },
    { id: id(session, ACTIONS.NEXT), label: 'Next divisions', style: 'secondary', disabled: session.choicePage >= pageCount - 1 },
  ];
}

function choicePayload(session: MembershipPanelSession) {
  const add = session.kind === 'division-add-member';
  const available = add ? divisionAddChoices(session) : divisionRemoveChoices(session);
  const choices = page(available, session.choicePage);
  const summary = divisionChangeSummary(session);
  const emptyStatus = add
    ? session.context?.member.member_type !== MEMBER_TYPES.RESEARCHER
      ? 'Only active Researchers can join a division. Use `/member-update` to change the member type first.'
      : targetIsLocalExecutive(session)
        ? 'Presidents and Vice Presidents already have university-wide access to every division.'
        : available.length ? undefined : 'There is no additional division in your scope that this member can join.'
    : available.length ? undefined : 'No current division can be removed by you. Read-only and blocked memberships remain visible above.';
  return renderInteractionPanel({
    kind: 'interaction-panel',
    tone: add ? 'brand' : 'warning',
    title: add
      ? `Add ${memberName(session)} to a division`
      : `Remove ${memberName(session)} from a division`,
    progress: { label: panelLabel(), current: 2, total: 3 },
    facts: summary.facts,
    sections: [
      ...summary.sections,
      ...(!add ? [{
        heading: 'Current division memberships',
        body: membershipAvailability(session),
        spacingBefore: true,
      }] : []),
    ],
    detailsDensity: 'compact',
    controls: choices.items.length ? [{
      kind: 'string-select',
      id: id(session, ACTIONS.DIVISION),
      placeholder: add ? 'Choose a division to add' : 'Choose a division to remove',
      label: add ? 'Division to add' : 'Division to remove',
      options: choices.items.map((division) => ({
        label: divisionLabel(division.name, division.color),
        value: rowValue(division),
        selected: rowValue(division) === session.selectedDivisionId,
      })),
    }] : undefined,
    contentActions: [
      ...paginationActions(session, available.length),
      ...(add ? [] : [{
        id: id(session, ACTIONS.REASON_OPEN),
        label: session.reason ? 'Edit private reason' : 'Add private reason',
        style: 'primary' as const,
      }]),
    ],
    actions: [
      { id: id(session, ACTIONS.REVIEW), label: 'Continue to review', style: 'primary', disabled: !selectedDivision(session) },
      { id: id(session, ACTIONS.BACK_TARGET), label: 'Back to member', style: 'secondary' },
      { id: id(session, ACTIONS.CANCEL), label: 'Cancel', style: 'danger' },
    ],
    status: emptyStatus,
    audience: 'actor',
  });
}

function divisionMembershipList(divisions: DivisionRow[]) {
  if (divisions.length === 0) return 'None';
  return divisions
    .map((division) => escapeMarkdown(divisionLabel(division.name, division.color)))
    .join(', ');
}

function reviewSummary(session: MembershipPanelSession, division: DivisionRow, add: boolean) {
  assertUser(session.context, 'Load a member before reviewing this change.');
  const memberSummary = memberRecordSummary(session.context);
  const currentMemberships = divisionMembershipList(session.context.divisions);
  const nextMemberships = divisionMembershipList(divisionsAfterChange(session, division, add));
  return {
    facts: [
      memberSummary.metadata.find((field) => field.label === 'Member')
        ?? { label: 'Member', value: userReference(session.context.target) },
      { label: 'University', value: escapeMarkdown(session.university.name) },
      {
        label: add ? 'Division being added' : 'Division being removed',
        value: escapeMarkdown(divisionLabel(division.name, division.color)),
      },
    ],
    sections: [
      {
        heading: 'Division memberships',
        body: `${currentMemberships} → ${nextMemberships}`,
      },
      ...(!add ? [{
        heading: 'Private reason',
        body: session.reason ? escapeMarkdown(session.reason) : 'None',
      }] : []),
    ],
  };
}

function reviewPayload(session: MembershipPanelSession) {
  const division = selectedDivision(session);
  assertUser(division, 'Choose a current in-scope division before reviewing.');
  const add = session.kind === 'division-add-member';
  const summary = reviewSummary(session, division, add);
  return renderInteractionPanel({
    kind: 'interaction-panel',
    tone: add ? 'changed' : 'warning',
    title: add ? 'Review division addition' : 'Review division removal',
    progress: { label: panelLabel(), current: 3, total: 3 },
    facts: summary.facts,
    sections: summary.sections,
    detailsDensity: 'compact-groups',
    actions: [
      { id: id(session, ACTIONS.SAVE), label: add ? 'Add member to division' : 'Remove member from division', style: add ? 'success' : 'danger' },
      { id: id(session, ACTIONS.BACK_CHOICE), label: 'Change division', style: 'secondary' },
      { id: id(session, ACTIONS.CANCEL), label: 'Cancel', style: 'danger' },
    ],
    audience: 'actor',
  });
}

function reasonModal(session: MembershipPanelSession) {
  return renderInteractionModal({
    id: id(session, ACTIONS.REASON_MODAL),
    title: `${panelLabel()} · Reason`,
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
    title: session.kind === 'division-add-member' ? 'Adding division access' : 'Removing division access',
    description: `${config.botName} is re-checking authority, membership, project eligibility, and managed Discord roles.`,
    status: 'This panel will update when the operation finishes. Do not submit it again.',
    audience: 'actor',
  });
}

function failurePayload(session: MembershipPanelSession, error: unknown) {
  const expected = error instanceof UserFacingError;
  const message = expected ? error.message : `${config.botName} could not save this division membership change. Try again.`;
  return renderInteractionPanel(interactionRecovery({
    kind: expected ? recoveryKindForMessage(message) : 'unexpected',
    title: 'Division membership not changed',
    whatHappened: message,
    preservedState: 'No division membership was changed. The proposed change is still available.',
    correction: 'Review the member, division, and current eligibility. Choose a valid in-scope option before trying again.',
    continueWith: 'Use the controls below to try again, return to division choices, or cancel this private flow.',
    actions: [
      { id: id(session, ACTIONS.SAVE), label: 'Try again', style: 'primary' },
      { id: id(session, ACTIONS.BACK_CHOICE), label: 'Back to choices', style: 'secondary' },
      { id: id(session, ACTIONS.CANCEL), label: 'Cancel', style: 'danger' },
    ],
  }));
}

async function defaultSendHandoff(target: DiscordMemberReference, payload: unknown) {
  assertUser(target.send, 'The affected member could not be reached by DM.');
  await target.send(payload);
}

export function createGovernanceMembershipPanelService({
  addDivisionMemberOperation = addDivisionMember,
  removeDivisionMemberOperation = removeDivisionMember,
  loadMemberContext = getMemberInfo,
  loadUniversities = listUniversities,
  loadDivisions = listDivisions,
  formatActivity = formatBoardActivity,
  postActivity = postUniversityBoardActivity,
  sendHandoff = defaultSendHandoff,
  now = () => Date.now(),
} = {}) {
  const store = createFlowSessionStore<MembershipPanelSession>({
    now,
    expiredMessage: 'This division membership panel has expired. Run the command again.',
  });

  function actorScope(interaction, universityName: string) {
    return {
      global: hasGlobalAuthority(interaction.member),
      president: isUniversityPresident(interaction.member, universityName),
      vicePresident: isUniversityVicePresident(interaction.member, universityName),
    };
  }

  async function start(interaction, kind: MembershipPanelKind) {
    const scope = botCommandChannelScope(interaction.channel);
    const universities = await loadUniversities() as UniversityRow[];
    const resolved = resolveCommandContext({ commandName: kind, channelScope: scope, requireUniversity: false });
    const university = resolved.universityName
      ? universities.find((candidate) => sameText(candidate.name, resolved.universityName)) ?? null
      : null;
    if (resolved.universityName) {
      assertUser(university, `The ${resolved.universityName} bot-log is not linked to an active university.`);
      const actor = actorScope(interaction, university.name);
      assertUser(
        actor.global || actor.president || actor.vicePresident || isUniversityDivisionHead(interaction.member, university.name),
        `Only a board member of ${university.name} can manage division memberships here.`,
      );
    } else {
      assertUser(hasGlobalAuthority(interaction.member), 'Your global board access changed. Run the command again.');
    }
    const session = store.start(interaction, (base) => ({
      ...base,
      kind,
      universities,
      university,
      targetUser: null,
      context: null,
      divisions: [],
      manageableDivisionIds: [],
      selectedDivisionId: null,
      reason: '',
      choicePage: 0,
      screen: 'target',
    })) as MembershipPanelSession;
    await interaction.reply(ephemeralReplyPayload(targetPayload(session)));
  }

  function requireSession(interaction) {
    const parsed = parseFlowCustomId(interaction.customId, PREFIX, ACTION_VALUES);
    if (!parsed) return null;
    return { parsed, session: store.require(interaction, parsed.sessionId) };
  }

  async function loadSelectedMember(interaction, session: MembershipPanelSession) {
    assertUser(session.targetUser, 'Choose a member before continuing.');
    assertNotBotUser(interaction, session.targetUser.id);
    session.busy = true;
    try {
      await interaction.update(targetPayload(session, { loading: true }));
      const context = await loadMemberContext(interaction, { user: session.targetUser });
      assertUser(!hasRole(context.target, ROLE_NAMES.BOT), 'The Bot member cannot be managed.');
      const resolved = resolveCommandContext({
        commandName: session.kind,
        channelScope: botCommandChannelScope(interaction.channel),
        targetUniversity: context.member.university_name,
        selectedUniversity: session.university,
      });
      const university = session.universities.find((candidate) => sameText(candidate.name, resolved.universityName));
      assertUser(university, `The member's university, ${resolved.universityName}, is no longer active.`);
      session.university = university;
      assertUser(context.member.status === 'active', `Choose an active member of ${session.university.name}.`);
      const actor = actorScope(interaction, session.university.name);
      assertUser(
        actor.global || actor.president || actor.vicePresident || isUniversityDivisionHead(interaction.member, session.university.name),
        'Your division-management access changed. Run the command again.',
      );
      const divisions = await loadDivisions(session.university.name) as DivisionRow[];
      session.context = context;
      session.targetUser = context.target.user ?? session.targetUser;
      session.divisions = divisions;
      session.manageableDivisionIds = divisions
        .filter((division) => actor.global || actor.president || actor.vicePresident || isDivisionHead(interaction.member, session.university.name, division.name))
        .map(rowValue);
      session.selectedDivisionId = null;
      session.choicePage = 0;
      session.screen = 'choice';
      session.busy = false;
      await interaction.editReply(interactionEditPayload(choicePayload(session)));
    } catch (error) {
      session.busy = false;
      const message = error instanceof UserFacingError
        ? error.message
        : `${config.botName} could not load that member. Review your selection and try again.`;
      if (!(error instanceof UserFacingError)) {
        logger.error('Division membership context could not be loaded', {
          command: session.kind,
          targetId: session.targetUser?.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      await interaction.editReply(interactionEditPayload(targetPayload(session, { problem: message })));
    }
  }

  async function save(interaction, session: MembershipPanelSession) {
    const division = selectedDivision(session);
    assertUser(session.context && division, 'Choose a valid current division change before confirming.');
    resolveCommandContext({
      commandName: session.kind,
      channelScope: botCommandChannelScope(interaction.channel),
      targetUniversity: session.context.member.university_name,
      selectedUniversity: session.university,
    });
    session.busy = true;
    await interaction.update(pendingPayload(session));
    let result;
    try {
      const operation = session.kind === 'division-add-member'
        ? addDivisionMemberOperation
        : removeDivisionMemberOperation;
      result = await operation(interaction, {
        user: session.targetUser ?? { id: session.context.target.id },
        university: session.university.name,
        division: division.name,
        ...(session.kind === 'division-remove-member' ? { reason: session.reason || null } : {}),
      });
    } catch (error) {
      session.busy = false;
      await interaction.editReply(interactionEditPayload(failurePayload(session, error)));
      return;
    }

    store.remove(session);
    const activity = formatActivity(session.kind, { actorId: interaction.user.id, result });
    const activityDelivery = await postActivity(interaction, activity, result.university.name);
    const handoffSent = result.notificationDelivery
      ? result.notificationDelivery.status === 'delivered'
      : await sendHandoff(
        result.target,
        formatDivisionMemberHandoff(result, {
          removed: session.kind === 'division-remove-member',
          reason: session.reason || null,
        }),
      ).then(() => true).catch((error) => {
        logger.warn('Division membership handoff could not be delivered', {
          command: session.kind,
          userId: String(result.target?.id ?? ''),
          error: error instanceof Error ? error.message : String(error),
        });
        return false;
      });
    const warnings = [
      activityDelivery.status !== 'posted' ? 'The governance activity card could not be posted.' : null,
      !handoffSent ? 'The affected member could not be reached by DM.' : null,
    ].filter(Boolean);
    await interaction.editReply(interactionEditPayload(renderInteractionPanel(interactionOutcome({
      outcome: warnings.length ? 'delivery-failed' : 'success',
      title: session.kind === 'division-add-member' ? 'Division access added' : 'Division access removed',
      description: warnings.length
        ? `The membership change was saved. ${warnings.join(' ')}`
        : 'The membership change was saved, activity was posted, and the affected member received a private handoff.',
    }))));
  }

  async function handleButton(interaction) {
    const matched = requireSession(interaction);
    if (!matched) return;
    const { parsed, session } = matched;
    if (parsed.action === ACTIONS.CANCEL) {
      store.remove(session);
      await interaction.update(renderInteractionPanel(interactionOutcome({
        outcome: 'cancelled',
        title: `${panelLabel()} cancelled`,
        description: 'Nothing was changed.',
      })));
      return;
    }
    if (parsed.action === ACTIONS.TARGET_CONTINUE) {
      await loadSelectedMember(interaction, session);
      return;
    }
    if (parsed.action === ACTIONS.BACK_TARGET) {
      session.context = null;
      session.divisions = [];
      session.selectedDivisionId = null;
      session.choicePage = 0;
      session.screen = 'target';
      await interaction.update(targetPayload(session));
      return;
    }
    if (parsed.action === ACTIONS.PREVIOUS || parsed.action === ACTIONS.NEXT) {
      session.choicePage += parsed.action === ACTIONS.PREVIOUS ? -1 : 1;
      await interaction.update(choicePayload(session));
      return;
    }
    if (parsed.action === ACTIONS.REASON_OPEN) {
      await interaction.showModal(reasonModal(session));
      return;
    }
    if (parsed.action === ACTIONS.REVIEW) {
      assertUser(selectedDivision(session), 'Choose a valid current division change before continuing.');
      session.screen = 'review';
      await interaction.update(reviewPayload(session));
      return;
    }
    if (parsed.action === ACTIONS.BACK_CHOICE) {
      session.screen = 'choice';
      await interaction.update(choicePayload(session));
      return;
    }
    if (parsed.action === ACTIONS.SAVE) await save(interaction, session);
  }

  async function handleStringSelect(interaction) {
    const matched = requireSession(interaction);
    if (!matched || matched.parsed.action !== ACTIONS.DIVISION) return;
    matched.session.selectedDivisionId = String(interaction.values?.[0] ?? '');
    await interaction.update(choicePayload(matched.session));
  }

  async function handleUserSelect(interaction) {
    const matched = requireSession(interaction);
    if (!matched || matched.parsed.action !== ACTIONS.TARGET) return;
    const selectedId = String(interaction.values?.[0] ?? '');
    assertUser(selectedId, 'Choose one member from the list.');
    matched.session.targetUser = interaction.users?.get?.(selectedId) ?? { id: selectedId };
    matched.session.context = null;
    matched.session.selectedDivisionId = null;
    matched.session.choicePage = 0;
    matched.session.screen = 'target';
    await interaction.update(targetPayload(matched.session));
  }

  async function handleModalSubmit(interaction) {
    const matched = requireSession(interaction);
    if (!matched || matched.parsed.action !== ACTIONS.REASON_MODAL) return;
    matched.session.reason = truncateText(interaction.fields.getTextInputValue('reason').trim(), 1_000, '');
    matched.session.screen = 'choice';
    const payload = choicePayload(matched.session);
    if (interaction.isFromMessage?.()) await interaction.update(payload);
    else await interaction.reply(ephemeralReplyPayload(payload));
  }

  return {
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
