import { qaMemoryDeadline } from './memory-admission.ts';
import { commandAsync } from './core.ts';

function startupChildContext(env: NodeJS.ProcessEnv, workTimeout: number, started: number) {
  if (env.REZICS_STACK_PROFILE !== undefined && env.REZICS_STACK_PROFILE !== 'qa')
    return { env, timeout: workTimeout };
  const deadline = qaMemoryDeadline(env);
  return { env: { ...env, REZICS_QA_MEMORY_DEADLINE: String(deadline), REZICS_QA_MEMORY_EVENTS: '1' },
    timeout: Math.max(1, deadline - started) + workTimeout };
}

/** The child bounds Compose readiness after admission; its parent must allow both. */
export async function runQaStartupChildAsync(root: string, args: string[], workTimeout: number,
  env: NodeJS.ProcessEnv = process.env, onOutputLine?: (line: string) => void) {
  const context = startupChildContext(env, workTimeout, Date.now());
  // Clone's work budget also covers copying. Pause it for admission rather than
  // enlarging it to the run deadline; stack:up bounds readiness in its child.
  const cloneDeadline = args[0] === 'stack:clone' && context.env.REZICS_QA_MEMORY_EVENTS === '1'
    ? qaMemoryDeadline(context.env) : undefined;
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
