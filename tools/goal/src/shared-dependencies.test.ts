import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { expect, test } from 'bun:test';
import { dependencyKey, installShared, pruneStores, sealReadOnly } from './shared-dependencies.ts';

function fixture() {
  const temporaryRoot = resolve(import.meta.dir, '../../../.temp/goal-tests');
  mkdirSync(temporaryRoot, { recursive: true });
  const root = mkdtempSync(join(temporaryRoot, 'goal-deps-'));
  const tree = (name: string) => {
    const path = join(root, name);
    mkdirSync(join(path, 'packages', 'sample'), { recursive: true });
    writeFileSync(join(path, 'package.json'), JSON.stringify({ name: 'fixture', workspaces: ['packages/*'] }));
    writeFileSync(
      join(path, 'packages/sample/package.json'),
      JSON.stringify({ name: '@test/sample', version: '1.0.0' }),
    );
    const lock = Bun.spawnSync(['bun', 'install', '--lockfile-only'], { cwd: path });
    if (lock.exitCode !== 0) throw new Error(new TextDecoder().decode(lock.stderr));
    return path;
  };
  return {
    root,
    tree,
    close: () => {
      const writable = (dir: string) => {
        for (const name of readdirSync(dir)) {
          const path = join(dir, name);
          if (lstatSync(path).isDirectory()) writable(path);
          else if (!lstatSync(path).isSymbolicLink()) chmodSync(path, 0o644);
        }
        chmodSync(dir, 0o755);
      };
      writable(root);
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test('worktrees with one key share a read-only store and retain local workspace links', () => {
  const h = fixture();
  try {
    const a = h.tree('a'),
      b = h.tree('b'),
      c = h.tree('c'),
      stores = join(h.root, 'stores');
    installShared(a, stores);
    installShared(b, stores);
    installShared(c, stores);
    const count = (dir: string): number => requireCount(dir);
    expect(count(join(a, 'node_modules'))).toBeLessThan(1000);
    expect(count(join(b, 'node_modules'))).toBeLessThan(1000);
    const aBun = resolve(a, 'node_modules/.bun'),
      bBun = resolve(b, 'node_modules/.bun');
    expect(bunTarget(a)).toBe(bunTarget(b));
    expect(aBun).not.toBe(bunTarget(a));
    expect(bBun).not.toBe(bunTarget(a));
    expect(realpathSync(join(a, 'node_modules/@test/sample'))).toBe(resolve(a, 'packages/sample'));
    expect(realpathSync(join(b, 'node_modules/@test/sample'))).toBe(resolve(b, 'packages/sample'));
    expect(readlinkSync(join(a, 'node_modules/.bun'))).toContain('stores');
    expect(() => writeFileSync(join(b, 'node_modules/.bun/canary'), 'changed')).toThrow();
  } finally {
    h.close();
  }
});

function bunTarget(worktree: string): string {
  return resolve(worktree, 'node_modules', readlinkSync(join(worktree, 'node_modules/.bun')));
}
function requireCount(dir: string): number {
  return readdirSync(dir).reduce((n: number, name: string) => {
    const path = join(dir, name);
    return n + 1 + (lstatSync(path).isDirectory() ? requireCount(path) : 0);
  }, 0);
}

test('manifest drift and the private command keep installs private', async () => {
  const h = fixture();
  try {
    const a = h.tree('a'),
      b = h.tree('b'),
      c = h.tree('c'),
      stores = join(h.root, 'stores');
    installShared(a, stores);
    installShared(b, stores);
    installShared(c, stores);
    writeFileSync(join(a, 'packages/sample/package.json'), '{"name":"@test/sample","version":"2"}');
    const updated = Bun.spawnSync(['bun', 'install', '--lockfile-only'], { cwd: a });
    if (updated.exitCode !== 0) throw new Error(new TextDecoder().decode(updated.stderr));
    installShared(a, stores);
    expect(lstatSync(join(a, 'node_modules/.bun')).isSymbolicLink()).toBe(false);
    expect(lstatSync(join(b, 'node_modules/.bun')).isSymbolicLink()).toBe(true);
    writeFileSync(join(b, 'bun.lock'), `${readFileSync(join(b, 'bun.lock'), 'utf8')}\n`);
    installShared(b, stores);
    expect(lstatSync(join(b, 'node_modules/.bun')).isSymbolicLink()).toBe(false);
    const cli = new URL('./cli.ts', import.meta.url).pathname;
    const command = Bun.spawn([process.execPath, cli, 'deps', 'private'], { cwd: c, stdout: 'pipe', stderr: 'pipe' });
    expect(await command.exited).toBe(0);
    expect(lstatSync(join(c, 'node_modules/.bun')).isSymbolicLink()).toBe(false);
    installShared(c, stores);
    expect(lstatSync(join(c, 'node_modules/.bun')).isSymbolicLink()).toBe(false);
  } finally {
    h.close();
  }
});

test('an interrupted store build is discarded and the next use builds it cleanly', () => {
  const h = fixture();
  try {
    const a = h.tree('a'),
      stores = join(h.root, 'stores');
    // A malformed lockfile forces the build to fail before it can publish a store.
    writeFileSync(join(a, 'bun.lock'), '{}');
    expect(() => installShared(a, stores)).toThrow();
    expect(existsSync(join(stores, dependencyKey(a), 'node_modules/.bun'))).toBe(false);
    const lock = Bun.spawnSync(['bun', 'install', '--lockfile-only'], { cwd: a });
    if (lock.exitCode !== 0) throw new Error(new TextDecoder().decode(lock.stderr));
    installShared(a, stores);
    expect(existsSync(join(stores, dependencyKey(a), 'node_modules/.bun'))).toBe(true);
  } finally {
    h.close();
  }
});

function processIsAlive(pid: number): boolean {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    if (stat.slice(stat.lastIndexOf(')') + 2).startsWith('Z ')) return false;
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function expectProcessStopped(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 100 && processIsAlive(pid); attempt++)
    await new Promise((resolve) => setTimeout(resolve, 20));
  expect(processIsAlive(pid)).toBe(false);
}

test('shared and private install failures preserve structured infrastructure classification and their original cause', async () => {
  const h = fixture();
  try {
    for (const mode of ['shared-exit', 'private-exit', 'shared-timeout']) {
      const worktree = h.tree(mode);
      const stores = join(h.root, `${mode}-stores`);
      const bin = join(h.root, `${mode}-bin`);
      const pidFile = join(h.root, `${mode}.pid`);
      const timedOut = mode === 'shared-timeout';
      const shared = mode !== 'private-exit';
      const diagnostic =
        mode === 'shared-exit' ? 'Installing package @fixture/broken@4.5.6' : '+ @fixture/completed@1.0.0';
      mkdirSync(bin);
      mkdirSync(join(stores, '.building-unrelated'), { recursive: true });
      writeFileSync(join(stores, '.building-unrelated', 'owned-by-another-install'), 'keep');
      writeFileSync(
        join(bin, 'bun'),
        `#!/bin/sh
if [ "$1" = "--version" ]; then echo fixture-bun; exit 0; fi
mkdir -p node_modules/.bun/partial
echo '${diagnostic}' >&2
sleep 30 >/dev/null 2>&1 & echo $! > '${pidFile}'
${timedOut ? 'wait' : 'exit 29'}
`,
        { mode: 0o755 },
      );
      const module = new URL('./shared-dependencies.ts', import.meta.url).href;
      const runner = new URL('./install-process.ts', import.meta.url).href;
      const source = `
import { installShared, installPrivate, DependencyInstallError } from ${JSON.stringify(module)};
import { BoundedProcessError } from ${JSON.stringify(runner)};
try {
  const limits = { startupMs: 2000, runMs: 2000, budgetMs: ${timedOut ? 250 : 2000}, terminationMs: 500 };
  ${shared ? `installShared(process.cwd(), ${JSON.stringify(stores)}, limits)` : 'installPrivate(process.cwd(), limits)'};
  throw new Error('Expected dependency installation to fail');
} catch (error) {
  if (!(error instanceof DependencyInstallError)) throw error;
  const cause = error.cause;
  if (!(cause instanceof BoundedProcessError)) throw new Error('Original process cause was lost');
  console.log(JSON.stringify({
    infrastructure: error.infrastructure, step: error.step, workspace: error.workspace,
    packageName: error.packageName ?? null, message: error.message,
    cause: { infrastructure: cause.infrastructure, timedOut: cause.timedOut, phase: cause.phase,
      exitCode: cause.exitCode, step: cause.step, workspace: cause.workspace,
      packageName: cause.packageName ?? null, stderr: cause.stderr }
  }));
  process.exitCode = 1;
}`;
      const childEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GOAL_')));
      const started = performance.now();
      const child = Bun.spawn([process.execPath, '-e', source], {
        cwd: worktree,
        env: { ...childEnv, PATH: `${bin}:${process.env.PATH ?? ''}` },
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect(code).toBe(1);
      expect(stderr).toBe('');
      const result = JSON.parse(stdout);
      const step = `bun install --frozen-lockfile${shared ? ' --backend=copyfile' : ''}`;
      const packageName = mode === 'shared-exit' ? '@fixture/broken' : null;
      expect(result).toMatchObject({
        infrastructure: true,
        step,
        workspace: 'fixture',
        packageName,
        cause: {
          infrastructure: true,
          step,
          workspace: 'fixture',
          packageName,
          timedOut,
          phase: timedOut ? 'run' : 'exit',
          exitCode: timedOut ? 124 : 29,
          stderr: `${diagnostic}\n`,
        },
      });
      expect(result.message).toContain('Infrastructure failure');
      expect(result.message).toContain(diagnostic);
      expect(performance.now() - started).toBeLessThan(2_000);
      await expectProcessStopped(Number(readFileSync(pidFile, 'utf8').trim()));
      expect(readdirSync(stores).filter((name) => /^[a-f0-9]{64}$/.test(name))).toEqual([]);
      expect(readdirSync(stores).filter((name) => name.startsWith('.building-'))).toEqual(['.building-unrelated']);
      expect(readFileSync(join(stores, '.building-unrelated', 'owned-by-another-install'), 'utf8')).toBe('keep');
      if (shared) expect(readdirSync(join(stores, '.leases'))).toEqual([]);
      expect(existsSync(join(worktree, 'node_modules', '.goal-private-dependencies'))).toBe(false);
    }
  } finally {
    h.close();
  }
}, 10_000);

test(
  'a timed out shared install is an infrastructure failure, reaps descendants, releases its lease, and publishes no store',
  async () => {
    const h = fixture();
    try {
      const a = h.tree('a');
      const stores = join(h.root, 'stores');
      const bin = join(h.root, 'bin');
      const pidFile = join(h.root, 'installer-descendant.pid');
      mkdirSync(bin);
      writeFileSync(
        join(bin, 'bun'),
        `#!/bin/sh\nif [ "$1" = "--version" ]; then echo fixture-bun; exit 0; fi\necho 'Installing package @fixture/shared-stall@3.4.5' >&2\nsleep 0.1\necho 'postinstall setup active' >&2\nsleep 30 >/dev/null 2>&1 & echo $! > '${pidFile}'\nwait\n`,
      );
      chmodSync(join(bin, 'bun'), 0o755);
      const started = performance.now();
      const module = new URL('./shared-dependencies.ts', import.meta.url).href;
      const source = `import { installShared } from ${JSON.stringify(module)}; try { installShared(process.cwd(), ${JSON.stringify(stores)}, { startupMs: 2_000, runMs: 2_000, budgetMs: 350, terminationMs: 500 }); } catch (error) { console.error(String(error)); process.exitCode = 1; }`;
      const childEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GOAL_')));
      const child = Bun.spawn([process.execPath, '-e', source], {
        cwd: a,
        env: { ...childEnv, PATH: `${bin}:${process.env.PATH ?? ''}` },
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      const failure = `${stdout}${stderr}`;
      expect(code).not.toBe(0);
      expect(failure).toContain('ETIMEDOUT: Infrastructure failure');
      expect(failure).toContain('phase=run');
      expect(failure).toContain('bun install --frozen-lockfile --backend=copyfile');
      expect(failure).toContain('package="@fixture/shared-stall"');
      expect(performance.now() - started).toBeLessThan(1_500);

      expect(readdirSync(stores).filter((name) => /^[a-f0-9]{64}$/.test(name))).toEqual([]);
      expect(readdirSync(stores).filter((name) => name.startsWith('.building-'))).toEqual([]);
      expect(readdirSync(join(stores, '.leases'))).toEqual([]);
      await expectProcessStopped(Number(readFileSync(pidFile, 'utf8').trim()));
    } finally {
      h.close();
    }
  },
  10_000,
);

test('an install without node_modules/.bun stays private and publishes no store', async () => {
  const h = fixture();
  try {
    const a = h.tree('a'),
      stores = join(h.root, 'stores'),
      bin = join(h.root, 'bin');
    mkdirSync(bin);
    writeFileSync(
      join(bin, 'bun'),
      '#!/bin/sh\nif [ "$1" = "--version" ]; then echo fixture-bun; exit 0; fi\nmkdir -p node_modules\n',
    );
    chmodSync(join(bin, 'bun'), 0o755);
    const module = new URL('./shared-dependencies.ts', import.meta.url).href;
    const source = `import { installShared } from ${JSON.stringify(module)}; installShared(process.cwd(), ${JSON.stringify(stores)});`;
    const childEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GOAL_')));
    const child = Bun.spawn([process.execPath, '-e', source], {
      cwd: a,
      env: { ...childEnv, PATH: `${bin}:${process.env.PATH ?? ''}` },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(await child.exited).toBe(0);
    expect(existsSync(join(a, 'node_modules', '.goal-private-dependencies'))).toBe(true);
    expect(readdirSync(stores).filter((name) => /^[a-f0-9]{64}$/.test(name))).toEqual([]);
    expect(lstatSyncSafe(join(a, 'node_modules', '.bun'))).toBe(false);
  } finally {
    h.close();
  }
});

function lstatSyncSafe(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

test('concurrent first uses of the same key build one shared store', async () => {
  const h = fixture();
  try {
    const a = h.tree('a'),
      b = h.tree('b'),
      stores = join(h.root, 'stores'),
      bin = join(h.root, 'bin'),
      counter = join(h.root, 'builds');
    mkdirSync(bin);
    writeFileSync(
      join(bin, 'bun'),
      `#!/bin/sh\nif [ "$1" = "--version" ]; then echo fixture-bun; exit 0; fi\necho build >> ${counter}\nsleep 0.2\nmkdir -p node_modules/.bun/pkg/node_modules/pkg node_modules/@test\necho package > node_modules/.bun/pkg/node_modules/pkg/data\nln -s "$(pwd)/packages/sample" node_modules/@test/sample\n`,
    );
    chmodSync(join(bin, 'bun'), 0o755);
    const module = new URL('./shared-dependencies.ts', import.meta.url).href;
    const source = `import { installShared } from ${JSON.stringify(module)}; installShared(process.cwd(), ${JSON.stringify(stores)});`;
    const childEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GOAL_')));
    const options = {
      env: { ...childEnv, PATH: `${bin}:${process.env.PATH ?? ''}` },
      stdout: 'pipe' as const,
      stderr: 'pipe' as const,
    };
    const children = [a, b].map((cwd) => Bun.spawn([process.execPath, '-e', source], { ...options, cwd }));
    const results = await Promise.all(
      children.map(async (child) => ({ code: await child.exited, stderr: await new Response(child.stderr).text() })),
    );
    expect(results).toEqual([
      { code: 0, stderr: '' },
      { code: 0, stderr: '' },
    ]);
    expect(readFileSync(counter, 'utf8').trim().split('\n')).toHaveLength(1);
    expect(readlinkSync(join(a, 'node_modules/.bun'))).toBe(readlinkSync(join(b, 'node_modules/.bun')));
  } finally {
    h.close();
  }
});

test('dependency keys include all workspace manifests and the lockfile', () => {
  const h = fixture();
  try {
    const a = h.tree('a');
    const initial = dependencyKey(a);
    expect(dependencyKey(a)).toBe(initial);
    writeFileSync(join(a, 'packages/sample/package.json'), JSON.stringify({ name: '@test/a', version: '2.0.0' }));
    expect(dependencyKey(a)).not.toBe(initial);
    writeFileSync(join(a, 'bun.lock'), `${readFileSync(join(a, 'bun.lock'), 'utf8')}\n`);
    expect(dependencyKey(a)).not.toBe(initial);
    const b = h.tree('b');
    expect(dependencyKey(b)).toBe(initial);
  } finally {
    h.close();
  }
});

test('pruning removes only unused stores older than 24 hours and keeps the newest three', () => {
  const h = fixture();
  try {
    const root = join(h.root, 'stores');
    const worktrees = join(h.root, 'trees');
    mkdirSync(root);
    mkdirSync(worktrees);
    const stores = ['1'.repeat(64), '2'.repeat(64), '3'.repeat(64), '4'.repeat(64), '5'.repeat(64)];
    stores.forEach((key) => mkdirSync(join(root, key, 'node_modules', '.bun'), { recursive: true }));
    const tree = join(worktrees, 'a');
    mkdirSync(join(tree, 'node_modules'), { recursive: true });
    symlinkSync(join(root, stores[0]!, 'node_modules', '.bun'), join(tree, 'node_modules', '.bun'), 'dir');
    const old = Date.now() - 25 * 60 * 60 * 1000;
    for (let i = 0; i < stores.length; i++) {
      const date = new Date(old + i * 1000);
      const path = join(root, stores[i]!);
      Bun.spawnSync(['touch', '-d', date.toISOString(), path]);
    }
    pruneStores(root, worktrees);
    expect(existsSync(join(root, stores[0]!))).toBe(true);
    expect(existsSync(join(root, stores[1]!))).toBe(false);
    expect(stores.filter((key) => existsSync(join(root, key)))).toHaveLength(4);
  } finally {
    h.close();
  }
});

test('a sealed store keeps package binaries executable and refuses writes', () => {
  const h = fixture();
  try {
    const bin = join(h.root, 'store', 'pkg', 'bin');
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, 'tool'), '#!/bin/sh\necho ran\n');
    chmodSync(join(bin, 'tool'), 0o755);
    writeFileSync(join(bin, 'data.json'), '{}');
    chmodSync(join(bin, 'data.json'), 0o644);
    sealReadOnly(join(h.root, 'store'));
    expect(lstatSync(join(bin, 'tool')).mode & 0o777).toBe(0o555);
    expect(lstatSync(join(bin, 'data.json')).mode & 0o777).toBe(0o444);
    expect(new TextDecoder().decode(Bun.spawnSync([join(bin, 'tool')]).stdout)).toBe('ran\n');
    expect(() => writeFileSync(join(bin, 'data.json'), 'changed')).toThrow();
  } finally {
    h.close();
  }
});

test('a worktree on a shared store gets each workspace its own dependency links', () => {
  const h = fixture();
  try {
    const stores = join(h.root, 'stores');
    const tree = (name: string) => {
      const path = h.tree(name);
      mkdirSync(join(path, 'packages', 'other'), { recursive: true });
      writeFileSync(join(path, 'packages/other/package.json'), JSON.stringify({ name: '@test/other', version: '1.0.0' }));
      writeFileSync(
        join(path, 'packages/sample/package.json'),
        JSON.stringify({ name: '@test/sample', version: '1.0.0', dependencies: { '@test/other': 'workspace:*' } }),
      );
      const lock = Bun.spawnSync(['bun', 'install', '--lockfile-only'], { cwd: path });
      if (lock.exitCode !== 0) throw new Error(new TextDecoder().decode(lock.stderr));
      return path;
    };
    const a = tree('a'),
      b = tree('b');
    installShared(a, stores);
    installShared(b, stores);
    expect(lstatSync(join(b, 'node_modules/.bun')).isSymbolicLink()).toBe(true);
    expect(realpathSync(join(b, 'packages/sample/node_modules/@test/other'))).toBe(resolve(b, 'packages/other'));
  } finally {
    h.close();
  }
});

test('pruning stores reads only each worktree top-level dependency link, not the worktrees trees', () => {
  const h = fixture();
  try {
    const stores = join(h.root, 'stores');
    const worktrees = join(h.root, 'worktrees');
    const used = join(stores, 'a'.repeat(64));
    const unused = join(stores, 'b'.repeat(64));
    mkdirSync(join(used, 'node_modules', '.bun'), { recursive: true });
    mkdirSync(join(unused, 'node_modules', '.bun'), { recursive: true });
    mkdirSync(join(worktrees, 'task', 'node_modules'), { recursive: true });
    symlinkSync(join(used, 'node_modules', '.bun'), join(worktrees, 'task', 'node_modules', '.bun'));
    // A deep tree inside a worktree must not be walked: an unreadable directory there would throw if it were.
    mkdirSync(join(worktrees, 'task', 'deep', 'sealed'), { recursive: true });
    chmodSync(join(worktrees, 'task', 'deep', 'sealed'), 0o000);
    const old = Date.now() + 48 * 3_600_000;
    pruneStores(stores, worktrees, old);
    chmodSync(join(worktrees, 'task', 'deep', 'sealed'), 0o755);
    expect(existsSync(used)).toBe(true);
  } finally {
    h.close();
  }
});
