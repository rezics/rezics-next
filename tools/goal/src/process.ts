import { readdirSync, readFileSync, readlinkSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
export type ProcessIdentity = { pid: number; start: string; boot: string; group: number };

// The boot id cannot change while this process runs; reading it for every /proc entry dominated each scan.
const bootIds = new Map<string, string>();
function bootId(procRoot: string): string {
  let id = bootIds.get(procRoot);
  if (id === undefined) { id = readFileSync(`${procRoot}/sys/kernel/random/boot_id`, 'utf8').trim(); bootIds.set(procRoot, id); }
  return id;
}
export function processIdentity(pid = process.pid, procRoot = '/proc'): ProcessIdentity | null {
  if (!Number.isSafeInteger(pid) || pid < 1) return null;
  try {
    const stat = readFileSync(`${procRoot}/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
    if (fields[0] === 'Z' || fields[0] === 'X' || !fields[19]) return null;
    return { pid, start: fields[19], boot: bootId(procRoot), group: Number(fields[2]) };
  } catch { return null; }
}
export function sameProcess(identity: ProcessIdentity, procRoot = '/proc'): boolean {
  const current = processIdentity(identity.pid, procRoot);
  return current?.start === identity.start && current.boot === identity.boot && current.group === identity.group;
}
export function groupMembers(group: number): ProcessIdentity[] {
  return readdirSync('/proc').filter(name => /^\d+$/.test(name)).map(name => processIdentity(Number(name)))
    .filter((p): p is ProcessIdentity => p !== null && p.group === group);
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
    const members = groupMembers(identity.group);
    if (members.some(member => member.boot !== identity.boot || BigInt(member.start) < BigInt(identity.start)))
      throw new Error('process group identity changed');
    if (!members.length) return;
    await new Promise<void>(resolve => setTimeout(resolve, 1000));
  }
}
/** What the launch wrapper records when the worker CLI ends; a missing file means the wrapper itself was killed. */
export type WorkerExit = { code: number | null; signal: NodeJS.Signals | null };
export const workerExitPath = (logPath: string): string => `${logPath}.exit`;
export function readWorkerExit(logPath: string): WorkerExit {
  try {
    const value = JSON.parse(readFileSync(workerExitPath(logPath), 'utf8')) as { code?: unknown; signal?: unknown };
    return { code: Number.isInteger(value.code) ? value.code as number : null, signal: typeof value.signal === 'string' ? value.signal as NodeJS.Signals : null };
  } catch { return { code: null, signal: null }; }
}
/** Wait until a worker's wrapper has exited, then read the exit it recorded just before. */
export async function waitForWorkerExit(identity: ProcessIdentity | null, logPath: string): Promise<WorkerExit> {
  if (identity) await waitForProcess(identity);
  return readWorkerExit(logPath);
}
/** Linux pidfds let a restarted controller wait for non-children without polling or a model. */
export async function waitForProcess(identity: ProcessIdentity, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted || !sameProcess(identity)) return;
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
  const waiter = spawn('python3', ['-c', source, String(identity.pid), identity.start, identity.boot], { stdio: 'ignore' });
  await new Promise<void>((resolve, reject) => {
    const abort = () => waiter.kill('SIGTERM');
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    waiter.once('error', reject);
    waiter.once('exit', code => {
      signal?.removeEventListener('abort', abort);
      if (code === 0 || signal?.aborted) resolve(); else reject(new Error('pidfd waiter failed'));
    });
  });
}
/** Signal only an identified detached group, then verify every surviving member before allowing launch. */
export async function terminateProcessGroup(identity: ProcessIdentity | null, graceMs: number): Promise<void> {
  if (!identity) return;
  const current = processIdentity(identity.pid);
  if (current && !sameProcess(identity)) throw new Error('process identity changed; refusing to signal reused PID');
  if (identity.group !== identity.pid || identity.group === processIdentity(process.pid)?.group) throw new Error('worker must own a detached process group');
  // A vanished leader can leave descendants. A live reused leader is refused above.
  const members = groupMembers(identity.group);
  if (!members.length) return;
  if (members.some(member => member.boot !== identity.boot || BigInt(member.start) < BigInt(identity.start))) throw new Error('process group identity changed');
  for (const member of members) {
    if (sameProcess(member)) { try { process.kill(member.pid, 'SIGTERM'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; } }
  }
  const gone = Promise.all(members.map(identity => waitForProcess(identity)));
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([gone, new Promise<void>(resolve => { timer = setTimeout(resolve, graceMs); })]);
  } finally { clearTimeout(timer); }
  const remaining = groupMembers(identity.group);
  for (const member of remaining) {
    if (member.boot !== identity.boot || BigInt(member.start) < BigInt(identity.start)) throw new Error('process group identity changed');
    if (sameProcess(member)) { try { process.kill(member.pid, 'SIGKILL'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; } }
  }
  await Promise.all(remaining.map(identity => waitForProcess(identity)));
  await gone;
  if (groupMembers(identity.group).length) throw new Error('worker process group is still alive');
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
    try { pid = Number(readFileSync(`${procRoot}/${pid}/stat`, 'utf8').split(') ').pop()!.split(' ')[1]); } catch { break; }
  }
  const inside = () => readdirSync(procRoot).filter(name => /^\d+$/.test(name) && !spared.has(Number(name))).flatMap(name => {
    let cwd: string;
    try { cwd = readlinkSync(`${procRoot}/${name}/cwd`).replace(/ \(deleted\)$/, ''); } catch { return []; }
    if (cwd !== root && !cwd.startsWith(`${root}/`)) return [];
    const identity = processIdentity(Number(name), procRoot);
    return identity ? [identity] : [];
  });
  const signal = (members: ProcessIdentity[], name: NodeJS.Signals) => {
    for (const member of members) {
      if (!sameProcess(member, procRoot)) continue;
      try { process.kill(member.pid, name); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
    }
  };
  const found = inside();
  if (!found.length) return 0;
  signal(found, 'SIGTERM');
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([Promise.all(found.map(member => waitForProcess(member))), new Promise<void>(done => { timer = setTimeout(done, graceMs); })]);
  } finally { clearTimeout(timer); }
  const remaining = found.filter(member => sameProcess(member, procRoot));
  signal(remaining, 'SIGKILL');
  await Promise.all(remaining.map(member => waitForProcess(member)));
  return found.length;
}
