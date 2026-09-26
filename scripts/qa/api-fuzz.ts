import { spawn, type ChildProcess } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { readEnv } from '../dev/config.ts';
import { hostLoopbackAccess, loadDockerEnvironment } from '../load/docker-env.ts';
import { command, newRunId } from './core.ts';

// Schema-driven API fuzzing of Main's generated public OpenAPI contract against an
// isolated QA stack. Unauthenticated: it covers public operations fully and the
// validation and rejection responses of protected ones.

export const schemathesisImage = 'docker.io/schemathesis/schemathesis:4.28.0@sha256:'
  + '0a71757c60ccdba270c154a859d9dd3d019625f782f23ab36ad604771e15f78b';
export const baselinePath = 'tests/qa/api-fuzz/baseline.json';
const specPath = 'generated/openapi/main/public.json';
// Undocumented-status and acceptance checks need authenticated state; see the harness page.
export const checks = ['not_a_server_error', 'status_code_conformance', 'content_type_conformance',
  'response_headers_conformance', 'response_schema_conformance'];

export interface FuzzOptions { maxExamples: number; seed?: number; maxTime?: number;
  updateBaseline: boolean; keep: boolean }

export function parseFuzzArgs(args: string[]): FuzzOptions {
  const options: FuzzOptions = { maxExamples: 10, updateBaseline: false, keep: false };
  for (let i = 0; i < args.length; i++) {
    const value = args[i + 1];
    const integer = (min: number, max: number) => {
      if (!value || !/^\d+$/.test(value) || Number(value) < min || Number(value) > max) {
        throw new Error(`${args[i]} expects an integer from ${min} to ${max}`);
      }
      i++;
      return Number(value);
    };
    if (args[i] === '--max-examples') options.maxExamples = integer(1, 200);
    else if (args[i] === '--seed') options.seed = integer(0, 2 ** 31 - 1);
    else if (args[i] === '--max-time') options.maxTime = integer(30, 1800);
    else if (args[i] === '--update-baseline') options.updateBaseline = true;
    else if (args[i] === '--keep') options.keep = true;
    else throw new Error(`Unsupported api:fuzz option: ${args[i]}`);
  }
  if (options.maxTime !== undefined && options.seed === undefined) {
    throw new Error('--max-time repeats an exploratory run; add --seed');
  }
  if (options.updateBaseline && options.seed !== undefined) {
    throw new Error('--update-baseline records one deterministic pass only; omit --seed');
  }
  return options;
}

// Deterministic generation keeps baseline comparisons stable; --seed opts into an
// exploratory random run whose seed reproduces it. --max-time repeats fuzzing and
// stateful phases until the budget is spent, so the default is one pass.
export function schemathesisArgs(options: FuzzOptions, baseUrl: string): string[] {
  return ['run', '/spec/public.json', '--url', baseUrl, '--checks', checks.join(','),
    ...(options.seed === undefined ? ['--generation-deterministic'] : ['--seed', String(options.seed)]),
    '--max-examples', String(options.maxExamples),
    ...(options.maxTime === undefined ? [] : ['--max-time', String(options.maxTime)]),
    // Strict identifier patterns make Hypothesis discard most drafts for a few
    // operations; that is intended, so the health check must not abort them.
    '--suppress-health-check', 'filter_too_much',
    '--workers', '1', '--request-timeout', '10', '--no-color',
    // JUnit holds each failure's response and curl reproduction; NDJSON event
    // streams exceed 100 MB per pass.
    '--report', 'junit', '--report-dir', '/artifacts',
    '--baseline', '/baseline/baseline.json',
    ...(options.updateBaseline ? ['--baseline-update', '--baseline-prune'] : [])];
}

export function fuzzTimeoutSeconds(options: FuzzOptions): number {
  return (options.maxTime ?? 900) + 120;
}

async function waitReady(url: string, name: string, child: ChildProcess): Promise<void> {
  const until = Date.now() + 60_000;
  while (Date.now() < until && child.exitCode === null) {
    try {
      if ((await fetch(url, { signal: AbortSignal.timeout(2_000) })).ok) return;
    } catch { /* still starting */ }
    await Bun.sleep(250);
  }
  throw new Error(`${name} did not become ready; see its log in the run directory`);
}

if (import.meta.main) {
  const root = resolve(import.meta.dir, '../..');
  const options = parseFuzzArgs(process.argv.slice(2));
  const runId = `fuzz-${newRunId()}`.slice(0, 31);
  const directory = join(root, '.artifacts', 'api-fuzz', runId);
  mkdirSync(directory, { recursive: true });
  const children: ChildProcess[] = [];
  let exitCode = 1;
  try {
    const up = command(root, 'corepack', ['yarn', 'stack:up', '--profile', 'qa', '--run-id', runId], 180_000);
    writeFileSync(join(directory, 'stack.log'), up.output);
    if (!up.ok) throw new Error('QA stack startup failed; see stack.log');
    const stackDir = join(root, '.temp', 'stack', `rezics-qa-${runId}`);
    const apps = readEnv(join(stackDir, 'apps.env'));
    const appsPath = join(stackDir, 'qa-apps.json');
    const composePath = join(stackDir, 'qa-compose.json');
    writeFileSync(appsPath, JSON.stringify(apps), { mode: 0o600 });
    writeFileSync(composePath, JSON.stringify(readEnv(join(stackDir, 'compose.env'))), { mode: 0o600 });
    const bootstrap = command(root, 'bun', ['scripts/qa/bootstrap.ts', appsPath, composePath], 180_000);
    writeFileSync(join(directory, 'bootstrap.log'), bootstrap.output);
    if (!bootstrap.ok) throw new Error('QA bootstrap failed; see bootstrap.log');
    for (const [name, entry, port] of [['account', 'services/account/src/index.ts', apps.ACCOUNT_PORT],
      ['main', 'services/main/src/index.ts', apps.MAIN_PORT]] as const) {
      const log = openSync(join(directory, `${name}.log`), 'w');
      const child = spawn('bun', [entry], { cwd: root, env: { ...process.env, ...apps }, stdio: ['ignore', log, log] });
      closeSync(log);
      children.push(child);
      await waitReady(`http://127.0.0.1:${port}/health/ready`, name, child);
    }
    const baselineDir = join(root, 'tests/qa/api-fuzz');
    mkdirSync(baselineDir, { recursive: true });
    if (!options.updateBaseline && !existsSync(join(root, baselinePath))) {
      throw new Error(`Missing ${baselinePath}; create it with yarn api:fuzz --update-baseline`);
    }
    const log = openSync(join(directory, 'schemathesis.log'), 'w');
    const dockerEnv = loadDockerEnvironment();
    const access = hostLoopbackAccess(dockerEnv);
    const container = `rezics-api-fuzz-${runId}`;
    const fuzz = spawn('docker', ['run', '--rm', '--name', container, ...access.args, '--user', '0:0',
      '--volume', `${join(root, specPath)}:/spec/public.json:ro,Z`,
      '--volume', `${baselineDir}:/baseline:Z`, '--volume', `${directory}:/artifacts:Z`,
      schemathesisImage, ...schemathesisArgs(options, `http://${access.host}:${apps.MAIN_PORT}`)],
    { cwd: root, env: dockerEnv, stdio: ['ignore', log, log] });
    closeSync(log);
    // A single pass finishes in minutes; the guard bounds a hung API or container.
    const guard = setTimeout(() => {
      console.error(`Schemathesis exceeded ${fuzzTimeoutSeconds(options)} seconds; stopping ${container}`);
      spawn('docker', ['kill', container], { env: dockerEnv, stdio: 'ignore' });
    }, fuzzTimeoutSeconds(options) * 1000);
    exitCode = await new Promise<number>(done => fuzz.once('exit', code => done(code ?? 1)));
    clearTimeout(guard);
    const output = readFileSync(join(directory, 'schemathesis.log'), 'utf8');
    // The tail holds Schemathesis's own failure and summary sections.
    console.log(output.split('\n').slice(-40).join('\n'));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
  } finally {
    for (const child of children) child.kill('SIGTERM');
    if (!options.keep) {
      const reset = command(root, 'corepack', ['yarn', 'stack:reset', '--profile', 'qa', '--run-id', runId], 120_000);
      if (!reset.ok) console.error(`QA stack cleanup failed: ${runId}`);
    }
    console.log(`API fuzz artifacts: ${directory}`);
  }
  process.exit(exitCode);
}
