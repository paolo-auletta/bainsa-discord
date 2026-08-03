#!/usr/bin/env node

import { spawn, type ChildProcess } from 'node:child_process';
import { constants as osConstants } from 'node:os';

const children: ChildProcess[] = [];
let shuttingDown = false;
let shutdownInitiator: ChildProcess | null = null;
let bot: ChildProcess | null = null;

function exitCodeForSignal(signal: NodeJS.Signals): number {
  return 128 + (osConstants.signals[signal] ?? 1);
}

function start(command: string, args: string[]): ChildProcess {
  const child = spawn(command, args, {
    env: process.env,
    stdio: 'inherit',
  });
  children.push(child);
  return child;
}

function stop(signal: NodeJS.Signals, initiator: ChildProcess | null = null): void {
  if (shuttingDown) return;
  shuttingDown = true;
  shutdownInitiator = initiator;
  for (const child of children) child.kill(signal);
}

function monitor(child: ChildProcess): void {
  child.once('exit', (code, signal) => {
    if (!shuttingDown) stop('SIGTERM', child);
    if (shutdownInitiator !== child) return;
    if (signal) process.exitCode = exitCodeForSignal(signal);
    else process.exitCode = code ?? 1;
  });
}

// Let the compiler finish its initial emit before starting Node's watcher.
// Otherwise that emit changes dist/src/bot.js while Discord login is still in
// flight and forces an immediate, racy restart of the bot.
const compiler = spawn(process.execPath, [
  'node_modules/typescript/bin/tsc',
  '--project',
  'tsconfig.test.json',
  '--watch',
  '--preserveWatchOutput',
  '--pretty',
  'false',
], {
  env: process.env,
  stdio: ['inherit', 'pipe', 'pipe'],
});
children.push(compiler);
monitor(compiler);

let compilerOutput = '';
compiler.stdout.setEncoding('utf8');
compiler.stdout.on('data', (chunk: string) => {
  process.stdout.write(chunk);
  compilerOutput = `${compilerOutput}${chunk}`.slice(-4096);
  if (!bot && !shuttingDown && compilerOutput.includes('Found 0 errors. Watching for file changes.')) {
    bot = start(process.execPath, [
      '--enable-source-maps',
      '--env-file=.env',
      '--watch',
      'dist/src/bot.js',
    ]);
    monitor(bot);
  }
});
compiler.stderr.pipe(process.stderr);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    if (shuttingDown) return;
    stop(signal);
    process.kill(process.pid, signal);
  });
}
