import { redactCommandOutput } from '../../../scripts/fixture/command-output.ts';
import { applyQaSqlMigrations } from '../../../scripts/qa/bootstrap.ts';
import { runQaAdmissionChildAsync } from '../../../scripts/qa/stack-startup.ts';
import { schemaFiles } from '../../../scripts/qa/schema-files.ts';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { composeProcessEnvironment, projectName, readEnv, stackDirectory,
  type StackOptions } from '../../../scripts/dev/config.ts';
import { loadDockerEnvironment } from '../../../scripts/load/docker-env.ts';
import { preserveReapEnvironment } from '../../../scripts/qa/container-reaper.ts';
import { fusekiImageFromCompose } from '../../../scripts/load/image.ts';
import type { FusekiStateRunner } from '../../../scripts/operations/search-state.ts';
import { FusekiClient } from '../../../services/main/src/infrastructure/fuseki.ts';
import { scriptCommand } from '../../../scripts/dev/commands.ts';

export const root = resolve(import.meta.dir, '../../..');

export function requireFaultTier(): { runId: string; artifacts: string } {
  if (!Bun.env.REZICS_QA_RUN_ID || !Bun.env.REZICS_QA_ARTIFACT_DIR) {
    throw new Error('Run through the isolated fault/recovery QA tier');
  }
  return { runId: Bun.env.REZICS_QA_RUN_ID, artifacts: Bun.env.REZICS_QA_ARTIFACT_DIR };
}

export async function rootCommand(args: string[], timeout: number): Promise<string> {
  const result = await runQaAdmissionChildAsync(root, ...scriptCommand(args), timeout);
  if (result.status !== 0 || result.error) {
    throw new Error(`yarn ${args[0]} failed: ${redactCommandOutput(result.stderr || result.stdout || result.error?.message || '').slice(-4000)}`);
  }
  return result.stdout;
}

/** A root command that must fail; returns its combined output. */
export async function refusedRootCommand(args: string[], timeout: number): Promise<string> {
  const result = await runQaAdmissionChildAsync(root, ...scriptCommand(args), timeout);
  if (result.status === 0) throw new Error(`yarn ${args[0]} unexpectedly succeeded`);
  return redactCommandOutput(`${result.stdout}${result.stderr}`);
}

/** Runs a root command without blocking, so a test can probe the API meanwhile. */
export async function backgroundRootCommand(args: string[]): Promise<string> {
  const result = await runQaAdmissionChildAsync(root, ...scriptCommand(args), 420_000);
  if (!result.ok) throw new Error(`yarn ${args[0]} failed: ${redactCommandOutput(result.output).slice(-4000)}`);
  return result.stdout;
}

export function lastJson<T>(output: string): T {
  return JSON.parse(output.trim().split(/\r?\n/).at(-1) ?? '') as T;
}

export async function migrateAccess(url: string): Promise<void> {
  await applyQaSqlMigrations(url, join(root, 'services/main/migrations/access'), schemaFiles(root, 'access'));
}

export function pinnedImage(): string {
  return fusekiImageFromCompose(readFileSync(join(root, 'infra/dev/compose.yaml'), 'utf8')).image;
}

export interface QaStack {
  options: StackOptions;
  args: string[];
  directory: string;
  apps: Record<string, string>;
  composeEnv: Record<string, string>;
  dockerEnv: NodeJS.ProcessEnv;
  project: string;
  stateVolume: string;
  compose(args: string[], timeout?: number): { status: number | null; output: string };
  /** Same runner. Private stdin stays off argv so one argument cannot exceed the spawn limit. */
  runner: FusekiStateRunner & {
    offline(script: string, privateInput?: string): string;
  };
  fuseki: FusekiClient;
}

/** Spawn evidence only: no environment, no private command bytes. */
export function boundedComposeFailure(command: string, result: {
  status?: number | null; signal?: NodeJS.Signals | null;
  error?: NodeJS.ErrnoException | null; output?: string | null;
}, privateBytes?: number): string {
  const status = result.status ?? null;
  const signal = result.signal ?? null;
  const code = result.error?.code ?? null;
  const detail = redactCommandSecrets(result.error?.message ?? '').slice(0, 200);
  const output = redactCommandSecrets(result.output ?? '').slice(-2000);
  const bytes = privateBytes === undefined ? '' : ` privateBytes=${privateBytes}`;
  const tail = [detail, output].filter(part => part.length > 0).join(': ');
  return `docker compose ${command} failed: status=${status === null ? 'null' : status} signal=${signal ?? 'null'} error=${code ?? 'null'}${bytes}${tail ? ` ${tail}` : ''}`;
}

function redactCommandSecrets(text: string): string {
  return redactCommandOutput(text);
}

export function qaStack(runId: string): QaStack {
  const options: StackOptions = { profile: 'qa', runId, persistent: true };
  const args = ['--profile', 'qa', '--run-id', runId, '--persistent'];
  const directory = stackDirectory(root, options);
  const dockerEnv = loadDockerEnvironment();
  const project = projectName(options);
  const compose = (commandArgs: string[], timeout = 180_000, privateInput?: string) => {
    const saved = readEnv(join(directory, 'compose.env'));
    const result = spawnSync('docker', ['compose', '--env-file', join(directory, 'compose.env'),
      '-f', join(root, 'infra/dev/compose.yaml'), '--project-name', project, ...commandArgs],
    { cwd: root, env: composeProcessEnvironment(dockerEnv, saved), encoding: 'utf8', timeout,
      maxBuffer: 10_000_000, ...(privateInput !== undefined ? { input: privateInput } : {}) });
    return { status: result.status, signal: result.signal,
      error: result.error as NodeJS.ErrnoException | undefined,
      output: redactCommandOutput(`${result.stdout ?? ''}${result.stderr ?? ''}`) };
  };
  const ok = (commandArgs: string[], timeout?: number, privateInput?: string) => {
    const result = compose(commandArgs, timeout, privateInput);
    if (result.error || result.status !== 0) {
      throw new Error(boundedComposeFailure(commandArgs[0] ?? 'compose', result,
        privateInput === undefined ? undefined : Buffer.byteLength(privateInput)));
    }
    return result.output;
  };
  const stack = { options, args, directory, dockerEnv, project, stateVolume: `${project}_fuseki_data`,
    compose: (commandArgs: string[], timeout?: number) => {
      const result = compose(commandArgs, timeout);
      return { status: result.status ?? null, output: result.output };
    },
    runner: {
      exec: script => ok(['exec', '-T', 'fuseki', 'sh', '-ec', script]),
      // -i is only for private stdin. One argv above 131072 bytes is E2BIG
      // before Compose creates a container, with empty stdout and stderr.
      offline: (script: string, privateInput?: string) => ok(['run', '--rm', '--no-deps',
        ...(privateInput !== undefined ? ['-i'] : []),
        '-T', '--entrypoint', 'sh', 'fuseki', '-ec', script], 300_000, privateInput),
      stop: () => { ok(['stop', 'fuseki']); },
      start: () => { ok(['up', '-d', '--wait', 'fuseki']); },
      container: () => ok(['ps', '-q', '--no-trunc', 'fuseki']).trim(),
    } } as Omit<QaStack, 'apps' | 'composeEnv' | 'fuseki'>;
  return Object.defineProperties(stack, {
    apps: { get: () => readEnv(join(directory, 'apps.env')) },
    composeEnv: { get: () => readEnv(join(directory, 'compose.env')) },
    fuseki: { get: () => {
      const apps = readEnv(join(directory, 'apps.env'));
      return new FusekiClient(apps.FUSEKI_URL!, apps.FUSEKI_MAINTENANCE_TOKEN!, apps.FUSEKI_COMMAND_TOKEN!);
    } },
  }) as QaStack;
}

export async function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const server = createServer();
    server.once('error', fail);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => typeof address === 'object' && address ? done(address.port) : fail(new Error('no port')));
    });
  });
}

export async function waitForFuseki(url: string, timeoutMs = 90_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const response = await fetch(new URL('query', url), { method: 'POST',
        headers: { 'content-type': 'application/sparql-query', accept: 'application/sparql-results+json' },
        body: 'ASK {}', signal: AbortSignal.timeout(2_000) });
      if (response.ok) return;
    } catch { /* starting */ }
    if (Date.now() > deadline) throw new Error(`Fuseki at ${url} did not become ready`);
    await Bun.sleep(250);
  }
}

export interface StandaloneFuseki {
  name: string;
  url: string;
  runner: FusekiStateRunner;
  remove(): void;
}

export interface StandaloneDockerResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: NodeJS.ErrnoException;
}

export type StandaloneDockerExecutor = (args: string[], env: NodeJS.ProcessEnv,
  timeout: number) => StandaloneDockerResult;

/** Injectable process boundary for lifecycle tests; production uses the real Docker CLI. */
export interface StandaloneFusekiDependencies {
  docker?: StandaloneDockerExecutor;
  waitForReady?: (url: string) => Promise<void>;
  artifactDir?: string;
  now?: () => number;
}

const STOP_CLIENT_TIMEOUT_MS = 90_000;
const STOP_DIAGNOSTIC_DEADLINE_MS = 5_000;
const REMOVE_TIMEOUT_MS = 60_000;

const runStandaloneDocker: StandaloneDockerExecutor = (args, env, timeout) => spawnSync('docker', args,
  { env, encoding: 'utf8', timeout, maxBuffer: 10_000_000 });

function dockerFailure(args: string[], result: StandaloneDockerResult): Error {
  const detail = result.stderr || result.stdout || result.error?.message || '';
  return new Error(`docker ${args[0]} failed: ${detail.trim().slice(-2000)}`);
}

function dockerOutput(execute: StandaloneDockerExecutor, args: string[], env: NodeJS.ProcessEnv,
  timeout: number): string {
  const result = execute(args, env, timeout);
  if (result.error || result.status !== 0) throw dockerFailure(args, result);
  return `${result.stdout}${result.stderr}`;
}

function redactDiagnostic(text: string, secrets: string[]): string {
  let result = redactCommandOutput(text);
  for (const secret of secrets) {
    if (secret.length >= 4) result = result.replaceAll(secret, '[redacted]');
  }
  return result;
}

function artifactName(container: string): string {
  const safe = container.replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 100) || 'container';
  return `standalone-fuseki-stop-${safe}.json`;
}

function writeStopArtifact(artifactDir: string | undefined, container: string, record: unknown): void {
  console.info('standalone Fuseki stop', record && typeof record === 'object'
    ? { container, durationMs: (record as { durationMs?: number }).durationMs,
      succeeded: (record as { succeeded?: boolean }).succeeded }
    : { container });
  if (!artifactDir) return;
  try {
    writeFileSync(join(artifactDir, artifactName(container)), `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  } catch (error) {
    console.warn('could not write standalone Fuseki stop artifact', {
      container, error: redactCommandOutput(error instanceof Error ? error.message : String(error)).slice(0, 300),
    });
  }
}

function captureStopFailure(execute: StandaloneDockerExecutor, env: NodeJS.ProcessEnv, container: string,
  secrets: string[], now: () => number): Record<string, unknown> {
  const startedAt = now();
  const deadline = startedAt + STOP_DIAGNOSTIC_DEADLINE_MS;
  const evidence: Record<string, unknown> = {
    deadlineMs: STOP_DIAGNOSTIC_DEADLINE_MS,
    stateFields: null,
    engineVersion: null,
    processes: null,
    logTail: null,
    errors: [] as string[],
  };
  const errors = evidence.errors as string[];
  const capture = (field: string, args: string[], limit: number) => {
    const remaining = Math.floor(deadline - now());
    if (remaining <= 0) return;
    try {
      const output = dockerOutput(execute, args, env, remaining);
      evidence[field] = redactDiagnostic(output, secrets).slice(-limit);
    } catch (error) {
      errors.push(redactDiagnostic(error instanceof Error ? error.message : String(error), secrets).slice(-500));
    }
  };

  capture('stateFields', ['inspect', '--type', 'container', '--format',
    '{{.State.Status}}|{{.State.Running}}|{{.State.Paused}}|{{.State.Restarting}}|{{.State.OOMKilled}}|{{.State.Dead}}|{{.State.ExitCode}}|{{.State.Pid}}|{{.State.StartedAt}}|{{.State.FinishedAt}}',
    container], 1_000);
  capture('engineVersion', ['version', '--format', '{{.Server.Version}}'], 200);
  capture('processes', ['exec', container, 'sh', '-ec', 'ps -eo comm=,state=,wchan='], 3_000);
  capture('logTail', ['logs', '--tail', '80', container], 8_000);
  evidence.elapsedMs = Math.max(0, Math.round(now() - startedAt));
  evidence.deadlineReached = evidence.elapsedMs >= STOP_DIAGNOSTIC_DEADLINE_MS;
  return evidence;
}

function isVerifiedAbsent(result: StandaloneDockerResult, container: string): boolean {
  if (result.error || result.status === null || result.status === 0) return false;
  const name = container.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`No such (?:object|container):\\s*${name}(?:\\s|$)`).test(`${result.stderr}\n${result.stdout}`);
}

/** One loopback-only pinned Fuseki container on a named state volume; never routed. */
export async function standaloneFuseki(env: NodeJS.ProcessEnv, input: { name: string; image: string;
  volume: string; secrets: Record<string, string>; mounts?: string[]; command?: string[] },
dependencies: StandaloneFusekiDependencies = {}): Promise<StandaloneFuseki> {
  const port = await freePort();
  const url = `http://127.0.0.1:${port}/rezics/`;
  const owned = preserveReapEnvironment(env);
  const execute = dependencies.docker ?? runStandaloneDocker;
  const waitForReady = dependencies.waitForReady ?? waitForFuseki;
  const now = dependencies.now ?? (() => performance.now());
  const artifacts = dependencies.artifactDir ?? process.env.REZICS_QA_ARTIFACT_DIR;
  const secrets = Object.values(input.secrets);
  dockerOutput(execute, ['run', '-d', '--name', input.name, '--stop-timeout=60',
    '--publish', `127.0.0.1:${port}:3030`,
    '--volume', `${input.volume}:/fuseki/databases`,
    ...(input.mounts ?? []).flatMap(mount => ['--volume', mount]),
    ...Object.entries(input.secrets).flatMap(([key, value]) => ['--env', `${key}=${value}`]),
    input.image, ...(input.command ?? [])], owned, 60_000);
  await waitForReady(url);
  return { name: input.name, url,
    runner: {
      exec: script => dockerOutput(execute, ['exec', input.name, 'sh', '-ec', script], owned, 120_000),
      offline: script => dockerOutput(execute, ['run', '--rm', '--network', 'none', '--volume', `${input.volume}:/fuseki/databases`,
        ...(input.mounts ?? []).flatMap(mount => ['--volume', mount]),
        '--entrypoint', 'sh', input.image, '-ec', script], owned, 300_000),
      stop: () => {
        const started = now();
        try {
          dockerOutput(execute, ['stop', input.name], owned, STOP_CLIENT_TIMEOUT_MS);
          writeStopArtifact(artifacts, input.name, { container: input.name,
            durationMs: Math.max(0, Math.round(now() - started)), succeeded: true });
        } catch (error) {
          let durationMs = 0;
          let diagnostics: Record<string, unknown> | null = null;
          try {
            durationMs = Math.max(0, Math.round(now() - started));
            diagnostics = captureStopFailure(execute, owned, input.name, secrets, now);
            writeStopArtifact(artifacts, input.name, { container: input.name, durationMs, succeeded: false,
              error: redactDiagnostic(error instanceof Error ? error.message : String(error), secrets).slice(-2_000),
              diagnostics });
          } catch { /* evidence collection must preserve the stop failure */ }
          throw error;
        }
      },
      start: async () => { dockerOutput(execute, ['start', input.name], owned, 60_000); await waitForReady(url); },
      container: () => dockerOutput(execute, ['ps', '-q', '--no-trunc', '--filter', `name=^${input.name}$`], owned, 10_000).trim(),
    },
    remove: () => {
      try {
        dockerOutput(execute, ['rm', '-f', input.name], owned, REMOVE_TIMEOUT_MS);
      } catch (error) {
        try {
          const result = execute(['inspect', '--type', 'container', '--format', '{{.Id}}', input.name], owned, 5_000);
          if (isVerifiedAbsent(result, input.name)) return;
        } catch { /* inspection could not verify absence; report the original removal failure */ }
        throw error;
      }
    },
  };
}

export function fusekiSecrets(composeEnv: Record<string, string>): Record<string, string> {
  return Object.fromEntries(['FUSEKI_MAINTENANCE_TOKEN', 'FUSEKI_COMMAND_TOKEN', 'FUSEKI_TITLE_ADMISSION_KEY']
    .map(key => [key, composeEnv[key]!]));
}
