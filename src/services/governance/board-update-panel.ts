
import { assertNotBotUser, hasGlobalAuthority } from '../../authorization.js';
import { formatBoardActivity } from '../../activity/formatters.js';
import { postUniversityBoardActivity } from '../../activity/router.js';
import { config } from '../../config.js';
import { BOARD_ROLES, divisionLabel, ROLE_NAMES } from '../../constants.js';
import { assertUser, UserFacingError } from '../../errors.js';
import { createFlowSessionStore, type FlowSessionBase } from '../../flows/session-store.js';
import { logger } from '../../logger.js';
import {
  ephemeralReplyPayload,
  interactionEditPayload,
  interactionOutcome,
  interactionRecovery,
  renderInteractionPanel,
  recoveryKindForMessage,
} from '../../messages/index.js';
import type { InteractionActionSpec, InteractionControlSpec } from '../../messages/types.js';
import { botCommandChannelScope } from '../../runtime/command-channels.js';
import { resolveCommandContext } from '../../runtime/command-scope.js';
import { boardRecordSummary, formatBoardUpdateHandoff } from './formatters.js';
import {
  getBoardInfo,
  getMemberInfo,
  listDivisions,
  listUniversities,
  updateBoardRoster,
} from './service.js';

const PREFIX = 'gbu';
const POSITION_PAGE_SIZE = 8;
export const BOARD_UPDATE_HANDOFF_CONCURRENCY = 5;

const ACTIONS = Object.freeze({
  UNIVERSITY: 'u',
  UNIVERSITY_PREVIOUS: 'upv',
  UNIVERSITY_NEXT: 'unx',
  UNIVERSITY_CONTINUE: 'uc',
  EDIT: 'e',
  PREVIOUS: 'p',
  NEXT: 'n',
  REVIEW: 'r',
  BACK_EDIT: 'b',
  SAVE: 's',
  CANCEL: 'x',
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
}

interface BoardAssignmentRow {
  discord_user_id: string;
  full_name?: string | null;
  role: string;
  division_id?: unknown;
  division_name?: string | null;
}

interface MemberContext {
  target: {
    id: string;
    roles?: { cache?: { some?: (predicate: (role: { name?: string }) => boolean) => boolean } };
  };
  member: {
    status?: string;
    university_name?: string | null;
  };
  boardRoles?: Array<{
    role: string;
    university_name?: string | null;
  }>;
}

interface BoardPosition {
  key: string;
  token: string;
  role: string;
  division: DivisionRow | null;
  label: string;
  group: 'University leadership' | 'Division leadership';
  multiple: boolean;
}

interface BoardPositionPage {
  label: string;
  items: BoardPosition[];
}

interface BoardUpdateSession extends FlowSessionBase {
  universities: UniversityRow[];
  university: UniversityRow | null;
  universityPage: number;
  fixedUniversity: boolean;
  divisions: DivisionRow[];
  currentAssignments: BoardAssignmentRow[];
  selections: Record<string, string[]>;
  actorPresident: boolean;
  actorVicePresident: boolean;
  page: number;
  screen: 'scope' | 'overview' | 'edit' | 'review';
  problem: string | null;
}

function customId(session: BoardUpdateSession, action: string) {
  return `${PREFIX}:${session.id}:${action}`;
}

function parseCustomId(value: unknown) {
  const [prefix, sessionId, action, ...extra] = String(value ?? '').split(':');
  if (prefix !== PREFIX || !sessionId || extra.length > 0) return null;
  if (!ACTION_VALUES.has(action) && !/^h[0-9a-z]+$/.test(action) && !['up', 'uv'].includes(action)) return null;
  return { sessionId, action };
}

function sameText(left: unknown, right: unknown) {
  return String(left ?? '').trim().toLowerCase() === String(right ?? '').trim().toLowerCase();
}

function rowValue(row: DivisionRow | UniversityRow | null | undefined) {
  return String(row?.id ?? row?.name ?? '');
}

function universityScopePayload(session: BoardUpdateSession) {
  const pageCount = Math.max(1, Math.ceil(session.universities.length / 25));
  session.universityPage = Math.min(pageCount - 1, Math.max(0, session.universityPage));
  const start = session.universityPage * 25;
  const universities = session.universities.slice(start, start + 25);
  return renderInteractionPanel({
    kind: 'interaction-panel',
    tone: 'brand',
    title: 'Update a university board',
    description: 'Choose the university first. Its roster and positions load only after you continue.',
    progress: { label: 'Board update', current: 1, total: 4 },
    facts: [{ label: 'University', value: session.university?.name ?? 'Not selected yet' }],
    controls: universities.length ? [{
      kind: 'string-select',
      id: customId(session, ACTIONS.UNIVERSITY),
      label: 'University',
      placeholder: 'Choose a university',
      options: universities.map((university) => ({
        label: university.name,
        value: rowValue(university),
        selected: rowValue(university) === rowValue(session.university),
      })),
    }] : [],
    contentActions: pageCount > 1 ? [
      { id: customId(session, ACTIONS.UNIVERSITY_PREVIOUS), label: 'Previous universities', style: 'secondary', disabled: session.universityPage === 0 },
      { id: customId(session, ACTIONS.UNIVERSITY_NEXT), label: 'Next universities', style: 'secondary', disabled: session.universityPage === pageCount - 1 },
    ] : [],
    actions: [
      { id: customId(session, ACTIONS.UNIVERSITY_CONTINUE), label: 'Continue', style: 'primary', disabled: !session.university },
      { id: customId(session, ACTIONS.CANCEL), label: 'Cancel update', style: 'danger' },
    ],
    status: universities.length ? undefined : 'No active universities are available.',
    audience: 'actor',
  });
}

function positions(session: BoardUpdateSession): BoardPosition[] {
  return [
    {
      key: 'president',
      token: 'up',
      role: BOARD_ROLES.PRESIDENT,
      division: null,
      label: 'President',
      group: 'University leadership',
      multiple: true,
    },
    {
      key: 'vice-president',
      token: 'uv',
      role: BOARD_ROLES.VICE_PRESIDENT,
      division: null,
      label: 'Vice President',
      group: 'University leadership',
      multiple: true,
    },
    ...session.divisions.map((division, index) => ({
      key: `head:${rowValue(division)}`,
      token: `h${index.toString(36)}`,
      role: BOARD_ROLES.HEAD,
      division,
      label: `Head of ${divisionLabel(division.name, division.color)}`,
      group: 'Division leadership' as const,
      multiple: true,
    })),
  ];
}

function assignmentPositionKey(assignment: BoardAssignmentRow) {
  if (assignment.role === BOARD_ROLES.PRESIDENT) return 'president';
  if (assignment.role === BOARD_ROLES.VICE_PRESIDENT) return 'vice-president';
  return `head:${String(assignment.division_id ?? '')}`;
}

function initialSelections(session: Pick<BoardUpdateSession, 'currentAssignments'>) {
  const selections: Record<string, string[]> = {};
  for (const assignment of session.currentAssignments) {
    const key = assignmentPositionKey(assignment);
    selections[key] = [...(selections[key] ?? []), String(assignment.discord_user_id)].sort();
  }
  return selections;
}

function selectedIds(session: BoardUpdateSession, position: BoardPosition) {
  return [...(session.selections[position.key] ?? [])].sort();
}

function currentIds(session: BoardUpdateSession, position: BoardPosition) {
  return session.currentAssignments
    .filter((assignment) => assignmentPositionKey(assignment) === position.key)
    .map((assignment) => String(assignment.discord_user_id))
    .sort();
}

function sameIds(left: string[], right: string[]) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function changedValue(current: string, next: string, changed: boolean) {
  return changed ? `${current} → ${next}` : current;
}

function selectedAssignments(session: BoardUpdateSession): BoardAssignmentRow[] {
  return positions(session).flatMap((position) => selectedIds(session, position).map((userId) => ({
    discord_user_id: userId,
    full_name: session.currentAssignments.find((row) => String(row.discord_user_id) === userId)?.full_name ?? null,
    role: position.role,
    division_id: position.division?.id ?? null,
    division_name: position.division?.name ?? null,
  })));
}

function canonicalBoardSummary(session: BoardUpdateSession, assignments: BoardAssignmentRow[]) {
  return boardRecordSummary({
    university: session.university,
    divisions: session.divisions,
    rows: assignments,
  });
}

function summaryLines(session: BoardUpdateSession, group: BoardPosition['group'], changedOnly = false) {
  const before = canonicalBoardSummary(session, session.currentAssignments);
  const after = canonicalBoardSummary(session, selectedAssignments(session));
  const beforeFields = group === 'University leadership' ? before.leadership : before.divisions;
  const afterFields = group === 'University leadership' ? after.leadership : after.divisions;
  const lines = beforeFields.flatMap((field, index) => {
    const next = afterFields[index]?.value ?? field.value;
    if (changedOnly && field.value === next) return [];
    return [`• **${field.label}:** ${changedValue(field.value, next, field.value !== next)}`];
  });
  return lines.length ? lines.join('\n') : 'No changes';
}

function boardSections(session: BoardUpdateSession, changedOnly = false) {
  return [
    { heading: 'University leadership', body: summaryLines(session, 'University leadership', changedOnly) },
    { heading: 'Division leadership', body: summaryLines(session, 'Division leadership', changedOnly) },
  ];
}

function hasChanges(session: BoardUpdateSession) {
  return positions(session).some((position) => !sameIds(currentIds(session, position), selectedIds(session, position)));
}

function boardUpdateProgress(session: BoardUpdateSession, localStep: number) {
  const scopeStep = session.fixedUniversity ? 0 : 1;
  return { label: 'Board update', current: localStep + scopeStep, total: 3 + scopeStep };
}

function validationStatus(session: BoardUpdateSession) {
  if ((session.selections.president ?? []).length === 0) {
    return `${session.university.name} must keep at least one President.`;
  }
  return session.problem ?? undefined;
}

function overviewPayload(session: BoardUpdateSession) {
  return renderInteractionPanel({
    kind: 'interaction-panel',
    tone: 'brand',
    title: `${session.university.name} board`,
    description: 'Review the current roster, then open the editor to change one or more positions.',
    progress: boardUpdateProgress(session, 1),
    facts: [
      { label: 'University', value: session.university.name },
      { label: 'Board positions', value: String(positions(session).length) },
    ],
    sections: boardSections(session),
    detailsDensity: 'compact-groups',
    actions: [
      { id: customId(session, ACTIONS.EDIT), label: 'Edit board', style: 'primary' },
      { id: customId(session, ACTIONS.CANCEL), label: 'Cancel update', style: 'danger' },
    ],
    audience: 'actor',
  });
}

function positionPages(session: BoardUpdateSession): BoardPositionPage[] {
  const all = positions(session);
  if (all.length <= POSITION_PAGE_SIZE) {
    return [{ label: 'All board positions', items: all }];
  }

  const divisionPositions = all.filter((position) => position.group === 'Division leadership');
  const divisionPageCount = Math.max(1, Math.ceil(divisionPositions.length / POSITION_PAGE_SIZE));
  const divisionPages = Array.from({ length: divisionPageCount }, (_, index) => ({
    label: divisionPageCount === 1
      ? 'Division leadership'
      : `Division leadership ${index + 1} of ${divisionPageCount}`,
    items: divisionPositions.slice(index * POSITION_PAGE_SIZE, (index + 1) * POSITION_PAGE_SIZE),
  }));
  const universityPositions = all.filter((position) => position.group === 'University leadership');
  return [
    ...divisionPages,
    { label: 'University leadership', items: universityPositions },
  ];
}

function pageState(session: BoardUpdateSession) {
  const all = positions(session);
  const pages = positionPages(session);
  const pageCount = pages.length;
  session.page = Math.min(pageCount - 1, Math.max(0, session.page));
  const current = pages[session.page];
  return { all, items: current.items, pageCount, pages, current };
}

function positionControls(session: BoardUpdateSession): InteractionControlSpec[] {
  const { all, items } = pageState(session);
  return items.map((position) => {
    const absoluteIndex = all.findIndex((candidate) => candidate.key === position.key);
    const previous = absoluteIndex > 0 ? all[absoluteIndex - 1] : null;
    const startsGroup = !previous || previous.group !== position.group || items[0]?.key === position.key;
    const readOnly = position.role === BOARD_ROLES.PRESIDENT && !session.actorPresident;
    return {
      kind: 'user-select',
      id: customId(session, position.token),
      placeholder: position.role === BOARD_ROLES.HEAD
        ? `Choose one or more Heads of ${position.division.name}`
        : `Choose one or more ${position.label}s`,
      label: readOnly ? `${position.label} · View only` : position.label,
      groupLabel: startsGroup ? position.group : undefined,
      groupSpacingBefore: startsGroup && position.group === 'Division leadership',
      description: position.role === BOARD_ROLES.HEAD
        ? `Division leadership for ${position.division.name}`
        : readOnly
          ? 'Only a President can change this position.'
          : 'University-wide access to every division',
      selectedUserIds: selectedIds(session, position),
      min: 0,
      max: position.multiple ? 25 : 1,
      disabled: readOnly,
    };
  });
}

function pageActions(session: BoardUpdateSession): InteractionActionSpec[] {
  const { pageCount, pages } = pageState(session);
  if (pageCount <= 1) return [];
  const previous = pages[session.page - 1];
  const next = pages[session.page + 1];
  return [
    {
      id: customId(session, ACTIONS.PREVIOUS),
      label: previous ? `Back: ${previous.label}` : 'Previous positions',
      style: 'secondary',
      disabled: session.page === 0,
    },
    {
      id: customId(session, ACTIONS.NEXT),
      label: next ? `Next: ${next.label}` : 'Next positions',
      style: 'secondary',
      disabled: session.page === pageCount - 1,
    },
  ];
}

function editPayload(session: BoardUpdateSession) {
  const { pageCount, current } = pageState(session);
  const status = validationStatus(session);
  return renderInteractionPanel({
    kind: 'interaction-panel',
    tone: status ? 'warning' : 'brand',
    title: `Update the ${session.university.name} board`,
    description: 'Current assignments stay selected. Change the positions that should be different, then review the resulting roster.',
    progress: boardUpdateProgress(session, 2),
    facts: [
      { label: 'University', value: session.university.name },
      {
        label: 'Positions shown',
        value: pageCount === 1
          ? `All ${current.items.length}`
          : `${current.label} · Page ${session.page + 1} of ${pageCount}`,
      },
    ],
    sections: boardSections(session),
    detailsDensity: 'compact-groups',
    controls: positionControls(session),
    contentActions: pageActions(session),
    actions: [
      {
        id: customId(session, ACTIONS.REVIEW),
        label: 'Continue to review',
        style: 'primary',
        disabled: !hasChanges(session) || Boolean(status),
      },
      { id: customId(session, ACTIONS.CANCEL), label: 'Cancel update', style: 'danger' },
    ],
    status,
    audience: 'actor',
  });
}

function changedPositions(session: BoardUpdateSession) {
  return positions(session).filter((position) =>
    !sameIds(currentIds(session, position), selectedIds(session, position)),
  );
}

function affectedMemberIds(session: BoardUpdateSession) {
  return new Set(changedPositions(session).flatMap((position) => [
    ...currentIds(session, position),
    ...selectedIds(session, position),
  ]));
}

function affectedMembers(session: BoardUpdateSession) {
  return affectedMemberIds(session).size;
}

function reviewPayload(session: BoardUpdateSession) {
  return renderInteractionPanel({
    kind: 'interaction-panel',
    tone: 'changed',
    title: `Review the ${session.university.name} board`,
    description: 'These position changes will become the new university board roster.',
    progress: boardUpdateProgress(session, 3),
    facts: [
      { label: 'Positions changing', value: String(changedPositions(session).length) },
      { label: 'Members affected', value: String(affectedMembers(session)) },
    ],
    sections: boardSections(session, true),
    detailsDensity: 'compact-groups',
    actions: [
      { id: customId(session, ACTIONS.SAVE), label: 'Save board update', style: 'success' },
      { id: customId(session, ACTIONS.BACK_EDIT), label: 'Back to positions', style: 'secondary' },
      { id: customId(session, ACTIONS.CANCEL), label: 'Cancel update', style: 'danger' },
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
    status: 'This panel will update when the check finishes. Do not submit it again.',
    audience: 'actor',
  });
}

function failurePayload(session: BoardUpdateSession, error: unknown) {
  const expected = error instanceof UserFacingError;
  const message = expected ? error.message : `${config.botName} could not save this board update. Try again.`;
  return renderInteractionPanel(interactionRecovery({
    kind: expected ? recoveryKindForMessage(message) : 'unexpected',
    title: 'Board update not saved',
    whatHappened: message,
    preservedState: 'No board appointment was changed. The proposed roster is still available.',
    correction: 'Review the listed condition. Reload the roster if a member, position, or your authority changed while the panel was open.',
    continueWith: 'Use the controls below to try again, return to positions, or cancel this private flow.',
    actions: [
      { id: customId(session, ACTIONS.SAVE), label: 'Try again', style: 'primary' },
      { id: customId(session, ACTIONS.BACK_EDIT), label: 'Back to positions', style: 'secondary' },
      { id: customId(session, ACTIONS.CANCEL), label: 'Cancel update', style: 'danger' },
    ],
  }));
}

function desiredAssignments(session: BoardUpdateSession) {
  return positions(session).flatMap((position) => selectedIds(session, position).map((userId) => ({
    userId,
    role: position.role,
    divisionId: position.division?.id ?? null,
  })));
}

function expectedAssignments(session: BoardUpdateSession) {
  return session.currentAssignments.map((assignment) => ({
    userId: assignment.discord_user_id,
    role: assignment.role,
    divisionId: assignment.division_id ?? null,
  }));
}

async function defaultBoardRows(interaction, universityName: string) {
  return (await getBoardInfo(interaction, { university: universityName })).rows;
}

async function defaultSendHandoff(target, payload) {
  assertUser(target?.send, 'The affected member could not be reached by DM.');
  await target.send(payload);
}

async function sendBoardUpdateHandoffs(result, sendHandoff) {
  const changes = result.memberChanges ?? [];
  const handoffResults = new Array<boolean>(changes.length);
  let nextIndex = 0;
  const workerCount = Math.min(BOARD_UPDATE_HANDOFF_CONCURRENCY, changes.length);

  async function worker() {
    while (nextIndex < changes.length) {
      const index = nextIndex;
      nextIndex += 1;
      const change = changes[index];
      try {
        await sendHandoff(change.target, formatBoardUpdateHandoff(result, change));
        handoffResults[index] = true;
      } catch (error) {
        logger.warn('Board update handoff could not be delivered', {
          userId: String(change.target?.id ?? ''),
          error: error instanceof Error ? error.message : String(error),
        });
        handoffResults[index] = false;
      }
    }
  }

  await Promise.all(Array.from({ length: workerCount }, worker));
  return handoffResults;
}

export function createBoardUpdatePanelService({
  loadUniversities = listUniversities,
  loadDivisions = listDivisions,
  loadBoardAssignments = defaultBoardRows,
  loadMemberContext = getMemberInfo,
  updateOperation = updateBoardRoster,
  formatActivity = formatBoardActivity,
  postActivity = postUniversityBoardActivity,
  sendHandoff = defaultSendHandoff,
  now = () => Date.now(),
} = {}) {
  const store = createFlowSessionStore<BoardUpdateSession>({
    now,
    expiredMessage: 'This board update has expired. Run `/board-update` again.',
  });

  function actorScope(context: MemberContext, universityName: string) {
    const localRoles = (context.boardRoles ?? []).filter((role) =>
      sameText(role.university_name, universityName),
    );
    return {
      president: localRoles.some((role) => role.role === BOARD_ROLES.PRESIDENT),
      vicePresident: localRoles.some((role) => role.role === BOARD_ROLES.VICE_PRESIDENT),
    };
  }

  async function start(interaction) {
    const scope = botCommandChannelScope(interaction.channel);
    const universities = await loadUniversities() as UniversityRow[];
    const resolved = resolveCommandContext({
      commandName: 'board-update',
      channelScope: scope,
      requireUniversity: false,
    });
    const university = resolved.universityName
      ? universities.find((candidate) => sameText(candidate.name, resolved.universityName)) ?? null
      : null;
    if (resolved.universityName) {
      assertUser(university, `The ${resolved.universityName} bot-log is not linked to an active university.`);
    } else {
      assertUser(hasGlobalAuthority(interaction.member), 'Your global board access changed. Run `/board-update` again.');
    }
    const session = store.start(interaction, (base) => ({
      ...base,
      universities,
      university,
      universityPage: 0,
      fixedUniversity: Boolean(university),
      divisions: [],
      currentAssignments: [],
      selections: {},
      actorPresident: false,
      actorVicePresident: false,
      page: 0,
      screen: university ? 'overview' : 'scope',
      problem: null,
    })) as BoardUpdateSession;
    if (!university) {
      await interaction.reply(ephemeralReplyPayload(universityScopePayload(session)));
      return;
    }
    await loadSelectedUniversity(interaction, session, false);
  }

  async function loadSelectedUniversity(interaction, session: BoardUpdateSession, updating: boolean) {
    assertUser(session.university, 'Choose a university before continuing.');
    resolveCommandContext({
      commandName: 'board-update',
      channelScope: botCommandChannelScope(interaction.channel),
      selectedUniversity: session.university,
    });
    const global = hasGlobalAuthority(interaction.member);
    if (updating) {
      session.busy = true;
      await interaction.update(pendingPayload(
        `Loading the ${session.university.name} board`,
        `${config.botName} is checking your current authority and loading the canonical roster and active divisions.`,
      ));
    }
    try {
      const actorContext = await loadMemberContext(interaction, { user: interaction.user }) as MemberContext;
      const actor = actorScope(actorContext, session.university.name);
      assertUser(
        global || actor.president || actor.vicePresident,
        `Only a Global President or the President or Vice President of ${session.university.name} can update its board.`,
      );
      const [divisions, currentAssignments] = await Promise.all([
        loadDivisions(session.university.name) as Promise<DivisionRow[]>,
        loadBoardAssignments(interaction, session.university.name) as Promise<BoardAssignmentRow[]>,
      ]);
      session.divisions = divisions;
      session.currentAssignments = currentAssignments;
      session.actorPresident = global || actor.president;
      session.actorVicePresident = actor.vicePresident;
      session.selections = initialSelections(session);
      session.screen = 'overview';
      session.busy = false;
      if (updating) await interaction.editReply(interactionEditPayload(overviewPayload(session)));
      else await interaction.reply(ephemeralReplyPayload(overviewPayload(session)));
    } catch (error) {
      session.busy = false;
      throw error;
    }
  }

  function requireSession(interaction) {
    const parsed = parseCustomId(interaction.customId);
    if (!parsed) return null;
    return { parsed, session: store.require(interaction, parsed.sessionId) };
  }

  async function validateSelections(interaction, session: BoardUpdateSession) {
    for (const userId of affectedMemberIds(session)) {
      assertNotBotUser(interaction, userId);
      const context = await loadMemberContext(interaction, { user: { id: userId } }) as MemberContext;
      assertUser(!context.target.roles?.cache?.some?.((role) => role.name === ROLE_NAMES.BOT), 'The Bot member cannot be managed.');
      assertUser(
        !context.target.roles?.cache?.some?.((role) => role.name === ROLE_NAMES.GLOBAL_PRESIDENT)
          && !(context.boardRoles ?? []).some((role) => role.role === BOARD_ROLES.GLOBAL_PRESIDENT),
        'You cannot manage Global President members.',
      );
      assertUser(
        context.member.status === 'active' && sameText(context.member.university_name, session.university.name),
        `<@${userId}> is not an active member of ${session.university.name}.`,
      );
      assertUser(
        session.actorPresident || !(context.boardRoles ?? []).some((role) =>
          role.role === BOARD_ROLES.PRESIDENT
          && sameText(role.university_name, session.university.name),
        ),
        'A Vice President cannot manage their university President.',
      );
    }
  }

  async function openReview(interaction, session: BoardUpdateSession) {
    session.busy = true;
    await interaction.update(pendingPayload('Checking the proposed board', `${config.botName} is validating the selected members and your current authority.`));
    try {
      await validateSelections(interaction, session);
      session.busy = false;
      session.screen = 'review';
      session.problem = null;
      await interaction.editReply(interactionEditPayload(reviewPayload(session)));
    } catch (error) {
      session.busy = false;
      session.screen = 'edit';
      session.problem = error instanceof UserFacingError
        ? error.message
        : `${config.botName} could not validate the selected members. Review the roster and try again.`;
      await interaction.editReply(interactionEditPayload(editPayload(session)));
    }
  }

  async function save(interaction, session: BoardUpdateSession) {
    resolveCommandContext({
      commandName: 'board-update',
      channelScope: botCommandChannelScope(interaction.channel),
      selectedUniversity: session.university,
    });
    session.busy = true;
    await interaction.update(pendingPayload('Saving the board update', `${config.botName} is re-checking the roster and reconciling managed Discord roles.`));
    let result;
    try {
      result = await updateOperation(interaction, {
        university: session.university.name,
        expectedAssignments: expectedAssignments(session),
        assignments: desiredAssignments(session),
      });
    } catch (error) {
      session.busy = false;
      await interaction.editReply(interactionEditPayload(failurePayload(session, error)));
      return;
    }

    store.remove(session);
    const activity = formatActivity('board-update', { actorId: interaction.user.id, result });
    const activityDelivery = await postActivity(interaction, activity, result.university.name);
    const handoffResults = result.notificationDeliveries?.length
      ? result.notificationDeliveries.map((delivery) => delivery?.status === 'delivered')
      : await sendBoardUpdateHandoffs(result, sendHandoff);
    const missedHandoffs = handoffResults.filter((sent) => !sent).length;
    const warnings = [
      activityDelivery.status !== 'posted' ? 'The governance activity card could not be posted.' : null,
      missedHandoffs ? `${missedHandoffs} affected member handoff(s) could not be delivered.` : null,
    ].filter(Boolean);
    await interaction.editReply(interactionEditPayload(renderInteractionPanel(interactionOutcome({
      outcome: warnings.length ? 'delivery-failed' : 'success',
      title: 'Board updated',
      description: warnings.length
        ? `The new roster was saved. ${warnings.join(' ')}`
        : 'The new roster was saved, activity was posted, and every affected member received a private handoff.',
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
        title: 'Board update cancelled',
        description: 'Nothing was changed.',
      })));
      return;
    }
    if (parsed.action === ACTIONS.UNIVERSITY_PREVIOUS || parsed.action === ACTIONS.UNIVERSITY_NEXT) {
      session.universityPage += parsed.action === ACTIONS.UNIVERSITY_PREVIOUS ? -1 : 1;
      await interaction.update(universityScopePayload(session));
      return;
    }
    if (parsed.action === ACTIONS.UNIVERSITY_CONTINUE) {
      await loadSelectedUniversity(interaction, session, true);
      return;
    }
    if (parsed.action === ACTIONS.EDIT) {
      session.screen = 'edit';
      await interaction.update(editPayload(session));
      return;
    }
    if (parsed.action === ACTIONS.PREVIOUS || parsed.action === ACTIONS.NEXT) {
      session.page += parsed.action === ACTIONS.PREVIOUS ? -1 : 1;
      await interaction.update(editPayload(session));
      return;
    }
    if (parsed.action === ACTIONS.REVIEW) {
      assertUser(hasChanges(session) && !validationStatus(session), 'Choose a valid board change before reviewing.');
      await openReview(interaction, session);
      return;
    }
    if (parsed.action === ACTIONS.BACK_EDIT) {
      session.screen = 'edit';
      await interaction.update(editPayload(session));
      return;
    }
    if (parsed.action === ACTIONS.SAVE) await save(interaction, session);
  }

  async function handleUserSelect(interaction) {
    const matched = requireSession(interaction);
    if (!matched) return;
    const { parsed, session } = matched;
    const position = positions(session).find((candidate) => candidate.token === parsed.action);
    if (!position) return;
    assertUser(
      position.role !== BOARD_ROLES.PRESIDENT || session.actorPresident,
      'Only a President can change the President position.',
    );
    const values = [...new Set<string>((interaction.values ?? []).map((value) => String(value)))].sort();
    assertUser(position.multiple || values.length <= 1, `${position.label} accepts only one member.`);

    if (!session.actorPresident && values.some((userId) =>
      session.currentAssignments.some((assignment) =>
        assignment.role === BOARD_ROLES.PRESIDENT && assignment.discord_user_id === userId,
      ),
    ) && position.role !== BOARD_ROLES.PRESIDENT) {
      session.problem = 'A Vice President cannot move their university President into another board position.';
      await interaction.update(editPayload(session));
      return;
    }

    session.problem = null;
    session.selections[position.key] = values;
    if (position.role === BOARD_ROLES.HEAD && values.length > 0) {
      for (const userId of values) {
        for (const candidate of positions(session)) {
          if (candidate.role === BOARD_ROLES.HEAD && candidate.key !== position.key) {
            session.selections[candidate.key] = selectedIds(session, candidate).filter((id) => id !== userId);
          }
        }
        session.selections['vice-president'] = (session.selections['vice-president'] ?? []).filter((id) => id !== userId);
        if (session.actorPresident) {
          session.selections.president = (session.selections.president ?? []).filter((id) => id !== userId);
        }
      }
    } else if (position.role !== BOARD_ROLES.HEAD) {
      for (const userId of values) {
        for (const candidate of positions(session).filter((entry) => entry.role === BOARD_ROLES.HEAD)) {
          session.selections[candidate.key] = selectedIds(session, candidate).filter((id) => id !== userId);
        }
      }
    }
    await interaction.update(editPayload(session));
  }

  async function handleStringSelect(interaction) {
    const matched = requireSession(interaction);
    if (!matched || matched.parsed.action !== ACTIONS.UNIVERSITY) return;
    assertUser(!matched.session.fixedUniversity, 'The university is fixed by this command channel.');
    matched.session.university = matched.session.universities.find(
      (university) => rowValue(university) === String(interaction.values?.[0] ?? ''),
    ) ?? null;
    await interaction.update(universityScopePayload(matched.session));
  }

  return {
    start,
    canHandle(customIdValue: string) {
      return Boolean(parseCustomId(customIdValue));
    },
    handleButton,
    handleStringSelect,
    handleUserSelect,
  };
}

export const boardUpdatePanel = createBoardUpdatePanelService();

export { ACTIONS as BOARD_UPDATE_PANEL_ACTIONS };
