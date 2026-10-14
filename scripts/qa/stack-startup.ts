import { FusekiClient } from '../../services/main/src/infrastructure/fuseki.ts';
import { qaMemoryDeadline } from './memory-admission.ts';
import { commandAsync, goalSlotDirectory } from './core.ts';
import { preserveReapEnvironment } from './container-reaper.ts';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { processAncestors } from './process/identity.ts';
import { directoryLeaseHeld, readDirectoryLease } from './process/lease.ts';

const PREPARE_BUDGET_MS = 60_000;

/** Page the Work-name directory to complete. The exclusive writer is admitted
 * in process when the fresh graph is stored, so Fuseki stays up. Main's startup
 * preparation runs before that graph exists and leaves the directory unfinished;
 * this wait still finishes it after bootstrap and after every maintenance reset. */
export async function admitIntegrationWorkScope(input: {
  root: string;
  projectRunId: string;
  fusekiUrl: string;
  maintenanceToken: string | undefined;
  environment: NodeJS.ProcessEnv;
}): Promise<{ prepareMs: number }> {
  const container = `rezics-qa-${input.projectRunId}-fuseki-1`;
  const fuseki = new FusekiClient(input.fusekiUrl, input.maintenanceToken);
  const prepareStarted = Date.now();
  const prepareDeadline = prepareStarted + PREPARE_BUDGET_MS;
  while (Date.now() < prepareDeadline) {
    const page = await fuseki.prepareWorkScopeDirectory();
    if (page.status === 'unavailable') {
      const logs = await commandAsync(
        input.root, 'docker', ['logs', '--tail', '40', container], 15_000, preserveReapEnvironment(input.environment),
      );
      throw new Error(`Work name scope writer was not admitted (${page.reason})\n${logs.output}`);
    }
    if (page.status === 'deadline') continue;
    if (page.phase === 'complete' && page.more === false) {
      const prepareMs = Date.now() - prepareStarted;
      console.log(`work-scope-admission prepareMs=${prepareMs}`);
      return { prepareMs };
    }
    if (page.phase === 'owners' && page.more === true) continue;
    throw new Error(`Work name scope preparation is unqualified (${page.status} ${page.phase})`);
  }
  throw new Error('Work name scope preparation exceeds 60 seconds');
}

/** Bun's case clock cannot pause; the enclosing runner bounds active file work. */
export function qaStartupTestTimeout(activeMs: number, env: NodeJS.ProcessEnv = process.env,
  now: () => number = Date.now): number {
  if (env.REZICS_STACK_PROFILE !== undefined && env.REZICS_STACK_PROFILE !== 'qa') return activeMs;
  return Math.max(activeMs, qaMemoryDeadline(env) - now());
}

/** Indirect startup scripts must stream admission and retain their active work budget. */
export async function runQaAdmissionChildAsync(root: string, program: string, args: string[],
  workTimeout: number, env: NodeJS.ProcessEnv = process.env, onOutputLine?: (line: string) => void,
  now: () => number = Date.now) {
  const context = startupChildContext(root, env, workTimeout, now());
  const result = await commandAsync(root, program, args, workTimeout, context.env,
    onOutputLine, { runDeadline: context.deadline, now });
  return { ...result, status: result.ok ? 0 : 1,
    error: result.timedOut ? new Error('QA admission child timed out') : undefined };
}

/** A runner snapshots its environment before obtaining its lifetime lease. A
 * later child may therefore inherit GOAL_IN_SLOT=0 despite its parent's lease.
 * Consult the existing lease owner, as acquireQaSlots does, before requesting
 * another acknowledgement through the provisional startup mailbox. */
export function startupChildEnvironment(env: NodeJS.ProcessEnv, pid = process.pid): NodeJS.ProcessEnv {
  const directory = env.GOAL_QA_SLOT_DIRECTORY;
  if (!directory) return env;
  let slots: string[];
  try { slots = readdirSync(directory).filter(name => /^\d+$/.test(name)); }
  catch { return env; }
  const lineage = new Set(processAncestors(pid));
  const inherited = slots.some(name => {
    const path = join(directory, name);
    const lease = readDirectoryLease(path);
    return lease && !lease.invalid && lineage.has(lease.pid) && directoryLeaseHeld(path);
  });
  if (!inherited) return env;
  const selected: NodeJS.ProcessEnv = { ...env, GOAL_IN_SLOT: '1' };
  delete selected.REZICS_QA_STARTUP_SLOT_GATE;
  return selected;
}

function startupChildContext(root: string, env: NodeJS.ProcessEnv, workTimeout: number, started: number) {
  if (env.REZICS_STACK_PROFILE !== undefined && env.REZICS_STACK_PROFILE !== 'qa')
    return { env, timeout: workTimeout, deadline: undefined };
  const deadline = qaMemoryDeadline(env);
  const inherited = startupChildEnvironment({ ...env,
    GOAL_QA_SLOT_DIRECTORY: env.GOAL_QA_SLOT_DIRECTORY ?? goalSlotDirectory(root) });
  return { env: { ...inherited, REZICS_QA_MEMORY_DEADLINE: String(deadline), REZICS_QA_MEMORY_EVENTS: '1' },
    timeout: Math.max(1, deadline - started) + workTimeout, deadline };
}

/** The child bounds Compose readiness after admission; its parent must allow both. */
export async function runQaStartupChildAsync(root: string, args: string[], workTimeout: number,
  env: NodeJS.ProcessEnv = process.env, onOutputLine?: (line: string) => void,
  now: () => number = Date.now) {
  const context = startupChildContext(root, env, workTimeout, now());
  // Clone's work budget also covers copying. Pause it for admission rather than
  // enlarging it to the run deadline; stack:up bounds readiness in its child.
  const cloneDeadline = args[0] === 'stack:clone' ? context.deadline : undefined;
  const result = await commandAsync(root, 'bun', ['scripts/dev/cli.ts', ...args],
    cloneDeadline === undefined ? context.timeout : workTimeout,
    context.env, onOutputLine, { runDeadline: cloneDeadline, now });
  const admissionWaitMs = admissionWaitDuration(result.output);
  return { ...result, admissionWaitMs, activeElapsedMs: result.elapsedMs - admissionWaitMs,
    status: result.ok ? 0 : 1,
    error: result.timedOut ? new Error('QA startup child timed out') : undefined };
}

export function admissionWaitDuration(output: string): number {
  const tokens = new Map<string, number>();
  for (const match of output.matchAll(/^QA_MEMORY_WAIT_END (\S+) (\d+)$/gm))
    tokens.set(match[1]!, Number(match[2]));
  return [...tokens.values()].reduce((total, duration) => total + duration, 0);
}
