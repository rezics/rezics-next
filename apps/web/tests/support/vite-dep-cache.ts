import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { cleanupAll, ownBunProcess } from './server-custody.ts';

export const viteDepCacheReadyName = '_ready';
export const viteDepCacheLockName = '_lock';
export const viteDepCacheMetadataName = join('deps', '_metadata.json');

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

export function viteDepCacheOptimizeCommand(appRoot: string): string[] {
  return [join(appRoot, 'node_modules', '.bin', 'vite'), 'optimize', '--force'];
}

async function defaultBuild(stagingDirectory: string, env: NodeJS.ProcessEnv, appRoot: string): Promise<void> {
  const child = Bun.spawn(viteDepCacheOptimizeCommand(appRoot), {
    cwd: appRoot,
    env: { ...env, WEB_VITE_CACHE_DIR: stagingDirectory, REZICS_TEST_RUNTIME: '1' },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const custody = ownBunProcess(child, { label: 'Vite dependency pre-bundle' });
  try {
    const status = await child.exited;
    if (status !== 0) {
      throw new Error(`Vite dependency pre-bundle exited with ${status}\n${custody.diagnostics()}`);
    }
    const metadata = join(stagingDirectory, viteDepCacheMetadataName);
    if (!existsSync(metadata)) {
      throw new Error(`Vite dependency pre-bundle did not write ${metadata}\n${custody.diagnostics()}`);
    }
  } finally {
    await cleanupAll([{ label: 'Vite dependency pre-bundle', run: () => custody.close(), timeoutMs: 12_000 }]);
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
