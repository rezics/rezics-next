import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';

const EXECUTABLE_TYPESCRIPT = /\.(?:ts|tsx|mts|cts)$/i;
const DECLARATION_TYPESCRIPT = /\.d\.(?:ts|tsx|mts|cts)$/i;

export type LandingTranspileDiagnostic = {
  file: string | null;
  line: number | null;
  column: number | null;
  message: string;
};

export type LandingTranspileResult = {
  outcome: 'skipped' | 'passed' | 'diagnostic' | 'unavailable';
  base: string;
  candidate: string;
  changedFileCount: number;
  typescriptFileCount: number;
  typescriptFiles: string[];
  /** Null means no compiler measurement was available; a measured zero remains zero. */
  elapsedMs: number | null;
  logPath: string;
  diagnostic?: LandingTranspileDiagnostic;
  output?: string;
  infrastructureError?: string;
};

export class LandingTranspileInterruptedError extends Error {
  constructor(readonly signal: NodeJS.Signals) {
    super(`dev landing transpile interrupted by ${signal}`);
    this.name = 'LandingTranspileInterruptedError';
  }
}

function diagnosticFrom(output: string): LandingTranspileDiagnostic | undefined {
  const message = output.match(/^\s*error:\s*(.+)$/m)?.[1]?.trim();
  if (!message) return undefined;
  const location = output.match(/^\s*(?:at\s+)?((?:[A-Za-z]:)?[^\n\r]*?\.(?:tsx?|mts|cts)):(\d+):(\d+)\s*$/im);
  return {
    file: location?.[1] ?? null,
    line: location ? Number(location[2]) : null,
    column: location ? Number(location[3]) : null,
    message,
  };
}

function runBuild(
  cwd: string,
  args: string[],
): Promise<{ status: number | null; output: string; error?: Error; signal?: NodeJS.Signals }> {
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
      if (interrupted) rejectBuild(new LandingTranspileInterruptedError(interrupted));
      else resolveBuild({ status, output, ...(error ? { error } : {}) });
    });
  });
}

/** Transpile only executable TypeScript files changed by this exact candidate, without traversing dependencies. */
export async function transpileLandingCandidate(input: {
  cwd: string;
  base: string;
  candidate: string;
  changedFiles: readonly string[];
  logPath: string;
}): Promise<LandingTranspileResult> {
  const cwd = resolve(input.cwd);
  const logPath = resolve(input.logPath);
  const changedFileCount = input.changedFiles.length;
  const typescriptFiles = input.changedFiles.filter((path) => {
    if (!EXECUTABLE_TYPESCRIPT.test(path) || DECLARATION_TYPESCRIPT.test(path)) return false;
    const absolute = resolve(cwd, path);
    return existsSync(absolute) && statSync(absolute).isFile();
  });
  const result = (
    outcome: LandingTranspileResult['outcome'],
    elapsedMs: number | null,
    extra: Partial<LandingTranspileResult> = {},
  ): LandingTranspileResult => ({
    outcome,
    base: input.base,
    candidate: input.candidate,
    changedFileCount,
    typescriptFileCount: typescriptFiles.length,
    typescriptFiles: [...typescriptFiles],
    elapsedMs,
    logPath,
    ...extra,
  });
  if (!typescriptFiles.length) return result('skipped', null);

  const tempRoot = join(cwd, '.temp');
  mkdirSync(tempRoot, { recursive: true });
  const outdir = mkdtempSync(join(tempRoot, 'dev-transpile-'));
  let build: Awaited<ReturnType<typeof runBuild>>;
  let started = performance.now();
  try {
    const args = [
      'build',
      '--no-bundle',
      '--target=bun',
      `--root=${cwd}`,
      `--outdir=${outdir}`,
      ...typescriptFiles.map((path) => resolve(cwd, path)),
    ];
    mkdirSync(dirname(logPath), { recursive: true });
    appendFileSync(
      logPath,
      `\nDev landing transpile candidate=${input.candidate} base=${input.base} changedFiles=${changedFileCount} typescriptFiles=${typescriptFiles.length}\n$ ${JSON.stringify([process.execPath, ...args])}\n`,
    );
    started = performance.now();
    build = await runBuild(cwd, args);
  } finally {
    rmSync(outdir, { recursive: true, force: true });
  }
  const elapsedMs = Math.round(performance.now() - started);
  const output = build.output;
  appendFileSync(logPath, `${output}${output.endsWith('\n') || !output ? '' : '\n'}`);
  if (build.error) {
    appendFileSync(logPath, `Bun command unavailable: ${build.error.message}\n`);
    return result('unavailable', null, { output, infrastructureError: build.error.message });
  }
  if (build.status === 0) {
    appendFileSync(logPath, `Dev landing transpile passed in ${elapsedMs}ms\n`);
    return result('passed', elapsedMs, { output });
  }
  const diagnostic = diagnosticFrom(output);
  if (diagnostic) {
    if (diagnostic.file && !isAbsolute(diagnostic.file)) diagnostic.file = resolve(cwd, diagnostic.file);
    appendFileSync(logPath, `Dev landing transpile diagnostic: ${JSON.stringify(diagnostic)}\n`);
    return result('diagnostic', elapsedMs, { diagnostic, output });
  }
  const infrastructureError = `Bun exited ${build.status ?? 'without a status'} without a TypeScript diagnostic`;
  appendFileSync(logPath, `Dev landing transpile unavailable: ${infrastructureError}\n`);
  return result('unavailable', null, { output, infrastructureError });
}
