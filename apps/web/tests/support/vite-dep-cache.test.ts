import { afterAll, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hashLockfile, prepareViteDepCache, viteDepCacheReadyName, viteDepCacheRoot } from './vite-dep-cache.ts';

const temporary = mkdtempSync(join(tmpdir(), 'rezics-vite-dep-cache-'));

afterAll(() => rmSync(temporary, { recursive: true, force: true }));

function cacheHome(): string {
  return join(temporary, `home-${hashLockfile(String(Math.random())).slice(0, 12)}`);
}

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
  expect(first.lockHash).toBe(hashLockfile('lock-a'));
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
  expect(changed.lockHash).toBe(hashLockfile('lock-b'));
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
