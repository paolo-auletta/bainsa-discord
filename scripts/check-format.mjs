import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const files = execFileSync('git', ['ls-files', '--', 'src', 'scripts', 'test'], {
  encoding: 'utf8'
})
  .split('\n')
  .filter((file) => file.endsWith('.mjs'));

const failures = files.flatMap((file) => {
  const source = readFileSync(file, 'utf8');
  const issues = [];

  if (source.includes('\r')) {
    issues.push('must use LF line endings');
  }
  if (!source.endsWith('\n')) {
    issues.push('must end with a newline');
  }
  if (/\t/.test(source)) {
    issues.push('must use spaces instead of tab characters');
  }
  if (/[ \t]+$/m.test(source)) {
    issues.push('must not contain trailing whitespace');
  }

  return issues.map((issue) => `${file}: ${issue}`);
});

if (failures.length > 0) {
  console.error(failures.join('\n'));
  process.exit(1);
}
