#!/usr/bin/env bun
import { join } from 'node:path';

// Run from the candidate checkout, including its lockfile and dependencies, rather than the controller checkout.
const cwd = join(process.cwd(), 'tools/goal');
for (const command of [['bun', 'install', '--frozen-lockfile'], ['bun', 'run', 'check']]) {
  const child = Bun.spawn(command, { cwd, stdin: 'ignore', stdout: 'inherit', stderr: 'inherit' });
  const code = await child.exited;
  if (code !== 0) process.exit(code);
}
