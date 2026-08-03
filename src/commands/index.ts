import { governanceCommands } from './governance/index.js';
import { guideCommand } from './guide/index.js';
import { projectCommands } from './projects/index.js';
import { assertUniqueCommandNames } from '../runtime/command-registry.js';

export const commands = assertUniqueCommandNames([
  guideCommand,
  ...governanceCommands,
  ...projectCommands,
]);
