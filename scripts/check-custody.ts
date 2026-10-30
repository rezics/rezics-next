import { spawn, type ChildProcess } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { hostname } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

export const CHECK_RECORD_CUSTODY_VERSION = 1 as const;
export const CHECK_HISTORY_VERSION = 1 as const;

export type CheckOwnership = { taskId: string; attempt: number };
export type RunnerIdentity = { pid: number; start: string; boot: string; group: number };

export type CheckCustodyExpectation = {
  ownership: CheckOwnership;
  physicalRunId: string;
  runnerHost: string;
  runnerIdentity: RunnerIdentity;
};

export type CheckCleanupReceipt = {
  version: 1;
  receiptId: string;
  checkId: string;
  physicalRunId: string;
  ownership: CheckOwnership;
  runnerHost: string;
  runnerIdentity: RunnerIdentity;
  disposition: 'stopped' | 'already-terminal' | 'refused' | 'uncertain';
  localTerminal: boolean;
  remoteTerminal: boolean | null;
  resultTerminal: boolean;
  remoteRun?: { host: string; id: string };
  reason?: string;
  completedAt: string;
};

export type CheckRemoteAttempt = {
  host: string;
  id: string;
  status: 'running' | 'terminal' | 'uncertain';
  startedAt: string;
  endedAt?: string;
};

export type CheckRemoteObservation = {
  host?: string;
  id?: string;
  status: 'running' | 'terminal' | 'uncertain';
  observedAt: string;
};

export type CheckRemoteRunCustody = {
  version: 1;
  physicalRunId: string;
  status: 'running' | 'terminal' | 'uncertain';
  attempts: CheckRemoteAttempt[];
  observations?: CheckRemoteObservation[];
  updatedAt: string;
};

export type CheckRegistration = {
  version: 1;
  checkId: string;
  resultPath: string;
  ownership: CheckOwnership;
  physicalRunId: string;
  runnerHost: string;
  runnerIdentity: RunnerIdentity;
  registeredAt: string;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isCheckId(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}

export function isPhysicalRunId(value: unknown): value is string {
  return isCheckId(value);
}

export function validateOwnership(value: unknown): CheckOwnership {
  if (!value || typeof value !== 'object') throw new Error('worker-check: invalid task check ownership');
  const candidate = value as { taskId?: unknown; attempt?: unknown };
  if (!isCheckId(candidate.taskId) || !Number.isSafeInteger(candidate.attempt) || Number(candidate.attempt) < 1) {
    throw new Error('worker-check: invalid task check ownership');
  }
  return { taskId: candidate.taskId, attempt: Number(candidate.attempt) };
}

/** Launcher identity is all-or-nothing. A partial or malformed task identity refuses before command execution. */
export function ownershipFromEnvironment(env: Record<string, string | undefined>): CheckOwnership | undefined {
  const taskId = env.GOAL_TASK_ID;
  const attempt = env.GOAL_ATTEMPT;
  if (taskId === undefined && attempt === undefined) return undefined;
  if (taskId === undefined || attempt === undefined || !/^[1-9]\d*$/.test(attempt)) {
    throw new Error('worker-check: GOAL_TASK_ID and GOAL_ATTEMPT must both identify a valid task attempt');
  }
  return validateOwnership({ taskId, attempt: Number(attempt) });
}

export function validateRunnerIdentity(value: unknown): RunnerIdentity {
  if (!value || typeof value !== 'object') throw new Error('worker-check: invalid runner identity');
  const identity = value as Partial<RunnerIdentity>;
  if (
    !Number.isSafeInteger(identity.pid) ||
    Number(identity.pid) < 1 ||
    !Number.isSafeInteger(identity.group) ||
    Number(identity.group) < 1 ||
    typeof identity.start !== 'string' ||
    !/^\d+$/.test(identity.start) ||
    typeof identity.boot !== 'string' ||
    !UUID.test(identity.boot)
  ) {
    throw new Error('worker-check: invalid runner identity');
  }
  return {
    pid: Number(identity.pid),
    start: identity.start,
    boot: identity.boot,
    group: Number(identity.group),
  };
}

export function processIdentity(pid = process.pid, procRoot = '/proc'): RunnerIdentity | null {
  if (!Number.isSafeInteger(pid) || pid < 1) return null;
  try {
    const stat = readFileSync(join(procRoot, String(pid), 'stat'), 'utf8');
    const fields = stat
      .slice(stat.lastIndexOf(')') + 2)
      .trim()
      .split(/\s+/);
    if (fields[0] === 'Z' || fields[0] === 'X' || !fields[19]) return null;
    const group = Number(fields[2]);
    if (!Number.isSafeInteger(group) || group < 1) return null;
    const boot = readFileSync(join(procRoot, 'sys/kernel/random/boot_id'), 'utf8').trim();
    if (!UUID.test(boot)) return null;
    return { pid, start: fields[19]!, boot, group };
  } catch {
    return null;
  }
}

export function sameProcess(identity: RunnerIdentity, procRoot = '/proc'): boolean {
  const current = processIdentity(identity.pid, procRoot);
  return (
    current?.pid === identity.pid &&
    current.start === identity.start &&
    current.boot === identity.boot &&
    current.group === identity.group
  );
}

export function processGroupMembers(group: number): RunnerIdentity[] {
  try {
    return readdirSync('/proc')
      .filter((name) => /^\d+$/.test(name))
      .map((name) => processIdentity(Number(name)))
      .filter((identity): identity is RunnerIdentity => identity !== null && identity.group === group);
  } catch {
    return [];
  }
}

export function processTreeMembers(rootPid: number): RunnerIdentity[] {
  try {
    const parents = new Map<number, number>();
    const identities = new Map<number, RunnerIdentity>();
    for (const entry of readdirSync('/proc')) {
      if (!/^\d+$/.test(entry)) continue;
      const pid = Number(entry);
      try {
        const stat = readFileSync(join('/proc', entry, 'stat'), 'utf8');
        const fields = stat
          .slice(stat.lastIndexOf(')') + 2)
          .trim()
          .split(/\s+/);
        const identity = processIdentity(pid);
        const parent = Number(fields[1]);
        if (!identity || !Number.isSafeInteger(parent)) continue;
        parents.set(pid, parent);
        identities.set(pid, identity);
      } catch {
        // A process can exit while procfs is being read.
      }
    }
    const descendants = new Set<number>([rootPid]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const [pid, parent] of parents) {
        if (descendants.has(parent) && !descendants.has(pid)) {
          descendants.add(pid);
          changed = true;
        }
      }
    }
    return [...descendants]
      .map((pid) => identities.get(pid))
      .filter((item): item is RunnerIdentity => item !== undefined);
  } catch {
    return [];
  }
}

export function runnerCommandMatches(
  identity: RunnerIdentity,
  scriptPath: string,
  checkId: string,
  physicalRunId: string,
): boolean {
  if (!sameProcess(identity)) return false;
  try {
    const args = readFileSync(`/proc/${identity.pid}/cmdline`, 'utf8').split('\0').filter(Boolean);
    const script = resolve(scriptPath);
    const detached = args[1] === script && args[2] === '--run' && args[3] === checkId;
    const explicitlyBound = args[4] === '--physical-run' && args[5] === physicalRunId;
    const legacyDetached = args[4] === undefined;
    return detached && (explicitlyBound || legacyDetached);
  } catch {
    return false;
  }
}

export async function waitForProcess(identity: RunnerIdentity, pollMs = 25): Promise<void> {
  while (sameProcess(identity)) await new Promise<void>((done) => setTimeout(done, pollMs));
}

/** Signal the verified wrapper first, then drain or exactly reap only its identified detached group. */
export async function terminateDetachedGroup(
  identity: RunnerIdentity,
  graceMs = 10_000,
): Promise<{ terminal: boolean; reason?: string }> {
  const current = processIdentity(identity.pid);
  if (current && !sameProcess(identity)) return { terminal: false, reason: 'runner PID identity changed' };
  if (identity.group !== identity.pid || identity.group === processIdentity(process.pid)?.group) {
    return { terminal: false, reason: 'runner does not own a detached process group' };
  }
  const treeMembers = new Map<number, RunnerIdentity>(
    processTreeMembers(identity.pid).map((member) => [member.pid, member]),
  );
  let members = processGroupMembers(identity.group);
  if (members.some((member) => member.boot !== identity.boot || BigInt(member.start) < BigInt(identity.start))) {
    return { terminal: false, reason: 'process group identity changed' };
  }
  if (!members.length) return { terminal: true };
  if (sameProcess(identity)) {
    try {
      process.kill(identity.pid, 'SIGTERM');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
        return { terminal: false, reason: `could not signal verified runner: ${String(error)}` };
      }
    }
  }
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    for (const member of processTreeMembers(identity.pid)) treeMembers.set(member.pid, member);
    members = processGroupMembers(identity.group);
    if (members.some((member) => member.boot !== identity.boot || BigInt(member.start) < BigInt(identity.start))) {
      return { terminal: false, reason: 'process group identity changed while draining' };
    }
    const treeAlive = [...treeMembers.values()].some((member) => sameProcess(member));
    if (!members.length && !treeAlive) return { terminal: true };
    await new Promise<void>((done) => setTimeout(done, 25));
  }
  const owned = new Map<number, RunnerIdentity>([
    ...treeMembers,
    ...members.map((member) => [member.pid, member] as const),
  ]);
  for (const member of owned.values()) {
    if (!sameProcess(member)) continue;
    try {
      process.kill(member.pid, 'SIGKILL');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
        return { terminal: false, reason: `could not reap owned process ${member.pid}: ${String(error)}` };
      }
    }
  }
  const reapDeadline = Date.now() + Math.max(1_000, graceMs);
  while (Date.now() < reapDeadline) {
    for (const member of processTreeMembers(identity.pid)) treeMembers.set(member.pid, member);
    members = processGroupMembers(identity.group);
    if (members.some((member) => member.boot !== identity.boot || BigInt(member.start) < BigInt(identity.start))) {
      return { terminal: false, reason: 'process group identity changed while reaping' };
    }
    const treeAlive = [...treeMembers.values()].some((member) => sameProcess(member));
    if (!members.length && !treeAlive) return { terminal: true };
    await new Promise<void>((done) => setTimeout(done, 25));
  }
  return { terminal: false, reason: 'owned process tree is still alive' };
}

export function custodyDirectory(root: string): string {
  return join(resolve(root), '.temp', 'goal', 'checks', 'custody');
}

export function physicalHistoryPath(root: string, checkId: string, physicalRunId: string): string {
  return join(custodyDirectory(root), 'history', `${checkId}.${physicalRunId}.json`);
}

export function cleanupReceiptPath(root: string, checkId: string, physicalRunId: string): string {
  return join(custodyDirectory(root), 'receipts', `${checkId}.${physicalRunId}.json`);
}

export function cleanupReceiptHistoryDirectory(root: string, checkId: string, physicalRunId: string): string {
  return join(custodyDirectory(root), 'receipts', `${checkId}.${physicalRunId}`);
}

export function cleanupReceiptEventPath(
  root: string,
  checkId: string,
  physicalRunId: string,
  receiptId: string,
): string {
  return join(cleanupReceiptHistoryDirectory(root, checkId, physicalRunId), `${receiptId}.json`);
}

export function stopIntentPath(root: string, checkId: string, physicalRunId: string): string {
  return join(custodyDirectory(root), 'stopping', `${checkId}.${physicalRunId}.json`);
}

export function cancellationPath(root: string, checkId: string): string {
  return join(custodyDirectory(root), 'cancelled', `${checkId}.json`);
}

export function remoteRunCustodyPath(root: string, physicalRunId: string): string {
  return join(custodyDirectory(root), 'remote', `${physicalRunId}.json`);
}

export function runnerReadyPath(root: string, checkId: string, physicalRunId: string): string {
  return join(custodyDirectory(root), 'ready', `${checkId}.${physicalRunId}.json`);
}

export function writeAtomicJson(file: string, value: unknown, createParent = true): void {
  if (createParent) mkdirSync(dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600, flag: 'wx' });
  renameSync(temporary, file);
}

export function readJsonFile<T>(file: string): T | undefined {
  try {
    const raw = readFileSync(file, 'utf8');
    if (raw.length > 64 * 1024) return undefined;
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

/** Use the kernel flock primitive as the publication fence for one logical check ID. */
export async function withCheckFence<T>(root: string, checkId: string, operation: () => Promise<T> | T): Promise<T> {
  const directory = join(custodyDirectory(root), 'locks');
  mkdirSync(directory, { recursive: true });
  const lock = join(directory, `${checkId}.lock`);
  const child: ChildProcess = spawn('flock', ['-x', lock, 'sh', '-c', 'printf "LOCKED\\n"; cat >/dev/null'], {
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  let ready = '';
  await new Promise<void>((resolveReady, rejectReady) => {
    let timeout: ReturnType<typeof setTimeout> | undefined = setTimeout(() => {
      child.kill('SIGKILL');
      rejectReady(new Error('worker-check: check publication fence timed out'));
    }, 30_000);
    const finish = (error?: Error) => {
      if (timeout) clearTimeout(timeout);
      timeout = undefined;
      if (error) rejectReady(error);
      else resolveReady();
    };
    child.stdout?.on('data', (chunk: Buffer) => {
      ready += chunk.toString('utf8');
      if (ready.includes('\n')) finish();
    });
    child.once('error', (error) => finish(error));
    child.once('close', (code) => {
      if (!ready.includes('\n')) finish(new Error(`worker-check: could not acquire check publication fence (${code})`));
    });
  });
  try {
    return await operation();
  } finally {
    child.stdin?.end();
    await new Promise<void>((done) => {
      if (child.exitCode !== null || child.signalCode !== null) done();
      else child.once('close', () => done());
    });
  }
}

export function validatedRegistryDirectory(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (!isAbsolute(value)) throw new Error('worker-check: GOAL_CHECK_REGISTRY must be an absolute directory');
  let stats;
  try {
    stats = lstatSync(value);
  } catch {
    throw new Error('worker-check: GOAL_CHECK_REGISTRY is unavailable');
  }
  if (!stats.isDirectory() || stats.isSymbolicLink())
    throw new Error('worker-check: GOAL_CHECK_REGISTRY is not a directory');
  const real = realpathSync(value);
  if (resolve(value) !== real) throw new Error('worker-check: GOAL_CHECK_REGISTRY resolves through a path alias');
  return real;
}

export function publishCheckRegistration(registry: string, registration: CheckRegistration): string {
  if (
    registration.version !== CHECK_RECORD_CUSTODY_VERSION ||
    !isCheckId(registration.checkId) ||
    !isPhysicalRunId(registration.physicalRunId) ||
    !isAbsolute(registration.resultPath) ||
    registration.runnerHost !== hostname()
  ) {
    throw new Error('worker-check: invalid check registration');
  }
  if (validatedRegistryDirectory(registry) !== registry) {
    throw new Error('worker-check: check registry changed before registration');
  }
  validateOwnership(registration.ownership);
  validateRunnerIdentity(registration.runnerIdentity);
  const file = join(registry, `${registration.checkId}.${registration.physicalRunId}.json`);
  writeAtomicJson(file, registration, false);
  if (validatedRegistryDirectory(registry) !== registry) {
    throw new Error('worker-check: check registry changed during registration');
  }
  return file;
}

export function registrationPath(registry: string, checkId: string, physicalRunId: string): string {
  return join(registry, `${checkId}.${physicalRunId}.json`);
}

export function validRegistration(
  registration: unknown,
  expected: CheckRegistration,
): registration is CheckRegistration {
  if (!registration || typeof registration !== 'object') return false;
  const value = registration as Partial<CheckRegistration>;
  try {
    return (
      value.version === 1 &&
      value.checkId === expected.checkId &&
      value.resultPath === expected.resultPath &&
      value.physicalRunId === expected.physicalRunId &&
      value.runnerHost === expected.runnerHost &&
      JSON.stringify(validateOwnership(value.ownership)) === JSON.stringify(expected.ownership) &&
      JSON.stringify(validateRunnerIdentity(value.runnerIdentity)) === JSON.stringify(expected.runnerIdentity)
    );
  } catch {
    return false;
  }
}

export function registrationIsPresent(registry: string, expected: CheckRegistration): boolean {
  const file = registrationPath(registry, expected.checkId, expected.physicalRunId);
  if (!existsSync(file)) return false;
  return validRegistration(readJsonFile(file), expected);
}
