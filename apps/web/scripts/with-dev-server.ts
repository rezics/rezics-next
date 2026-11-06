import { join, resolve } from 'node:path';
import { startDevServer } from '../tests/support/dev-server.ts';
import {
  sharedDevServerEnvName,
  writeSharedDevServer,
} from '../tests/support/dev-server-fixture.ts';
import { prepareViteDepCache } from '../tests/support/vite-dep-cache.ts';

const app = resolve(import.meta.dir, '..');
const workspace = resolve(app, '../..');
const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;

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
    env,
  });
  let firstEnMs = 0;
  const server = await startDevServer({
    exclusive: true,
    cwd: appDirectory,
    env: {
      ...env,
      WEB_VITE_CACHE_DIR: cache.directory,
      REZICS_TEST_RUNTIME: '1',
    },
    warmUpPaths: [],
    firstPath: '/en',
    now: () => performance.now(),
    onPhase: (timing) => {
      if (timing.phase === 'first response' && timing.path === '/en') firstEnMs = timing.elapsedMs;
      options.onPhase?.(timing);
    },
    ...(options.signal ? { signal: options.signal } : {}),
  });
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
    await server?.stop();
  }
}
