import { afterAll, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  alignViteDepCacheToOptimizer,
  alignViteLockfileHashes,
  bindViteDepCacheAlign,
  hashLockfile,
  hashViteDepCacheIdentity,
  materializeViteDepCache,
  prepareViteDepCache,
  readPatchBytes,
  viteDepCacheMetadataFile,
  viteDepCacheMetadataName,
  viteDepCacheOptimizeCommand,
  viteDepCacheReadyName,
  viteDepCacheRoot,
  viteDepCacheSsrMetadataName,
  viteDepCacheWarmCommand,
  viteEnvironmentConfigHash,
  viteEnvironmentDepHashes,
  viteLockfileHash,
  webViteOptimizerIdentity,
  webViteWarmSsrEnvName,
  webViteWorkerSsrEnvironment,
  webViteWorkerSsrOptimizeDeps,
} from './vite-dep-cache.ts';

const temporary = mkdtempSync(join(tmpdir(), 'rezics-vite-dep-cache-'));

afterAll(() => rmSync(temporary, { recursive: true, force: true }));

function cacheHome(): string {
  return join(temporary, `home-${hashLockfile(String(Math.random())).slice(0, 12)}`);
}

test('the default pre-bundle is vite optimize --force, not a second HTTP server', async () => {
  expect(viteDepCacheOptimizeCommand('/app')).toEqual(['/app/node_modules/.bin/vite', 'optimize', '--force']);
  expect(viteDepCacheWarmCommand('/app')).toEqual(['node', '/app/scripts/warm-vite-deps.ts']);
  const source = await Bun.file(join(import.meta.dir, '../../scripts/warm-vite-deps.ts')).text();
  expect(source).toContain('middlewareMode: true');
  expect(source).not.toMatch(/\.listen\(/);
  expect(source).toContain('fileURLToPath');
  expect(source).not.toContain('import.meta.dir');
  expect(source).toContain(`${webViteWarmSsrEnvName} = '1'`);
  expect(webViteWorkerSsrEnvironment.optimizeDeps.include).toEqual([...webViteWorkerSsrOptimizeDeps.include]);
  expect(webViteWorkerSsrEnvironment.resolve.conditions).toContain('workerd');
  expect(webViteWorkerSsrEnvironment.optimizeDeps.noDiscovery).toBe(true);
});

test('a lock hash reuses one published cache and a changed lock builds its own directory', async () => {
  const home = cacheHome();
  const workspaceRoot = join(temporary, 'workspace');
  mkdirSync(workspaceRoot, { recursive: true });
  let builds = 0;
  const build = async (staging: string) => {
    builds += 1;
    writeFileSync(join(staging, 'marker'), `build-${builds}`);
  };
  const first = await prepareViteDepCache({
    workspaceRoot,
    appRoot: workspaceRoot,
    cacheHome: home,
    lockBytes: 'lock-a',
    build,
  });
  expect(first.reused).toBe(false);
  expect(first.lockHash).toBe(hashViteDepCacheIdentity({ lockBytes: 'lock-a' }));
  expect(first.directory).toBe(join(viteDepCacheRoot({ XDG_CACHE_HOME: home }, home), first.lockHash));
  expect(readFileSync(join(first.directory, 'marker'), 'utf8')).toBe('build-1');
  expect(JSON.parse(readFileSync(join(first.directory, viteDepCacheReadyName), 'utf8')).lockHash).toBe(first.lockHash);

  const second = await prepareViteDepCache({
    workspaceRoot,
    appRoot: workspaceRoot,
    cacheHome: home,
    lockBytes: 'lock-a',
    build,
  });
  expect(second).toEqual({ directory: first.directory, lockHash: first.lockHash, reused: true });
  expect(builds).toBe(1);

  const changed = await prepareViteDepCache({
    workspaceRoot,
    appRoot: workspaceRoot,
    cacheHome: home,
    lockBytes: 'lock-b',
    build,
  });
  expect(changed.reused).toBe(false);
  expect(changed.lockHash).toBe(hashViteDepCacheIdentity({ lockBytes: 'lock-b' }));
  expect(changed.directory).not.toBe(first.directory);
  expect(readFileSync(join(changed.directory, 'marker'), 'utf8')).toBe('build-2');
  expect(builds).toBe(2);
});

test('a concurrent waiter reuses the published cache instead of building twice', async () => {
  const home = cacheHome();
  const workspaceRoot = join(temporary, 'concurrent');
  mkdirSync(workspaceRoot, { recursive: true });
  let builds = 0;
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  const build = async (staging: string) => {
    builds += 1;
    if (builds === 1) await held;
    writeFileSync(join(staging, 'marker'), 'shared');
  };
  const first = prepareViteDepCache({
    workspaceRoot,
    appRoot: workspaceRoot,
    cacheHome: home,
    lockBytes: 'lock-concurrent',
    build,
    pollIntervalMs: 10,
  });
  const deadline = Date.now() + 5_000;
  while (builds === 0) {
    if (Date.now() >= deadline) throw new Error('owner did not start the cache build');
    await Bun.sleep(10);
  }
  const waiter = prepareViteDepCache({
    workspaceRoot,
    appRoot: workspaceRoot,
    cacheHome: home,
    lockBytes: 'lock-concurrent',
    build,
    pollIntervalMs: 10,
  });
  release();
  const [owner, waiting] = await Promise.all([first, waiter]);
  expect(builds).toBe(1);
  expect(owner.reused).toBe(false);
  expect(waiting.reused).toBe(true);
  expect(waiting.directory).toBe(owner.directory);
  expect(readFileSync(join(owner.directory, 'marker'), 'utf8')).toBe('shared');
});

test('a materialized copy restamps Vite lockfileHash without rebuilding or mutating the published cache', async () => {
  const home = cacheHome();
  const workspaceRoot = join(temporary, 'lockfile-hash');
  const appRoot = join(workspaceRoot, 'apps', 'web');
  mkdirSync(join(workspaceRoot, 'patches'), { recursive: true });
  mkdirSync(appRoot, { recursive: true });
  writeFileSync(join(workspaceRoot, 'bun.lock'), 'lock-shared');
  writeFileSync(join(workspaceRoot, 'patches', 'keep.patch'), 'patch');
  const published = await prepareViteDepCache({
    workspaceRoot,
    appRoot,
    cacheHome: home,
    lockBytes: 'lock-shared',
    build: async (staging) => {
      mkdirSync(join(staging, 'deps'), { recursive: true });
      mkdirSync(join(staging, 'deps_ssr'), { recursive: true });
      writeFileSync(join(staging, viteDepCacheMetadataName), `${JSON.stringify({ lockfileHash: 'stalecli' })}\n`);
      writeFileSync(join(staging, viteDepCacheSsrMetadataName), `${JSON.stringify({ lockfileHash: 'stalecli' })}\n`);
    },
  });
  expect(JSON.parse(readFileSync(join(published.directory, viteDepCacheMetadataName), 'utf8')).lockfileHash).toBe(
    'stalecli',
  );

  const runDirectory = join(temporary, 'run-copy');
  const copy = materializeViteDepCache(published, runDirectory);
  expect(copy).toBe(runDirectory);
  alignViteLockfileHashes(copy, appRoot);
  const current = viteLockfileHash(appRoot);
  expect(current).not.toBe('stalecli');
  expect(JSON.parse(readFileSync(join(copy, viteDepCacheMetadataName), 'utf8')).lockfileHash).toBe(current);
  expect(JSON.parse(readFileSync(join(copy, viteDepCacheSsrMetadataName), 'utf8')).lockfileHash).toBe(current);
  expect(JSON.parse(readFileSync(join(published.directory, viteDepCacheMetadataName), 'utf8')).lockfileHash).toBe(
    'stalecli',
  );

  const reused = await prepareViteDepCache({
    workspaceRoot,
    appRoot,
    cacheHome: home,
    lockBytes: 'lock-shared',
    build: async () => {
      throw new Error('must not rebuild');
    },
  });
  expect(reused.reused).toBe(true);
  expect(reused.directory).toBe(published.directory);
});

test('equivalent lock, patch bytes and optimizer config reuse across worktrees; a patch or optimizer change rebuilds', async () => {
  const home = cacheHome();
  const firstRoot = join(temporary, 'worktree-a');
  const secondRoot = join(temporary, 'worktree-b');
  mkdirSync(join(firstRoot, 'patches'), { recursive: true });
  mkdirSync(join(secondRoot, 'patches'), { recursive: true });
  writeFileSync(join(firstRoot, 'bun.lock'), 'lock-shared');
  writeFileSync(join(secondRoot, 'bun.lock'), 'lock-shared');
  writeFileSync(join(firstRoot, 'patches', 'keep.patch'), 'same-bytes');
  writeFileSync(join(secondRoot, 'patches', 'keep.patch'), 'same-bytes');
  let builds = 0;
  const build = async (staging: string) => {
    builds += 1;
    writeFileSync(join(staging, 'marker'), `build-${builds}`);
  };
  const first = await prepareViteDepCache({
    workspaceRoot: firstRoot,
    appRoot: firstRoot,
    cacheHome: home,
    build,
  });
  expect(first.reused).toBe(false);
  expect(first.lockHash).toBe(
    hashViteDepCacheIdentity({ lockBytes: 'lock-shared', patchBytes: readPatchBytes(firstRoot) }),
  );
  expect(readPatchBytes(firstRoot)).toBe(readPatchBytes(secondRoot));

  const second = await prepareViteDepCache({
    workspaceRoot: secondRoot,
    appRoot: secondRoot,
    cacheHome: home,
    build,
  });
  expect(second).toEqual({ directory: first.directory, lockHash: first.lockHash, reused: true });
  expect(builds).toBe(1);

  writeFileSync(join(secondRoot, 'patches', 'keep.patch'), 'changed-bytes');
  const patched = await prepareViteDepCache({
    workspaceRoot: secondRoot,
    appRoot: secondRoot,
    cacheHome: home,
    build,
  });
  expect(patched.reused).toBe(false);
  expect(patched.directory).not.toBe(first.directory);
  expect(builds).toBe(2);

  const optimizerChanged = await prepareViteDepCache({
    workspaceRoot: firstRoot,
    appRoot: firstRoot,
    cacheHome: home,
    optimizer: { ...webViteOptimizerIdentity, ssr: { ...webViteOptimizerIdentity.ssr, include: ['react'] } },
    build,
  });
  expect(optimizerChanged.reused).toBe(false);
  expect(optimizerChanged.directory).not.toBe(first.directory);
  expect(optimizerChanged.directory).not.toBe(patched.directory);
  expect(builds).toBe(3);
});

test('serve restamps optimizer hashes onto published metadata and keeps the pre-bundled files', () => {
  const directory = join(temporary, 'serve-align');
  mkdirSync(join(directory, 'deps_ssr'), { recursive: true });
  const optimized = {
    react: { src: '/app/node_modules/react/index.js', file: 'react.js', fileHash: 'abc', needsInterop: false },
  };
  writeFileSync(
    join(directory, viteDepCacheSsrMetadataName),
    `${JSON.stringify({
      hash: 'oldhash1',
      lockfileHash: 'stalecli',
      configHash: 'middleware',
      browserHash: 'keep-browser',
      optimized,
      chunks: {},
    })}\n`,
  );
  expect(viteDepCacheMetadataFile('ssr')).toBe(viteDepCacheSsrMetadataName);
  expect(viteDepCacheMetadataFile('client')).toBe(viteDepCacheMetadataName);
  alignViteDepCacheToOptimizer(directory, 'ssr', {
    hash: 'newhash12',
    lockfileHash: 'serveLock',
    configHash: 'serveConf',
  });
  const rewritten = JSON.parse(readFileSync(join(directory, viteDepCacheSsrMetadataName), 'utf8')) as {
    hash: string;
    lockfileHash: string;
    configHash: string;
    browserHash: string;
    optimized: typeof optimized;
  };
  expect(rewritten.hash).toBe('newhash12');
  expect(rewritten.lockfileHash).toBe('serveLock');
  expect(rewritten.configHash).toBe('serveConf');
  expect(rewritten.browserHash).toBe('keep-browser');
  expect(rewritten.optimized).toEqual(optimized);
});

test('optimizer init restamps serve hashes before the original init reads metadata', async () => {
  const directory = join(temporary, 'init-align');
  mkdirSync(join(directory, 'deps_ssr'), { recursive: true });
  writeFileSync(
    join(directory, viteDepCacheSsrMetadataName),
    `${JSON.stringify({
      hash: 'oldhash1',
      lockfileHash: 'stalecli',
      configHash: 'middleware',
      browserHash: 'keep-browser',
      optimized: { react: { file: 'react.js', fileHash: 'x' } },
      chunks: {},
    })}\n`,
  );
  const ssr = {
    name: 'ssr',
    config: {
      root: '/worktree-a/apps/web',
      plugins: [{ name: 'serve' }],
      optimizeDeps: { include: ['react'] },
      resolve: { conditions: ['ssr'] },
    },
    depsOptimizer: {
      init: async () => {
        const metadata = JSON.parse(readFileSync(join(directory, viteDepCacheSsrMetadataName), 'utf8')) as {
          hash: string;
          configHash: string;
        };
        expect(metadata).toMatchObject(viteEnvironmentDepHashes(ssr));
      },
    },
  };
  const after = bindViteDepCacheAlign(directory, { ssr });
  await ssr.depsOptimizer.init();
  after();
});

test('optimizer assigned after bind restamps before the first init', async () => {
  const directory = join(temporary, 'late-optimizer');
  mkdirSync(join(directory, 'deps_ssr'), { recursive: true });
  writeFileSync(
    join(directory, viteDepCacheSsrMetadataName),
    `${JSON.stringify({
      hash: 'oldhash1',
      lockfileHash: 'stalecli',
      configHash: 'middleware',
      browserHash: 'keep-browser',
      optimized: { react: { file: 'react.js', fileHash: 'x' } },
      chunks: {},
    })}\n`,
  );
  const ssr: {
    name: string;
    config: {
      root: string;
      plugins: Array<{ name: string }>;
      optimizeDeps: { include: string[] };
      resolve: { conditions: string[] };
    };
    depsOptimizer?: { init: () => Promise<void> };
  } = {
    name: 'ssr',
    config: {
      root: '/worktree-a/apps/web',
      plugins: [{ name: 'cloudflare-pre' }],
      optimizeDeps: { include: ['react'] },
      resolve: { conditions: ['ssr'] },
    },
  };
  bindViteDepCacheAlign(directory, { ssr });
  ssr.depsOptimizer = {
    init: async () => {
      const metadata = JSON.parse(readFileSync(join(directory, viteDepCacheSsrMetadataName), 'utf8')) as {
        hash: string;
        configHash: string;
      };
      expect(metadata).toMatchObject(viteEnvironmentDepHashes(ssr));
    },
  };
  await ssr.depsOptimizer.init();
});

test('live environment hashes follow plugin names and root, not the published cache identity', () => {
  const first = viteEnvironmentDepHashes({
    config: {
      root: '/worktree-a/apps/web',
      plugins: [{ name: 'middleware' }],
      optimizeDeps: { include: ['react'] },
      resolve: { conditions: ['ssr'] },
    },
  });
  const renamed = viteEnvironmentDepHashes({
    config: {
      root: '/worktree-a/apps/web',
      plugins: [{ name: 'serve' }],
      optimizeDeps: { include: ['react'] },
      resolve: { conditions: ['ssr'] },
    },
  });
  const moved = viteEnvironmentDepHashes({
    config: {
      root: '/worktree-b/apps/web',
      plugins: [{ name: 'middleware' }],
      optimizeDeps: { include: ['react'] },
      resolve: { conditions: ['ssr'] },
    },
  });
  expect(first.configHash).toBe(
    viteEnvironmentConfigHash({
      config: {
        root: '/worktree-a/apps/web',
        plugins: [{ name: 'middleware' }],
        optimizeDeps: { include: ['react'] },
        resolve: { conditions: ['ssr'] },
      },
    }),
  );
  expect(renamed.configHash).not.toBe(first.configHash);
  expect(moved.configHash).not.toBe(first.configHash);
  expect(hashViteDepCacheIdentity({ lockBytes: 'lock', patchBytes: 'patch' })).toBe(
    hashViteDepCacheIdentity({ lockBytes: 'lock', patchBytes: 'patch' }),
  );
});

test('a failed build does not publish a ready cache', async () => {
  const home = cacheHome();
  const workspaceRoot = join(temporary, 'failed');
  mkdirSync(workspaceRoot, { recursive: true });
  await expect(
    prepareViteDepCache({
      workspaceRoot,
      appRoot: workspaceRoot,
      cacheHome: home,
      lockBytes: 'lock-fail',
      build: async () => {
        throw new Error('optimize failed');
      },
    }),
  ).rejects.toThrow('optimize failed');
  expect(
    existsSync(
      join(
        viteDepCacheRoot({ XDG_CACHE_HOME: home }, home),
        hashViteDepCacheIdentity({ lockBytes: 'lock-fail' }),
        viteDepCacheReadyName,
      ),
    ),
  ).toBe(false);
});
