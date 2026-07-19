import { governanceCommands } from './governance/index.mjs';
import { projectCommands } from './projects/index.mjs';
import { assertUniqueCommandNames } from '../runtime/command-registry.mjs';

export const commands = assertUniqueCommandNames([
  ...governanceCommands,
  ...projectCommands,
]);
