#!/usr/bin/env bun
/**
 * One OpenSSH ControlMaster per configured check host, shared by every remote-check SSH and rsync path.
 *
 * Sockets live under `<workspace>/.temp/ssh-control/<host>` (or REMOTE_CHECK_SSH_CONTROL_DIR). Concurrent callers
 * reuse the host master. Completing a run closes only that run's channels; it never `-O exit`s a master other
 * callers still use. A stale or lost master is recovered with `-O check` then `-O exit` before the next auto
 * connection. Connection work is timed separately from admitted execution.
 */
import { chmodSync, existsSync, lstatSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const CONTROL_MASTER = 'auto';
export const CONTROL_PERSIST = '10m';
export const SSH_CONTROL_DIR_MODE = 0o700;
export const DEFAULT_CONTROL_PROBE_TIMEOUT_MS = 8_000;

export type SshControlHost = {
  readonly name: string;
  readonly address: string;
  readonly identity: string;
};

const HOST_NAME = /^[a-zA-Z0-9][a-zA-Z0-9-]{0,63}$/;

function quote(word: string): string {
  return /^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`;
}

function unixUserId(): number {
  const getuid = process.getuid;
  if (typeof getuid !== 'function') throw new Error('remote-check: SSH control directories require a Unix user id');
  return getuid.call(process);
}

/** Directory that holds one control socket per configured host name. */
export function sshControlDirectory(workspace: string, env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.REMOTE_CHECK_SSH_CONTROL_DIR;
  if (configured) {
    if (!configured || configured.includes('\0')) throw new Error('remote-check: SSH control directory is invalid');
    return resolve(configured);
  }
  return join(resolve(workspace), '.temp', 'ssh-control');
}

export function hostControlSocketPath(directory: string, hostName: string): string {
  if (!HOST_NAME.test(hostName)) throw new Error(`remote-check: SSH control host name is invalid: ${hostName}`);
  return join(directory, hostName);
}

export function ensureSshControlDirectory(directory: string, uid = unixUserId()): string {
  mkdirSync(directory, { recursive: true, mode: SSH_CONTROL_DIR_MODE });
  const info = lstatSync(directory);
  if (!info.isDirectory() || info.uid !== uid) {
    throw new Error(`remote-check: SSH control directory is not a user-owned directory: ${directory}`);
  }
  if ((info.mode & 0o777) !== SSH_CONTROL_DIR_MODE) chmodSync(directory, SSH_CONTROL_DIR_MODE);
  return directory;
}

/** OpenSSH options for every operational SSH and rsync path, including probes, polling, heartbeat and cleanup. */
export function sshControlOptions(host: SshControlHost, directory: string): string[] {
  const root = ensureSshControlDirectory(directory);
  return [
    '-i',
    host.identity,
    '-o',
    'IdentitiesOnly=yes',
    '-o',
    'BatchMode=yes',
    '-o',
    'ConnectTimeout=15',
    '-o',
    'ServerAliveInterval=15',
    '-o',
    'ServerAliveCountMax=4',
    '-o',
    `ControlMaster=${CONTROL_MASTER}`,
    '-o',
    `ControlPersist=${CONTROL_PERSIST}`,
    '-o',
    `ControlPath=${hostControlSocketPath(root, host.name)}`,
  ];
}

/** Resolve `ssh` from the current PATH so tests and callers can inject a fake without a hashed lookup. */
export function sshExecutable(env: NodeJS.ProcessEnv = process.env): string {
  for (const directory of (env.PATH ?? '').split(':')) {
    if (!directory) continue;
    const candidate = join(directory, 'ssh');
    try {
      if (existsSync(candidate) && (lstatSync(candidate).mode & 0o111) !== 0) return candidate;
    } catch {
      continue;
    }
  }
  return 'ssh';
}

export function rsyncRemoteShell(host: SshControlHost, directory: string): string {
  return [sshExecutable(), ...sshControlOptions(host, directory)].map(quote).join(' ');
}

export function sshControlArgv(
  host: SshControlHost,
  directory: string,
  operation?: 'check' | 'exit',
  command?: string,
): string[] {
  const options = sshControlOptions(host, directory);
  const ssh = sshExecutable();
  if (operation) return [ssh, '-O', operation, ...options, host.address];
  if (command === undefined) throw new Error('remote-check: SSH command is missing');
  return [ssh, ...options, host.address, command];
}

async function within<T>(timeoutMs: number, work: Promise<T>): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function stopAndReap(child: ReturnType<typeof Bun.spawn>): Promise<void> {
  try {
    child.kill('SIGTERM');
  } catch {
    // The multiplexed helper may already have exited.
  }
  if ((await within(1_000, child.exited)) !== null) return;
  try {
    child.kill('SIGKILL');
  } catch {
    // The helper is already gone.
  }
  await child.exited;
}

export type MasterControlResult = { code: number; output: string };

async function masterControl(
  host: SshControlHost,
  directory: string,
  operation: 'check' | 'exit',
  timeoutMs: number,
): Promise<MasterControlResult> {
  const child = Bun.spawn(sshControlArgv(host, directory, operation), {
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    env: process.env,
  });
  const output = Promise.all([
    new Response(child.stdout).text(),
    child.stderr instanceof ReadableStream ? new Response(child.stderr).text() : Promise.resolve(''),
  ]).then(([stdout, stderr]) => stdout + stderr);
  const code = await within(timeoutMs, child.exited);
  if (code === null) {
    await stopAndReap(child);
    await output;
    return { code: 255, output: await output };
  }
  return { code, output: await output };
}

/** True when the host's persisted master is alive and accepting multiplexed sessions. */
export async function hostMasterIsLive(
  host: SshControlHost,
  directory: string,
  timeoutMs = 1_000,
): Promise<boolean> {
  const result = await masterControl(host, directory, 'check', timeoutMs);
  return result.code === 0;
}

/**
 * Drop only a stale or lost master. Live masters stay up so other runs keep their connection.
 * OpenSSH `-O exit` is a no-op once the socket is already gone.
 */
export async function dropStaleHostMaster(
  host: SshControlHost,
  directory: string,
  timeoutMs = 1_000,
): Promise<void> {
  if (await hostMasterIsLive(host, directory, timeoutMs)) return;
  await masterControl(host, directory, 'exit', timeoutMs);
}

const CONTROL_OK = 'REMOTE_CHECK_CONTROL_OK';

export type HostControlLease = {
  readonly host: SshControlHost;
  readonly directory: string;
  readonly socketPath: string;
  readonly connectionMs: number;
};

const liveLeases = new Map<string, { count: number; host: SshControlHost; directory: string }>();

function leaseKey(directory: string, hostName: string): string {
  return `${resolve(directory)}\0${hostName}`;
}

export function activeHostControlCount(directory: string, hostName: string): number {
  return liveLeases.get(leaseKey(directory, hostName))?.count ?? 0;
}

export function reportConnectionWork(hostName: string, started: number, recovered = false): void {
  const recoveredMark = recovered ? ', recovered stale master' : '';
  console.error(
    `remote-check: connection ${((performance.now() - started) / 1000).toFixed(3)} s on ${hostName}${recoveredMark}`,
  );
}

/**
 * Verify the host master before upload or run work uses it. A dead socket is dropped once and the next auto
 * connection creates a replacement. Callers hold a lease so a completed run cannot `-O exit` a shared master.
 */
export async function acquireHostControl(
  host: SshControlHost,
  directory: string,
  timeoutMs = DEFAULT_CONTROL_PROBE_TIMEOUT_MS,
): Promise<HostControlLease> {
  const root = ensureSshControlDirectory(directory);
  const started = performance.now();
  let recovered = false;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (attempt === 1) {
      recovered = true;
      await masterControl(host, root, 'exit', 1_000);
    }
    const child = Bun.spawn(
      sshControlArgv(host, root, undefined, `# REMOTE_CHECK_CONTROL_PROBE\nprintf '${CONTROL_OK}\\n'`),
      { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', env: process.env },
    );
    const output = Promise.all([
      new Response(child.stdout).text(),
      child.stderr instanceof ReadableStream ? new Response(child.stderr).text() : Promise.resolve(''),
    ]).then(([stdout, stderr]) => stdout + stderr);
    const code = await within(timeoutMs, child.exited);
    if (code === null) {
      await stopAndReap(child);
      await output;
      if (attempt === 1) throw new Error(`remote-check: connection to ${host.name} failed during control probe`);
      continue;
    }
    const text = await output;
    if (code === 0 && text.includes(CONTROL_OK)) {
      const key = leaseKey(root, host.name);
      const held = liveLeases.get(key);
      if (held) held.count += 1;
      else liveLeases.set(key, { count: 1, host, directory: root });
      reportConnectionWork(host.name, started, recovered);
      return {
        host,
        directory: root,
        socketPath: hostControlSocketPath(root, host.name),
        connectionMs: performance.now() - started,
      };
    }
    if (attempt === 1) {
      throw new Error(`remote-check: connection to ${host.name} failed during control probe`);
    }
  }
  throw new Error(`remote-check: connection to ${host.name} failed during control probe`);
}

/**
 * Release this caller's claim on the host master. The persisted ControlMaster stays for other runs; ControlPersist
 * reaps it after idle. Never `-O exit` here.
 */
export function releaseHostControl(lease: HostControlLease): void {
  const key = leaseKey(lease.directory, lease.host.name);
  const held = liveLeases.get(key);
  if (!held) return;
  held.count -= 1;
  if (held.count <= 0) liveLeases.delete(key);
}

/** Test seam: forget in-process lease counts without touching a live OpenSSH master. */
export function resetHostControlLeases(): void {
  liveLeases.clear();
}
