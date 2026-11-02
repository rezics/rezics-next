import { readdirSync, readFileSync, readlinkSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { fixtureOwnerForLog, recordFixtureOwnedProcess, trackFixtureWait } from './fixture-process-ownership.ts';
export type ProcessIdentity = { pid: number; start: string; boot: string; group: number };

// The boot id cannot change while this process runs; reading it for every /proc entry dominated each scan.
const bootIds = new Map<string, string>();
function bootId(procRoot: string): string {
  let id = bootIds.get(procRoot);
  if (id === undefined) {
    id = readFileSync(`${procRoot}/sys/kernel/random/boot_id`, 'utf8').trim();
    bootIds.set(procRoot, id);
  }
  return id;
}
/** A missing or dead process is distinct from process state we cannot inspect. */
function inspectProcessSnapshot(pid: number, procRoot: string): { identity: ProcessIdentity; dead: boolean } | null {
  if (!Number.isSafeInteger(pid) || pid < 1) return null;
  let stat: string;
  try {
    stat = readFileSync(`${procRoot}/${pid}/stat`, 'utf8');
  } catch (error) {
    if (['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code ?? '')) return null;
    throw new Error(`process visibility unknown for PID ${pid}`, { cause: error });
  }
  const end = stat.lastIndexOf(')');
  const fields = stat
    .slice(end + 2)
    .trim()
    .split(/\s+/);
  if (end < 0 || !/^\d+$/.test(fields[19] ?? '') || !/^\d+$/.test(fields[2] ?? ''))
    throw new Error(`process visibility unknown for PID ${pid}: invalid stat`);
  try {
    const boot = bootId(procRoot);
    if (!boot) throw new Error('empty boot id');
    return {
      identity: { pid, start: fields[19]!, boot, group: Number(fields[2]) },
      dead: fields[0] === 'Z' || fields[0] === 'X',
    };
  } catch (error) {
    throw new Error(`process visibility unknown for PID ${pid}: boot identity unavailable`, { cause: error });
  }
}
export function inspectProcessIdentity(pid = process.pid, procRoot = '/proc'): ProcessIdentity | null {
  const snapshot = inspectProcessSnapshot(pid, procRoot);
  return snapshot && !snapshot.dead ? snapshot.identity : null;
}
export function processIdentity(pid = process.pid, procRoot = '/proc'): ProcessIdentity | null {
  try {
    return inspectProcessIdentity(pid, procRoot);
  } catch {
    return null;
  }
}
function matches(current: ProcessIdentity | null, identity: ProcessIdentity): boolean {
  return current?.start === identity.start && current.boot === identity.boot && current.group === identity.group;
}
export function sameProcess(identity: ProcessIdentity, procRoot = '/proc'): boolean {
  return matches(processIdentity(identity.pid, procRoot), identity);
}
export function groupMembers(group: number, procRoot = '/proc'): ProcessIdentity[] {
  return readdirSync(procRoot)
    .filter((name) => /^\d+$/.test(name))
    .map((name) => inspectProcessIdentity(Number(name), procRoot))
    .filter((p): p is ProcessIdentity => p !== null && p.group === group);
}
/** Signal zero inspects kernel group existence without delivering a signal to any member. */
function processGroupIsAbsent(group: number): boolean {
  try {
    process.kill(-group, 0);
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true;
    throw new Error(`process group visibility unknown for group ${group}`, { cause: error });
  }
}
/** Verify custody before either signalling a group or declaring it terminal. */
export function checkedProcessGroup(identity: ProcessIdentity): ProcessIdentity[] {
  if (identity.group !== identity.pid || identity.group === inspectProcessIdentity(process.pid)?.group)
    throw new Error('worker must own a detached process group');
  // Dead leaders still carry a birth identity: a reused zombie must never authorize killing its children.
  const current = inspectProcessSnapshot(identity.pid, '/proc')?.identity ?? null;
  const members = groupMembers(identity.group);
  if (current && !matches(current, identity)) {
    const reused = current.start !== identity.start || current.boot !== identity.boot;
    if (reused && !members.length && processGroupIsAbsent(identity.group)) return [];
    throw new Error('process identity changed; refusing to signal reused PID');
  }
  if (members.some((member) => member.boot !== identity.boot || BigInt(member.start) < BigInt(identity.start)))
    throw new Error('process group identity changed');
  if (!members.length && !processGroupIsAbsent(identity.group))
    throw new Error(`process group visibility unknown for group ${identity.group}: no live members visible`);
  return members;
}
/** Process groups with a live member, from one scan of /proc. */
export function liveGroups(): Set<number> {
  const groups = new Set<number>();
  for (const name of readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    const identity = processIdentity(Number(name));
    if (identity) groups.add(identity.group);
  }
  return groups;
}
/** Wait until every process in an identified detached group has exited. */
export async function waitForProcessGroup(identity: ProcessIdentity): Promise<void> {
  for (;;) {
    const members = checkedProcessGroup(identity);
    if (!members.length) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 1000));
  }
}
/** What the launch wrapper records when the worker CLI ends; a missing file means the wrapper itself was killed. */
export type WorkerExit = { code: number | null; signal: NodeJS.Signals | null };
export const workerExitPath = (logPath: string): string => `${logPath}.exit`;
export function readWorkerExit(logPath: string): WorkerExit {
  try {
    const value = JSON.parse(readFileSync(workerExitPath(logPath), 'utf8')) as { code?: unknown; signal?: unknown };
    return {
      code: Number.isInteger(value.code) ? (value.code as number) : null,
      signal: typeof value.signal === 'string' ? (value.signal as NodeJS.Signals) : null,
    };
  } catch {
    return { code: null, signal: null };
  }
}
/** Wait until a worker's wrapper has exited, then read the exit it recorded just before. */
export function waitForWorkerExit(identity: ProcessIdentity | null, logPath: string): Promise<WorkerExit> {
  const fixtureOwner = fixtureOwnerForLog(logPath);
  const waiting = (async () => {
    if (identity)
      await waitForProcess(
        identity,
        undefined,
        fixtureOwner ? (waiter) => recordFixtureOwnedProcess(logPath, 'waiter', waiter) : undefined,
      );
    return readWorkerExit(logPath);
  })();
  if (fixtureOwner) trackFixtureWait(logPath, waiting);
  return waiting;
}
/** Linux pidfds let a restarted controller wait for non-children without polling or a model. */
export async function waitForProcess(
  identity: ProcessIdentity,
  signal?: AbortSignal,
  onWaiter?: (identity: ProcessIdentity) => void,
): Promise<void> {
  if (signal?.aborted || !matches(inspectProcessIdentity(identity.pid), identity)) return;
  const source = `import os,sys,select
pid,start,boot=sys.argv[1:]
try:
 fd=os.pidfd_open(int(pid))
 stat=open('/proc/'+pid+'/stat').read().rsplit(')',1)[1].split()
 current_boot=open('/proc/sys/kernel/random/boot_id').read().strip()
 if stat[19]==start and current_boot==boot and stat[0] not in ('Z','X'):
  select.select([fd],[],[])
 os.close(fd)
except ProcessLookupError: pass
except FileNotFoundError: pass
`;
  const waiter = spawn('python3', ['-c', source, String(identity.pid), identity.start, identity.boot], {
    stdio: 'ignore',
  });
  await new Promise<void>((resolve, reject) => {
    let registrationFailure: unknown;
    const abort = () => waiter.kill('SIGTERM');
    signal?.addEventListener('abort', abort, { once: true });
    waiter.once('error', (error) => reject(registrationFailure ?? error));
    waiter.once('exit', (code) => {
      signal?.removeEventListener('abort', abort);
      if (registrationFailure !== undefined) {
        reject(registrationFailure);
        return;
      }
      if (signal?.aborted) {
        resolve();
        return;
      }
      // The waiter can fail on a loaded host (a race in /proc, an interrupted wait). Its failure says nothing about the
      // process, so fall back to checking the identity until it is gone; never report an exit that did not happen.
      const poll = () => {
        try {
          if (signal?.aborted || !matches(inspectProcessIdentity(identity.pid), identity)) resolve();
          else setTimeout(poll, 50);
        } catch (error) {
          reject(error);
        }
      };
      poll();
    });
    if (signal?.aborted) abort();
    if (onWaiter) {
      try {
        const waiterIdentity = processIdentity(waiter.pid ?? 0);
        if (waiterIdentity) onWaiter(waiterIdentity);
        else if (waiter.exitCode === null && waiter.signalCode === null && sameProcess(identity))
          throw new Error('Cannot identify fixture-owned process waiter');
      } catch (error) {
        registrationFailure = error;
        waiter.kill('SIGTERM');
      }
    }
  });
}
/** Pin the incarnation before signalling: a PID can be recycled after the /proc check. */
export async function signalProcessIdentity(identity: ProcessIdentity, name: NodeJS.Signals): Promise<boolean> {
  if (!matches(inspectProcessIdentity(identity.pid), identity)) return false;
  const source = `import os,sys,signal
pid,start,boot,group,name=sys.argv[1:]
try:
 fd=os.pidfd_open(int(pid))
except ProcessLookupError:
 sys.exit(3)
try:
 try:
  stat=open('/proc/'+pid+'/stat').read().rsplit(')',1)[1].split()
 except FileNotFoundError:
  sys.exit(3)
 current_boot=open('/proc/sys/kernel/random/boot_id').read().strip()
 if stat[19]!=start or current_boot!=boot or stat[2]!=group or stat[0] in ('Z','X'):
  sys.exit(3)
 try:
  signal.pidfd_send_signal(fd,getattr(signal,name),None,0)
 except ProcessLookupError:
  sys.exit(3)
finally:
 os.close(fd)
`;
  const sender = spawn(
    'python3',
    ['-c', source, String(identity.pid), identity.start, identity.boot, String(identity.group), name],
    {
      stdio: ['ignore', 'ignore', 'pipe'],
    },
  );
  let detail = '';
  sender.stderr!.on('data', (chunk) => {
    detail = (detail + String(chunk)).slice(-4096);
  });
  return new Promise<boolean>((done, reject) => {
    sender.once('error', reject);
    sender.once('close', (code) => {
      if (code === 0) done(true);
      else if (code === 3) done(false);
      else
        reject(
          new Error(
            `process signalling unconfirmed for PID ${identity.pid}: ${detail.trim() || `helper exit ${code}`}`,
          ),
        );
    });
  });
}
/** Signal only an identified detached group, then verify every surviving member before allowing launch. */
export async function terminateProcessGroup(identity: ProcessIdentity | null, graceMs: number): Promise<void> {
  if (!identity) return;
  const members = checkedProcessGroup(identity);
  if (!members.length) return;
  for (const member of members) {
    await signalProcessIdentity(member, 'SIGTERM');
  }
  const gone = Promise.all(members.map((identity) => waitForProcess(identity)));
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      gone,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, graceMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
  const remaining = checkedProcessGroup(identity);
  for (const member of remaining) {
    if (member.boot !== identity.boot || BigInt(member.start) < BigInt(identity.start))
      throw new Error('process group identity changed');
    await signalProcessIdentity(member, 'SIGKILL');
  }
  await Promise.all(remaining.map((identity) => waitForProcess(identity)));
  await gone;
  if (checkedProcessGroup(identity).length) throw new Error('worker process group is still alive');
}
/**
 * Stop every process whose working directory is inside a directory, such as a finished attempt's worktree. A dev
 * server that a worker or a test starts in a new session leaves the worker's process group, so only its place finds
 * it. This process and its ancestors are spared.
 */
export async function stopProcessesUnder(directory: string, graceMs: number, procRoot = '/proc'): Promise<number> {
  const root = resolve(directory);
  const spared = new Set<number>();
  for (let pid = process.pid; pid > 1 && !spared.has(pid);) {
    spared.add(pid);
    try {
      pid = Number(readFileSync(`${procRoot}/${pid}/stat`, 'utf8').split(') ').pop()!.split(' ')[1]);
    } catch {
      break;
    }
  }
  const inside = () =>
    readdirSync(procRoot)
      .filter((name) => /^\d+$/.test(name) && !spared.has(Number(name)))
      .flatMap((name) => {
        let cwd: string;
        try {
          cwd = readlinkSync(`${procRoot}/${name}/cwd`).replace(/ \(deleted\)$/, '');
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code === 'ENOENT' || code === 'ESRCH') return [];
          const detail = error instanceof Error ? error.message : String(error);
          throw new Error(`Unable to inspect cwd for PID ${name}: ${detail}`, { cause: error });
        }
        if (cwd !== root && !cwd.startsWith(`${root}/`)) return [];
        const identity = inspectProcessIdentity(Number(name), procRoot);
        return identity ? [identity] : [];
      });
  const signal = async (members: ProcessIdentity[], name: NodeJS.Signals) => {
    for (const member of members) {
      if (!matches(inspectProcessIdentity(member.pid, procRoot), member)) continue;
      await signalProcessIdentity(member, name);
    }
  };
  const found = inside();
  if (!found.length) return 0;
  await signal(found, 'SIGTERM');
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.all(found.map((member) => waitForProcess(member))),
      new Promise<void>((done) => {
        timer = setTimeout(done, graceMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
  const remaining = found.filter((member) => matches(inspectProcessIdentity(member.pid, procRoot), member));
  await signal(remaining, 'SIGKILL');
  await Promise.all(remaining.map((member) => waitForProcess(member)));
  return found.length;
}
