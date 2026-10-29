import { createHash, randomUUID } from 'node:crypto';
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  chmodSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { acquireDirectoryLeaseWaiting } from './lease.ts';

const hour = 60 * 60 * 1000;
function manifestPaths(root: string): string[] {
  const packageFile = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
    workspaces?: string[] | { packages?: string[] };
  };
  const patterns = Array.isArray(packageFile.workspaces)
    ? packageFile.workspaces
    : (packageFile.workspaces?.packages ?? []);
  const paths = ['package.json', 'bun.lock', 'bunfig.toml'];
  for (const pattern of patterns) {
    const wildcard = pattern.indexOf('*');
    const parent = wildcard < 0 ? pattern : pattern.slice(0, wildcard).replace(/\/$/, '');
    const dirs = wildcard < 0 ? [parent] : readdirSync(join(root, parent)).map((name) => join(parent, name));
    for (const dir of dirs) if (existsSync(join(root, dir, 'package.json'))) paths.push(join(dir, 'package.json'));
  }
  return paths.filter((path) => existsSync(join(root, path))).sort();
}
function patchPaths(root: string): string[] {
  const packageFile = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
    patchedDependencies?: Record<string, string>;
  };
  return Object.values(packageFile.patchedDependencies ?? {}).map((path) => join(root, path));
}
export function dependencyKey(root: string): string {
  const hash = createHash('sha256').update(spawnSync('bun', ['--version'], { encoding: 'utf8' }).stdout.trim());
  for (const path of manifestPaths(root))
    hash
      .update(path)
      .update('\0')
      .update(readFileSync(join(root, path)))
      .update('\0');
  return hash.digest('hex');
}
function runInstall(root: string, shared = false): void {
  const args = ['install', '--frozen-lockfile', ...(shared ? ['--backend=copyfile'] : [])];
  const result = spawnSync('bun', args, { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  if (result.status !== 0)
    throw new Error(
      `Dependency install failed in ${root}: ${result.stderr || result.error?.message || `bun exited ${result.status}`}`,
    );
}
/** Workspace directories (relative to root) that have a package.json. */
function workspaceDirs(root: string): string[] {
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
    workspaces?: string[] | { packages?: string[] };
  };
  const patterns = Array.isArray(manifest.workspaces) ? manifest.workspaces : (manifest.workspaces?.packages ?? []);
  const result: string[] = [];
  for (const pattern of patterns) {
    const wildcard = pattern.indexOf('*');
    const parent = wildcard < 0 ? pattern : pattern.slice(0, wildcard).replace(/\/$/, '');
    if (!existsSync(join(root, parent))) continue;
    const dirs = wildcard < 0 ? [parent] : readdirSync(join(root, parent)).map((name) => join(parent, name));
    for (const dir of dirs) if (existsSync(join(root, dir, 'package.json'))) result.push(dir);
  }
  return result;
}
function localWorkspaceLinks(root: string): void {
  for (const dir of workspaceDirs(root)) {
    const name = (JSON.parse(readFileSync(join(root, dir, 'package.json'), 'utf8')) as { name?: string }).name;
    if (!name) continue;
    const link = join(root, 'node_modules', name);
    if (existsSync(link) || lstatSyncSafe(link)) continue;
    mkdirSync(dirname(link), { recursive: true });
    symlinkSync(join(root, dir), link, 'dir');
  }
}
/**
 * Copies each workspace's own node_modules (its dependency links) from the store. The links are relative and reach
 * the packages through the worktree's node_modules/.bun link, so they are copied unchanged.
 */
export function copyWorkspaceSkeletons(template: string, worktree: string): void {
  for (const dir of workspaceDirs(template)) {
    const source = join(template, dir, 'node_modules');
    const target = join(worktree, dir, 'node_modules');
    if (!existsSync(source) || lstatSyncSafe(target) || !existsSync(join(worktree, dir))) continue;
    cpSync(source, target, { recursive: true, dereference: false, verbatimSymlinks: true });
  }
}
function lstatSyncSafe(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}
function ignoreNodeModules(worktree: string): void {
  const nodeModules = join(worktree, 'node_modules');
  mkdirSync(nodeModules, { recursive: true });
  writeFileSync(join(nodeModules, '.gitignore'), '*\n');
}
function removeBuild(path: string): void {
  if (!existsSync(path)) return;
  const makeWritable = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const child = join(dir, entry.name);
      if (entry.isDirectory() && !entry.isSymbolicLink()) makeWritable(child);
      else if (!entry.isSymbolicLink()) chmodSync(child, 0o644);
    }
    chmodSync(dir, 0o755);
  };
  makeWritable(path);
  rmSync(path, { recursive: true, force: true });
}
function copySkeleton(template: string, worktree: string): void {
  const source = join(template, 'node_modules');
  const target = join(worktree, 'node_modules');
  cpSync(source, target, {
    recursive: true,
    dereference: false,
    filter: (path) => resolve(path) !== resolve(source, '.bun'),
  });
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) {
        const link = readlinkSync(path);
        const abs = resolve(dirname(path), link);
        if (abs === resolve(template) || abs.startsWith(resolve(template) + '/')) {
          const next = relative(template, abs);
          rmSync(path);
          symlinkSync(resolve(worktree, next), path, 'dir');
        }
      } else if (stat.isDirectory()) walk(path);
    }
  };
  walk(target);
  symlinkSync(join(template, 'node_modules', '.bun'), join(target, '.bun'), 'dir');
  copyWorkspaceSkeletons(template, worktree);
  localWorkspaceLinks(worktree);
}
export function installPrivate(worktree: string): void {
  const nodeModules = join(worktree, 'node_modules');
  rmSync(nodeModules, { recursive: true, force: true });
  runInstall(worktree);
  localWorkspaceLinks(worktree);
  ignoreNodeModules(worktree);
  writeFileSync(join(nodeModules, '.goal-private-dependencies'), dependencyKey(worktree));
}
/** Removes write permission below `path` and keeps each file's execute bits, so package binaries still run. */
export function sealReadOnly(path: string): void {
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) sealReadOnly(child);
    else if (!entry.isSymbolicLink()) chmodSync(child, statSync(child).mode & 0o555);
  }
  chmodSync(path, 0o555);
}

export function installShared(worktree: string, storeRoot = join(dirname(worktree), '..', 'dependency-stores')): void {
  if (!existsSync(join(worktree, 'package.json'))) return;
  const key = dependencyKey(worktree);
  const prior = readlinkStore(worktree);
  const marker = join(worktree, 'node_modules', '.goal-private-dependencies');
  if (existsSync(marker)) {
    if (readFileSync(marker, 'utf8') === key) return;
    installPrivate(worktree);
    return;
  }
  if (prior && basename(dirname(dirname(prior))) !== key) {
    installPrivate(worktree);
    return;
  }
  const store = join(storeRoot, key);
  mkdirSync(storeRoot, { recursive: true });
  const lease = acquireDirectoryLeaseWaiting(join(storeRoot, '.leases', key), 15 * 60_000);
  try {
    if (!existsSync(join(store, 'node_modules', '.bun'))) {
      if (prior) {
        installPrivate(worktree);
        return;
      }
      const temp = join(storeRoot, `.building-${key}-${randomUUID()}`);
      mkdirSync(temp, { recursive: true });
      try {
        for (const path of manifestPaths(worktree)) {
          const dest = join(temp, path);
          mkdirSync(dirname(dest), { recursive: true });
          cpSync(join(worktree, path), dest);
        }
        for (const path of patchPaths(worktree)) {
          const dest = join(temp, relative(worktree, path));
          mkdirSync(dirname(dest), { recursive: true });
          cpSync(path, dest);
        }
        runInstall(temp, true);
        if (!existsSync(join(temp, 'node_modules', '.bun'))) {
          removeBuild(temp);
          installPrivate(worktree);
          return;
        }
        sealReadOnly(join(temp, 'node_modules', '.bun'));
        rmSync(store, { recursive: true, force: true });
        renameSync(temp, store);
      } catch (error) {
        removeBuild(temp);
        throw error;
      }
    }
    const linkedStore = readlinkStore(worktree);
    if (linkedStore !== resolve(store)) {
      rmSync(join(worktree, 'node_modules'), { recursive: true, force: true });
      copySkeleton(store, worktree);
    }
    ignoreNodeModules(worktree);
  } finally {
    lease.release();
  }
}
function readlinkStore(worktree: string): string | null {
  try {
    return resolve(
      dirname(join(worktree, 'node_modules', '.bun')),
      readlinkSync(join(worktree, 'node_modules', '.bun')),
    );
  } catch {
    return null;
  }
}
export function pruneStores(storeRoot: string, worktreeRoot: string, now = Date.now()): void {
  if (!existsSync(storeRoot)) return;
  const stores = readdirSync(storeRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^[a-f0-9]{64}$/.test(entry.name))
    .map((entry) => join(storeRoot, entry.name));
  const used = new Set<string>();
  // Only a worktree's own node_modules/.bun links a store. Walking every worktree's whole tree (hundreds of private
  // node_modules) on each host sweep blocked the manager host in directory reads for minutes on 10-29.
  if (existsSync(worktreeRoot))
    for (const entry of readdirSync(worktreeRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const link = join(worktreeRoot, entry.name, 'node_modules', '.bun');
      try {
        if (lstatSync(link).isSymbolicLink()) used.add(resolve(dirname(link), readlinkSync(link)));
      } catch {}
    }
  const ordered = stores.sort((a, b) => lstatSync(b).mtimeMs - lstatSync(a).mtimeMs);
  const keep = new Set(ordered.slice(0, 3));
  for (const store of stores)
    if (
      !used.has(join(store, 'node_modules', '.bun')) &&
      !keep.has(store) &&
      now - lstatSync(store).mtimeMs >= 24 * hour
    )
      rmSync(store, { recursive: true, force: true });
}
