#!/usr/bin/env node

import { spawn, type ChildProcess } from 'node:child_process';

const children: ChildProcess[] = [];
let shuttingDown = false;

function start(command: string, args: string[]): ChildProcess {
  const child = spawn(command, args, {
    env: process.env,
    stdio: 'inherit',
  });
  children.push(child);
  return child;
}

function stop(signal: NodeJS.Signals): void {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) child.kill(signal);
}

const compiler = start(process.execPath, [
  'node_modules/typescript/bin/tsc',
  '--project',
  'tsconfig.test.json',
  '--watch',
  '--preserveWatchOutput',
]);

const bot = start(process.execPath, [
  '--enable-source-maps',
  '--env-file=.env',
  '--watch',
  'dist/src/bot.js',
]);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => stop(signal));
}

for (const child of [compiler, bot]) {
  child.once('exit', (code, signal) => {
    if (!shuttingDown) stop('SIGTERM');
    if (signal) process.kill(process.pid, signal);
    else process.exitCode = code ?? 1;
  });
}
