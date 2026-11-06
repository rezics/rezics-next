#!/usr/bin/env bun
/**
 * One OpenSSH ControlMaster per configured check host, shared by every remote-check SSH and rsync path.
 *
 * Sockets live under a short owned directory: `$XDG_RUNTIME_DIR/rezics-ssh/<host>`, or `/tmp/rezics-ssh-<uid>/<host>`
 * when the runtime directory is unset (`REMOTE_CHECK_SSH_CONTROL_DIR` overrides). OpenSSH's unix_listener adds a
 * `.XXXXXXXXXX` suffix, so a path at or over 97 bytes fails; a long override or runtime directory relocates to a
 * hashed `/tmp/rs<uid>-<digest>` that still names one socket per host. Concurrent callers reuse that master.
 * Completing a run never `-O exit`s it, and a failed probe never does either: a socket is removed only when `-O check`
 * reports its listener refused.
 */
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const CONTROL_MASTER = 'auto';
export const CONTROL_PERSIST = '10m';
export const SSH_CONTROL_DIR_MODE = 0o700;
/**
 * ConnectTimeout bounds only the TCP connect; banner exchange, key exchange and authentication run unbounded. A cold
 * master on a loaded check host took 57 s on 2026-11-06, so the probe waits well past that before it gives up.
 */
export const DEFAULT_CONTROL_PROBE_TIMEOUT_MS = 90_000;
/** Bounds a local `-O check`; a timeout is not evidence that the master is gone. */
const CONTROL_CHECK_TIMEOUT_MS = 5_000;
/** Linux `sockaddr_un.sun_path` length, including the trailing NUL OpenSSH writes. */
export const UNIX_LISTENER_PATH_LIMIT = 108;
/** OpenSSH `unix_listener` temporary suffix `.XXXXXXXXXX`. */
export const UNIX_LISTENER_TMP_SUFFIX = 11;
/** Longest configured host name (`a-zA-Z0-9` plus hyphen, 64 characters after the first). */
export const SSH_HOST_NAME_MAX = 64;

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

/** True when OpenSSH can bind `path` and its temporary suffix inside `sun_path`. */
export function unixListenerFits(path: string): boolean {
  return Buffer.byteLength(path) + UNIX_LISTENER_TMP_SUFFIX < UNIX_LISTENER_PATH_LIMIT;
}

/**
 * Short owned directory that holds one control socket per configured host.
 * `runtimeDirectory` is `$XDG_RUNTIME_DIR`; without it the socket lives under `/tmp/rezics-ssh-<uid>`.
 */
export function controlSocketDirectoryPath(
  runtimeDirectory: string | undefined,
  uid: number | undefined,
  fallbackId = process.pid,
): string {
  if (runtimeDirectory) {
    if (!runtimeDirectory || runtimeDirectory.includes('\0'))
      throw new Error('remote-check: SSH control directory is invalid');
    return join(resolve(runtimeDirectory), 'rezics-ssh');
  }
  return `/tmp/rezics-ssh-${uid ?? fallbackId}`;
}

function relocateIfTooLong(directory: string, uid: number): string {
  if (unixListenerFits(join(directory, 'h'.repeat(SSH_HOST_NAME_MAX)))) return directory;
  const digest = createHash('sha256').update(directory).digest('hex').slice(0, 8);
  const relocated = `/tmp/rs${uid.toString(16)}-${digest}`;
  if (!unixListenerFits(join(relocated, 'h'.repeat(SSH_HOST_NAME_MAX)))) {
    throw new Error('remote-check: SSH control directory cannot fit a Unix socket path');
  }
  return relocated;
}

/** Directory that holds one control socket per configured host name, independent of worktree path length. */
export function sshControlDirectory(workspace: string, env: NodeJS.ProcessEnv = process.env): string {
  void workspace;
  const uid = unixUserId();
  const configured = env.REMOTE_CHECK_SSH_CONTROL_DIR;
  if (configured) {
    if (!configured || configured.includes('\0')) throw new Error('remote-check: SSH control directory is invalid');
    return relocateIfTooLong(resolve(configured), uid);
  }
  return relocateIfTooLong(controlSocketDirectoryPath(env.XDG_RUNTIME_DIR, uid), uid);
}

export function hostControlSocketPath(directory: string, hostName: string): string {
  if (!HOST_NAME.test(hostName)) throw new Error(`remote-check: SSH control host name is invalid: ${hostName}`);
  const path = join(directory, hostName);
  if (!unixListenerFits(path)) {
    throw new Error(
      `remote-check: SSH ControlPath exceeds the Unix socket path limit (${UNIX_LISTENER_PATH_LIMIT} bytes with OpenSSH's temporary suffix): ${path}`,
    );
  }
  return path;
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

/** The short, user-owned directory the sockets live in, created on first use. */
function relocatedControlDirectory(directory: string): string {
  return ensureSshControlDirectory(relocateIfTooLong(directory, unixUserId()));
}

/** OpenSSH options for every operational SSH and rsync path, including probes, polling, heartbeat and cleanup. */
export function sshControlOptions(host: SshControlHost, directory: string): string[] {
  const root = relocatedControlDirectory(directory);
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

/** OpenSSH warns about a stale socket and then connects directly; the warning is not the failure. */
const MULTIPLEX_WARNING = /disabling multiplexing/;

function probeFailureDetail(output: string, code: number | null): string {
  const lines = output
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .filter(Boolean);
  const line = lines.find((entry) => !MULTIPLEX_WARNING.test(entry)) ?? lines[0];
  if (line) return line;
  if (code === null) return 'control probe timed out';
  return `exit ${code}`;
}

/**
 * Removes a control socket that no master listens on. OpenSSH leaves the file behind when its master is killed, and
 * ControlMaster=auto then cannot bind the path again ("already exists, disabling multiplexing"): every later connection
 * is a full handshake until someone removes the file. Only a refused or missing listener qualifies; a timed-out check
 * leaves a possibly live master alone.
 */
async function removeDeadControlSocket(host: SshControlHost, directory: string): Promise<boolean> {
  const root = relocatedControlDirectory(directory);
  const path = hostControlSocketPath(root, host.name);
  try {
    if (!lstatSync(path).isSocket()) return false;
  } catch {
    return false;
  }
  const result = await masterControl(host, root, 'check', CONTROL_CHECK_TIMEOUT_MS);
  if (result.code === 0 || !/Connection refused|No such file or directory/.test(result.output)) return false;
  rmSync(path, { force: true });
  return true;
}

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
    return { code: 255, output: await output };
  }
  return { code, output: await output };
}

/** True when the host's persisted master is alive and accepting multiplexed sessions. */
export async function hostMasterIsLive(host: SshControlHost, directory: string, timeoutMs = 1_000): Promise<boolean> {
  const result = await masterControl(host, directory, 'check', timeoutMs);
  return result.code === 0;
}

/**
 * Drop only a stale or lost master. Live masters stay up so other runs keep their connection.
 * OpenSSH `-O exit` is a no-op once the socket is already gone.
 */
export async function dropStaleHostMaster(host: SshControlHost, directory: string, timeoutMs = 1_000): Promise<void> {
  if (await hostMasterIsLive(host, directory, timeoutMs)) return;
  await masterControl(host, directory, 'exit', timeoutMs);
  await removeDeadControlSocket(host, directory);
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
  const root = relocatedControlDirectory(directory);
  const started = performance.now();
  let recovered = await removeDeadControlSocket(host, root);
  let lastDetail = 'control probe failed';
  for (let attempt = 0; attempt < 2; attempt += 1) {
    // A failed probe does not make the master dead: a busy master times out too, and `-O exit` would cut every run
    // multiplexed through it. Only a socket whose listener refused is removed before the retry.
    if (attempt === 1) recovered = (await removeDeadControlSocket(host, root)) || recovered;
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
      lastDetail = probeFailureDetail(await output, null);
      if (attempt === 1)
        throw new Error(`remote-check: connection to ${host.name} failed during control probe: ${lastDetail}`);
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
    lastDetail = probeFailureDetail(text, code);
    if (attempt === 1) {
      throw new Error(`remote-check: connection to ${host.name} failed during control probe: ${lastDetail}`);
    }
  }
  throw new Error(`remote-check: connection to ${host.name} failed during control probe: ${lastDetail}`);
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
