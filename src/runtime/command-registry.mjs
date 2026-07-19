export function getCommandName(command) {
  return command?.name ?? command?.data?.name ?? command?.data?.toJSON?.().name;
}

export function commandToJSON(command) {
  if (command?.data?.toJSON) return command.data.toJSON();
  if (command?.toJSON) return command.toJSON();
  if (command?.data) return command.data;
  return command;
}

export function buildCommandMap(commands) {
  const map = new Map();

  for (const command of commands) {
    const name = getCommandName(command);
    if (!name) throw new Error('Every command must expose a name.');
    if (map.has(name)) throw new Error(`Duplicate slash command name: ${name}`);
    map.set(name, command);
  }

  return map;
}

export function assertUniqueCommandNames(commands) {
  buildCommandMap(commands);
  return commands;
}

export function serializeCommands(commands) {
  assertUniqueCommandNames(commands);
  return commands.map(commandToJSON);
}
