import { FusekiClient } from '../../services/main/src/infrastructure/fuseki.ts';
import { qaMemoryDeadline } from './memory-admission.ts';
import { commandAsync } from './core.ts';

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
        input.root, 'docker', ['logs', '--tail', '40', container], 15_000, input.environment,
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
export function qaStartupTestTimeout(activeMs: number, env: NodeJS.ProcessEnv = process.env): number {
  if (env.REZICS_STACK_PROFILE !== undefined && env.REZICS_STACK_PROFILE !== 'qa') return activeMs;
  return Math.max(activeMs, qaMemoryDeadline(env) - Date.now());
}

/** Indirect startup scripts must stream admission and retain their active work budget. */
export async function runQaAdmissionChildAsync(root: string, program: string, args: string[],
  workTimeout: number, env: NodeJS.ProcessEnv = process.env, onOutputLine?: (line: string) => void) {
  const context = startupChildContext(env, workTimeout, Date.now());
  const result = await commandAsync(root, program, args, workTimeout, context.env,
    onOutputLine, { runDeadline: context.deadline });
  return { ...result, stdout: result.output, stderr: '', status: result.ok ? 0 : 1,
    error: result.timedOut ? new Error('QA admission child timed out') : undefined };
}

function startupChildContext(env: NodeJS.ProcessEnv, workTimeout: number, started: number) {
  if (env.REZICS_STACK_PROFILE !== undefined && env.REZICS_STACK_PROFILE !== 'qa')
    return { env, timeout: workTimeout, deadline: undefined };
  const deadline = qaMemoryDeadline(env);
  return { env: { ...env, REZICS_QA_MEMORY_DEADLINE: String(deadline), REZICS_QA_MEMORY_EVENTS: '1' },
    timeout: Math.max(1, deadline - started) + workTimeout, deadline };
}

/** The child bounds Compose readiness after admission; its parent must allow both. */
export async function runQaStartupChildAsync(root: string, args: string[], workTimeout: number,
  env: NodeJS.ProcessEnv = process.env, onOutputLine?: (line: string) => void) {
  const context = startupChildContext(env, workTimeout, Date.now());
  // Clone's work budget also covers copying. Pause it for admission rather than
  // enlarging it to the run deadline; stack:up bounds readiness in its child.
  const cloneDeadline = args[0] === 'stack:clone' ? context.deadline : undefined;
  const result = await commandAsync(root, 'bun', ['scripts/dev/cli.ts', ...args],
    cloneDeadline === undefined ? context.timeout : workTimeout,
    context.env, onOutputLine, { runDeadline: cloneDeadline });
  const admissionWaitMs = admissionWaitDuration(result.output);
  return { ...result, admissionWaitMs, activeElapsedMs: result.elapsedMs - admissionWaitMs,
    stdout: result.output, stderr: '', status: result.ok ? 0 : 1,
    error: result.timedOut ? new Error('QA startup child timed out') : undefined };
}

export function admissionWaitDuration(output: string): number {
  const tokens = new Map<string, number>();
  for (const match of output.matchAll(/^QA_MEMORY_WAIT_END (\S+) (\d+)$/gm))
    tokens.set(match[1]!, Number(match[2]));
  return [...tokens.values()].reduce((total, duration) => total + duration, 0);
}
