import { handleInteractionError } from '../discord/reply.js';
import { assertUser, UserFacingError } from '../errors.js';
import { assertNoBotCommandTarget } from '../authorization.js';
import { assertCommandChannel, commandChannelScope } from './command-channels.js';
import { canDiscoverCommand } from './command-permissions.js';
import { buildCommandMap, type CommandDefinition } from './command-registry.js';

interface ComponentHandler {
  canHandle: (customId: string) => boolean;
  handleButton?: (interaction: unknown) => unknown;
  handleStringSelect?: (interaction: unknown) => unknown;
  handleUserSelect?: (interaction: unknown) => unknown;
  handleModalSubmit?: (interaction: unknown) => unknown;
  handleComponent?: (interaction: unknown) => unknown;
}

interface InteractionDispatcherOptions {
  commands?: readonly CommandDefinition[];
  onboarding?: ComponentHandler;
  guide?: ComponentHandler;
  projectSetup?: ComponentHandler;
  profiles?: ComponentHandler;
  onError?: (interaction: unknown, error: unknown) => Promise<void>;
}

export function routeInteraction(interaction) {
  if (interaction.isChatInputCommand?.()) return 'chatInput';
  if (interaction.isAutocomplete?.()) return 'autocomplete';
  if (interaction.isButton?.()) return 'button';
  if (interaction.isStringSelectMenu?.()) return 'stringSelect';
  if (interaction.isUserSelectMenu?.()) return 'userSelect';
  if (interaction.isModalSubmit?.()) return 'modalSubmit';
  return 'unknown';
}

function requireComponentHandler(handler: ((interaction: unknown) => unknown) | undefined) {
  if (!handler) throw new UserFacingError('This interaction is no longer available.');
  return handler;
}

export function createInteractionDispatcher({
  commands,
  onboarding,
  guide,
  projectSetup,
  profiles,
  onError = handleInteractionError,
}: InteractionDispatcherOptions = {}) {
  const commandMap = buildCommandMap(commands ?? []);

  return async function dispatchInteraction(interaction) {
    try {
      const route = routeInteraction(interaction);

      if (route === 'chatInput') {
        const command = commandMap.get(interaction.commandName);
        if (!command) throw new UserFacingError(`Unknown command: ${interaction.commandName}`);
        const channelScope = assertCommandChannel(interaction, interaction.commandName);
        const allowed = canDiscoverCommand({
          commandName: interaction.commandName,
          member: interaction.member,
          channelScope,
        });
        assertUser(allowed, 'This command is not available in this channel.');
        assertNoBotCommandTarget(interaction);
        await command.execute(interaction);
        return;
      }

      if (route === 'autocomplete') {
        const command = commandMap.get(interaction.commandName);
        if (!command?.autocomplete) return interaction.respond([]);
        const allowed = canDiscoverCommand({
          commandName: interaction.commandName,
          member: interaction.member,
          channelScope: commandChannelScope(interaction.channel),
        });
        // Do this before invoking a handler: autocomplete handlers may query
        // Postgres or Discord's guild-member directory.
        if (!allowed) return interaction.respond([]);
        await command.autocomplete(interaction);
        return;
      }

      if (route === 'button' && onboarding?.canHandle?.(interaction.customId)) {
        await requireComponentHandler(onboarding.handleButton)(interaction);
        return;
      }

      if (route === 'button' && profiles?.canHandle?.(interaction.customId)) {
        await requireComponentHandler(profiles.handleButton)(interaction);
        return;
      }

      if (route === 'button' && projectSetup?.canHandle?.(interaction.customId)) {
        await requireComponentHandler(projectSetup.handleButton)(interaction);
        return;
      }

      if (route === 'userSelect' && projectSetup?.canHandle?.(interaction.customId)) {
        await requireComponentHandler(projectSetup.handleUserSelect)(interaction);
        return;
      }

      if (route === 'stringSelect' && projectSetup?.canHandle?.(interaction.customId)) {
        await requireComponentHandler(projectSetup.handleStringSelect)(interaction);
        return;
      }

      if (route === 'stringSelect' && profiles?.canHandle?.(interaction.customId)) {
        await requireComponentHandler(profiles.handleStringSelect)(interaction);
        return;
      }

      if (route === 'modalSubmit' && projectSetup?.canHandle?.(interaction.customId)) {
        await requireComponentHandler(projectSetup.handleModalSubmit)(interaction);
        return;
      }

      if (route === 'modalSubmit' && profiles?.canHandle?.(interaction.customId)) {
        await requireComponentHandler(profiles.handleModalSubmit)(interaction);
        return;
      }

      if (
        (route === 'button' || route === 'stringSelect') &&
        guide?.canHandle?.(interaction.customId)
      ) {
        await requireComponentHandler(guide.handleComponent)(interaction);
        return;
      }

      if (route === 'stringSelect' && onboarding?.canHandle?.(interaction.customId)) {
        await requireComponentHandler(onboarding.handleStringSelect)(interaction);
        return;
      }

      if (route === 'modalSubmit' && onboarding?.canHandle?.(interaction.customId)) {
        await requireComponentHandler(onboarding.handleModalSubmit)(interaction);
        return;
      }

      if (route !== 'unknown' && interaction.isRepliable?.()) {
        throw new UserFacingError('This interaction is no longer available.');
      }
    } catch (error) {
      if (interaction.isRepliable?.()) {
        await onError(interaction, error);
        return;
      }
      throw error;
    }
  };
}
