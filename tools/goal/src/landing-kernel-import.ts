import { spawn, type ChildProcess } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { matchesPath } from './briefs.ts';
import { ensureDerivedDependencies } from './candidate.ts';
import { LandingTranspileInterruptedError, type LandingTranspileDiagnostic } from './landing-transpile.ts';

/** Any change under Kernel source, including SQL, triggers one candidate-scoped import of both entries. */
export const KERNEL_SRC_PATHS = ['services/kernel/src/**'];
export const KERNEL_IMPORT_ENTRIES = ['services/kernel/src/server.ts', 'services/kernel/src/worker.ts'] as const;

export type LandingKernelImportDiagnostic = LandingTranspileDiagnostic & { entry: string };

export type LandingKernelImportResult = {
  outcome: 'skipped' | 'passed' | 'diagnostic' | 'unavailable';
  base: string;
  candidate: string;
  changedFileCount: number;
  kernelFileCount: number;
  kernelFiles: string[];
  entries: string[];
  /** Null means that phase was not measured; a measured zero remains zero. */
  setupMs: number | null;
  importMs: number | null;
  cleanupMs: number | null;
  elapsedMs: number | null;
  logPath: string;
  argv: string[];
  diagnostic?: LandingKernelImportDiagnostic;
  output?: string;
  infrastructureError?: string;
};

type DriverResult = {
  outcome: 'passed' | 'diagnostic' | 'unavailable';
  setupMs: number;
  importMs: number;
  cleanupMs: number;
  entry?: string;
  diagnostic?: LandingTranspileDiagnostic;
  infrastructureError?: string;
  argv: string[];
  output: string;
};

function diagnosticFrom(output: string): LandingTranspileDiagnostic | undefined {
  const message =
    output.match(/^\s*error:\s*(.+)$/m)?.[1]?.trim() ??
    output.match(/Cannot access '[^']+' before initialization/)?.[0] ??
    output
      .split('\n')
      .map((line) => line.trim())
      .find((line) => /\b(error|mismatch|does not exist|not exist|query key)\b/i.test(line));
  if (!message) return undefined;
  const location = output.match(/^\s*(?:at\s+)?((?:[A-Za-z]:)?[^\n\r]*?\.(?:tsx?|mts|cts|sql)):(\d+)(?::(\d+))?\s*$/im);
  return {
    file: location?.[1] ?? null,
    line: location ? Number(location[2]) : null,
    column: location?.[3] ? Number(location[3]) : null,
    message,
  };
}

export function kernelSourceChanged(changedFiles: readonly string[]): string[] {
  return changedFiles.filter((path) => matchesPath(path, KERNEL_SRC_PATHS));
}

function resolveReyloRegister(cwd: string): string | undefined {
  for (const path of [
    join(cwd, 'services/kernel/node_modules/reylo/src/register.js'),
    join(cwd, 'node_modules/reylo/src/register.js'),
  ])
    if (existsSync(path)) return path;
  return undefined;
}

function driverSource(input: {
  derivedPath: string;
  importerPath: string;
  resultPath: string;
  entries: readonly string[];
  cwd: string;
  preload?: string | undefined;
}): string {
  return `import { spawn } from 'node:child_process';
import { appendFileSync, writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { withThrowawayDatabase } from ${JSON.stringify(input.derivedPath)};

const entries = ${JSON.stringify(input.entries)};
const importer = ${JSON.stringify(input.importerPath)};
const resultPath = ${JSON.stringify(input.resultPath)};
const cwd = ${JSON.stringify(input.cwd)};
const preload = ${JSON.stringify(input.preload ?? null)};
const bun = process.execPath;
const children = new Set();
const killChildren = () => {
  for (const child of children) {
    try {
      child.kill('SIGKILL');
    } catch {}
  }
};
process.on('SIGINT', killChildren);
process.on('SIGTERM', killChildren);

function runEntry(entry, env) {
  return new Promise((resolveRun, rejectRun) => {
    const args = preload ? ['--preload', preload, importer, entry] : [importer, entry];
    const child = spawn(bun, args, {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.add(child);
    let output = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => (output += chunk));
    child.stderr.setEncoding('utf8').on('data', (chunk) => (output += chunk));
    child.once('error', (error) => {
      children.delete(child);
      rejectRun(error);
    });
    child.once('close', (status, signal) => {
      children.delete(child);
      resolveRun({ status, signal, output, argv: [bun, ...args] });
    });
  });
}

const started = performance.now();
let setupMs = 0;
let importMs = 0;
let cleanupStarted = 0;
let output = '';
const writeResult = (result) => {
  writeFileSync(resultPath, JSON.stringify({ ...result, output, argv: result.argv ?? [bun] }));
};

try {
  await withThrowawayDatabase(async (env) => {
    setupMs = Math.round(performance.now() - started);
    if (!env.DATABASE_URL) throw new Error('Throwaway DATABASE_URL is missing before Kernel entry import');
    const importEnv = { ...env, DATABASE_URL: env.DATABASE_URL };
    for (const relative of entries) {
      const entry = cwd + '/' + relative;
      const importStarted = performance.now();
      const run = await runEntry(entry, importEnv);
      importMs += Math.round(performance.now() - importStarted);
      output += run.output;
      if (run.output && !run.output.endsWith('\\n')) output += '\\n';
      if (run.status !== 0) {
        cleanupStarted = performance.now();
        writeResult({
          outcome: 'diagnostic',
          setupMs,
          importMs,
          cleanupMs: 0,
          entry: relative,
          argv: run.argv,
        });
        process.exitCode = 1;
        return;
      }
    }
    cleanupStarted = performance.now();
    writeResult({
      outcome: 'passed',
      setupMs,
      importMs,
      cleanupMs: 0,
      argv: [bun, importer, ...entries],
    });
  });
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  output += message + '\\n';
  writeResult({
    outcome: 'unavailable',
    setupMs,
    importMs,
    cleanupMs: 0,
    infrastructureError: message,
    argv: [bun],
  });
  process.exitCode = 2;
} finally {
  const cleanupMs = cleanupStarted ? Math.round(performance.now() - cleanupStarted) : 0;
  try {
    const current = JSON.parse(readFileSync(resultPath, 'utf8'));
    current.cleanupMs = cleanupMs;
    writeFileSync(resultPath, JSON.stringify(current));
  } catch {}
}
`;
}

function importerSource(): string {
  return `const entry = process.argv[2];
if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is missing before Kernel entry import');
  process.exit(2);
}
console.error(
  'kernel-import entry=' +
    entry +
    ' pid=' +
    process.pid +
    ' import.meta.main=' +
    import.meta.main +
    ' database=' +
    process.env.DATABASE_URL,
);
await import(entry);
`;
}

function runDriver(
  cwd: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<{ status: number | null; output: string; error?: Error; signal?: NodeJS.Signals }> {
  return new Promise((resolveRun, rejectRun) => {
    const child: ChildProcess = spawn(process.execPath, args, {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    let error: Error | undefined;
    let interrupted: NodeJS.Signals | undefined;
    const onSignal = (signal: NodeJS.Signals) => {
      interrupted ??= signal;
      child.kill('SIGTERM');
    };
    const onInterrupt = () => onSignal('SIGINT');
    const onTerminate = () => onSignal('SIGTERM');
    process.once('SIGINT', onInterrupt);
    process.once('SIGTERM', onTerminate);
    child.stdout?.setEncoding('utf8').on('data', (chunk: string) => (output += chunk));
    child.stderr?.setEncoding('utf8').on('data', (chunk: string) => (output += chunk));
    child.once('error', (cause) => {
      error = cause;
    });
    child.once('close', (status) => {
      process.removeListener('SIGINT', onInterrupt);
      process.removeListener('SIGTERM', onTerminate);
      if (interrupted) rejectRun(new LandingTranspileInterruptedError(interrupted));
      else resolveRun({ status, output, ...(error ? { error } : {}) });
    });
  });
}

/** Import both Kernel entries against one migrated throwaway database when this candidate changed Kernel source. */
export async function importLandingKernelCandidate(input: {
  cwd: string;
  base: string;
  candidate: string;
  changedFiles: readonly string[];
  logPath: string;
}): Promise<LandingKernelImportResult> {
  const cwd = resolve(input.cwd);
  const logPath = resolve(input.logPath);
  const kernelFiles = kernelSourceChanged(input.changedFiles);
  const entries = [...KERNEL_IMPORT_ENTRIES];
  const result = (
    outcome: LandingKernelImportResult['outcome'],
    times: Pick<LandingKernelImportResult, 'setupMs' | 'importMs' | 'cleanupMs' | 'elapsedMs'>,
    extra: Partial<LandingKernelImportResult> = {},
  ): LandingKernelImportResult => ({
    outcome,
    base: input.base,
    candidate: input.candidate,
    changedFileCount: input.changedFiles.length,
    kernelFileCount: kernelFiles.length,
    kernelFiles: [...kernelFiles],
    entries,
    argv: extra.argv ?? [],
    logPath,
    ...times,
    ...extra,
  });
  const unmeasured = { setupMs: null, importMs: null, cleanupMs: null, elapsedMs: null };
  if (!kernelFiles.length) return result('skipped', unmeasured);

  const derivedPath = join(cwd, 'services/kernel/scripts/derived.ts');
  if (!existsSync(derivedPath)) {
    mkdirSync(dirname(logPath), { recursive: true });
    const infrastructureError = `Kernel throwaway-database seam is missing: ${derivedPath}`;
    appendFileSync(logPath, `Dev landing Kernel import unavailable: ${infrastructureError}\n`);
    return result('unavailable', unmeasured, { infrastructureError, argv: [process.execPath] });
  }

  ensureDerivedDependencies(cwd, logPath, [['bun', 'services/kernel/src/server.ts']]);
  const tempRoot = join(cwd, '.temp');
  mkdirSync(tempRoot, { recursive: true });
  const workdir = mkdtempSync(join(tempRoot, 'dev-kernel-import-'));
  const driverPath = join(workdir, 'driver.ts');
  const importerPath = join(workdir, 'importer.ts');
  const resultPath = join(workdir, 'result.json');
  const argv = [process.execPath, driverPath];
  mkdirSync(dirname(logPath), { recursive: true });
  appendFileSync(
    logPath,
    `\nDev landing Kernel import candidate=${input.candidate} base=${input.base} kernelFiles=${kernelFiles.length}\n$ ${JSON.stringify(argv)}\n`,
  );
  const { DATABASE_URL: _inheritedUrl, KERNEL_DATABASE_CONTAINER: _inheritedContainer, ...driverEnv } = process.env;
  let driver: Awaited<ReturnType<typeof runDriver>> | undefined;
  let parsed: DriverResult | undefined;
  const phaseStarted = performance.now();
  try {
    writeFileSync(
      driverPath,
      driverSource({
        derivedPath,
        importerPath,
        resultPath,
        entries,
        cwd,
        preload: resolveReyloRegister(cwd),
      }),
    );
    writeFileSync(importerPath, importerSource());
    driver = await runDriver(cwd, [driverPath], driverEnv);
    try {
      parsed = JSON.parse(readFileSync(resultPath, 'utf8')) as DriverResult;
    } catch {
      parsed = undefined;
    }
  } finally {
    // Owned driver files go away; the landing log is the retained diagnostic.
    rmSync(workdir, { recursive: true, force: true });
  }
  const wallMs = Math.round(performance.now() - phaseStarted);
  const output = `${driver?.output ?? ''}${parsed?.output ?? ''}`;
  appendFileSync(logPath, `${output}${output.endsWith('\n') || !output ? '' : '\n'}`);
  if (driver?.error) {
    appendFileSync(logPath, `Bun command unavailable: ${driver.error.message}\n`);
    return result('unavailable', unmeasured, {
      output,
      infrastructureError: driver.error.message,
      argv,
    });
  }
  const setupMs = parsed?.setupMs ?? null;
  const importMs = parsed?.importMs ?? null;
  const cleanupMs = parsed?.cleanupMs ?? null;
  const elapsedMs =
    setupMs !== null && importMs !== null && cleanupMs !== null ? setupMs + importMs + cleanupMs : wallMs;
  const times = { setupMs, importMs, cleanupMs, elapsedMs };
  if (!parsed) {
    const infrastructureError = `Kernel import driver exited ${driver?.status ?? 'without a status'} without a result`;
    appendFileSync(logPath, `Dev landing Kernel import unavailable: ${infrastructureError}\n`);
    return result(
      'unavailable',
      { setupMs: null, importMs: null, cleanupMs: null, elapsedMs: null },
      {
        output,
        infrastructureError,
        argv,
      },
    );
  }
  appendFileSync(
    logPath,
    `Dev landing Kernel import ${parsed.outcome} setup=${setupMs}ms import=${importMs}ms cleanup=${cleanupMs}ms total=${elapsedMs}ms\n`,
  );
  if (parsed.outcome === 'passed') return result('passed', times, { output: parsed.output, argv: parsed.argv });
  if (parsed.outcome === 'unavailable') {
    appendFileSync(logPath, `Dev landing Kernel import unavailable: ${parsed.infrastructureError ?? 'unknown'}\n`);
    return result(
      'unavailable',
      { setupMs: null, importMs: null, cleanupMs: null, elapsedMs: null },
      {
        output: parsed.output,
        infrastructureError: parsed.infrastructureError ?? 'unknown',
        argv: parsed.argv,
      },
    );
  }
  const diagnostic = parsed.diagnostic ?? diagnosticFrom(parsed.output);
  if (!diagnostic) {
    const infrastructureError = `Kernel import failed without a source diagnostic`;
    appendFileSync(logPath, `Dev landing Kernel import unavailable: ${infrastructureError}\n`);
    return result(
      'unavailable',
      { setupMs: null, importMs: null, cleanupMs: null, elapsedMs: null },
      {
        output: parsed.output,
        infrastructureError,
        argv: parsed.argv,
      },
    );
  }
  if (diagnostic.file && !isAbsolute(diagnostic.file)) diagnostic.file = resolve(cwd, diagnostic.file);
  const located: LandingKernelImportDiagnostic = { ...diagnostic, entry: parsed.entry ?? entries[0]! };
  appendFileSync(logPath, `Dev landing Kernel import diagnostic: ${JSON.stringify(located)}\n`);
  return result('diagnostic', times, { diagnostic: located, output: parsed.output, argv: parsed.argv });
}
