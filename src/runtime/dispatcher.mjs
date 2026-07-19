import { handleInteractionError } from '../discord/reply.mjs';
import { UserFacingError } from '../errors.mjs';
import { assertNoBotCommandTarget } from '../authorization.mjs';
import { assertBotCommandChannel } from './command-channels.mjs';
import { buildCommandMap } from './command-registry.mjs';

export function routeInteraction(interaction) {
  if (interaction.isChatInputCommand?.()) return 'chatInput';
  if (interaction.isAutocomplete?.()) return 'autocomplete';
  if (interaction.isButton?.()) return 'button';
  if (interaction.isStringSelectMenu?.()) return 'stringSelect';
  if (interaction.isModalSubmit?.()) return 'modalSubmit';
  return 'unknown';
}

export function createInteractionDispatcher({
  commands,
  onboarding,
  onError = handleInteractionError,
} = {}) {
  const commandMap = buildCommandMap(commands ?? []);

  return async function dispatchInteraction(interaction) {
    try {
      const route = routeInteraction(interaction);

      if (route === 'chatInput') {
        const command = commandMap.get(interaction.commandName);
        if (!command) throw new UserFacingError(`Unknown command: ${interaction.commandName}`);
        assertBotCommandChannel(interaction);
        assertNoBotCommandTarget(interaction);
        await command.execute(interaction);
        return;
      }

      if (route === 'autocomplete') {
        const command = commandMap.get(interaction.commandName);
        if (!command?.autocomplete) return interaction.respond([]);
        await command.autocomplete(interaction);
        return;
      }

      if (route === 'button' && onboarding?.canHandle?.(interaction.customId)) {
        await onboarding.handleButton(interaction);
        return;
      }

      if (route === 'stringSelect' && onboarding?.canHandle?.(interaction.customId)) {
        await onboarding.handleStringSelect(interaction);
        return;
      }

      if (route === 'modalSubmit' && onboarding?.canHandle?.(interaction.customId)) {
        await onboarding.handleModalSubmit(interaction);
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
