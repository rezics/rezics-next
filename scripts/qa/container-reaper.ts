import { spawnSync } from 'node:child_process';
import { accessSync, constants, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

/** Containers started for QA carry this label. Compose stacks and the dev stack do not. */
export const reapOwnerLabel = 'rezics.reap-owner';
const dockerTimeoutMs = 30_000;

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

function resolveRealDocker(pathValue: string | undefined): string | undefined {
  const shim = dockerShimDirectory();
  for (const directory of (pathValue ?? '').split(':')) {
    if (!directory || directory === shim) continue;
    const candidate = resolve(directory, 'docker');
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch { /* keep looking */ }
  }
  return undefined;
}

/** Shim first on PATH, the real docker binary, and this process as owner unless one was already assigned. */
export function reapOwnerEnvironment(env: NodeJS.ProcessEnv, pid = process.pid): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = { ...env };
  const real = next.REZICS_REAL_DOCKER || resolveRealDocker(env.PATH);
  if (!real) return next;
  next.REZICS_REAL_DOCKER = real;
  const shim = dockerShimDirectory();
  const directories = (next.PATH ?? '').split(':').filter(directory => directory && directory !== shim);
  next.PATH = [shim, ...directories].join(':');
  if (!next.REZICS_REAP_OWNER) {
    const start = processStartTime(pid);
    if (start) next.REZICS_REAP_OWNER = `${pid}:${start}`;
  }
  return next;
}

function dockerOutput(args: string[]): string | undefined {
  const result = spawnSync('docker', args, { encoding: 'utf8', timeout: dockerTimeoutMs });
  if (result.error || result.status !== 0) return undefined;
  return result.stdout ?? '';
}

function containerIds(stdout: string): string[] {
  return stdout.split('\n').map(id => id.trim()).filter(id => /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(id));
}

export function removeOwnedContainers(owner: string): void {
  if (!owner) return;
  const listed = dockerOutput(['ps', '-aq', '--filter', `label=${reapOwnerLabel}=${owner}`]);
  if (listed === undefined) return;
  const ids = containerIds(listed);
  if (ids.length) spawnSync('docker', ['rm', '-f', ...ids], { encoding: 'utf8', timeout: dockerTimeoutMs });
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

// Bun's unit-gate preload. The test process records itself so a killed shard is a dead owner.
if (process.env.REZICS_REAP_PRELOAD === '1') {
  const environment = reapOwnerEnvironment(process.env);
  if (environment.PATH) process.env.PATH = environment.PATH;
  if (environment.REZICS_REAL_DOCKER) process.env.REZICS_REAL_DOCKER = environment.REZICS_REAL_DOCKER;
  if (environment.REZICS_REAP_OWNER) process.env.REZICS_REAP_OWNER = environment.REZICS_REAP_OWNER;
  const owner = process.env.REZICS_REAP_OWNER;
  if (owner) process.on('exit', () => {
    try { removeOwnedContainers(owner); } catch { /* the process is already leaving */ }
  });
}
