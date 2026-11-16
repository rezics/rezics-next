import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  hashViteDepCacheIdentity,
  readPatchBytes,
  viteDepCacheMetadataFiles,
  viteDepCacheOptimizeCommand,
  viteDepCacheReadyName,
  viteDepCacheRoot,
  viteDepCacheWarmCommand,
  type PrepareViteDepCacheOptions,
  type ViteDepCache,
  type ViteDepCacheReady,
} from './vite-dep-cache.ts';

function readReady(directory: string, lockHash: string): ViteDepCacheReady | undefined {
  const path = join(directory, viteDepCacheReadyName);
  if (!existsSync(path)) return undefined;
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as ViteDepCacheReady;
  if (parsed.lockHash !== lockHash || typeof parsed.workspaceRoot !== 'string') return undefined;
  return parsed;
}

async function runOwned(
  command: string[],
  appRoot: string,
  env: NodeJS.ProcessEnv,
  label: string,
  signal?: AbortSignal,
): Promise<string> {
  const { cleanupAll, ownBunProcess } = await import('./server-custody.ts');
  signal?.throwIfAborted();
  const child = Bun.spawn(command, {
    cwd: appRoot,
    env,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const custody = ownBunProcess(child, { label });
  const abort = () => void custody.close().catch(() => {});
  signal?.addEventListener('abort', abort, { once: true });
  try {
    const status = await child.exited;
    signal?.throwIfAborted();
    if (status !== 0) throw new Error(`${label} exited with ${status}\n${custody.diagnostics()}`);
    return custody.diagnostics();
  } finally {
    signal?.removeEventListener('abort', abort);
    await cleanupAll([{ label, run: () => custody.close(), timeoutMs: 12_000 }]);
  }
}

async function defaultBuild(
  stagingDirectory: string,
  env: NodeJS.ProcessEnv,
  appRoot: string,
  signal?: AbortSignal,
): Promise<void> {
  const childEnv: NodeJS.ProcessEnv = {
    ...env,
    WEB_VITE_CACHE_DIR: stagingDirectory,
    REZICS_TEST_RUNTIME: '1',
    CLOUDFLARE_VITE_FORCE_LOCAL: 'true',
  };
  // The startup probe owns the inspector. Optimizing dependencies does not open its listener.
  delete childEnv.WORKER_INSPECTOR_PORT;
  const optimizeOutput = await runOwned(
    viteDepCacheOptimizeCommand(appRoot),
    appRoot,
    childEnv,
    'Vite dependency pre-bundle',
    signal,
  );
  const warmOutput = await runOwned(
    viteDepCacheWarmCommand(appRoot),
    appRoot,
    childEnv,
    'Vite SSR dependency warm',
    signal,
  );
  const missing = viteDepCacheMetadataFiles.filter((relativePath) => !existsSync(join(stagingDirectory, relativePath)));
  if (missing.length > 0) {
    throw new Error(`Vite dependency pre-bundle did not write ${missing.join(', ')}\n${optimizeOutput}\n${warmOutput}`);
  }
}

/** Host-local Vite optimizeDeps cache keyed by lock, patch bytes and optimizer include/entries. */
export async function prepareViteDepCache(options: PrepareViteDepCacheOptions): Promise<ViteDepCache> {
  const { signal } = options;
  signal?.throwIfAborted();
  const env = options.env ?? process.env;
  const lockBytes = options.lockBytes ?? readFileSync(join(options.workspaceRoot, 'bun.lock'));
  const patchBytes = options.patchBytes ?? readPatchBytes(options.workspaceRoot);
  const lockHash = hashViteDepCacheIdentity({
    lockBytes,
    patchBytes,
    ...(options.optimizer === undefined ? {} : { optimizer: options.optimizer }),
  });
  const directory = join(viteDepCacheRoot(env, options.cacheHome), lockHash);
  const pollIntervalMs = options.pollIntervalMs ?? 50;
  const waitMs = options.waitMs ?? 180_000;
  mkdirSync(dirname(directory), { recursive: true, mode: 0o700 });
  const cached = () => {
    const ready = readReady(directory, lockHash);
    return ready && { directory, lockHash, workspaceRoot: ready.workspaceRoot, reused: true };
  };
  const existing = cached();
  if (existing) return existing;

  const lockDirectory = join(directory + '.lock');
  let owned = false;
  const deadline = Date.now() + waitMs;
  while (!owned) {
    signal?.throwIfAborted();
    const existing = cached();
    if (existing) return existing;
    try {
      mkdirSync(lockDirectory);
      owned = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (Date.now() >= deadline) throw new Error(`Vite dependency cache lock ${lockDirectory} did not release`);
      await delay(pollIntervalMs, undefined, { signal });
    }
  }

  try {
    const existing = cached();
    if (existing) return existing;
    const workspaceRoot = realpathSync(options.workspaceRoot);
    const staging = `${directory}.staging-${process.pid}`;
    rmSync(staging, { recursive: true, force: true });
    mkdirSync(staging, { recursive: true, mode: 0o700 });
    try {
      const build = options.build ?? ((path, buildEnv) => defaultBuild(path, buildEnv, options.appRoot, signal));
      await build(staging, { ...env, WEB_VITE_CACHE_DIR: staging, REZICS_TEST_RUNTIME: '1' });
      signal?.throwIfAborted();
      const ready: ViteDepCacheReady = {
        workspaceRoot,
        lockHash,
        builtAt: (options.now ?? (() => new Date()))().toISOString(),
      };
      writeFileSync(join(staging, viteDepCacheReadyName), `${JSON.stringify(ready)}\n`);
      rmSync(directory, { recursive: true, force: true });
      renameSync(staging, directory);
    } catch (error) {
      rmSync(staging, { recursive: true, force: true });
      throw error;
    }
    return { directory, lockHash, workspaceRoot, reused: false };
  } finally {
    rmSync(lockDirectory, { recursive: true, force: true });
  }
}
