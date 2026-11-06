import { join, resolve } from 'node:path';
import { startDevServer, type DevServerOptions } from '../tests/support/dev-server.ts';
import { sharedDevServerEnvName, writeSharedDevServer } from '../tests/support/dev-server-fixture.ts';
import { prepareViteDepCache } from '../tests/support/vite-dep-cache.ts';
import { readExampleWorkerVars } from './dev-vars.ts';

const app = resolve(import.meta.dir, '..');
const workspace = resolve(app, '../..');
const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;

/** Vite-process bindings for a shared test server. Per-file overlays still replace these on each request. */
export function sharedViteChildEnvironment(
  env: NodeJS.ProcessEnv,
  extras: { cacheDirectory?: string } = {},
): NodeJS.ProcessEnv {
  const child: NodeJS.ProcessEnv = {
    ...readExampleWorkerVars(),
    ...env,
    REZICS_TEST_RUNTIME: '1',
    CLOUDFLARE_VITE_FORCE_LOCAL: 'true',
  };
  if (extras.cacheDirectory) child.WEB_VITE_CACHE_DIR = extras.cacheDirectory;
  return child;
}

export function commandNeedsSharedDevServer(command: string[]): boolean {
  return command[0] === 'bun' && command[1] === 'test';
}

export type SharedDevServerRun = {
  origin: string;
  pid: number | undefined;
  cacheDirectory: string;
  lockHash: string;
  reused: boolean;
  firstEnMs: number;
  stop: () => Promise<void>;
};

export async function startSharedWebDevServer(
  env: NodeJS.ProcessEnv,
  options: {
    appDirectory?: string;
    workspaceRoot?: string;
    descriptorPath: string;
    signal?: AbortSignal;
    onPhase?: (timing: { phase: string; path: string; elapsedMs: number }) => void;
  },
): Promise<SharedDevServerRun> {
  const appDirectory = resolve(options.appDirectory ?? app);
  const workspaceRoot = resolve(options.workspaceRoot ?? workspace);
  const cache = await prepareViteDepCache({
    workspaceRoot,
    appRoot: appDirectory,
    env: sharedViteChildEnvironment(env),
  });
  let firstEnMs = 0;
  const start: DevServerOptions = {
    exclusive: true,
    cwd: appDirectory,
    env: sharedViteChildEnvironment(env, { cacheDirectory: cache.directory }),
    warmUpPaths: [],
    firstPath: '/en',
    now: () => performance.now(),
    onPhase: (timing) => {
      if (timing.phase === 'first response' && timing.path === '/en') firstEnMs = timing.elapsedMs;
      options.onPhase?.(timing);
    },
  };
  if (options.signal) start.signal = options.signal;
  const server = await startDevServer(start);
  if (server.pid === undefined) throw new Error('Shared Web dev server started without a process id');
  writeSharedDevServer(options.descriptorPath, {
    origin: server.origin,
    pid: server.pid,
    fixtureDirectory: env.WEB_TEST_STATE_DIR ?? appDirectory,
    cacheDirectory: cache.directory,
    lockHash: cache.lockHash,
  });
  return {
    origin: server.origin,
    pid: server.pid,
    cacheDirectory: cache.directory,
    lockHash: cache.lockHash,
    reused: cache.reused,
    firstEnMs,
    stop: server.stop,
  };
}

function parseArguments(args: string[]): string[] {
  const separator = args.indexOf('--');
  const command = separator < 0 ? args : args.slice(separator + 1);
  if (command.length === 0) throw new Error('Usage: bun scripts/with-dev-server.ts -- <command...>');
  return command;
}

if (import.meta.main) {
  const command = parseArguments(process.argv.slice(2));
  const abort = new AbortController();
  let server: SharedDevServerRun | undefined;
  const forwarders: Array<readonly [NodeJS.Signals, () => void]> = [];
  for (const signal of signals) {
    const listener = () => abort.abort();
    process.on(signal, listener);
    forwarders.push([signal, listener]);
  }
  try {
    const childEnvironment: NodeJS.ProcessEnv = { ...process.env, REZICS_TEST_RUNTIME: '1' };
    if (commandNeedsSharedDevServer(command) && !childEnvironment[sharedDevServerEnvName]) {
      const descriptorPath = join(childEnvironment.WEB_TEST_STATE_DIR || app, 'dev-server.json');
      server = await startSharedWebDevServer(childEnvironment, {
        descriptorPath,
        signal: abort.signal,
      });
      childEnvironment[sharedDevServerEnvName] = descriptorPath;
      childEnvironment.WEB_VITE_CACHE_DIR = server.cacheDirectory;
      childEnvironment.WEB_TEST_DEV_SERVER_FIRST_EN_MS = String(Math.round(server.firstEnMs));
      childEnvironment.WEB_TEST_DEV_SERVER_CACHE = server.reused ? 'reuse' : 'build';
      childEnvironment.WEB_TEST_DEV_SERVER_LOCK = server.lockHash;
      process.stderr.write(
        `[web-dev-server] origin=${server.origin} pid=${server.pid} lock=${server.lockHash} cache=${server.reused ? 'reuse' : 'build'} first-en-ms=${Math.round(server.firstEnMs)} ${server.cacheDirectory}\n`,
      );
    }
    const child = Bun.spawn(command, {
      cwd: app,
      env: childEnvironment,
      stdin: 'inherit',
      stdout: 'inherit',
      stderr: 'inherit',
    });
    const status = await child.exited;
    process.exitCode = abort.signal.aborted ? 143 : status;
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  } finally {
    for (const [signal, listener] of forwarders) process.off(signal, listener);
    try {
      await server?.stop();
    } catch (error) {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode ||= 1;
    }
  }
}
