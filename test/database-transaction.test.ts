import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { projectPath } from '../src/project-paths.js';

test('application transactions explicitly use READ COMMITTED isolation', async () => {
  const source = await readFile(projectPath('src', 'db.ts'), 'utf8');

  assert.match(source, /await client\.query\('BEGIN ISOLATION LEVEL READ COMMITTED'\)/);
});
