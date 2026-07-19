import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

test('syntax check rejects a broken tracked file after a valid one', () => {
  const directory = mkdtempSync(join(tmpdir(), 'bainsa-syntax-check-'));

  try {
    execFileSync('git', ['init', '--quiet', directory]);
    const syntaxCheck = readFileSync(new URL('../scripts/check-syntax.mjs', import.meta.url));

    mkdirSync(join(directory, 'scripts'));
    mkdirSync(join(directory, 'src'));
    writeFileSync(join(directory, 'scripts', 'check-syntax.mjs'), syntaxCheck, { flag: 'w' });
    writeFileSync(join(directory, 'src', 'valid.mjs'), "export const valid = true;\n", { flag: 'w' });
    writeFileSync(join(directory, 'scripts', 'broken.mjs'), 'export const broken = ;\n', { flag: 'w' });
    execFileSync('git', ['add', 'scripts', 'src'], { cwd: directory });

    const result = spawnSync(process.execPath, ['scripts/check-syntax.mjs'], {
      cwd: directory,
      encoding: 'utf8'
    });

    assert.notEqual(result.status, 0);
    assert.match(`${result.stderr}${result.stdout}`, /scripts\/broken\.mjs/);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});
