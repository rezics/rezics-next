import { redactCommandOutput } from '../../../scripts/fixture/command-output.ts';
import { runQaAdmissionChildAsync } from '../../../scripts/qa/stack-startup.ts';
import { schemaFiles } from '../../../scripts/qa/schema-files.ts';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { Client } from 'pg';
import { composeProcessEnvironment, projectName, readEnv, stackDirectory,
  type StackOptions } from '../../../scripts/dev/config.ts';
import { loadDockerEnvironment } from '../../../scripts/load/docker-env.ts';
import { fusekiImageFromCompose } from '../../../scripts/load/image.ts';
import { docker, type FusekiStateRunner } from '../../../scripts/operations/search-state.ts';
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
  const db = new Client({ connectionString: url });
  await db.connect();
  try {
    const directory = join(root, 'services/main/migrations/access');
    for (const file of schemaFiles(root, 'access')) {
      await db.query(readFileSync(join(directory, file), 'utf8'));
    }
  } finally { await db.end(); }
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

/** One loopback-only pinned Fuseki container on a named state volume; never routed. */
export async function standaloneFuseki(env: NodeJS.ProcessEnv, input: { name: string; image: string;
  volume: string; secrets: Record<string, string>; mounts?: string[]; command?: string[] }): Promise<StandaloneFuseki> {
  const port = await freePort();
  const url = `http://127.0.0.1:${port}/rezics/`;
  docker(['run', '-d', '--name', input.name, '--publish', `127.0.0.1:${port}:3030`,
    '--volume', `${input.volume}:/fuseki/databases`,
    ...(input.mounts ?? []).flatMap(mount => ['--volume', mount]),
    ...Object.entries(input.secrets).flatMap(([key, value]) => ['--env', `${key}=${value}`]),
    input.image, ...(input.command ?? [])], env, 60_000);
  await waitForFuseki(url);
  return { name: input.name, url,
    runner: {
      exec: script => docker(['exec', input.name, 'sh', '-ec', script], env),
      offline: script => docker(['run', '--rm', '--network', 'none', '--volume', `${input.volume}:/fuseki/databases`,
        ...(input.mounts ?? []).flatMap(mount => ['--volume', mount]),
        '--entrypoint', 'sh', input.image, '-ec', script], env, 300_000),
      stop: () => { docker(['stop', input.name], env, 60_000); },
      start: async () => { docker(['start', input.name], env, 60_000); await waitForFuseki(url); },
      container: () => docker(['ps', '-q', '--no-trunc', '--filter', `name=^${input.name}$`], env, 10_000).trim(),
    },
    remove: () => { spawnSync('docker', ['rm', '-f', input.name], { env, timeout: 60_000 }); },
  };
}

export function fusekiSecrets(composeEnv: Record<string, string>): Record<string, string> {
  return Object.fromEntries(['FUSEKI_MAINTENANCE_TOKEN', 'FUSEKI_COMMAND_TOKEN', 'FUSEKI_TITLE_ADMISSION_KEY']
    .map(key => [key, composeEnv[key]!]));
}
