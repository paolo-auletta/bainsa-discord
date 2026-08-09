import { spawnSync } from 'node:child_process';

// This is a ratcheting gate. The existing suite has a large historic typing
// backlog, so builds still emit checked production code and unchecked tests.
// CI rejects any increase while typed fakes and boundary interfaces reduce it.
const MAX_TEST_DIAGNOSTICS = 288;

const result = spawnSync(
  process.execPath,
  [
    'node_modules/typescript/bin/tsc',
    '--project',
    'tsconfig.test.json',
    '--noEmit',
    '--noCheck',
    'false',
    '--pretty',
    'false',
  ],
  { cwd: process.cwd(), encoding: 'utf8' },
);

if (result.error) throw result.error;

const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
const diagnostics = output.match(/^test\/.*error TS\d+:/gm) ?? [];
const nonTestDiagnostics = (output.match(/^.+\(\d+,\d+\): error TS\d+:/gm) ?? [])
  .filter((diagnostic) => !diagnostic.startsWith('test/'));
if (result.status === 0) {
  console.log('Test TypeScript check is clean.');
  process.exit(0);
}

if (nonTestDiagnostics.length > 0 || diagnostics.length > MAX_TEST_DIAGNOSTICS || diagnostics.length === 0) {
  process.stderr.write(output);
  throw new Error(
    nonTestDiagnostics.length > 0
      ? 'The test TypeScript check failed outside the tracked test-diagnostic baseline.'
      : diagnostics.length === 0
      ? 'The test TypeScript check failed outside the tracked test-diagnostic baseline.'
      : `Test TypeScript diagnostics increased from ${MAX_TEST_DIAGNOSTICS} to ${diagnostics.length}.`,
  );
}

console.log(
  `Test TypeScript diagnostic baseline: ${diagnostics.length}/${MAX_TEST_DIAGNOSTICS}. `
  + 'Do not increase it; reduce it as test fakes are typed.',
);
