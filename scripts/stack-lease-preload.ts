import { readFileSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { acquireStackSlot } from './stack-lease.ts';
import { runOnCheckHost, testKeepsFiles } from './stack-run.ts';

const root = resolve(import.meta.dir, '..');
const waitFileKey = Symbol.for('rezics.goal-check-wait-file');
const hostsFileKey = Symbol.for('rezics.check-hosts-file');
const waitFileHandoff = globalThis as typeof globalThis & Record<symbol, unknown>;
const goalCheckWaitFile = waitFileHandoff[waitFileKey] as string | undefined;
const checkHostsFile = waitFileHandoff[hostsFileKey] as string | undefined;
delete waitFileHandoff[waitFileKey];
delete waitFileHandoff[hostsFileKey];

const requiredValueOptions = new Set([
  '--timeout',
  '--rerun-each',
  '--retry',
  '--seed',
  '--coverage-reporter',
  '--coverage-dir',
  '-t',
  '--test-name-pattern',
  '--reporter',
  '--reporter-outfile',
  '--max-concurrency',
  '--path-ignore-patterns',
  '--shard',
  '--timings',
]);

function testArguments(): string[] {
  // Bun sets process.argv to the first test file, while /proc preserves the full `bun test` invocation.
  try {
    const args = readFileSync('/proc/self/cmdline', 'utf8').split('\0').filter(Boolean);
    const command = args.indexOf('test');
    if (command !== -1) return args.slice(command + 1);
  } catch {
    // Use Bun's test-file argv below if procfs is unavailable.
  }

  return process.argv.length > 2 ? process.argv.slice(2) : process.argv.slice(1);
}

function testFileFilters(args: string[]): string[] {
  const filters: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const argument = args[index]!;
    if (argument === '--') {
      filters.push(...args.slice(index + 1));
      break;
    }
    if (!argument.startsWith('-')) {
      filters.push(argument);
      continue;
    }
    if (argument.includes('=')) continue;
    if (requiredValueOptions.has(argument)) {
      index++;
      continue;
    }
    if (argument === '--changed') {
      if (args[index + 1] && !args[index + 1]!.startsWith('-')) index++;
      continue;
    }
    if ((argument === '--bail' || argument === '--parallel') && /^\d+$/.test(args[index + 1] ?? '')) {
      index++;
    }
  }
  return filters;
}

function includesSpecs(filters: string[]): boolean {
  if (filters.length === 0) return true;
  return filters.some((filter) => /(?:^|[/\\])specs(?:[/\\]|$)/.test(filter));
}

/**
 * The invocation as a host runs it: file arguments inside the checkout become relative to the working directory, and
 * null when one lies outside it, where a host has no such file.
 */
function hostInvocation(args: string[]): string[] | null {
  const rewritten: string[] = [];
  for (const argument of args) {
    if (!isAbsolute(argument)) {
      rewritten.push(argument);
      continue;
    }
    const inside = relative(root, argument);
    if (inside === '..' || inside.startsWith('../') || isAbsolute(inside)) return null;
    rewritten.push(relative(process.cwd(), argument));
  }
  return rewritten;
}

if (includesSpecs(testFileFilters(testArguments()))) {
  // The preload cannot move its own process, so it re-runs the whole invocation on a host and exits with its code. A
  // run whose working directory is under the check host's run root stays here.
  const args = testArguments();
  const forHost = hostInvocation(args);
  if (goalCheckWaitFile !== undefined) process.env.GOAL_CHECK_WAIT_FILE = goalCheckWaitFile;
  if (checkHostsFile !== undefined) process.env.KERNEL_CHECK_REMOTE = checkHostsFile;
  let code: number | null;
  try {
    code = await runOnCheckHost({
      label: 'root bun test',
      root,
      cwd: process.cwd(),
      command: ['bun', 'test', ...(forHost ?? [])],
      keepsFiles: forHost === null || testKeepsFiles(args),
    });
  } finally {
    delete process.env.GOAL_CHECK_WAIT_FILE;
    delete process.env.KERNEL_CHECK_REMOTE;
  }
  if (code !== null) process.exit(code);
  const slot = await acquireStackSlot('root bun test', {
    ...process.env,
    ...(goalCheckWaitFile === undefined ? {} : { GOAL_CHECK_WAIT_FILE: goalCheckWaitFile }),
  });
  if (slot.env.REZICS_STACK_SLOT !== undefined) {
    process.env.REZICS_STACK_SLOT = slot.env.REZICS_STACK_SLOT;
  }
}
