#!/usr/bin/env bun
/**
 * One OpenSSH ControlMaster per configured check host, shared by every remote-check SSH and rsync path.
 *
 * Sockets live under a short owned directory: `$XDG_RUNTIME_DIR/rezics-ssh/<host>`, or `/tmp/rezics-ssh-<uid>/<host>`
 * when the runtime directory is unset (`REMOTE_CHECK_SSH_CONTROL_DIR` overrides). OpenSSH's unix_listener adds a
 * `.XXXXXXXXXX` suffix, so a path at or over 97 bytes fails; a long override or runtime directory relocates to a
 * hashed `/tmp/rs<uid>-<digest>` that still names one socket per host. Concurrent callers reuse that master.
 * Completing a run never `-O exit`s it. Only a refused or missing listener permits recovery, at most once per host per minute.
 * Recovery holds the exclusive lease flock through retirement; acquisition holds it shared before probing.
 */
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
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
/** Placement-probe recovery of one host's master is claimed at most this often, across remote-check processes. */
export const MASTER_RECOVERY_INTERVAL_MS = 60_000;
/** Consecutive placement-probe timeouts of this length report one environment event for the host. */
export const PLACEMENT_PROBE_TIMEOUT_EVENT_MS = 5 * 60_000;
const FLOCK_BUSY = 75;
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

function controlRoot(directory: string): string {
  return ensureSshControlDirectory(relocateIfTooLong(directory, unixUserId()));
}

function hostLockPath(directory: string, hostName: string, suffix: string): string {
  if (!HOST_NAME.test(hostName)) throw new Error(`remote-check: SSH control host name is invalid: ${hostName}`);
  return join(directory, `${hostName}.${suffix}`);
}

/** OpenSSH options for every operational SSH and rsync path, including probes, polling, heartbeat and cleanup. */
export function sshControlOptions(host: SshControlHost, directory: string): string[] {
  const root = controlRoot(directory);
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

export type MasterControlResult = { code: number; output: string; timedOut?: boolean };

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
  const root = controlRoot(directory);
  const path = hostControlSocketPath(root, host.name);
  try {
    if (!lstatSync(path).isSocket()) return false;
  } catch {
    return false;
  }
  const result = await masterControl(host, root, 'check', CONTROL_CHECK_TIMEOUT_MS);
  if (!deadMasterEvidence(result)) return false;
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
    return { code: 255, output: await output, timedOut: true };
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
  const root = controlRoot(directory);
  await withExclusiveLock(hostLockPath(root, host.name, 'lease'), async () => {
    const result = await masterControl(host, root, 'check', timeoutMs);
    if (!deadMasterEvidence(result)) return;
    await masterControl(host, root, 'exit', timeoutMs);
    await removeDeadControlSocket(host, root);
  });
}

function deadMasterEvidence(result: MasterControlResult): boolean {
  return !result.timedOut && result.code !== 0 && /Connection refused|No such file or directory/.test(result.output);
}

type FlockHold = { release: () => Promise<void> };

async function holdFlock(file: string, shared: boolean, blocking: boolean): Promise<FlockHold | null> {
  writeFileSync(file, '', { flag: 'a', mode: 0o600 });
  const child = Bun.spawn(
    [
      'flock',
      ...(shared ? ['-s'] : []),
      ...(blocking ? [] : ['-n']),
      '--no-fork',
      '-E',
      String(FLOCK_BUSY),
      file,
      'sh',
      '-c',
      'printf LOCKED\\n; exec cat >/dev/null',
    ],
    { stdin: 'pipe', stdout: 'pipe', stderr: 'ignore' },
  );
  const reader = child.stdout.getReader();
  const first = await reader.read();
  reader.releaseLock();
  if (first.done) {
    const code = await child.exited;
    if (code === FLOCK_BUSY) return null;
    throw new Error(`remote-check: flock failed for ${file} (exit ${code})`);
  }
  let released: Promise<void> | undefined;
  return {
    release() {
      return (released ??= (async () => {
        try {
          await child.stdin.end();
        } catch {
          // The helper may already have exited.
        }
        await child.exited;
      })());
    },
  };
}

async function withExclusiveLock<T>(file: string, work: () => T | Promise<T>, blocking = false): Promise<T | null> {
  const hold = await holdFlock(file, false, blocking);
  if (!hold) return null;
  try {
    return await work();
  } finally {
    await hold.release();
  }
}

function exclusiveLockIsHeld(file: string): boolean {
  if (!existsSync(file)) return false;
  const result = Bun.spawnSync(['flock', '-n', '-E', String(FLOCK_BUSY), file, 'true'], {
    stdin: 'ignore',
    stdout: 'ignore',
    stderr: 'ignore',
  });
  if (result.exitCode === FLOCK_BUSY) return true;
  if (result.exitCode !== 0) {
    throw new Error(`remote-check: flock inspect failed for ${file} (exit ${result.exitCode})`);
  }
  return false;
}

const CONTROL_OK = 'REMOTE_CHECK_CONTROL_OK';

export type HostControlLease = {
  readonly host: SshControlHost;
  readonly directory: string;
  readonly socketPath: string;
  readonly connectionMs: number;
};

type HeldLease = {
  count: number;
  host: SshControlHost;
  directory: string;
  unlock: () => Promise<void>;
};

const liveLeases = new Map<string, HeldLease>();

function leaseKey(directory: string, hostName: string): string {
  return `${resolve(directory)}\0${hostName}`;
}

export function activeHostControlCount(directory: string, hostName: string): number {
  return liveLeases.get(leaseKey(directory, hostName))?.count ?? 0;
}

/** True when this process or another remote-check process holds a run lease on the host master. */
export function hostControlLeaseIsHeld(directory: string, hostName: string): boolean {
  const root = controlRoot(directory);
  if (activeHostControlCount(root, hostName) > 0) return true;
  return exclusiveLockIsHeld(hostLockPath(root, hostName, 'lease'));
}

export function reportConnectionWork(hostName: string, started: number, recovered = false): void {
  const recoveredMark = recovered ? ', recovered stale master' : '';
  console.error(
    `remote-check: connection ${((performance.now() - started) / 1000).toFixed(3)} s on ${hostName}${recoveredMark}`,
  );
}

function readRecoveryStamp(path: string): number | undefined {
  try {
    const value = Number(readFileSync(path, 'utf8').trim());
    return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

/** Retire only an affirmatively dead listener while excluding every in-process and cross-process lease. */
export async function recoverHungHostMaster(
  host: SshControlHost,
  directory: string,
  now = Date.now(),
  timeoutMs = 1_000,
): Promise<boolean> {
  const root = controlRoot(directory);
  const claimed = await withExclusiveLock(hostLockPath(root, host.name, 'lease'), async () => {
    const stampPath = hostLockPath(root, host.name, 'recovered-at');
    const last = readRecoveryStamp(stampPath);
    if (last !== undefined && now - last < MASTER_RECOVERY_INTERVAL_MS) return false;
    const result = await masterControl(host, root, 'check', timeoutMs);
    // A slow or failing control check is uncertainty. Neither authorizes cutting a multiplexed session.
    if (!deadMasterEvidence(result)) return false;
    await masterControl(host, root, 'exit', timeoutMs);
    await removeDeadControlSocket(host, root);
    writeFileSync(stampPath, `${now}\n`);
    return true;
  });
  return claimed === true;
}

type ProbeTimeoutState = { firstAt: number; reported: boolean };

function readProbeTimeoutState(path: string): ProbeTimeoutState | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<ProbeTimeoutState>;
    const firstAt = parsed.firstAt;
    if (typeof firstAt !== 'number' || !Number.isSafeInteger(firstAt) || firstAt < 0) return undefined;
    return { firstAt, reported: parsed.reported === true };
  } catch {
    return undefined;
  }
}

export function placementProbeTimeoutEvent(hostName: string, error: string): string {
  return `remote-check: environment: check host ${hostName} skipped for probe timeouts: ${error}`;
}

/** Record a placement-probe timeout. After five minutes in a row, returns one environment event line. */
export async function notePlacementProbeTimeout(
  directory: string,
  hostName: string,
  error: string,
  now = Date.now(),
): Promise<string | null> {
  const root = controlRoot(directory);
  const statePath = hostLockPath(root, hostName, 'probe-timeouts');
  const event = await withExclusiveLock(
    hostLockPath(root, hostName, 'probe-timeouts.lock'),
    () => {
      let state = readProbeTimeoutState(statePath);
      if (!state || state.firstAt > now) state = { firstAt: now, reported: false };
      let line: string | null = null;
      if (!state.reported && now - state.firstAt >= PLACEMENT_PROBE_TIMEOUT_EVENT_MS) {
        state.reported = true;
        line = placementProbeTimeoutEvent(hostName, error);
      }
      writeFileSync(statePath, JSON.stringify(state));
      return line;
    },
    true,
  );
  return event ?? null;
}

export async function clearPlacementProbeTimeout(directory: string, hostName: string): Promise<void> {
  const root = controlRoot(directory);
  const statePath = hostLockPath(root, hostName, 'probe-timeouts');
  if (!existsSync(statePath)) return;
  await withExclusiveLock(
    hostLockPath(root, hostName, 'probe-timeouts.lock'),
    () => {
      try {
        unlinkSync(statePath);
      } catch {
        // Already gone.
      }
    },
    true,
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
  const root = controlRoot(directory);
  const started = performance.now();
  const recovered = await withExclusiveLock(hostLockPath(root, host.name, 'lease'), () =>
    removeDeadControlSocket(host, root),
  );
  const lock = await holdFlock(hostLockPath(root, host.name, 'lease'), true, true);
  if (!lock) throw new Error(`remote-check: SSH lease lock failed for ${host.name}`);
  let adopted = false;
  try {
    let lastDetail = 'control probe failed';
    for (let attempt = 0; attempt < 2; attempt += 1) {
      // The shared lease spans probe startup and the entire run; retirement cannot race successful admission.
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
        if (held) {
          held.count += 1;
          await lock.release();
        } else liveLeases.set(key, { count: 1, host, directory: root, unlock: () => lock.release() });
        adopted = true;
        reportConnectionWork(host.name, started, recovered === true);
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
  } finally {
    if (!adopted) await lock.release();
  }
}

/**
 * Release this caller's claim on the host master. The persisted ControlMaster stays for other runs; ControlPersist
 * reaps it after idle. Never `-O exit` here. Waits until the cross-process lease flock is dropped so a later
 * recoverHungHostMaster cannot see a released run as still holding the master.
 */
export async function releaseHostControl(lease: HostControlLease): Promise<void> {
  const key = leaseKey(lease.directory, lease.host.name);
  const held = liveLeases.get(key);
  if (!held) return;
  held.count -= 1;
  if (held.count > 0) return;
  liveLeases.delete(key);
  await held.unlock();
}

/** Test seam: forget in-process lease counts without touching a live OpenSSH master. */
export async function resetHostControlLeases(): Promise<void> {
  const held = [...liveLeases.values()];
  liveLeases.clear();
  await Promise.all(held.map((entry) => entry.unlock()));
}
