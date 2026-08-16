import { assertUser } from '../errors.js';

export type CommandChannelKind = 'global' | 'university' | 'project';
export type CommandTargetKind = 'none' | 'member' | 'division' | 'board' | 'project';
export type CommandScopeSource = 'target' | 'channel' | 'selection' | 'all-universities';

export interface CommandScopePolicy {
  channels: readonly CommandChannelKind[];
  target: CommandTargetKind;
  university: 'none' | 'target-first' | 'channel-or-selection';
  selector: 'none' | 'university-when-global';
  search: 'none' | 'effective-university' | 'all-when-global';
  confirmation: 'none' | 'recheck-scope';
  activity: 'none' | 'affected-university';
}

const botLogs = ['global', 'university'] as const;
const projectChannels = ['global', 'university', 'project'] as const;

export const COMMAND_SCOPE_POLICIES = Object.freeze({
  guide: policy(botLogs, 'none', 'none', 'none', 'none', 'none', 'none'),
  'member-update': policy(botLogs, 'member', 'target-first', 'none', 'all-when-global', 'recheck-scope', 'affected-university'),
  'member-remove': policy(botLogs, 'member', 'target-first', 'none', 'all-when-global', 'recheck-scope', 'affected-university'),
  'member-info': policy(botLogs, 'member', 'target-first', 'none', 'all-when-global', 'none', 'none'),
  'division-create': policy(botLogs, 'division', 'channel-or-selection', 'university-when-global', 'effective-university', 'recheck-scope', 'affected-university'),
  'division-update': policy(botLogs, 'division', 'channel-or-selection', 'university-when-global', 'effective-university', 'recheck-scope', 'affected-university'),
  'division-add-member': policy(botLogs, 'member', 'target-first', 'none', 'all-when-global', 'recheck-scope', 'affected-university'),
  'division-remove-member': policy(botLogs, 'member', 'target-first', 'none', 'all-when-global', 'recheck-scope', 'affected-university'),
  'board-update': policy(botLogs, 'board', 'channel-or-selection', 'university-when-global', 'effective-university', 'recheck-scope', 'affected-university'),
  'board-info': policy(botLogs, 'board', 'channel-or-selection', 'university-when-global', 'effective-university', 'none', 'none'),
  'project-create': policy(botLogs, 'project', 'channel-or-selection', 'university-when-global', 'effective-university', 'recheck-scope', 'affected-university'),
  'project-update': policy(projectChannels, 'project', 'target-first', 'none', 'all-when-global', 'recheck-scope', 'affected-university'),
  'project-close': policy(projectChannels, 'project', 'target-first', 'none', 'all-when-global', 'recheck-scope', 'affected-university'),
  'project-info': policy(projectChannels, 'project', 'target-first', 'none', 'all-when-global', 'none', 'none'),
}) satisfies Readonly<Record<string, CommandScopePolicy>>;

function policy(
  channels: readonly CommandChannelKind[],
  target: CommandTargetKind,
  university: CommandScopePolicy['university'],
  selector: CommandScopePolicy['selector'],
  search: CommandScopePolicy['search'],
  confirmation: CommandScopePolicy['confirmation'],
  activity: CommandScopePolicy['activity'],
): CommandScopePolicy {
  return Object.freeze({ channels, target, university, selector, search, confirmation, activity });
}

export function commandScopePolicy(commandName: string): CommandScopePolicy | null {
  return COMMAND_SCOPE_POLICIES[commandName] ?? null;
}

function universityName(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() || null;
  if (!value || typeof value !== 'object') return null;
  const name = (value as { name?: unknown }).name;
  return typeof name === 'string' ? name.trim() || null : null;
}

function sameUniversity(left: unknown, right: unknown) {
  const a = universityName(left);
  const b = universityName(right);
  return Boolean(a && b && a.toLowerCase() === b.toLowerCase());
}

export interface ResolveCommandContextInput {
  commandName: string;
  channelScope?: { kind: CommandChannelKind; universityName?: string } | null;
  targetUniversity?: unknown;
  selectedUniversity?: unknown;
  requireUniversity?: boolean;
}

export interface ResolvedCommandContext {
  commandName: string;
  university: unknown | null;
  universityName: string | null;
  source: CommandScopeSource;
  channelKind: CommandChannelKind | null;
}

/**
 * Resolves university scope with one precedence rule: trusted target, scoped
 * channel, then explicit selection. Any lower-precedence value must agree.
 */
export function resolveCommandContext({
  commandName,
  channelScope = null,
  targetUniversity = null,
  selectedUniversity = null,
  requireUniversity = true,
}: ResolveCommandContextInput): ResolvedCommandContext {
  const commandPolicy = commandScopePolicy(commandName);
  assertUser(commandPolicy, `No scope policy is defined for /${commandName}.`);
  if (channelScope) {
    assertUser(
      commandPolicy.channels.includes(channelScope.kind),
      `/${commandName} is not available in this channel.`,
    );
  }

  const channelUniversity = channelScope?.kind === 'university'
    ? channelScope.universityName ?? null
    : null;
  const targetName = universityName(targetUniversity);
  const selectedName = universityName(selectedUniversity);

  assertUser(
    !targetName || !channelUniversity || sameUniversity(targetUniversity, channelUniversity),
    `The selected target belongs to ${targetName}, not this ${channelUniversity} command channel.`,
  );
  assertUser(
    !targetName || !selectedName || sameUniversity(targetUniversity, selectedUniversity),
    `The selected target belongs to ${targetName}, not ${selectedName}.`,
  );
  assertUser(
    !channelUniversity || !selectedName || sameUniversity(channelUniversity, selectedUniversity),
    `This command channel is scoped to ${channelUniversity}, not ${selectedName}.`,
  );

  if (targetName) {
    return { commandName, university: targetUniversity, universityName: targetName, source: 'target', channelKind: channelScope?.kind ?? null };
  }
  if (channelUniversity) {
    return { commandName, university: channelUniversity, universityName: channelUniversity, source: 'channel', channelKind: 'university' };
  }
  if (selectedName) {
    return { commandName, university: selectedUniversity, universityName: selectedName, source: 'selection', channelKind: channelScope?.kind ?? null };
  }

  assertUser(!requireUniversity, 'Choose a university before continuing.');
  return {
    commandName,
    university: null,
    universityName: null,
    source: 'all-universities',
    channelKind: channelScope?.kind ?? null,
  };
}
