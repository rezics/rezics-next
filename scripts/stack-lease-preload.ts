import { readFileSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import {
  includesSpecs,
  invocationKey,
  readRunEstimates,
  recordEstimate,
  runEstimatesDirectory,
} from './run-estimates.ts';
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

const args = testArguments();
if (includesSpecs(args)) {
  // The preload cannot move its own process, so it re-runs the whole invocation on a host and exits with its code. A
  // run whose working directory is under the check host's run root stays here.
  const forHost = hostInvocation(args);
  const estimateDirectory = runEstimatesDirectory(root, process.env.REZICS_TEST_ESTIMATES_DIR);
  const invocation = invocationKey(root, process.cwd(), args);
  const previousEstimates = estimateDirectory === null ? [] : readRunEstimates(estimateDirectory);
  const estimateMs = previousEstimates.find((entry) => entry.invocation === invocation)?.heldMs;
  if (goalCheckWaitFile !== undefined) process.env.GOAL_CHECK_WAIT_FILE = goalCheckWaitFile;
  if (checkHostsFile !== undefined) process.env.KERNEL_CHECK_REMOTE = checkHostsFile;
  let code: number | null;
  let remoteStarted: number | undefined;
  try {
    code = await runOnCheckHost({
      label: 'root bun test',
      root,
      cwd: process.cwd(),
      command: ['bun', 'test', ...(forHost ?? [])],
      ...(estimateMs === undefined ? {} : { estimateMs }),
      started: () => {
        remoteStarted = performance.now();
      },
      keepsFiles: forHost === null || testKeepsFiles(args),
    });
  } finally {
    if (estimateDirectory !== null && invocation !== null && remoteStarted !== undefined) {
      recordEstimate(
        estimateDirectory,
        invocation,
        Math.max(0, Math.round(performance.now() - remoteStarted)),
        new Date(),
        previousEstimates,
      );
    }
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
  if (estimateDirectory !== null && invocation !== null) {
    const localStarted = performance.now();
    process.once('exit', () => {
      recordEstimate(
        estimateDirectory,
        invocation,
        Math.max(0, Math.round(performance.now() - localStarted)),
        new Date(),
        previousEstimates,
      );
    });
  }
}
