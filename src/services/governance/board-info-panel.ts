import { escapeMarkdown } from 'discord.js';

import { hasGlobalAuthority } from '../../authorization.js';
import { assertUser } from '../../errors.js';
import { flowCustomId, parseFlowCustomId } from '../../flows/custom-id.js';
import { createFlowSessionStore, type FlowSessionBase } from '../../flows/session-store.js';
import {
  ephemeralReplyPayload,
  interactionEditPayload,
  interactionOutcome,
  renderInteractionPanel,
} from '../../messages/index.js';
import { botCommandChannelScope } from '../../runtime/command-channels.js';
import { resolveCommandContext } from '../../runtime/command-scope.js';
import { boardRecordSummary } from './formatters.js';
import { getBoardInfo, listUniversities } from './service.js';

const PREFIX = 'gbi';
const PAGE_SIZE = 25;
const ACTIONS = Object.freeze({
  UNIVERSITY: 'u',
  PREVIOUS: 'p',
  NEXT: 'n',
  CONTINUE: 'c',
  CANCEL: 'x',
});
const ACTION_VALUES = new Set<string>(Object.values(ACTIONS));

interface UniversityRow {
  id?: unknown;
  name: string;
}

interface BoardInfoSession extends FlowSessionBase {
  universities: UniversityRow[];
  university: UniversityRow | null;
  universityPage: number;
}

function id(session: BoardInfoSession, action: string) {
  return flowCustomId(PREFIX, session.id, action);
}

function rowValue(row: UniversityRow | null | undefined) {
  return String(row?.id ?? row?.name ?? '');
}

function scopePayload(session: BoardInfoSession) {
  const pageCount = Math.max(1, Math.ceil(session.universities.length / PAGE_SIZE));
  session.universityPage = Math.min(pageCount - 1, Math.max(0, session.universityPage));
  const start = session.universityPage * PAGE_SIZE;
  const universities = session.universities.slice(start, start + PAGE_SIZE);
  return renderInteractionPanel({
    kind: 'interaction-panel',
    tone: 'brand',
    title: 'View a university board',
    description: 'Choose the university whose current board roster and Discord consistency you want to inspect.',
    facts: [{ label: 'University', value: session.university?.name ?? 'Not selected yet' }],
    controls: universities.length ? [{
      kind: 'string-select',
      id: id(session, ACTIONS.UNIVERSITY),
      label: 'University',
      placeholder: 'Choose a university',
      options: universities.map((university) => ({
        label: university.name,
        value: rowValue(university),
        selected: rowValue(university) === rowValue(session.university),
      })),
    }] : [],
    contentActions: pageCount > 1 ? [
      { id: id(session, ACTIONS.PREVIOUS), label: 'Previous universities', style: 'secondary', disabled: session.universityPage === 0 },
      { id: id(session, ACTIONS.NEXT), label: 'Next universities', style: 'secondary', disabled: session.universityPage === pageCount - 1 },
    ] : [],
    actions: [
      { id: id(session, ACTIONS.CONTINUE), label: 'View board', style: 'primary', disabled: !session.university },
      { id: id(session, ACTIONS.CANCEL), label: 'Cancel', style: 'danger' },
    ],
    status: universities.length ? undefined : 'No active universities are available.',
    audience: 'actor',
  });
}

function loadingPayload(universityName: string) {
  return renderInteractionPanel({
    kind: 'interaction-panel',
    tone: 'pending',
    title: `Loading the ${escapeMarkdown(universityName)} board`,
    description: 'BAINSA is checking your current authority, the canonical roster, and managed Discord roles.',
    status: 'This private panel will update when the roster is ready.',
    audience: 'actor',
  });
}

// The university picker is Components V2, and Discord cannot replace that
// message with an embed. Keep the final roster in the same message format.
function boardPayload(info) {
  const summary = boardRecordSummary(info);
  const consistencyIssues = info.rows.filter((row) =>
    row.missingRoles.length > 0 || (row.unexpectedRoles?.length ?? 0) > 0,
  );
  const divisions = summary.divisions.length
    ? summary.divisions.map((field) => `**${field.label}** · ${field.value}`).join('\n')
    : 'No active divisions are recorded.';
  const issueSummary = consistencyIssues.length
    ? `${consistencyIssues.length} member${consistencyIssues.length === 1 ? '' : 's'} need Discord-role recovery. Open \`/board-update\` and save the roster again.`
    : 'Discord roles match the recorded board roster.';

  return renderInteractionPanel({
    kind: 'interaction-panel',
    tone: consistencyIssues.length ? 'warning' : (info.rows.length ? 'brand' : 'warning'),
    title: summary.title,
    description: summary.description,
    facts: summary.leadership,
    sections: [{ heading: 'Division Heads', body: divisions }],
    detailsDensity: 'compact-groups',
    status: issueSummary,
    audience: 'actor',
  });
}

export function createBoardInfoPanelService({
  loadUniversities = listUniversities,
  loadBoardInfo = getBoardInfo,
  now = () => Date.now(),
} = {}) {
  const store = createFlowSessionStore<BoardInfoSession>({
    now,
    expiredMessage: 'This board lookup has expired. Run `/board-info` again.',
  });

  async function showBoard(interaction, session: BoardInfoSession) {
    assertUser(session.university, 'Choose a university before continuing.');
    resolveCommandContext({
      commandName: 'board-info',
      channelScope: botCommandChannelScope(interaction.channel),
      selectedUniversity: session.university,
    });
    session.busy = true;
    if (interaction.isButton?.()) await interaction.update(loadingPayload(session.university.name));
    else await interaction.reply(ephemeralReplyPayload(loadingPayload(session.university.name)));
    try {
      const info = await loadBoardInfo(interaction, { university: session.university.name });
      store.remove(session);
      await interaction.editReply(interactionEditPayload(boardPayload(info)));
    } catch (error) {
      session.busy = false;
      throw error;
    }
  }

  async function start(interaction) {
    const channelScope = botCommandChannelScope(interaction.channel);
    const universities = await loadUniversities() as UniversityRow[];
    const resolved = resolveCommandContext({
      commandName: 'board-info',
      channelScope,
      requireUniversity: false,
    });
    assertUser(
      channelScope?.kind !== 'global' || hasGlobalAuthority(interaction.member),
      'Your global board access changed. Run `/board-info` again.',
    );
    const university = resolved.universityName
      ? universities.find((candidate) => candidate.name.toLowerCase() === resolved.universityName.toLowerCase()) ?? null
      : null;
    if (resolved.universityName) {
      assertUser(university, `The ${resolved.universityName} bot-log is not linked to an active university.`);
    }
    const session = store.start(interaction, (base) => ({
      ...base,
      universities,
      university,
      universityPage: 0,
    })) as BoardInfoSession;
    if (university) {
      await showBoard(interaction, session);
      return;
    }
    await interaction.reply(ephemeralReplyPayload(scopePayload(session)));
  }

  function requireSession(interaction) {
    const parsed = parseFlowCustomId(interaction.customId, PREFIX, ACTION_VALUES);
    if (!parsed) return null;
    return { parsed, session: store.require(interaction, parsed.sessionId) };
  }

  async function handleButton(interaction) {
    const matched = requireSession(interaction);
    if (!matched) return;
    const { parsed, session } = matched;
    if (parsed.action === ACTIONS.CANCEL) {
      store.remove(session);
      await interaction.update(renderInteractionPanel(interactionOutcome({
        outcome: 'cancelled',
        title: 'Board lookup cancelled',
        description: 'Nothing was changed.',
      })));
      return;
    }
    if (parsed.action === ACTIONS.PREVIOUS || parsed.action === ACTIONS.NEXT) {
      session.universityPage += parsed.action === ACTIONS.PREVIOUS ? -1 : 1;
      await interaction.update(scopePayload(session));
      return;
    }
    if (parsed.action === ACTIONS.CONTINUE) await showBoard(interaction, session);
  }

  async function handleStringSelect(interaction) {
    const matched = requireSession(interaction);
    if (!matched || matched.parsed.action !== ACTIONS.UNIVERSITY) return;
    matched.session.university = matched.session.universities.find(
      (university) => rowValue(university) === String(interaction.values?.[0] ?? ''),
    ) ?? null;
    await interaction.update(scopePayload(matched.session));
  }

  return {
    start,
    canHandle(customId: string) {
      return Boolean(parseFlowCustomId(customId, PREFIX, ACTION_VALUES));
    },
    handleButton,
    handleStringSelect,
  };
}

export const boardInfoPanel = createBoardInfoPanelService();
