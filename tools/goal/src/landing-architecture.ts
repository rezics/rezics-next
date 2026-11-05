import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';

export type LandingArchitectureResult = {
  outcome: 'passed' | 'diagnostic' | 'unavailable';
  base: string;
  candidate: string;
  changedFileCount: number;
  elapsedMs: number | null;
  logPath: string;
  diagnostics: string[];
  output?: string;
  infrastructureError?: string;
};

export class LandingArchitectureInterruptedError extends Error {
  constructor(readonly signal: NodeJS.Signals) {
    super(`Dev landing architecture check interrupted by ${signal}`);
    this.name = 'LandingArchitectureInterruptedError';
  }
}

type ProcessResult = { status: number | null; output: string; error?: Error };

function runBun(cwd: string, args: string[]): Promise<ProcessResult> {
  return new Promise((resolveBuild, rejectBuild) => {
    const child = spawn(process.execPath, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    let error: Error | undefined;
    let interrupted: NodeJS.Signals | undefined;
    const onSignal = (signal: NodeJS.Signals) => {
      interrupted ??= signal;
      child.kill('SIGKILL');
    };
    const onInterrupt = () => onSignal('SIGINT');
    const onTerminate = () => onSignal('SIGTERM');
    process.once('SIGINT', onInterrupt);
    process.once('SIGTERM', onTerminate);
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => (output += chunk));
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (output += chunk));
    child.once('error', (cause) => {
      error = cause;
    });
    child.once('close', (status) => {
      process.removeListener('SIGINT', onInterrupt);
      process.removeListener('SIGTERM', onTerminate);
      if (interrupted) rejectBuild(new LandingArchitectureInterruptedError(interrupted));
      else resolveBuild({ status, output, ...(error ? { error } : {}) });
    });
  });
}

/** Check the exact composed candidate against its captured base in one architecture-script invocation. */
export async function checkLandingArchitectureCandidate(input: {
  cwd: string;
  base: string;
  candidate: string;
  changedFiles: readonly string[];
  logPath: string;
}): Promise<LandingArchitectureResult> {
  const cwd = resolve(input.cwd);
  const logPath = resolve(input.logPath);
  const changedFileCount = input.changedFiles.length;
  const scriptPath = resolve(cwd, 'scripts/architecture.ts');
  const args = [scriptPath, '--changed', input.base];
  const result = (
    outcome: LandingArchitectureResult['outcome'],
    elapsedMs: number | null,
    extra: Partial<LandingArchitectureResult> = {},
  ): LandingArchitectureResult => ({
    outcome,
    base: input.base,
    candidate: input.candidate,
    changedFileCount,
    elapsedMs,
    logPath,
    diagnostics: [],
    ...extra,
  });
  if (!existsSync(scriptPath))
    return result('unavailable', null, { infrastructureError: `Architecture checker is missing: ${scriptPath}` });

  mkdirSync(dirname(logPath), { recursive: true });
  appendFileSync(
    logPath,
    `\nDev landing architecture candidate=${input.candidate} base=${input.base} changedFiles=${changedFileCount}\n$ ${JSON.stringify([process.execPath, ...args])}\n`,
  );
  const started = performance.now();
  const build = await runBun(cwd, args);
  const elapsedMs = Math.round(performance.now() - started);
  appendFileSync(logPath, `${build.output}${build.output.endsWith('\n') || !build.output ? '' : '\n'}`);
  if (build.error) {
    const infrastructureError = build.error.message;
    appendFileSync(logPath, `Dev landing architecture unavailable: ${infrastructureError}\n`);
    return result('unavailable', null, { output: build.output, infrastructureError });
  }
  if (build.status === 0) {
    appendFileSync(logPath, `Dev landing architecture passed in ${elapsedMs}ms\n`);
    return result('passed', elapsedMs, { output: build.output });
  }
  if (build.status === 1) {
    const diagnostics = build.output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('Boundary baseline can shrink'));
    appendFileSync(logPath, `Dev landing architecture diagnostic (${diagnostics.length} lines)\n`);
    return result('diagnostic', elapsedMs, {
      diagnostics,
      output: build.output,
    });
  }
  const infrastructureError = `Architecture checker exited ${build.status ?? 'without a status'}`;
  appendFileSync(logPath, `Dev landing architecture unavailable: ${infrastructureError}\n`);
  return result('unavailable', null, { output: build.output, infrastructureError });
}
