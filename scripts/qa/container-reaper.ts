import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { accessSync, closeSync, constants, openSync, readFileSync, readSync, realpathSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

/** Containers started for QA carry this label. Compose stacks and the dev stack do not. */
export const reapOwnerLabel = 'rezics.reap-owner';
/**
 * Key prefix. Each scope in a runner chain is its own label, `rezics.reap-scope.<id>=1`,
 * so removing an ancestor matches every descendant container however deep.
 * Siblings are not on each other's chain.
 */
export const reapScopeLabel = 'rezics.reap-scope';
/** First line of scripts/qa/docker-shim/docker. PATH search skips every docker file that carries it. */
const dockerShimMarker = '# rezics-docker-shim';
const dockerTimeoutMs = 30_000;
/** dockerd can commit a container after the client is gone and the first list has returned. */
export const reapSettleMs = 1_000;

export function settleReap(): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, reapSettleMs);
}

/** Repository path of the executable placed first on a test process PATH. */
export const dockerShimExecutable = 'scripts/qa/docker-shim/docker';

export function dockerShimDirectory(): string {
  return resolve(import.meta.dir, '..', '..', dirname(dockerShimExecutable));
}

/** Clock ticks since boot, field 22 of /proc/pid/stat. The command name can contain spaces, so count after the last ')'. */
export function processStartTime(pid: number): string | undefined {
  if (!Number.isInteger(pid) || pid < 1) return undefined;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const start = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
    return start && /^\d+$/.test(start) ? start : undefined;
  } catch {
    return undefined;
  }
}

/** The labelled process still exists and is the same process, not a pid the kernel has reused. */
export function reapOwnerAlive(owner: string): boolean {
  const match = /^(\d+):(\d+)$/.exec(owner);
  if (!match) return false;
  return processStartTime(Number(match[1])) === match[2];
}

function canonicalDirectory(directory: string): string | undefined {
  try { return realpathSync(directory); } catch { return undefined; }
}

function isDockerShimFile(candidate: string): boolean {
  let opened: number | undefined;
  try {
    if (!statSync(candidate).isFile()) return false;
    opened = openSync(candidate, 'r');
    const buffer = Buffer.alloc(512);
    const count = readSync(opened, buffer, 0, buffer.length, 0);
    return buffer.subarray(0, count).includes(dockerShimMarker);
  } catch {
    return false;
  } finally {
    if (opened !== undefined) closeSync(opened);
  }
}

/** An executable named docker whose file is not a shim from this or another worktree. */
function dockerAfterShim(pathValue: string | undefined): string | undefined {
  for (const directory of (pathValue ?? '').split(':')) {
    if (!directory) continue;
    const candidate = resolve(directory, 'docker');
    try {
      if (!statSync(candidate).isFile()) continue;
      accessSync(candidate, constants.X_OK);
    } catch { continue; }
    if (isDockerShimFile(candidate)) continue;
    return candidate;
  }
  return undefined;
}

/** Inherited chain, then the id just minted. The new id is what this runner removes. */
export function reapScopeChain(inherited: string | undefined, scope: string): string {
  const prior = (inherited ?? '').split(',').map(part => part.trim()).filter(part => part.length > 0 && part !== scope);
  return [...prior, scope].join(',');
}

/** Shim first on PATH, and this process as owner unless one was already assigned. */
export function reapOwnerEnvironment(env: NodeJS.ProcessEnv, pid = process.pid): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = { ...env };
  delete next.REZICS_REAL_DOCKER;
  if (!dockerAfterShim(env.PATH)) return next;
  const shim = dockerShimDirectory();
  const shimCanonical = canonicalDirectory(shim);
  const directories = (next.PATH ?? '').split(':').filter(directory => directory && canonicalDirectory(directory) !== shimCanonical);
  next.PATH = [shim, ...directories].join(':');
  if (!next.REZICS_REAP_OWNER) {
    const start = processStartTime(pid);
    if (start) next.REZICS_REAP_OWNER = `${pid}:${start}`;
  }
  return next;
}

export function newReapScope(): string {
  return randomUUID();
}

/**
 * Owner stays whatever the caller already had. The new scope is appended to the
 * inherited chain, so this child's containers also carry every ancestor scope.
 */
export function reapChildEnvironment(env: NodeJS.ProcessEnv, pid = process.pid): NodeJS.ProcessEnv {
  const next = reapOwnerEnvironment(env, pid);
  if (!dockerAfterShim(next.PATH)) return next;
  const scope = newReapScope();
  next.REZICS_REAP_SCOPE = scope;
  next.REZICS_REAP_SCOPES = reapScopeChain(env.REZICS_REAP_SCOPES, scope);
  return next;
}

/** `createdOwner` is set only for the process that minted the owner value. */
export function reapOwnerAssignment(env: NodeJS.ProcessEnv, pid = process.pid): {
  environment: NodeJS.ProcessEnv; createdOwner?: string;
} {
  const inherited = Boolean(env.REZICS_REAP_OWNER);
  const environment = reapOwnerEnvironment(env, pid);
  return { environment, createdOwner: inherited ? undefined : environment.REZICS_REAP_OWNER };
}

function dockerOutput(args: string[]): string | undefined {
  const result = spawnSync('docker', args, { encoding: 'utf8', timeout: dockerTimeoutMs });
  if (result.error || result.status !== 0) return undefined;
  return result.stdout ?? '';
}

function containerIds(stdout: string): string[] {
  return stdout.split('\n').map(id => id.trim()).filter(id => /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(id));
}

function removeLabelledContainers(filter: string): void {
  const listed = dockerOutput(['ps', '-aq', '--filter', filter]);
  if (listed === undefined) return;
  const ids = containerIds(listed);
  if (ids.length) spawnSync('docker', ['rm', '-f', ...ids], { encoding: 'utf8', timeout: dockerTimeoutMs });
}

export function removeOwnedContainers(owner: string): void {
  if (!owner) return;
  removeLabelledContainers(`label=${reapOwnerLabel}=${owner}`);
}

export function removeScopedContainers(scope: string): void {
  if (!scope) return;
  removeLabelledContainers(`label=${reapScopeLabel}.${scope}`);
}

/** A finished or timed-out child. The owner label is not a filter: siblings share it. */
export function reapChildScope(env: NodeJS.ProcessEnv): void {
  if (!env.REZICS_REAP_SCOPE) return;
  removeScopedContainers(env.REZICS_REAP_SCOPE);
}

const activeChildScopes = new Set<string>();

/** Remember a scope this runner minted for a child that is still running. */
export function noteChildScope(scope: string | undefined): void {
  if (scope) activeChildScopes.add(scope);
}

export function forgetChildScope(scope: string | undefined): void {
  if (scope) activeChildScopes.delete(scope);
}

/**
 * Cancellation skips the child's finally block. Remove only the scopes this
 * process still has in flight, then look again after dockerd has had a moment.
 */
export function reapActiveChildScopes(): void {
  const scopes = [...activeChildScopes];
  if (!scopes.length) return;
  for (const scope of scopes) activeChildScopes.delete(scope);
  for (const scope of scopes) removeScopedContainers(scope);
  settleReap();
  for (const scope of scopes) removeScopedContainers(scope);
}

/** Exit of the process that minted the owner. A nested runner passes no owner and removes nothing. */
export function reapCreatedOwner(createdOwner: string | undefined): void {
  if (!createdOwner) return;
  removeOwnedContainers(createdOwner);
}

/** Remove containers whose labelled process is gone or has a different start time. Unlabelled containers are never listed. */
export function sweepOrphanContainers(): void {
  const listed = dockerOutput(['ps', '-aq', '--filter', `label=${reapOwnerLabel}`]);
  if (listed === undefined) return;
  const stale: string[] = [];
  for (const id of containerIds(listed)) {
    const owner = dockerOutput(['inspect', '--format', `{{index .Config.Labels "${reapOwnerLabel}"}}`, id]);
    if (owner === undefined) continue;
    if (!reapOwnerAlive(owner.trim())) stale.push(id);
  }
  if (stale.length) spawnSync('docker', ['rm', '-f', ...stale], { encoding: 'utf8', timeout: dockerTimeoutMs });
}

function adoptReapEnvironment(environment: NodeJS.ProcessEnv): void {
  if (environment.PATH) process.env.PATH = environment.PATH;
  delete process.env.REZICS_REAL_DOCKER;
  if (environment.REZICS_REAP_OWNER) process.env.REZICS_REAP_OWNER = environment.REZICS_REAP_OWNER;
}

/**
 * Every runner, including one that inherited its owner, drops the scopes it minted
 * for children that are still running. Owner-wide removal stays with the minter.
 */
export function bindReapOwnerExit(env: NodeJS.ProcessEnv = process.env): void {
  const assigned = reapOwnerAssignment(env);
  adoptReapEnvironment(assigned.environment);
  const createdOwner = assigned.createdOwner;
  process.on('exit', () => {
    try {
      reapActiveChildScopes();
      if (!createdOwner) return;
      reapCreatedOwner(createdOwner);
      settleReap();
      reapCreatedOwner(createdOwner);
    } catch { /* the process is already leaving */ }
  });
}

// Bun's unit-gate preload. A shard that inherited its owner must not remove the ancestor's containers.
if (process.env.REZICS_REAP_PRELOAD === '1') bindReapOwnerExit();
