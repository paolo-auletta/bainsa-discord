import { execFileSync, spawnSync } from 'node:child_process';

const files = execFileSync('git', ['ls-files', '--', 'src', 'scripts'], {
  encoding: 'utf8'
})
  .split('\n')
  .filter((file) => file.endsWith('.mjs'));

const result = spawnSync(process.execPath, ['--check', ...files], {
  stdio: 'inherit'
});

process.exit(result.status ?? 1);
