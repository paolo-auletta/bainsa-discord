import { existsSync } from 'node:fs';
import { dirname, join, parse } from 'node:path';
import { fileURLToPath } from 'node:url';

export function findProjectRoot(startUrl: string | URL = import.meta.url): string {
  let directory = dirname(fileURLToPath(startUrl));
  const filesystemRoot = parse(directory).root;

  while (directory !== filesystemRoot) {
    if (existsSync(join(directory, 'package.json'))) return directory;
    directory = dirname(directory);
  }

  throw new Error('Could not locate the project root from the current module.');
}

export function projectPath(...segments: string[]): string {
  return join(findProjectRoot(), ...segments);
}
