import { join, resolve } from 'node:path';
import { startDevServer, type DevServerOptions } from '../tests/support/dev-server.ts';
import {
  sharedDevServerEnvName,
  workerFixtureOverlay,
  writeSharedDevServer,
} from '../tests/support/dev-server-fixture.ts';
import { prepareViteDepCache } from '../tests/support/vite-dep-cache-build.ts';
import { materializeViteDepCache } from '../tests/support/vite-dep-cache.ts';
import { testWorkerBindingsEnvName } from '../src/test-runtime-binding-config.ts';
import { readExampleWorkerVars } from './dev-vars.ts';
import { ownBunProcess } from '../tests/support/server-custody.ts';

const app = resolve(import.meta.dir, '..');
const workspace = resolve(app, '../..');
const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;
export const webTestPrivateNetworkEnvName = 'WEB_TEST_PRIVATE_NETWORK';
export const webTestDepCacheReadyEnvName = 'WEB_TEST_DEV_SERVER_CACHE_READY';

/** Vite-process bindings for a shared test server; Worker env is captured once at server startup. */
export function sharedViteChildEnvironment(
  env: NodeJS.ProcessEnv,
  extras: { cacheDirectory?: string } = {},
): NodeJS.ProcessEnv {
  const child: NodeJS.ProcessEnv = {
    ...readExampleWorkerVars(),
    ...env,
    REZICS_TEST_RUNTIME: '1',
    CLOUDFLARE_VITE_FORCE_LOCAL: 'true',
    CLOUDFLARE_CF_FETCH_ENABLED: 'false',
  };
  if (extras.cacheDirectory) child.WEB_VITE_CACHE_DIR = extras.cacheDirectory;
  const overlay = workerFixtureOverlay(child);
  if (overlay) child[testWorkerBindingsEnvName] = JSON.stringify(overlay);
  return child;
}

/**
 * Product walk Web is not the test runtime. Force local Cloudflare Vite without fixture Worker bindings
 * or a Node heap override; walk optimizeDeps then compiles the visited page on demand.
 */
export function walkViteChildEnvironment(
  env: NodeJS.ProcessEnv,
  extras: { cacheDirectory?: string } = {},
): NodeJS.ProcessEnv {
  const child: NodeJS.ProcessEnv = {
    ...env,
    CLOUDFLARE_VITE_FORCE_LOCAL: 'true',
    CLOUDFLARE_CF_FETCH_ENABLED: 'false',
  };
  delete child.REZICS_TEST_RUNTIME;
  if (extras.cacheDirectory) child.WEB_VITE_CACHE_DIR = extras.cacheDirectory;
  return child;
}

const testFileArgument = /\.test\.[cm]?[jt]sx?$/u;
const serverIndependentTests = [
  'scripts/check-placement.test.ts',
  'scripts/check-placement-custody.test.ts',
  'scripts/focused.test.ts',
  'scripts/messages-ready.test.ts',
  'scripts/storybook-dev.test.ts',
  'tests/accounts-goal-journeys.test.ts',
  'tests/first-public-journeys-walk.test.ts',
  'tests/focused-runner.test.ts',
  // This journey owns a server with private issuer/client bindings.
  'tests/post-editing.test.ts',
  'tests/root-application-shell.test.tsx',
  'tests/server-custody.test.ts',
  'tests/with-dev-server.test.ts',
];

/** These explicit selections own their fixtures; other page or mixed selections still start Vite. */
export function commandNeedsSharedDevServer(command: string[]): boolean {
  if (command[0] !== 'bun' || command[1] !== 'test') return false;
  const files = command.filter((argument) => testFileArgument.test(argument));
  return (
    files.length === 0 ||
    files.some((file) => {
      const normalized = file.replaceAll('\\', '/');
      return !serverIndependentTests.some((unit) => normalized === unit || normalized.endsWith(`/${unit}`));
    })
  );
}

export function privateNetworkCommand(command: string[]): string[] {
  return [
    'unshare',
    '--user',
    '--map-root-user',
    '--net',
    'sh',
    '-c',
    'ip link set lo up && exec "$@"',
    'sh',
    ...command,
  ];
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

function runCacheDirectory(env: NodeJS.ProcessEnv): string {
  return join(env.WEB_TEST_STATE_DIR || app, 'vite-deps');
}

export async function prepareSharedWebDevCache(
  env: NodeJS.ProcessEnv,
  options: { appDirectory?: string; workspaceRoot?: string } = {},
): Promise<{ directory: string; lockHash: string; reused: boolean }> {
  if (env[webTestDepCacheReadyEnvName] === '1' && env.WEB_VITE_CACHE_DIR) {
    return {
      directory: env.WEB_VITE_CACHE_DIR,
      lockHash: env.WEB_TEST_DEV_SERVER_LOCK ?? '',
      reused: env.WEB_TEST_DEV_SERVER_CACHE === 'reuse',
    };
  }
  const published = await prepareViteDepCache({
    workspaceRoot: resolve(options.workspaceRoot ?? workspace),
    appRoot: resolve(options.appDirectory ?? app),
    env: sharedViteChildEnvironment(env),
  });
  return {
    directory: materializeViteDepCache(published, runCacheDirectory(env)),
    lockHash: published.lockHash,
    reused: published.reused,
  };
}

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
  const cache = await prepareSharedWebDevCache(env, {
    appDirectory,
    ...(options.workspaceRoot === undefined ? {} : { workspaceRoot: options.workspaceRoot }),
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
    workerBindings: server.workerBindings,
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

function interruptedStatus(signal: AbortSignal): number {
  const interrupted = signal.reason;
  if (interrupted === 'SIGINT') return 130;
  if (interrupted === 'SIGHUP') return 129;
  return 143;
}

/** Run one wrapper child in its own process group and settle its recorded descendants on exit or cancellation. */
export async function runOwnedCommand(
  command: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; signal?: AbortSignal; label: string },
): Promise<number> {
  if (options.signal?.aborted) return interruptedStatus(options.signal);
  const child = Bun.spawn(command, {
    cwd: options.cwd,
    env: options.env,
    detached: true,
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
  });
  const custody = ownBunProcess(child, { label: options.label, termGraceMs: 2_000, settleTimeoutMs: 5_000 });
  let cleanup: Promise<void> | undefined;
  let cleanupError: unknown;
  const stop = () =>
    (cleanup ??= custody.close().catch((error) => {
      cleanupError = error;
      throw error;
    }));
  const onAbort = () => {
    void stop().catch(() => {});
  };
  options.signal?.addEventListener('abort', onAbort, { once: true });
  if (options.signal?.aborted) onAbort();
  try {
    const status = await child.exited;
    await stop();
    if (cleanupError) throw cleanupError;
    return options.signal?.aborted ? interruptedStatus(options.signal) : status;
  } finally {
    options.signal?.removeEventListener('abort', onAbort);
    await stop();
  }
}

async function main(command: string[]): Promise<void> {
  const abort = new AbortController();
  let server: SharedDevServerRun | undefined;
  const forwarders: Array<readonly [NodeJS.Signals, () => void]> = [];
  for (const signal of signals) {
    const listener = () => abort.abort(signal);
    process.on(signal, listener);
    forwarders.push([signal, listener]);
  }
  try {
    const childEnvironment: NodeJS.ProcessEnv = { ...process.env, REZICS_TEST_RUNTIME: '1' };
    const privateNetwork = childEnvironment[webTestPrivateNetworkEnvName] === '1';
    const cacheReady = childEnvironment[webTestDepCacheReadyEnvName] === '1';
    if (commandNeedsSharedDevServer(command) && !childEnvironment[sharedDevServerEnvName]) {
      if (privateNetwork && !cacheReady) {
        const cache = await prepareSharedWebDevCache(childEnvironment);
        childEnvironment.WEB_VITE_CACHE_DIR = cache.directory;
        childEnvironment[webTestDepCacheReadyEnvName] = '1';
        childEnvironment.WEB_TEST_DEV_SERVER_CACHE = cache.reused ? 'reuse' : 'build';
        childEnvironment.WEB_TEST_DEV_SERVER_LOCK = cache.lockHash;
        process.exitCode = await runOwnedCommand(
          privateNetworkCommand([process.execPath, import.meta.path, '--', ...command]),
          {
            cwd: app,
            env: childEnvironment,
            signal: abort.signal,
            label: 'private-network Web test command',
          },
        );
        return;
      }
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
    process.exitCode = await runOwnedCommand(command, {
      cwd: app,
      env: childEnvironment,
      signal: abort.signal,
      label: 'Web test command',
    });
  } catch (error) {
    console.error(error instanceof Error ? (error.stack ?? error.message) : error);
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

if (import.meta.main) await main(parseArguments(process.argv.slice(2)));
