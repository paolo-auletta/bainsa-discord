import { execFileSync, spawnSync } from 'node:child_process';

const files = execFileSync('git', ['ls-files', '--', 'src', 'scripts'], {
  encoding: 'utf8'
})
  .split('\n')
  .filter((file) => file.endsWith('.mjs'));

const failedFiles = files.filter((file) => {
  const result = spawnSync(process.execPath, ['--check', file], {
    stdio: 'inherit'
  });

  return result.status !== 0;
});

if (failedFiles.length > 0) {
  console.error(`Syntax check failed for: ${failedFiles.join(', ')}`);
  process.exit(1);
}
