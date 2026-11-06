import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { cleanupAll, ownBunProcess } from './server-custody.ts';

export const viteDepCacheReadyName = '_ready';
export const viteDepCacheLockName = '_lock';

export type ViteDepCacheReady = {
  lockHash: string;
  builtAt: string;
};

export type PrepareViteDepCacheOptions = {
  workspaceRoot: string;
  appRoot: string;
  env?: NodeJS.ProcessEnv;
  cacheHome?: string;
  lockBytes?: Uint8Array | string;
  build?: (stagingDirectory: string, env: NodeJS.ProcessEnv) => Promise<void>;
  now?: () => Date;
  pollIntervalMs?: number;
  waitMs?: number;
};

export type ViteDepCache = {
  directory: string;
  lockHash: string;
  reused: boolean;
};

function cacheHome(env: NodeJS.ProcessEnv, override?: string): string {
  if (override) return resolve(override);
  if (env.XDG_CACHE_HOME) return resolve(env.XDG_CACHE_HOME);
  return join(homedir(), '.cache');
}

export function viteDepCacheRoot(env: NodeJS.ProcessEnv = process.env, home?: string): string {
  return join(cacheHome(env, home), 'rezics', 'web-vite-deps');
}

export function hashLockfile(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function readReady(directory: string, lockHash: string): ViteDepCacheReady | undefined {
  const path = join(directory, viteDepCacheReadyName);
  if (!existsSync(path)) return undefined;
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as ViteDepCacheReady;
  if (parsed.lockHash !== lockHash) return undefined;
  return parsed;
}

async function waitFor(path: string, timeoutMs: number, pollIntervalMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) return false;
    await Bun.sleep(Math.min(pollIntervalMs, deadline - Date.now()));
  }
  return true;
}

function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as { port: number };
      probe.close((error) => (error ? reject(error) : resolvePort(port)));
    });
  });
}

async function defaultBuild(stagingDirectory: string, env: NodeJS.ProcessEnv, appRoot: string): Promise<void> {
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const child = Bun.spawn(['bun', 'run', 'dev', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
    cwd: appRoot,
    env: { ...env, WEB_VITE_CACHE_DIR: stagingDirectory, REZICS_TEST_RUNTIME: '1' },
    detached: true,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const custody = ownBunProcess(child, { label: 'Vite dependency pre-bundle' });
  let lastError: unknown = new Error('pre-bundle has not served /en');
  try {
    const deadline = Date.now() + 180_000;
    for (;;) {
      if (child.exitCode !== null) throw new Error(`Vite dependency pre-bundle exited with ${child.exitCode}`);
      try {
        const response = await fetch(`${origin}/en`, { redirect: 'manual', signal: AbortSignal.timeout(10_000) });
        await response.body?.cancel();
        if (response.status < 500) return;
        lastError = new Error(`HTTP ${response.status} for /en`);
      } catch (error) {
        lastError = error;
      }
      if (Date.now() >= deadline) throw new Error(`Vite dependency pre-bundle did not serve /en: ${String(lastError)}`);
      await Bun.sleep(250);
    }
  } finally {
    await cleanupAll([{ label: 'Vite dependency pre-bundle', run: () => custody.close(), timeoutMs: 8000 }]);
  }
}

/** Host-local Vite optimizeDeps cache keyed by bun.lock. Concurrent builders wait; a new lock gets a new directory. */
export async function prepareViteDepCache(options: PrepareViteDepCacheOptions): Promise<ViteDepCache> {
  const env = options.env ?? process.env;
  const lockBytes = options.lockBytes ?? readFileSync(join(options.workspaceRoot, 'bun.lock'));
  const lockHash = hashLockfile(lockBytes);
  const directory = join(viteDepCacheRoot(env, options.cacheHome), lockHash);
  const pollIntervalMs = options.pollIntervalMs ?? 50;
  const waitMs = options.waitMs ?? 180_000;
  mkdirSync(dirname(directory), { recursive: true, mode: 0o700 });
  if (readReady(directory, lockHash)) return { directory, lockHash, reused: true };

  const lockDirectory = join(directory + '.lock');
  let owned = false;
  const deadline = Date.now() + waitMs;
  while (!owned) {
    if (readReady(directory, lockHash)) return { directory, lockHash, reused: true };
    try {
      mkdirSync(lockDirectory);
      owned = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (Date.now() >= deadline) throw new Error(`Vite dependency cache lock ${lockDirectory} did not release`);
      await Bun.sleep(pollIntervalMs);
    }
  }

  try {
    if (readReady(directory, lockHash)) return { directory, lockHash, reused: true };
    const staging = `${directory}.staging-${process.pid}`;
    rmSync(staging, { recursive: true, force: true });
    mkdirSync(staging, { recursive: true, mode: 0o700 });
    try {
      const build = options.build ?? ((path, buildEnv) => defaultBuild(path, buildEnv, options.appRoot));
      await build(staging, { ...env, WEB_VITE_CACHE_DIR: staging, REZICS_TEST_RUNTIME: '1' });
      const ready: ViteDepCacheReady = {
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
    return { directory, lockHash, reused: false };
  } finally {
    rmSync(lockDirectory, { recursive: true, force: true });
  }
}
