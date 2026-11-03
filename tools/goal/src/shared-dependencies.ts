import { createHash, randomUUID, type Hash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
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
import { BoundedProcessError, runBoundedInstallProcess, type ProcessLimits } from './install-process.ts';
import { checkPinnedBunInstallation } from './check-compatibility.ts';

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
function patchInputs(root: string) {
  const packageFile = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
    patchedDependencies?: Record<string, string>;
  };
  return Object.values(packageFile.patchedDependencies ?? {})
    .map((declaredPath) => {
      const path = relative(root, join(root, declaredPath));
      try {
        return { path, contents: readFileSync(join(root, declaredPath)) };
      } catch (cause) {
        throw new DependencyInstallError(
          root,
          'reading dependency patches',
          new Error(`required patch ${path} could not be read`, { cause }),
        );
      }
    })
    .sort((left, right) => left.path.localeCompare(right.path));
}
function dependencyKeyWithPatches(root: string, patches: ReturnType<typeof patchInputs>): string {
  const hash = createHash('sha256').update(spawnSync('bun', ['--version'], { encoding: 'utf8' }).stdout.trim());
  for (const path of manifestPaths(root))
    hash
      .update(path)
      .update('\0')
      .update(readFileSync(join(root, path)))
      .update('\0');
  for (const patch of patches) hash.update(patch.path).update('\0').update(patch.contents).update('\0');
  return hash.digest('hex');
}
export function dependencyKey(root: string): string {
  return dependencyKeyWithPatches(root, patchInputs(root));
}
export class DependencyInstallError extends Error {
  readonly infrastructure = true;
  readonly step: string;
  readonly workspace: string;
  readonly packageName: string | undefined;

  constructor(root: string, step: string, cause: unknown) {
    super(`Infrastructure failure: dependency install failed in ${root}: ${String(cause)}`, { cause });
    this.name = 'DependencyInstallError';
    this.step = cause instanceof BoundedProcessError ? cause.step : step;
    this.workspace = cause instanceof BoundedProcessError ? cause.workspace : root;
    this.packageName = cause instanceof BoundedProcessError ? cause.packageName : undefined;
  }
}

function runInstall(root: string, shared = false, limits?: Partial<ProcessLimits>): void {
  const args = ['install', '--frozen-lockfile', ...(shared ? ['--backend=copyfile'] : [])];
  const step = `bun ${args.join(' ')}`;
  try {
    runBoundedInstallProcess({
      command: 'bun',
      args,
      cwd: root,
      step,
      purpose: 'preparation',
      ...(limits ? { limits } : {}),
    });
  } catch (error) {
    throw new DependencyInstallError(root, step, error);
  }
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
/** Only inspect direct manifest edges and workspace links, never walk the installed package graph. */
function dependencyLinksMatch(worktree: string, template?: string, identity?: Hash): boolean {
  const installed = (root: string, dir: string, name: string): { path: string; target: string } | undefined => {
    let current = join(root, dir);
    for (;;) {
      const candidate = join(current, 'node_modules', name);
      if (existsSync(candidate)) return { path: relative(root, candidate), target: realpathSync(candidate) };
      if (current === root) return undefined;
      current = dirname(current);
    }
  };
  const remap = (path: string): string => {
    if (!template || path.startsWith(join(template, 'node_modules', '.bun') + '/')) return path;
    return path === template || path.startsWith(template + '/') ? resolve(worktree, relative(template, path)) : path;
  };
  for (const dir of ['', ...workspaceDirs(worktree)]) {
    const manifest = JSON.parse(readFileSync(join(worktree, dir, 'package.json'), 'utf8')) as {
      name?: string;
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
    };
    if (dir && manifest.name && installed(worktree, '', manifest.name)?.target !== realpathSync(join(worktree, dir)))
      return false;
    const optional = manifest.optionalDependencies ?? {};
    const names = new Set([
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.devDependencies ?? {}),
      ...Object.keys(optional),
    ]);
    for (const name of names) {
      const actual = installed(worktree, dir, name);
      if (actual && !existsSync(join(actual.target, 'package.json'))) return false;
      if (identity) {
        identity.update(JSON.stringify([dir, name, actual ?? null]));
        if (actual) {
          const manifest = join(actual.target, 'package.json');
          identity.update(readFileSync(manifest)).update('\0');
        }
      }
      if (template) {
        const expected = installed(template, dir, name);
        if (
          expected
            ? actual?.path !== expected.path || actual.target !== remap(expected.target)
            : !(name in optional) || actual !== undefined
        )
          return false;
      } else if (!(name in optional) && !actual) return false;
    }
  }
  return true;
}

function privateReceipt(worktree: string, key: string): string | null {
  const identity = createHash('sha256');
  return dependencyLinksMatch(worktree, undefined, identity)
    ? JSON.stringify({ key, links: identity.digest('hex') })
    : null;
}

/** Use the consumer's artifact/installed-layout contract; never infer a declared pin from the old executable. */
function bunInstallationFailure(root: string): string | undefined {
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
    packageManager?: string;
    devDependencies?: { bun?: string };
  };
  if (!manifest.packageManager?.startsWith('bun@') && manifest.devDependencies?.bun === undefined) return;
  const failures = checkPinnedBunInstallation(root).filter((check) => check.status === 'incompatible');
  if (failures.length)
    return failures
      .map((check) => `${check.field}: ${check.detail} ${JSON.stringify(check.evidence ?? {})}`)
      .join('\n');
}

function requireUsableInstallation(root: string, step: string): void {
  const failure = bunInstallationFailure(root);
  if (failure || !dependencyLinksMatch(root))
    throw new DependencyInstallError(root, step, failure ?? 'required direct dependency links are missing');
}

/** A receipt/key alone is insufficient: the consumer's direct dependency links must still be usable. */
export function dependencyInstallationMatches(worktree: string, expectedKey?: string): boolean {
  if (!existsSync(join(worktree, 'package.json'))) return true;
  const key = expectedKey ?? dependencyKey(worktree);
  const prior = readlinkStore(worktree);
  const marker = join(worktree, 'node_modules', '.goal-private-dependencies');
  if (bunInstallationFailure(worktree)) return false;
  if (existsSync(marker)) {
    const receipt = prior ? null : privateReceipt(worktree, key);
    return receipt !== null && readFileSync(marker, 'utf8') === receipt;
  }
  if (!prior || basename(dirname(dirname(prior))) !== key || !existsSync(prior)) return false;
  const template = dirname(dirname(prior));
  return dependencyStoreMatches(template, key) && dependencyLinksMatch(worktree, template);
}

/** Validate a published immutable dependency store itself, without accepting a consumer's receipt as proof. */
export function dependencyStoreMatches(store: string, expectedKey: string): boolean {
  try {
    return (
      basename(resolve(store)) === expectedKey &&
      existsSync(join(store, 'package.json')) &&
      dependencyKey(store) === expectedKey &&
      !bunInstallationFailure(store) &&
      dependencyLinksMatch(store)
    );
  } catch {
    return false;
  }
}

function removeWorkspaceSkeletons(worktree: string): void {
  for (const dir of workspaceDirs(worktree))
    rmSync(join(worktree, dir, 'node_modules'), { recursive: true, force: true });
}

export function installPrivate(worktree: string, limits?: Partial<ProcessLimits>): void {
  const nodeModules = join(worktree, 'node_modules');
  rmSync(nodeModules, { recursive: true, force: true });
  removeWorkspaceSkeletons(worktree);
  runInstall(worktree, false, limits);
  localWorkspaceLinks(worktree);
  ignoreNodeModules(worktree);
  requireUsableInstallation(worktree, 'validating installed dependency identity');
  const receipt = privateReceipt(worktree, dependencyKey(worktree));
  if (!receipt)
    throw new DependencyInstallError(
      worktree,
      'validating installed dependency links',
      'required direct dependency links are missing',
    );
  writeFileSync(join(nodeModules, '.goal-private-dependencies'), receipt);
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

/** Keep published skeleton links relocatable, including absolute workspace links emitted by an installer. */
function relativizeSkeletons(root: string): void {
  const walk = (dir: string) => {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (path === join(root, 'node_modules', '.bun')) continue;
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) {
        const target = resolve(dirname(path), readlinkSync(path));
        if (target.startsWith(root + '/')) {
          rmSync(path);
          symlinkSync(relative(dirname(path), target), path, 'dir');
        }
      } else if (stat.isDirectory()) walk(path);
    }
  };
  for (const dir of ['', ...workspaceDirs(root)]) walk(join(root, dir, 'node_modules'));
}

export function installShared(
  worktree: string,
  storeRoot = join(dirname(worktree), '..', 'dependency-stores'),
  processLimits?: Partial<ProcessLimits>,
): void {
  if (!existsSync(join(worktree, 'package.json'))) return;
  const patches = patchInputs(worktree);
  const key = dependencyKeyWithPatches(worktree, patches);
  if (dependencyInstallationMatches(worktree, key)) return;
  const prior = readlinkStore(worktree);
  const marker = join(worktree, 'node_modules', '.goal-private-dependencies');
  if (existsSync(marker)) {
    installPrivate(worktree, processLimits);
    return;
  }
  if (prior && basename(dirname(dirname(prior))) !== key) {
    installPrivate(worktree, processLimits);
    return;
  }
  const store = join(storeRoot, key);
  mkdirSync(storeRoot, { recursive: true });
  const lease = acquireDirectoryLeaseWaiting(join(storeRoot, '.leases', key), 15 * 60_000);
  try {
    // Any published location belongs to its existing users, even when its skeleton is incomplete.
    if (lstatSyncSafe(store) && !existsSync(join(store, 'node_modules', '.bun'))) {
      installPrivate(worktree, processLimits);
      return;
    }
    if (!lstatSyncSafe(store)) {
      if (prior) {
        installPrivate(worktree, processLimits);
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
        for (const patch of patches) {
          const dest = join(temp, patch.path);
          mkdirSync(dirname(dest), { recursive: true });
          writeFileSync(dest, patch.contents);
        }
        runInstall(temp, true, processLimits);
        if (!existsSync(join(temp, 'node_modules', '.bun'))) {
          removeBuild(temp);
          installPrivate(worktree, processLimits);
          return;
        }
        localWorkspaceLinks(temp);
        relativizeSkeletons(temp);
        requireUsableInstallation(temp, 'validating store dependency identity');
        sealReadOnly(join(temp, 'node_modules', '.bun'));
        renameSync(temp, store);
      } catch (error) {
        removeBuild(temp);
        throw error;
      }
    }
    // An incomplete old store is never repaired in place while peers may be using its sealed packages.
    if (!dependencyStoreMatches(store, key)) {
      installPrivate(worktree, processLimits);
      return;
    }
    if (!dependencyInstallationMatches(worktree)) {
      rmSync(join(worktree, 'node_modules'), { recursive: true, force: true });
      removeWorkspaceSkeletons(worktree);
      copySkeleton(store, worktree);
    }
    ignoreNodeModules(worktree);
    if (!dependencyInstallationMatches(worktree))
      throw new DependencyInstallError(
        worktree,
        'validating installed dependency links',
        'shared dependency links do not match final manifests',
      );
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
