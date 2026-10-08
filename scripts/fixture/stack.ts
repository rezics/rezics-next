import { spawn, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { devPorts } from '../dev/config.ts';
import { createCommandOutputRedactor, redactCommandOutput } from './command-output.ts';
import { loadDockerEnvironment } from '../load/docker-env.ts';
import { fusekiImageFromCompose } from '../load/image.ts';

export const root = resolve(import.meta.dir, '../..');
export const composeFile = join(root, 'infra/dev/compose.yaml');
export const VOLUME_KINDS = ['postgres_data', 'fuseki_data', 'rustfs_data'] as const;

/** A worker with a checkout-local write boundary can override the shared backup directory. */
export const fixtureRoot = (() => {
  if (process.env.REZICS_FIXTURE_ROOT) return resolve(process.env.REZICS_FIXTURE_ROOT);
  const common = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'],
    { cwd: root, encoding: 'utf8' });
  return join(common.status === 0 ? dirname(common.stdout.trim()) : root, '.temp', 'fixture');
})();

export function fixtureDirectory(id: string): string { return join(fixtureRoot, id); }
/** Outside the `rezics-dev`/`rezics-qa-*` namespaces, so no stack command can start a backup. */
export function fixtureProject(id: string): string { return `rezics-fixture-${id}`; }

export function dockerEnvironment(): NodeJS.ProcessEnv { return loadDockerEnvironment(); }

export function run(command: string, args: string[], env: NodeJS.ProcessEnv, timeout = 120_000): string {
  const result = spawnSync(command, args, { cwd: root, env, encoding: 'utf8', timeout,
    maxBuffer: 64 * 1024 * 1024 });
  const stdout = redactCommandOutput(result.stdout ?? '');
  const stderr = redactCommandOutput(result.stderr ?? '');
  const message = redactCommandOutput(result.error?.message ?? '');
  if (result.error || result.status !== 0) {
    const detail = (stderr || stdout || message).trim().slice(-2000);
    throw new Error(redactCommandOutput(`${command} ${args.slice(0, 6).join(' ')} failed${detail ? `: ${detail}` : ''}`));
  }
  return `${stdout}${stderr}`;
}

/** Spawn with an optional streamed stdin; resolves with combined output or rejects with its tail. */
export async function stream(command: string, args: string[], env: NodeJS.ProcessEnv,
  input?: AsyncIterable<string>, timeout = 600_000): Promise<string> {
  const child = spawn(command, args, { cwd: root, env, stdio: [input ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
  let output = '';
  const stdoutRedactor = createCommandOutputRedactor();
  const stderrRedactor = createCommandOutputRedactor();
  // Redact each stream before the tail window. One scanner would glue the other
  // pipe into a split assignment and could keep the value past the slice.
  const keep = (redactor: ReturnType<typeof createCommandOutputRedactor>) => (chunk: Buffer) => {
    output = (output + redactor.push(chunk.toString())).slice(-200_000);
  };
  child.stdout!.on('data', keep(stdoutRedactor));
  child.stderr!.on('data', keep(stderrRedactor));
  const timer = setTimeout(() => child.kill('SIGKILL'), timeout);
  const exited = new Promise<number | null>((resolveExit, reject) => {
    child.once('error', reject);
    child.once('close', code => resolveExit(code));
  });
  try {
    if (input && child.stdin) {
      const stdin = child.stdin;
      let closed = false;
      // An early exit closes the pipe; its status and output explain the failure below.
      stdin.on('error', () => { closed = true; });
      child.once('close', () => { closed = true; });
      for await (const chunk of input) {
        if (closed) break;
        if (!stdin.write(chunk)) {
          await new Promise<void>(drained => {
            const done = () => { stdin.off('drain', done); child.off('close', done); drained(); };
            stdin.once('drain', done);
            child.once('close', done);
          });
        }
      }
      if (!closed) stdin.end();
    }
    const code = await exited;
    output = (output + stdoutRedactor.finish() + stderrRedactor.finish()).slice(-200_000);
    if (code !== 0) throw new Error(redactCommandOutput(`${command} ${args.slice(0, 6).join(' ')} exited ${code}: ${output.slice(-2000)}`));
    return output;
  } finally { clearTimeout(timer); }
}

export function composeArgs(project: string, envFile: string, command: string[]): string[] {
  return ['compose', '--env-file', envFile, '-f', composeFile, '--project-name', project, ...command];
}

async function availablePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') return reject(new Error('Could not allocate port'));
      server.close(() => resolvePort(address.port));
    });
  });
}

/** Fresh loopback ports for every Compose port variable; endpoints are run-local. */
export async function freshPorts(): Promise<Record<string, string>> {
  const selected = new Set<number>();
  const ports: Record<string, string> = {};
  for (const name of Object.keys(devPorts())) {
    let port: number;
    do { port = await availablePort(); } while (selected.has(port));
    selected.add(port);
    ports[name] = String(port);
  }
  return ports;
}

function pinnedImage(service: string, pattern: RegExp): string {
  const compose = readFileSync(composeFile, 'utf8');
  const image = compose.match(new RegExp(`^  ${service}:\\n    image: (\\S+)$`, 'm'))?.[1];
  if (!image || !pattern.test(image)) throw new Error(`pinned ${service} image is missing or malformed`);
  return image;
}

export function postgresImage(): string {
  return pinnedImage('postgres', /^postgres:[0-9.]+-[a-z]+@sha256:[0-9a-f]{64}$/);
}

export interface EngineIdentity { image: string; id: string }
export interface FixtureEngines { fuseki: EngineIdentity; postgres: EngineIdentity; rustfs: EngineIdentity }

/** Exact local engine images; a missing image fails before any storage is touched. */
export function currentEngines(docker: NodeJS.ProcessEnv): FixtureEngines {
  const identity = (image: string): EngineIdentity => {
    const id = run('docker', ['image', 'inspect', image, '--format', '{{.Id}}'], docker, 15_000).trim();
    if (!/^sha256:[0-9a-f]{64}$/.test(id)) throw new Error(`engine image ${image} has no local ID`);
    return { image, id };
  };
  return { fuseki: identity(fusekiImageFromCompose(readFileSync(composeFile, 'utf8')).image),
    postgres: identity(postgresImage()),
    rustfs: identity(pinnedImage('rustfs', /^rustfs\/rustfs:[0-9.]+@sha256:[0-9a-f]{64}$/)) };
}

export function volumeExists(name: string, docker: NodeJS.ProcessEnv): boolean {
  return spawnSync('docker', ['volume', 'inspect', name],
    { cwd: root, env: docker, encoding: 'utf8', timeout: 15_000 }).status === 0;
}

export function projectRunning(project: string, docker: NodeJS.ProcessEnv): boolean {
  return run('docker', ['ps', '-q', '--filter', `label=com.docker.compose.project=${project}`],
    docker, 15_000).trim() !== '';
}

export function removeVolumes(names: readonly string[], docker: NodeJS.ProcessEnv): void {
  for (const name of names) {
    if (volumeExists(name, docker)) run('docker', ['volume', 'rm', name], docker, 60_000);
  }
}

/** Whole-volume stopped copy with the pinned PostgreSQL image as the helper. */
export async function copyVolume(from: string, to: string, docker: NodeJS.ProcessEnv): Promise<void> {
  run('docker', ['volume', 'create', to], docker, 15_000);
  await stream('docker', ['run', '--rm', '--network', 'none', '--user', '0:0',
    '--volume', `${from}:/from:ro`, '--volume', `${to}:/to`, '--entrypoint', 'sh', postgresImage(),
    '-ec', 'cp -a /from/. /to/'], docker, undefined, 540_000);
}

/** Apparent bytes and file count of each named volume. */
export function volumeBytes(names: readonly string[], docker: NodeJS.ProcessEnv): Record<string, { bytes: number; files: number }> {
  const args = names.flatMap((name, index) => ['--volume', `${name}:/v${index}:ro`]);
  const output = run('docker', ['run', '--rm', '--network', 'none', '--user', '0:0', ...args,
    '--entrypoint', 'sh', postgresImage(), '-ec',
    names.map((_, index) => `echo "$(du -sb /v${index} | cut -f1) $(find /v${index} -type f | wc -l)"`).join('; ')],
  docker, 300_000).trim().split('\n');
  return Object.fromEntries(names.map((name, index) => {
    const [bytes, files] = (output[index] ?? '').trim().split(/\s+/).map(Number);
    return [name, { bytes: bytes ?? Number.NaN, files: files ?? Number.NaN }];
  }));
}
