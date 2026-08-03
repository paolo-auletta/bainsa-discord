export interface CommandDefinition {
  name?: string;
  data?: {
    name?: string;
    toJSON?: () => { name?: string };
  };
  toJSON?: () => { name?: string };
  execute: (interaction: unknown) => unknown;
  autocomplete?: (interaction: unknown) => unknown;
}

function resolveCommandJSON(command: CommandDefinition) {
  if (command?.data?.toJSON) return command.data.toJSON();
  if (command?.toJSON) return command.toJSON();
  if (command?.data) return command.data;
  return command;
}

export function getCommandName(command: CommandDefinition) {
  return resolveCommandJSON(command)?.name;
}

export function commandToJSON(command: CommandDefinition) {
  return resolveCommandJSON(command);
}

export function buildCommandMap<T extends CommandDefinition>(commands: readonly T[]) {
  const map = new Map<string, T>();

  for (const command of commands) {
    const name = getCommandName(command);
    if (!name) throw new Error('Every command must expose a name.');
    if (map.has(name)) throw new Error(`Duplicate slash command name: ${name}`);
    map.set(name, command);
  }

  return map;
}

export function assertUniqueCommandNames<T extends CommandDefinition>(commands: readonly T[]) {
  buildCommandMap(commands);
  return commands;
}

export function serializeCommands<T extends CommandDefinition>(commands: readonly T[]) {
  assertUniqueCommandNames(commands);
  return commands.map(commandToJSON);
}
