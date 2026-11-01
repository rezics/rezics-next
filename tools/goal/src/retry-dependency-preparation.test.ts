import { expect, test } from 'bun:test';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { dependencyInstallationMatches, installPrivate, installShared } from './shared-dependencies.ts';
import { harness, reading } from './test-support.ts';
import { git, WorkerTasks } from './tasks.ts';
import type { Task } from './types.ts';

const manifestPath = 'packages/definitions/package.json';
function manifest(version: string) {
  return JSON.stringify({ name: '@fixture/definitions', private: true, dependencies: { alpha: version } });
}

/** All package/process effects are deterministic and confined to this owned fixture. No registry or model runs. */
function fixture() {
  const h = harness();
  const previousPath = process.env.PATH;
  const bin = join(h.root, '.temp/fake-bin');
  const installs = join(h.root, '.temp/installs');
  const fail = join(h.root, '.temp/fail-install');
  const stall = join(h.root, '.temp/stall-install');
  mkdirSync(bin, { recursive: true });
  writeFileSync(
    join(bin, 'bun'),
    `#!${process.execPath}
import { appendFileSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
if (process.argv.includes('--version')) { console.log('fixture-bun'); process.exit(0); }
if (process.argv.includes('--lockfile-only')) { writeFileSync('bun.lock', 'generated lock\\n'); process.exit(0); }
appendFileSync(${JSON.stringify(installs)}, process.cwd() + '\\n');
if (existsSync(${JSON.stringify(fail)})) { console.error('fixture install failure'); process.exit(23); }
if (existsSync(${JSON.stringify(stall)})) { console.error('installing alpha@1.0.0'); setInterval(() => {}, 1000); await new Promise(() => {}); }
const root = process.cwd();
const link = (target, path) => { mkdirSync(dirname(path), { recursive: true }); symlinkSync(relative(dirname(path), target), path); };
mkdirSync('node_modules/.bun', { recursive: true });
for (const dir of ['', 'packages/definitions']) {
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  for (const [name, version] of Object.entries({ ...pkg.dependencies, ...pkg.devDependencies })) {
    const target = join(root, 'node_modules/.bun', name + '@' + version, 'node_modules', name);
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, 'package.json'), JSON.stringify({ name, version }));
    link(target, join(root, dir, 'node_modules', name));
  }
}
link(join(root, 'packages/definitions'), join(root, 'node_modules/@fixture/definitions'));
`,
  );
  chmodSync(join(bin, 'bun'), 0o755);
  process.env.PATH = `${bin}:${previousPath ?? ''}`;
  writeFileSync(join(h.root, manifestPath), manifest('1.0.0'));
  writeFileSync(join(h.root, 'bun.lock'), 'initial lock\n');
  git(h.root, ['add', '.']);
  git(h.root, ['commit', '-qm', 'Initial dependency manifests']);
  git(h.root, ['branch', 'dev', 'main']);
  h.settings.derivedFiles = [];
  const launches: { task: Task; session: string | undefined; conflicts: string }[] = [];
  const tasks = new WorkerTasks(
    h.settings,
    h.store,
    reading,
    async (store, task, attempt, _pool, _prompt, _codex, session) => {
      const conflicts = git(task.worktree, ['diff', '--name-only', '--diff-filter=U']);
      if (!conflicts) expect(dependencyInstallationMatches(task.worktree)).toBe(true);
      launches.push({ task, session, conflicts });
      store.updateAttempt(attempt, (current) => {
        current.state = 'exited';
        current.session = 'paid-session';
        current.exitCode = 0;
        current.endedAt = new Date().toISOString();
      });
      store.updateTask(attempt, (current) => {
        current.state = 'stopped';
      });
      return { attempt: store.attempt(attempt), exited: Promise.resolve({ code: 0, signal: null }) };
    },
  );
  const count = () => (existsSync(installs) ? readFileSync(installs, 'utf8').trim().split('\n').length : 0);
  const commit = (tree: string, path: string, content: string) => {
    writeFileSync(join(tree, path), content);
    git(tree, ['add', path]);
    git(tree, ['commit', '-qm', 'Paid source']);
    return git(tree, ['rev-parse', 'HEAD']);
  };
  const advance = (change: (tree: string) => void) => {
    const tree = join(h.root, '.temp/advance');
    git(h.root, ['worktree', 'add', '--detach', tree, 'dev']);
    change(tree);
    git(h.root, ['update-ref', 'refs/heads/dev', git(tree, ['rev-parse', 'HEAD'])]);
    git(h.root, ['worktree', 'remove', '--force', tree]);
  };
  const stores = join(dirname(h.settings.worktreeRoot), 'dependency-stores');
  return {
    ...h,
    tasks,
    launches,
    count,
    commit,
    advance,
    fail,
    stall,
    stores,
    close() {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      // The fixture owns its sealed stores; make only these temporary directories removable.
      const writable = (path: string) => {
        if (!existsSync(path) || lstatSync(path).isSymbolicLink()) return;
        if (lstatSync(path).isDirectory()) {
          chmodSync(path, 0o755);
          for (const name of readdirSync(path)) writable(join(path, name));
        }
      };
      writable(h.root);
      h.dispose();
    },
  };
}

test('healthy shared installations reuse their store; missing or stale workspace links refresh only owned skeletons', () => {
  const h = fixture();
  try {
    const a = h.tasks.dispatch(h.briefFile),
      b = h.tasks.dispatch(h.briefFile);
    expect(h.count()).toBe(1);
    const store = readlinkSync(join(a.worktree, 'node_modules/.bun'));
    const inode = lstatSync(join(a.worktree, 'node_modules/.bun')).ino;
    installShared(a.worktree, h.stores);
    expect(lstatSync(join(a.worktree, 'node_modules/.bun')).ino).toBe(inode);
    expect(h.count()).toBe(1);
    rmSync(join(a.worktree, 'packages/definitions/node_modules'), { recursive: true });
    expect(dependencyInstallationMatches(a.worktree)).toBe(false);
    installShared(a.worktree, h.stores);
    expect(dependencyInstallationMatches(a.worktree)).toBe(true);
    expect(readlinkSync(join(a.worktree, 'node_modules/.bun'))).toBe(store);
    expect(dependencyInstallationMatches(b.worktree)).toBe(true);
    expect(h.count()).toBe(1);
    const stale = join(a.worktree, '.temp/stale-alpha');
    mkdirSync(stale, { recursive: true });
    writeFileSync(join(stale, 'package.json'), '{"name":"alpha","version":"0.0.0"}');
    const edge = join(a.worktree, 'packages/definitions/node_modules/alpha');
    rmSync(edge);
    symlinkSync(stale, edge);
    expect(dependencyInstallationMatches(a.worktree)).toBe(false);
    installShared(a.worktree, h.stores);
    expect(dependencyInstallationMatches(a.worktree)).toBe(true);
    expect(h.count()).toBe(1);
    h.commit(a.worktree, manifestPath, manifest('2.0.0'));
    installShared(a.worktree, h.stores);
    expect(h.count()).toBe(2);
    expect(lstatSync(join(a.worktree, 'node_modules/.bun')).isSymbolicLink()).toBe(false);
    expect(
      JSON.parse(readFileSync(join(a.worktree, 'packages/definitions/node_modules/alpha/package.json'), 'utf8'))
        .version,
    ).toBe('2.0.0');
    expect(
      JSON.parse(readFileSync(join(b.worktree, 'packages/definitions/node_modules/alpha/package.json'), 'utf8'))
        .version,
    ).toBe('1.0.0');
    expect(realpathSync(join(b.worktree, 'node_modules/.bun'))).toBe(store);
  } finally {
    h.close();
  }
});

test('an incomplete same-key store with a .bun directory falls back to owned private preparation', () => {
  const h = fixture();
  try {
    const task = h.tasks.dispatch(h.briefFile);
    const packages = readlinkSync(join(task.worktree, 'node_modules/.bun'));
    const store = dirname(dirname(packages));
    rmSync(join(store, 'packages/definitions/node_modules'), { recursive: true });
    // The package bytes are still sealed and present; this is a missing store skeleton, not a new cache key.
    expect(existsSync(packages)).toBe(true);
    expect(dependencyInstallationMatches(task.worktree)).toBe(false);
    installShared(task.worktree, h.stores);
    expect(h.count()).toBe(2);
    expect(lstatSync(join(task.worktree, 'node_modules/.bun')).isSymbolicLink()).toBe(false);
    expect(dependencyInstallationMatches(task.worktree)).toBe(true);
    expect(existsSync(packages)).toBe(true);
    expect(existsSync(join(store, 'packages/definitions/node_modules'))).toBe(false);
  } finally {
    h.close();
  }
});

test('a matching private receipt also needs usable links and explicit private installs stay private', () => {
  const h = fixture();
  try {
    const task = h.tasks.dispatch(h.briefFile);
    installPrivate(task.worktree);
    const count = h.count();
    installShared(task.worktree, h.stores);
    expect(h.count()).toBe(count);
    rmSync(join(task.worktree, 'packages/definitions/node_modules/alpha'));
    expect(dependencyInstallationMatches(task.worktree)).toBe(false);
    installShared(task.worktree, h.stores);
    expect(h.count()).toBe(count + 1);
    const stale = join(task.worktree, 'node_modules/.bun/stale/node_modules/alpha');
    mkdirSync(stale, { recursive: true });
    writeFileSync(join(stale, 'package.json'), '{"name":"alpha","version":"0.0.0"}');
    const edge = join(task.worktree, 'packages/definitions/node_modules/alpha');
    rmSync(edge);
    symlinkSync(stale, edge);
    // The final key/receipt is unchanged, and the wrong package exists: presence alone is insufficient.
    expect(dependencyInstallationMatches(task.worktree)).toBe(false);
    installShared(task.worktree, h.stores);
    expect(h.count()).toBe(count + 2);
    expect(lstatSync(join(task.worktree, 'node_modules/.bun')).isSymbolicLink()).toBe(false);
    expect(dependencyInstallationMatches(task.worktree)).toBe(true);
  } finally {
    h.close();
  }
});

test('an ordinary same-base paid resume prepares final manifests and preserves session and failure history', async () => {
  const h = fixture();
  try {
    const task = h.tasks.dispatch(h.briefFile);
    await h.tasks.retry(task.id);
    const oldAttempt = h.store.attempt({ taskId: task.id, attempt: 1 });
    mkdirSync(oldAttempt.evidencePath, { recursive: true });
    const failure = join(oldAttempt.evidencePath, 'failure.json');
    writeFileSync(failure, '{"kind":"tool","detail":"old missing module"}\n');
    h.store.event(oldAttempt, 'old-failure', { error: 'missing module' });
    const paid = h.commit(task.worktree, manifestPath, manifest('2.0.0'));
    await h.tasks.retry(task.id);
    expect(h.count()).toBe(2);
    expect(h.launches.at(-1)?.session).toBe('paid-session');
    expect(h.store.task(task.id).base).toBe(task.base);
    expect(git(task.worktree, ['rev-parse', 'HEAD'])).toBe(paid);
    expect(readFileSync(failure, 'utf8')).toBe('{"kind":"tool","detail":"old missing module"}\n');
    expect(h.store.events(task.id, 1).some((event) => event.kind === 'old-failure')).toBe(true);
    const count = h.count();
    await h.tasks.retry(task.id);
    expect(h.count()).toBe(count);
  } finally {
    h.close();
  }
});

test('An ordinary resumed task launches only after its final resolved source manifests match a usable dependency installation, including after rebase conflict resolution and an unchanged recorded base', async () => {
  const h = fixture();
  try {
    const task = h.tasks.dispatch(h.briefFile);
    await h.tasks.retry(task.id);
    const paid = h.commit(task.worktree, manifestPath, manifest('2.0.0'));
    h.advance((tree) => {
      h.commit(tree, manifestPath, manifest('3.0.0'));
    });
    await h.tasks.retry(task.id);
    expect(h.launches.at(-1)?.conflicts).toContain(manifestPath);
    expect(h.count()).toBe(1);
    const base = h.store.task(task.id).base;
    writeFileSync(join(task.worktree, manifestPath), manifest('4.0.0'));
    git(task.worktree, ['add', manifestPath]);
    git(task.worktree, ['-c', 'core.editor=true', 'rebase', '--continue']);
    const resolved = git(task.worktree, ['rev-parse', 'HEAD']);
    await h.tasks.retry(task.id);
    expect(h.count()).toBe(2);
    expect(h.store.task(task.id).base).toBe(base);
    expect(git(task.worktree, ['rev-parse', 'HEAD'])).toBe(resolved);
    expect(git(task.worktree, ['show', `${paid}:${manifestPath}`])).toBe(manifest('2.0.0'));
    expect(h.launches.at(-1)?.conflicts).toBe('');
    expect(h.launches.at(-1)?.session).toBe('paid-session');
  } finally {
    h.close();
  }
});

test('a lockfile-only rebase generator does not skip final dependency installation', async () => {
  const h = fixture();
  try {
    const task = h.tasks.dispatch(h.briefFile);
    await h.tasks.retry(task.id);
    h.commit(task.worktree, manifestPath, manifest('2.0.0'));
    h.commit(task.worktree, 'bun.lock', 'paid lock\n');
    h.advance((tree) => {
      h.commit(tree, 'bun.lock', 'integration lock\n');
    });
    h.settings.derivedFiles = [
      { path: 'bun.lock', stage: 'integration', command: ['bun', 'install', '--lockfile-only'] },
    ];
    await h.tasks.retry(task.id);
    expect(readFileSync(join(task.worktree, 'bun.lock'), 'utf8')).toBe('generated lock\n');
    expect(h.count()).toBe(2);
    expect(h.launches.at(-1)?.conflicts).toBe('');
  } finally {
    h.close();
  }
});

test('failed bounded preparation prevents a model launch without losing paid source or claiming a receipt', async () => {
  const h = fixture();
  try {
    const task = h.tasks.dispatch(h.briefFile);
    await h.tasks.retry(task.id);
    const paid = h.commit(task.worktree, manifestPath, manifest('2.0.0'));
    writeFileSync(h.fail, 'fail');
    await expect(h.tasks.retry(task.id)).rejects.toThrow('fixture install failure');
    expect(h.launches).toHaveLength(1);
    expect(git(task.worktree, ['rev-parse', 'HEAD'])).toBe(paid);
    expect(existsSync(join(task.worktree, 'node_modules/.goal-private-dependencies'))).toBe(false);
    expect(h.store.attempt({ taskId: task.id, attempt: 2 })).toMatchObject({ failureKind: 'tool', exitCode: -1 });
    expect(h.store.events(task.id, 2).some((event) => event.kind === 'launch-failed')).toBe(true);
  } finally {
    h.close();
  }
});

test('shared module refresh fails before launch while a live peer holds dependency custody', async () => {
  const h = fixture();
  try {
    h.settings.sharedWebModules = { sample: ['result.txt'] };
    const peer = h.tasks.dispatch(h.briefFile);
    await h.tasks.retry(peer.id);
    const task = h.tasks.dispatch(h.briefFile);
    h.store.updateAttempt({ taskId: peer.id, attempt: 1 }, (attempt) => {
      attempt.state = 'running';
    });
    h.commit(task.worktree, manifestPath, manifest('2.0.0'));
    const link = readlinkSync(join(task.worktree, 'node_modules/.bun'));
    await expect(h.tasks.retry(task.id)).rejects.toThrow(`workspace custody held by task ${peer.id}`);
    expect(h.launches).toHaveLength(1);
    expect(h.count()).toBe(1);
    expect(readlinkSync(join(task.worktree, 'node_modules/.bun'))).toBe(link);
  } finally {
    h.close();
  }
});

test('a stalled fake installer obeys existing process limits and leaves no usable private receipt', () => {
  const h = fixture();
  try {
    const task = h.tasks.dispatch(h.briefFile);
    h.commit(task.worktree, manifestPath, manifest('2.0.0'));
    writeFileSync(h.stall, 'stall');
    expect(() =>
      installShared(task.worktree, h.stores, { startupMs: 1_000, runMs: 100, budgetMs: 1_000, terminationMs: 500 }),
    ).toThrow('ETIMEDOUT');
    expect(dependencyInstallationMatches(task.worktree)).toBe(false);
    expect(existsSync(join(task.worktree, 'node_modules/.goal-private-dependencies'))).toBe(false);
  } finally {
    h.close();
  }
});

import { createHash } from 'node:crypto';
import { renameSync } from 'node:fs';
import { CHECK_COMPATIBILITY_CONTRACT, checkPinnedBunInstallation } from './check-compatibility.ts';
import { dependencyKey, sealReadOnly } from './shared-dependencies.ts';

/** Synthetic trusted artifacts exercise the real custody reader without downloading or executing a real toolchain. */
function pinnedFixture() {
  const h = fixture();
  const artifacts = CHECK_COMPATIBILITY_CONTRACT.workerCheck.bun.artifacts;
  const platform = `${process.platform}-${process.arch}`;
  const platformPackage = '@fixture/preparation-bun';
  const pins = ['0.0.0-preparation-old', '0.0.0-preparation-new'];
  const packages = Object.fromEntries(
    pins.map((label) => {
      const revision = `fixture-revision-${label}`;
      const executable = `#!/bin/sh\nif [ "$1" = "--version" ]; then echo fixture-runtime; else echo ${revision}; fi\n`;
      const artifact = {
        packageVersion: `${label}+build`,
        runtimeVersion: 'fixture-runtime',
        runtimeRevision: revision,
        packageIntegrity: `sha512-fixture-${label}`,
        packageTarball: 'unused-fixture',
        platforms: {
          [platform]: {
            package: platformPackage,
            integrity: `sha512-fixture-platform-${label}`,
            tarball: 'unused-fixture',
            executable: 'bin/bun',
            executableSha256: createHash('sha256').update(executable).digest('hex'),
          },
        },
      };
      artifacts[`bun@${label}`] = artifact;
      return [label, { artifact, executable }];
    }),
  );
  const installedOverride = join(h.root, '.temp/installed-pin');
  const installs = join(h.root, '.temp/installs');
  const installer = join(h.root, '.temp/fake-bin/bun');
  writeFileSync(
    installer,
    `#!${process.execPath}
import { appendFileSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
if (process.argv.includes('--version')) { console.log('fixture-bun'); process.exit(0); }
appendFileSync(${JSON.stringify(installs)}, process.cwd() + '\\n');
if (existsSync(${JSON.stringify(h.fail)})) { console.error('fixture install failure'); process.exit(23); }
const packages = ${JSON.stringify(packages)};
const root = process.cwd();
const override = ${JSON.stringify(installedOverride)};
const link = (target, path) => { mkdirSync(dirname(path), { recursive: true }); symlinkSync(relative(dirname(path), target), path); };
mkdirSync('node_modules/.bun', { recursive: true });
for (const dir of ['', 'packages/definitions']) {
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  for (const [name, declared] of Object.entries({ ...pkg.dependencies, ...pkg.devDependencies })) {
    const label = name === 'bun' && existsSync(override) ? readFileSync(override, 'utf8') : declared;
    const target = join(root, 'node_modules/.bun', name + '@' + label, 'node_modules', name);
    mkdirSync(target, { recursive: true });
    if (name === 'bun') {
      const { artifact, executable } = packages[label];
      const platformPackage = ${JSON.stringify(platformPackage)};
      const native = join(root, 'node_modules/.bun/native-' + label, 'node_modules', platformPackage);
      mkdirSync(native, { recursive: true });
      writeFileSync(join(native, 'package.json'), JSON.stringify({ name: platformPackage, version: artifact.packageVersion }));
      link(native, join(target, 'node_modules', platformPackage));
      writeFileSync(join(target, 'package.json'), JSON.stringify({ name, version: artifact.packageVersion,
        bin: { bun: 'bin/bun.exe' }, optionalDependencies: { [platformPackage]: artifact.packageVersion } }));
      mkdirSync(join(target, 'bin'));
      // Model the supported optimizeBun moved layout: the optional package retains its metadata and dependency edge.
      writeFileSync(join(target, 'bin/bun.exe'), executable, { mode: 0o755 });
      link(join(target, 'bin/bun.exe'), join(root, 'node_modules/.bin/bun'));
    } else writeFileSync(join(target, 'package.json'), JSON.stringify({ name, version: label }));
    link(target, join(root, dir, 'node_modules', name));
  }
}
link(join(root, 'packages/definitions'), join(root, 'node_modules/@fixture/definitions'));
`,
  );
  const source = (tree: string, label: string) => {
    const artifact = packages[label]!.artifact;
    const manifest = JSON.parse(readFileSync(join(tree, 'package.json'), 'utf8'));
    manifest.packageManager = `bun@${label}`;
    manifest.devDependencies = { ...manifest.devDependencies, bun: label };
    writeFileSync(join(tree, 'package.json'), JSON.stringify(manifest));
    writeFileSync(
      join(tree, 'bun.lock'),
      JSON.stringify({
        workspaces: { '': { devDependencies: { bun: label } } },
        packages: {
          bun: [`bun@${label}`, artifact.packageIntegrity],
          [platformPackage]: [`${platformPackage}@${label}`, artifact.platforms[platform]!.integrity],
        },
      }),
    );
    git(tree, ['add', 'package.json', 'bun.lock']);
    git(tree, ['commit', '-qm', 'Paid declared runtime source']);
    return git(tree, ['rev-parse', 'HEAD']);
  };
  source(h.root, pins[0]!);
  git(h.root, ['branch', '-f', 'dev', 'main']);
  return {
    ...h,
    old: pins[0]!,
    next: pins[1]!,
    source,
    installedOverride,
    seedStore(binary?: string) {
      // Seed an already published wrong location, before any consumers use it. Never modify sealed package bytes.
      const store = join(h.stores, dependencyKey(h.root));
      mkdirSync(join(store, 'packages/definitions'), { recursive: true });
      for (const path of ['package.json', 'bun.lock', manifestPath])
        writeFileSync(join(store, path), readFileSync(join(h.root, path)));
      const result = Bun.spawnSync([installer, 'install'], { cwd: store });
      if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
      if (binary !== undefined) writeFileSync(realpathSync(join(store, 'node_modules/.bin/bun')), binary);
      sealReadOnly(join(store, 'node_modules/.bun'));
      return store;
    },
    close() {
      for (const pin of pins) delete artifacts[`bun@${pin}`];
      h.close();
    },
  };
}

test('declared new Bun replaces the old installation on a same-base paid resume and leaves its peer immutable', async () => {
  const h = pinnedFixture();
  try {
    const task = h.tasks.dispatch(h.briefFile),
      peer = h.tasks.dispatch(h.briefFile);
    await h.tasks.retry(task.id);
    const oldBinary = realpathSync(join(peer.worktree, 'node_modules/.bin/bun'));
    const oldBytes = readFileSync(oldBinary);
    const paid = h.source(task.worktree, h.next);
    expect(dependencyInstallationMatches(task.worktree)).toBe(false);
    const count = h.count();
    await h.tasks.retry(task.id);
    expect(h.count()).toBe(count + 1);
    expect(git(task.worktree, ['rev-parse', 'HEAD'])).toBe(paid);
    expect(h.store.task(task.id).base).toBe(task.base);
    expect(h.launches.at(-1)?.session).toBe('paid-session');
    expect(checkPinnedBunInstallation(task.worktree).filter((check) => check.status === 'incompatible')).toEqual([]);
    expect(readFileSync(oldBinary)).toEqual(oldBytes);
    expect(realpathSync(join(peer.worktree, 'node_modules/.bin/bun'))).toBe(oldBinary);
    expect(dependencyInstallationMatches(peer.worktree)).toBe(true);
    await h.tasks.retry(task.id);
    expect(h.count()).toBe(count + 1);
    expect(lstatSync(join(task.worktree, 'node_modules/.bun')).isSymbolicLink()).toBe(false);
  } finally {
    h.close();
  }
});

test('same-key wrong Bun package metadata takes the owned private path without changing the published store', () => {
  const h = pinnedFixture();
  try {
    h.source(h.root, h.next);
    git(h.root, ['branch', '-f', 'dev', 'main']);
    writeFileSync(h.installedOverride, h.old);
    const store = h.seedStore();
    const packagePath = realpathSync(join(store, 'node_modules/bun/package.json'));
    const binaryPath = realpathSync(join(store, 'node_modules/.bin/bun'));
    const metadata = readFileSync(packagePath),
      bytes = readFileSync(binaryPath);
    rmSync(h.installedOverride);
    const count = h.count();
    const task = h.tasks.dispatch(h.briefFile);
    expect(h.count()).toBe(count + 1);
    expect(dependencyInstallationMatches(task.worktree)).toBe(true);
    expect(lstatSync(join(task.worktree, 'node_modules/.bun')).isSymbolicLink()).toBe(false);
    expect(readFileSync(packagePath)).toEqual(metadata);
    expect(readFileSync(binaryPath)).toEqual(bytes);
    expect(JSON.parse(readFileSync(join(store, 'package.json'), 'utf8')).packageManager).toBe(`bun@${h.next}`);
  } finally {
    h.close();
  }
});

test('same-key wrong materialized Bun bin refreshes only the consumer skeleton and healthy immutable reuse installs nothing', async () => {
  const h = pinnedFixture();
  try {
    const task = h.tasks.dispatch(h.briefFile),
      peer = h.tasks.dispatch(h.briefFile);
    await h.tasks.retry(task.id);
    const key = dependencyKey(task.worktree);
    const count = h.count();
    const correctBinary = realpathSync(join(peer.worktree, 'node_modules/.bin/bun'));
    const correctBytes = readFileSync(correctBinary);
    const wrongBinary = join(h.root, '.temp/old-bin');
    writeFileSync(wrongBinary, '#!/bin/sh\necho stale-runtime\n', { mode: 0o755 });
    rmSync(join(task.worktree, 'node_modules/.bin/bun'));
    symlinkSync(wrongBinary, join(task.worktree, 'node_modules/.bin/bun'));
    expect(dependencyKey(task.worktree)).toBe(key);
    expect(dependencyInstallationMatches(task.worktree)).toBe(false);
    await h.tasks.retry(task.id);
    expect(h.count()).toBe(count);
    expect(realpathSync(join(task.worktree, 'node_modules/.bin/bun'))).toBe(correctBinary);
    expect(readFileSync(correctBinary)).toEqual(correctBytes);
    expect(dependencyInstallationMatches(peer.worktree)).toBe(true);
    const inode = lstatSync(join(task.worktree, 'node_modules/.bun')).ino;
    await h.tasks.retry(task.id);
    expect(lstatSync(join(task.worktree, 'node_modules/.bun')).ino).toBe(inode);
    expect(h.count()).toBe(count);
  } finally {
    h.close();
  }
});

test('successful installer with the wrong Bun identity leaves exact preparation evidence and no launch or receipt', async () => {
  const h = pinnedFixture();
  try {
    const task = h.tasks.dispatch(h.briefFile);
    await h.tasks.retry(task.id);
    const paid = h.source(task.worktree, h.next);
    writeFileSync(h.installedOverride, h.old);
    await expect(h.tasks.retry(task.id)).rejects.toThrow('workerCheck.bun.packages');
    expect(h.launches).toHaveLength(1);
    expect(git(task.worktree, ['rev-parse', 'HEAD'])).toBe(paid);
    expect(existsSync(join(task.worktree, 'node_modules/.goal-private-dependencies'))).toBe(false);
    const failed = h.store.attempt({ taskId: task.id, attempt: 2 });
    expect(failed).toMatchObject({ failureKind: 'tool', exitCode: -1 });
    expect(failed.result).toContain('workerCheck.bun.executable');
    expect(failed.result).toContain('workerCheck.bun.revision');
    expect(failed.result).toContain(`fixture-revision-${h.next}`);
    expect(failed.result).toContain(`fixture-revision-${h.old}`);
    expect(dependencyInstallationMatches(task.worktree)).toBe(false);
  } finally {
    h.close();
  }
});

test('a same-key store with stale source metadata or wrong binary bytes stays immutable during private recovery', () => {
  for (const defect of ['source', 'binary']) {
    const h = pinnedFixture();
    try {
      let store = h.seedStore(defect === 'binary' ? '#!/bin/sh\necho stale-runtime\n' : undefined);
      if (defect === 'source') {
        h.source(h.root, h.next);
        git(h.root, ['branch', '-f', 'dev', 'main']);
        const keyedLocation = join(h.stores, dependencyKey(h.root));
        // Model an older published store under the new key before exposing it to any consumers.
        renameSync(store, keyedLocation);
        store = keyedLocation;
      }
      const manifest = readFileSync(join(store, 'package.json'));
      const executable = realpathSync(join(store, 'node_modules/.bin/bun'));
      const bytes = readFileSync(executable);
      const count = h.count();
      const task = h.tasks.dispatch(h.briefFile);
      expect(h.count()).toBe(count + 1);
      expect(dependencyInstallationMatches(task.worktree)).toBe(true);
      expect(lstatSync(join(task.worktree, 'node_modules/.bun')).isSymbolicLink()).toBe(false);
      expect(readFileSync(join(store, 'package.json'))).toEqual(manifest);
      expect(readFileSync(executable)).toEqual(bytes);
      expect(lstatSync(executable).mode & 0o222).toBe(0);
    } finally {
      h.close();
    }
  }
});

test('a matching private receipt cannot certify a changed Bun executable lookup', async () => {
  const h = pinnedFixture();
  try {
    const task = h.tasks.dispatch(h.briefFile);
    await h.tasks.retry(task.id);
    installPrivate(task.worktree);
    const receipt = readFileSync(join(task.worktree, 'node_modules/.goal-private-dependencies'), 'utf8');
    const wrong = join(h.root, '.temp/wrong-private-bin');
    writeFileSync(wrong, '#!/bin/sh\necho stale-runtime\n', { mode: 0o755 });
    rmSync(join(task.worktree, 'node_modules/.bin/bun'));
    symlinkSync(wrong, join(task.worktree, 'node_modules/.bin/bun'));
    expect(readFileSync(join(task.worktree, 'node_modules/.goal-private-dependencies'), 'utf8')).toBe(receipt);
    expect(dependencyInstallationMatches(task.worktree)).toBe(false);
    const count = h.count();
    await h.tasks.retry(task.id);
    expect(h.count()).toBe(count + 1);
    expect(dependencyInstallationMatches(task.worktree)).toBe(true);
    expect(lstatSync(join(task.worktree, 'node_modules/.bun')).isSymbolicLink()).toBe(false);
  } finally {
    h.close();
  }
});
