import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { reapContainersAsync } from './containers.ts';
import {
  readTerminalTaskOwners,
  sweepAbandonedResources,
  TERMINAL_TASK_STATES,
  type CurrentTerminalOwnerLookup,
  type TerminalProcessSweep,
} from './attempt-resources.ts';
import { completedUtcHour } from './efficiency-report-time.ts';
import { SqliteManagerInbox } from './inbox.ts';
import type { HostRequest, IntegrationRuntime } from './integration-runtime.ts';
import { acquireDirectoryLease } from './lease.ts';
import { ManagerSessions } from './managers.ts';
import { defaultPolicy } from './policy.ts';
import type { Database } from 'bun:sqlite';
import { sameProcess, terminateProcessGroup, type ProcessIdentity } from './process.ts';
import {
  appServerEnvironmentFingerprint,
  appServerEndpointOwnership,
  attachPool,
  connectPool,
  ForeignAppServerEndpointError,
  isPrivateAppServerEndpoint,
  selectedAppServerExecutable,
  type AppServerAttachment,
  type CodexPool,
} from './app-server.ts';
import type { Task } from './types.ts';
import { activeOrdinaryProofRunner } from './verification.ts';
import { currentCodeVersion } from './runtime-version.ts';
import { runHostOperation, startHostHeartbeat } from './service.ts';
import {
  workerCheckHostActiveTypingRecovery,
  workerCheckHostActiveTypingRecoveries,
  type WorkerCheckHostActiveTypingRecovery,
} from './worker-check-budget.ts';

/**
 * Retain only the identified live local runner of a stopped registered ordinary proof. Explicit stop/cancel, settled,
 * stale and foreign processes stay sweepable.
 */
export function stoppedTaskSweepRetainsOrdinaryProof(
  db: Database,
  owner: string,
  worktree: string,
  processIdentity: ProcessIdentity,
): boolean {
  const taskRow = db.query('SELECT current_attempt, body FROM worker_tasks WHERE id=?').get(owner) as {
    current_attempt: number;
    body: string;
  } | null;
  if (!taskRow || !Number.isSafeInteger(taskRow.current_attempt) || taskRow.current_attempt < 1) return false;
  let task: Task;
  try {
    const parsed: unknown = JSON.parse(taskRow.body);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
    task = parsed as Task;
  } catch {
    return false;
  }
  if (task.id !== owner || task.worktree !== worktree || task.state !== 'stopped' || task.workspace) return false;
  const attemptRow = db
    .query('SELECT body FROM worker_attempts WHERE task_id=? AND attempt=?')
    .get(owner, taskRow.current_attempt) as { body: string } | null;
  if (!attemptRow) return false;
  let intent: { operation?: unknown } | undefined;
  try {
    const parsed: unknown = JSON.parse(attemptRow.body);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
    intent = (parsed as { terminationIntent?: { operation?: unknown } }).terminationIntent;
  } catch {
    return false;
  }
  if (intent?.operation === 'stop' || intent?.operation === 'cancel') return false;
  const runner = activeOrdinaryProofRunner(task, processIdentity);
  if (!runner) return false;
  const current = activeOrdinaryProofRunner(task, processIdentity);
  return Boolean(
    current &&
    current.checkId === runner.checkId &&
    current.physicalRunId === runner.physicalRunId &&
    current.runnerHost === runner.runnerHost &&
    current.runnerIdentity.pid === runner.runnerIdentity.pid &&
    current.runnerIdentity.start === runner.runnerIdentity.start &&
    current.runnerIdentity.boot === runner.runnerIdentity.boot &&
    current.runnerIdentity.group === runner.runnerIdentity.group,
  );
}

function typingRecoveryOwnsProcess(recovery: WorkerCheckHostActiveTypingRecovery, identity: ProcessIdentity): boolean {
  return (
    recovery.runnerIdentity.group === identity.group &&
    recovery.runnerIdentity.boot === identity.boot &&
    BigInt(identity.start) >= BigInt(recovery.runnerIdentity.start)
  );
}

function sameTypingRecovery(
  left: WorkerCheckHostActiveTypingRecovery | undefined,
  right: WorkerCheckHostActiveTypingRecovery,
): boolean {
  return Boolean(
    left &&
    left.token === right.token &&
    left.checkId === right.checkId &&
    left.physicalRunId === right.physicalRunId &&
    left.runnerHost === right.runnerHost &&
    left.runnerIdentity.pid === right.runnerIdentity.pid &&
    left.runnerIdentity.start === right.runnerIdentity.start &&
    left.runnerIdentity.boot === right.runnerIdentity.boot &&
    left.runnerIdentity.group === right.runnerIdentity.group,
  );
}

/** Revalidate the exact cached grant and runner at the sweep's TERM/KILL ownership decision. */
export function stoppedTaskSweepRetainsTypingRecovery(
  db: Database,
  stateDirectory: string,
  owner: string,
  worktree: string,
  processIdentity: ProcessIdentity,
  recoveries: readonly WorkerCheckHostActiveTypingRecovery[],
): boolean {
  if (!sameProcess(processIdentity)) return false;
  for (const recovery of recoveries) {
    if (!typingRecoveryOwnsProcess(recovery, processIdentity)) continue;
    const current = workerCheckHostActiveTypingRecovery({
      db,
      stateDirectory,
      taskId: owner,
      worktree,
      token: recovery.token,
    });
    if (current && sameTypingRecovery(current, recovery) && typingRecoveryOwnsProcess(current, processIdentity))
      return true;
  }
  return false;
}

/** Cache one bounded current-attempt stamp scan, then revalidate each matching grant before the sweep signals. */
export function createManagerTerminalOwnerLookup(db: Database, stateDirectory: string): CurrentTerminalOwnerLookup {
  const activeRecoveries = new Map<string, WorkerCheckHostActiveTypingRecovery[]>();
  return (owner, worktree, processIdentity) => {
    const task = db
      .query(
        `SELECT current_attempt, json_extract(body, '$.state') AS state, json_extract(body, '$.worktree') AS worktree, json_extract(body, '$.workspace') AS workspace FROM worker_tasks WHERE id=?`,
      )
      .get(owner) as {
      current_attempt: number;
      state: string;
      worktree: string;
      workspace: unknown;
    } | null;
    const current = Boolean(
      task &&
      (TERMINAL_TASK_STATES as readonly string[]).includes(task.state) &&
      task.worktree === worktree &&
      !task.workspace,
    );
    if (!current || !processIdentity || task?.state !== 'stopped') return current;

    const cacheKey = `${owner}/${task.current_attempt}`;
    let recoveries = activeRecoveries.get(cacheKey);
    if (!recoveries) {
      recoveries = workerCheckHostActiveTypingRecoveries({
        db,
        stateDirectory,
        taskId: owner,
        worktree,
      });
      activeRecoveries.set(cacheKey, recoveries);
    }
    if (stoppedTaskSweepRetainsTypingRecovery(db, stateDirectory, owner, worktree, processIdentity, recoveries))
      return false;
    if (stoppedTaskSweepRetainsOrdinaryProof(db, owner, worktree, processIdentity)) return false;
    return true;
  };
}

/** Socket server, registry, shutdown and periodic host scheduling; CLI dispatch stays in `integration-cli.ts`. */

/** Dispatch each completed UTC hour once in this host; the durable sender also fences restarts. */
export function createHourlyReportScheduler(
  publish: (bucket: string) => unknown,
  now: () => Date | number = () => Date.now(),
): () => void {
  let lastBucket: string | undefined;
  return () => {
    const bucket = completedUtcHour(now()).start;
    if (bucket === lastBucket) return;
    lastBucket = bucket;
    try {
      const result = publish(bucket);
      if (result && typeof (result as { then?: unknown }).then === 'function')
        void Promise.resolve(result).catch(() => undefined);
    } catch {}
  };
}

/**
 * Start a child only when the previous one has exited. Work that runs Git synchronously must never run in the host,
 * whose event loop serves the manager socket and app-server events.
 */
export function singleFlight(start: () => ChildProcess): () => ChildProcess | undefined {
  let child: ChildProcess | undefined;
  return () => {
    if (child && child.exitCode === null && child.signalCode === null) return undefined;
    child = start();
    return child;
  };
}

export function startOrphanRecoveryTimer(
  recoverOrphans: () => Promise<void>,
  intervalMs = defaultPolicy.host.recoveryIntervalMs,
  onTick: () => void = () => {},
): ReturnType<typeof setInterval> {
  const timer = setInterval(() => {
    // A sweep that throws must be visible: a silent failure left 46 finished waiting attempts unwoken for hours.
    void recoverOrphans().catch((error) => console.error('orphan sweep failed:', error));
    onTick();
  }, intervalMs);
  timer.unref();
  return timer;
}

const appServerRegistryName = 'manager-app-servers.json';
const appServerHandoffName = 'manager-app-servers-handoff.json';
type AppServerRegistryEntry = { identity: ProcessIdentity; attachment?: AppServerAttachment };

export type ManagerHostOptions = { terminalProcessSweep?: TerminalProcessSweep };

function isProcessIdentity(value: unknown): value is ProcessIdentity {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const identity = value as Partial<ProcessIdentity>;
  return (
    Number.isSafeInteger(identity.pid) &&
    identity.pid! > 0 &&
    typeof identity.start === 'string' &&
    typeof identity.boot === 'string' &&
    Number.isSafeInteger(identity.group) &&
    identity.group! > 0
  );
}

function isAppServerAttachment(value: unknown): value is AppServerAttachment {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const attachment = value as Partial<AppServerAttachment>;
  return (
    attachment.version === 1 &&
    isProcessIdentity(attachment.identity) &&
    typeof attachment.poolId === 'string' &&
    Boolean(attachment.poolId) &&
    typeof attachment.codexHome === 'string' &&
    Boolean(attachment.codexHome) &&
    typeof attachment.executable === 'string' &&
    Boolean(attachment.executable) &&
    typeof attachment.endpoint === 'string' &&
    /^[a-f0-9]{64}$/.test(attachment.environmentFingerprint ?? '') &&
    typeof attachment.selectedExecutablePath === 'string' &&
    Number.isSafeInteger(attachment.selectedExecutableDevice) &&
    Number.isSafeInteger(attachment.selectedExecutableInode) &&
    typeof attachment.processExecutablePath === 'string' &&
    Number.isSafeInteger(attachment.processExecutableDevice) &&
    Number.isSafeInteger(attachment.processExecutableInode)
  );
}

function sameIdentity(left: ProcessIdentity, right: ProcessIdentity): boolean {
  return left.pid === right.pid && left.start === right.start && left.boot === right.boot && left.group === right.group;
}

function readAppServerRegistry(path: string): AppServerRegistryEntry[] {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (!Array.isArray(parsed)) throw new Error(`Invalid app-server process registry: ${path}`);
    const entries: AppServerRegistryEntry[] = [];
    for (const value of parsed) {
      if (isProcessIdentity(value)) {
        // Older hosts stored only the process identity; those records cannot establish a safe endpoint handoff.
        entries.push({ identity: value });
        continue;
      }
      if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new Error(`Invalid app-server process registry: ${path}`);
      const candidate = value as { identity?: unknown; attachment?: unknown };
      const attachment = candidate.attachment;
      if (!isProcessIdentity(candidate.identity) || (attachment !== undefined && !isAppServerAttachment(attachment)))
        throw new Error(`Invalid app-server process registry: ${path}`);
      if (attachment && !sameIdentity(candidate.identity, attachment.identity))
        throw new Error(`Mismatched app-server process registry identity: ${path}`);
      entries.push({
        identity: candidate.identity,
        ...(attachment ? { attachment } : {}),
      });
    }
    return entries;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

function writeAppServerRegistry(path: string, entries: AppServerRegistryEntry[]): void {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(entries), { mode: 0o600 });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function writeAppServerIdentity(path: string, identity: ProcessIdentity): void {
  const entries = readAppServerRegistry(path).filter((entry) => entry.identity.pid !== identity.pid);
  entries.push({ identity });
  writeAppServerRegistry(path, entries);
}

function writeAppServerAttachment(path: string, attachment: AppServerAttachment): void {
  const entries = readAppServerRegistry(path).filter((entry) => entry.identity.pid !== attachment.identity.pid);
  entries.push({ identity: attachment.identity, attachment });
  writeAppServerRegistry(path, entries);
}

function removeAppServerIdentity(path: string, identity: ProcessIdentity): void {
  const entries = readAppServerRegistry(path).filter((entry) => !sameIdentity(entry.identity, identity));
  writeAppServerRegistry(path, entries);
}

/** Retire pre-handoff records and dead owners; a complete live attachment is left for exact pool recovery. */
async function prepareAppServerRegistry(path: string, policy: typeof defaultPolicy.appServer): Promise<void> {
  const kept: AppServerRegistryEntry[] = [];
  for (const entry of readAppServerRegistry(path)) {
    if (!entry.attachment) {
      await stopRecordedAppServer(entry.identity, policy);
      continue;
    }
    if (!sameProcess(entry.identity)) {
      // A dead leader can still have thread writers or helpers in its recorded private process group.
      await stopRecordedAppServer(entry.identity, policy);
      continue;
    }
    kept.push(entry);
  }
  writeAppServerRegistry(path, kept);
}

function processArgs(pid: number): string[] {
  return readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean);
}

function processEnvironment(pid: number): Map<string, string> {
  return new Map(
    readFileSync(`/proc/${pid}/environ`, 'utf8')
      .split('\0')
      .filter(Boolean)
      .map((entry) => {
        const separator = entry.indexOf('=');
        return [entry.slice(0, separator), entry.slice(separator + 1)] as [string, string];
      }),
  );
}

function appServerProcessProof(
  pool: CodexPool,
  attachment: AppServerAttachment,
): 'adopt' | 'stale' | 'obsolete' | 'refuse' {
  try {
    if (!isPrivateAppServerEndpoint(attachment.endpoint)) return 'refuse';
    if (attachment.environmentFingerprint !== appServerEnvironmentFingerprint(pool)) return 'refuse';
    if (!sameProcess(attachment.identity)) return 'stale';
    if (attachment.identity.group !== attachment.identity.pid) return 'refuse';
    const args = processArgs(attachment.identity.pid);
    const serverArgument = args.indexOf('app-server');
    if (
      serverArgument < 0 ||
      args[serverArgument + 1] !== '--listen' ||
      args[serverArgument + 2] !== 'ws://127.0.0.1:0' ||
      processEnvironment(attachment.identity.pid).get('CODEX_HOME') !== attachment.codexHome
    )
      return 'refuse';
    const executableLink = readlinkSync(`/proc/${attachment.identity.pid}/exe`);
    const processPath = executableLink.replace(/ \(deleted\)$/, '');
    const processStat = statSync(`/proc/${attachment.identity.pid}/exe`);
    if (
      processPath !== attachment.processExecutablePath ||
      processStat.dev !== attachment.processExecutableDevice ||
      processStat.ino !== attachment.processExecutableInode
    )
      return 'refuse';
    const selected = selectedAppServerExecutable(pool);
    if (selected !== attachment.selectedExecutablePath) return 'obsolete';
    const selectedStat = statSync(selected);
    if (
      selectedStat.dev !== attachment.selectedExecutableDevice ||
      selectedStat.ino !== attachment.selectedExecutableInode
    )
      return 'obsolete';
    return 'adopt';
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (['ENOENT', 'ESRCH'].includes(code ?? '') && !sameProcess(attachment.identity)) return 'stale';
    throw error;
  }
}

function buildAppServerAttachment(
  pool: CodexPool,
  endpoint: string | undefined,
  identity: ProcessIdentity | undefined,
): AppServerAttachment | undefined {
  if (!endpoint || !identity) return undefined;
  if (!isPrivateAppServerEndpoint(endpoint)) throw new Error(`Refusing non-private app-server endpoint: ${endpoint}`);
  if (!sameProcess(identity) || identity.group !== identity.pid) return undefined;
  const args = processArgs(identity.pid);
  const serverArgument = args.indexOf('app-server');
  if (
    serverArgument < 0 ||
    args[serverArgument + 1] !== '--listen' ||
    args[serverArgument + 2] !== 'ws://127.0.0.1:0' ||
    processEnvironment(identity.pid).get('CODEX_HOME') !== pool.codexHome
  )
    return undefined;
  if (appServerEndpointOwnership(identity, endpoint) !== 'owned')
    throw new Error(`App-server process does not own its loopback endpoint: ${endpoint}`);
  const processExecutablePath = readlinkSync(`/proc/${identity.pid}/exe`).replace(/ \(deleted\)$/, '');
  const processExecutable = statSync(`/proc/${identity.pid}/exe`);
  const selectedExecutablePath = selectedAppServerExecutable(pool);
  const selectedExecutable = statSync(selectedExecutablePath);
  return {
    version: 1,
    identity,
    poolId: pool.id,
    codexHome: pool.codexHome,
    executable: pool.executable ?? 'codex',
    endpoint,
    environmentFingerprint: appServerEnvironmentFingerprint(pool),
    selectedExecutablePath,
    selectedExecutableDevice: selectedExecutable.dev,
    selectedExecutableInode: selectedExecutable.ino,
    processExecutablePath,
    processExecutableDevice: processExecutable.dev,
    processExecutableInode: processExecutable.ino,
  };
}

function writeAppServerHandoffRequest(stateDirectory: string): void {
  const path = join(stateDirectory, appServerHandoffName);
  writeFileSync(path, JSON.stringify({ version: 1, requestedAt: Date.now(), requesterPid: process.pid }), {
    mode: 0o600,
  });
  chmodSync(path, 0o600);
}

function restartHandoffRequested(stateDirectory: string): boolean {
  try {
    const value = JSON.parse(readFileSync(join(stateDirectory, appServerHandoffName), 'utf8')) as {
      version?: unknown;
      requestedAt?: unknown;
      requesterPid?: unknown;
    };
    return (
      value.version === 1 &&
      Number.isSafeInteger(value.requestedAt) &&
      Number.isSafeInteger(value.requesterPid) &&
      Number(value.requesterPid) > 0 &&
      Date.now() - Number(value.requestedAt) >= 0 &&
      Date.now() - Number(value.requestedAt) <= 120_000
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function waitForProcessExit(identity: ProcessIdentity, timeoutMs: number, pollMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (sameProcess(identity) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, pollMs));
  return !sameProcess(identity);
}

async function stopRecordedAppServer(identity: ProcessIdentity, policy: typeof defaultPolicy.appServer): Promise<void> {
  // An app-server that leads its own process group (connectPool) takes its helpers and thread writers with it. Reclaim
  // the whole group and wait until it is empty, so resuming threads never meets a writer from the previous host.
  if (identity.group === identity.pid) {
    await terminateProcessGroup(identity, policy.terminationGraceMs);
    return;
  }
  // Records from before the group change name a shared group: only the recorded process can be signalled.
  if (!sameProcess(identity)) return;
  try {
    process.kill(identity.pid, 'SIGTERM');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
  if (await waitForProcessExit(identity, policy.terminationGraceMs, policy.exitPollMs)) return;
  if (sameProcess(identity)) {
    try {
      process.kill(identity.pid, 'SIGKILL');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
  }
  if (!(await waitForProcessExit(identity, policy.killWaitMs, policy.exitPollMs)))
    throw new Error(`App-server process did not exit: ${identity.pid}`);
}

export async function stopRecordedAppServers(path: string, policy: typeof defaultPolicy.appServer): Promise<void> {
  const entries = readAppServerRegistry(path);
  for (const entry of entries) await stopRecordedAppServer(entry.identity, policy);
  rmSync(path, { force: true });
}

export async function serveManagers(runtime: IntegrationRuntime, options: ManagerHostOptions = {}): Promise<void> {
  const policy = runtime.managerServices.policy ?? defaultPolicy;
  const stateSweepIntervalMs = runtime.hostSweepIntervalMs ?? policy.host.stateSweepIntervalMs;
  if (!Number.isSafeInteger(stateSweepIntervalMs) || stateSweepIntervalMs <= 0)
    throw new Error('Manager host state sweep interval must be a positive integer');
  const lease = acquireDirectoryLease(`${runtime.managerSocket}.lease`, policy.leases);
  let activeRequests = 0,
    stopServer: (() => void) | undefined;
  let reaping: Promise<unknown> | undefined;
  let stopRequested = false;
  let registrySafe = false;
  let managers!: ManagerSessions;
  const registryPath = join(runtime.stateDirectory, appServerRegistryName);
  const handoffPath = join(runtime.stateDirectory, appServerHandoffName);
  const handoffAppServers = () => restartHandoffRequested(runtime.stateDirectory);
  const connectManagerPool = async (pool: CodexPool, onStart?: (identity: ProcessIdentity) => void) => {
    const entries = readAppServerRegistry(registryPath);
    const samePoolId = entries.filter((entry) => entry.attachment?.poolId === pool.id);
    if (samePoolId.length > 1) throw new Error(`Multiple recorded app-servers for manager pool ${pool.id}`);
    const entry = samePoolId[0];
    let attachment = entry?.attachment;
    if (attachment) {
      if (attachment.codexHome !== pool.codexHome || attachment.executable !== (pool.executable ?? 'codex'))
        throw new Error(`Refusing manager pool identity change for ${pool.id}`);
      const proof = appServerProcessProof(pool, attachment);
      if (proof === 'refuse') throw new Error(`Refusing unverified manager app-server for pool ${pool.id}`);
      if (proof === 'stale') {
        await stopRecordedAppServer(attachment.identity, policy.appServer);
        removeAppServerIdentity(registryPath, attachment.identity);
        attachment = undefined;
      } else if (proof === 'obsolete') {
        await stopRecordedAppServer(attachment.identity, policy.appServer);
        removeAppServerIdentity(registryPath, attachment.identity);
        attachment = undefined;
      } else {
        try {
          const adopted = await attachPool(pool, attachment, policy.appServer);
          writeAppServerAttachment(registryPath, attachment);
          return adopted;
        } catch (error) {
          if (error instanceof ForeignAppServerEndpointError) throw error;
          // One bounded same-pool recovery: retire only the proven old group, then launch once and resume the stored
          // thread. A foreign endpoint or changed environment is refused before this recovery path.
          console.error(
            `Manager app-server reattach failed for ${pool.id}; starting one clean rejoin: ${String(error)}`,
          );
          await stopRecordedAppServer(attachment.identity, policy.appServer);
          removeAppServerIdentity(registryPath, attachment.identity);
          attachment = undefined;
        }
      }
    }
    const diagnosticsPath = join(
      runtime.stateDirectory,
      'manager-app-servers',
      `${createHash('sha256').update(pool.id).digest('hex')}.log`,
    );
    const created = runtime.managerServices.connect
      ? await runtime.managerServices.connect(pool, onStart)
      : await connectPool(pool, onStart, process.env, policy.appServer, diagnosticsPath);
    const createdAttachment = buildAppServerAttachment(pool, created.endpoint, created.identity);
    if (createdAttachment) writeAppServerAttachment(registryPath, createdAttachment);
    return created;
  };
  const server = createServer((socket) => {
    const lines = createInterface({ input: socket });
    socket.once('close', () => lines.close());
    lines.once('line', async (line) => {
      lines.close();
      activeRequests++;
      let completed = false;
      const completeRequest = () => {
        if (completed) return;
        completed = true;
        activeRequests--;
        stopWhenIdle();
      };
      socket.once('close', completeRequest);
      try {
        const request = JSON.parse(line) as HostRequest;
        let result: unknown;
        switch (request.command) {
          case 'register-supermanager':
            if (!request.sessionId) throw new Error('Missing resident provider session ID');
            if (!runtime.supermanager) throw new Error('Configured supermanager identity is missing');
            result = await managers.registerResidentSupermanager(runtime.supermanager, request.sessionId, {
              ...(request.residentProvider !== undefined ? { provider: request.residentProvider } : {}),
              ...(request.replaceSession !== undefined ? { replaceSession: request.replaceSession } : {}),
            });
            break;
          case 'start':
            if (!request.spec) throw new Error('Missing manager spec');
            result = await managers.start(request.spec);
            break;
          case 'renew':
            if (!request.spec) throw new Error('Missing manager spec');
            result = await managers.renew(request.manager!, request.spec);
            break;
          case 'stop':
            result = await managers.stop(request.manager!);
            break;
          case 'complete':
            result = await managers.completeCommand(request.manager!);
            break;
          case 'decision':
            result = await managers.noteCommand(request.manager!);
            break;
          case 'turn-start':
            result = await managers.claudeTurn(request.manager!, true);
            break;
          case 'turn-end':
            result = await managers.claudeTurn(request.manager!, false);
            break;
          case 'outgoing-message':
            if (!request.manager || !request.recipient || request.summary === undefined)
              throw new Error('Incomplete outgoing manager message');
            result = await managers.outgoingMessage(request.manager, request.recipient, request.summary);
            break;
          case 'assign':
            if (!request.goal || !request.manager) throw new Error('Missing Goal or manager for assign');
            result = await managers.assign(request.goal, request.manager);
            break;
          default:
            throw new Error('Unknown manager host command');
        }
        if (socket.destroyed || !socket.writable) completeRequest();
        else socket.end(`${JSON.stringify({ result: result ?? null })}\n`, completeRequest);
      } catch (error) {
        if (socket.destroyed || !socket.writable) completeRequest();
        else socket.end(`${JSON.stringify({ error: String(error) })}\n`, completeRequest);
      }
    });
    socket.on('error', () => {});
  });
  const stopWhenIdle = () => {
    if (stopRequested && activeRequests === 0) stopServer?.();
  };
  const closeServer = () => {
    if (server.listening) server.close();
  };
  const stop = () => {
    if (stopRequested) return;
    stopRequested = true;
    closeServer();
    stopWhenIdle();
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  let stopHeartbeat: (() => void) | undefined;
  let stateTimer: ReturnType<typeof setInterval> | undefined;
  let recoveryTimer: ReturnType<typeof setInterval> | undefined;
  let codePoll: ReturnType<typeof setInterval> | undefined;
  const recoverOrphans = () => {
    if (!runtime.recoverOrphans) return Promise.resolve();
    // A sweep may wait for adopted workers. Let later timer ticks start their own sweep so
    // newly orphaned tasks and retry intents are considered while those workers are running.
    return runHostOperation('orphan recovery', () => runtime.recoverOrphans!());
  };
  // A host keeps the tools/goal it loaded. Once main publishes another revision it starts no new attempt and stops
  // after its active requests, and systemd starts it on the published code. Retirement waits until this host has run
  // for restartIntervalMs, so a burst of releases cannot restart it in a loop. cp-sync restarts the host regardless.
  const loadedCode = runtime.loadedCodeVersion;
  const hostStartedAt = Date.now();
  let checkingCode = false;
  const retireForPublishedCode = async () => {
    if (checkingCode || stopRequested || loadedCode === undefined) return;
    if (Date.now() - hostStartedAt < policy.host.restartIntervalMs) return;
    checkingCode = true;
    try {
      const published = await currentCodeVersion(runtime.mainCheckout);
      // An unreadable main is not a new revision: only a readable, different tools/goal retires this host.
      if (published === undefined || published === loadedCode || stopRequested) return;
      if (runtime.codeRetirement) {
        runtime.codeRetirement.retiring = true;
        writeAppServerHandoffRequest(runtime.stateDirectory);
      }
      console.log(
        `tools/goal is published as ${published}; this host stops after its active requests so systemd restarts it.`,
      );
      stop();
    } finally {
      checkingCode = false;
    }
  };
  try {
    await prepareAppServerRegistry(registryPath, policy.appServer);
    registrySafe = true;
    rmSync(handoffPath, { force: true });
    const inbox = runtime.inbox ?? new SqliteManagerInbox(runtime.db, runtime.stateDirectory, undefined, policy.inbox);
    const onAppServerStart = runtime.managerServices.onAppServerStart;
    managers = new ManagerSessions(runtime.db, inbox, {
      ...runtime.managerServices,
      connect: connectManagerPool,
      handoffAppServersOnClose: handoffAppServers,
      onAppServerStart(identity) {
        const current = readAppServerRegistry(registryPath);
        const existing = current.find((record) => sameIdentity(record.identity, identity));
        const records = current.filter((record) => record.identity.pid !== identity.pid);
        records.push(existing ?? { identity });
        writeAppServerRegistry(registryPath, records);
        onAppServerStart?.(identity);
      },
    });
    rmSync(runtime.managerSocket, { force: true });
    // Recovery waits for adopted workers, which can run for an hour; the socket must not wait with it.
    void recoverOrphans().catch((error) => console.error(error));
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(runtime.managerSocket, resolve);
    });
    chmodSync(runtime.managerSocket, 0o600);
    if (stopRequested) return;
    // Readiness and the watchdog start with the socket: no recovery or scheduler pass can delay the heartbeat.
    stopHeartbeat = await startHostHeartbeat(undefined, undefined, policy.service);
    let reportRecoveryProgress!: () => void;
    const recoveryProgress = new Promise<void>((resolve) => (reportRecoveryProgress = resolve));
    void runHostOperation('manager recovery', () => managers.recover(reportRecoveryProgress)).catch((error) => {
      console.error('manager recovery failed:', error);
      reportRecoveryProgress();
    });
    let readinessTimer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      recoveryProgress,
      new Promise<void>((resolve) => {
        readinessTimer = setTimeout(resolve, policy.host.recoveryReadinessMs);
      }),
    ]);
    if (readinessTimer) clearTimeout(readinessTimer);
    // The socket is already accepting requests. Yield once so a submitted recovery RPC reaches its provider first.
    await new Promise<void>((resolve) => setImmediate(resolve));
    console.log('ready');
    const remind = () => {
      try {
        runHostOperation('daily step audit', () => runtime.dispatchDailyStepAudit?.()).catch((error) =>
          console.error(error),
        );
      } catch (error) {
        console.error(error);
      }
      try {
        runtime.dispatchArchitectureRepairs?.();
      } catch (error) {
        console.error(error);
      }
    };
    remind();
    // The train promotes only when its queue empties; with a steady backlog that never happens, so the host starts
    // a promotion step in its own process every minute. Promotion runs git and generators synchronously, so it must
    // never run inside the host, whose socket serves managers. The promotion lease keeps one run at a time.
    let promotion: ReturnType<typeof spawn> | undefined;
    const promote = () => {
      if (!runtime.promote || (promotion && promotion.exitCode === null && promotion.signalCode === null)) return;
      const log = openSync(join(runtime.stateDirectory, 'promotion-runner.log'), 'a');
      promotion = spawn(process.execPath, [process.argv[1]!, 'promote'], {
        cwd: runtime.mainCheckout,
        stdio: ['ignore', log, log],
      });
      promotion.once('exit', () => closeSync(log));
      promotion.unref();
    };
    const backlog = singleFlight(() => {
      const log = openSync(join(runtime.stateDirectory, 'backlog-runner.log'), 'a');
      const child = spawn(process.execPath, [process.argv[1]!, 'backlog', 'dispatch'], {
        cwd: runtime.mainCheckout,
        stdio: ['ignore', log, log],
      });
      child.once('exit', () => closeSync(log));
      child.once('error', () => closeSync(log));
      child.unref();
      return child;
    });
    const runBacklog = () => {
      if (!runtime.backlog) return;
      try {
        backlog();
      } catch (error) {
        console.error('backlog run failed to start:', error);
      }
    };
    // Ended-attempt resources and opted-in stale containers are reaped every five minutes.
    let reapedAt = 0;
    const reap = () => {
      if (reaping || Date.now() - reapedAt < policy.containers.cleanupIntervalMs) return;
      reapedAt = Date.now();
      // Docker and task projection run after a yield: a slow daemon must not hold the manager socket.
      reaping = Promise.resolve()
        .then(() =>
          runHostOperation('container reaper', async () => {
            await sweepAbandonedResources({
              tasks: readTerminalTaskOwners(runtime.db),
              stateDirectory: runtime.stateDirectory,
              containers: policy.containers,
              graceMs: 1000,
              ...(options.terminalProcessSweep ? { terminalProcessSweep: options.terminalProcessSweep } : {}),
              currentTerminalOwner: createManagerTerminalOwnerLookup(runtime.db, runtime.stateDirectory),
            });
            await reapContainersAsync(
              runtime.db,
              runtime.stateDirectory,
              Date.now(),
              runtime.managerServices.policy?.containers,
            );
          }),
        )
        .catch((error) => console.error(error))
        .finally(() => {
          reaping = undefined;
        });
    };
    let widthSweepRunning = false;
    const scheduleWidthSweep = () => {
      if (!runtime.sweepWidth || widthSweepRunning) return;
      setImmediate(() => {
        if (widthSweepRunning) return;
        widthSweepRunning = true;
        void Promise.resolve()
          .then(() => runHostOperation('width sweep', () => runtime.sweepWidth!()))
          .catch((error) => console.error('width sweep failed:', error))
          .finally(() => {
            widthSweepRunning = false;
          });
      });
    };
    scheduleWidthSweep();
    runBacklog();
    recoveryTimer = startOrphanRecoveryTimer(recoverOrphans, policy.host.recoveryIntervalMs, () => {
      remind();
      scheduleWidthSweep();
      runBacklog();
      promote();
      reap();
    });
    await new Promise<void>((resolve) => {
      stopServer = resolve;
      if (stopRequested) stopWhenIdle();
      stateTimer = setInterval(() => {
        if (!existsSync(runtime.stateDirectory)) {
          stop();
          return;
        }
      }, stateSweepIntervalMs);
      stateTimer.unref();
      codePoll = setInterval(() => {
        void retireForPublishedCode().catch((error) => console.error('tools/goal revision check failed:', error));
      }, policy.host.codePollMs);
      codePoll.unref();
    });
  } finally {
    if (reaping) await reaping;
    stopHeartbeat?.();
    if (recoveryTimer) clearInterval(recoveryTimer);
    if (stateTimer) clearInterval(stateTimer);
    if (codePoll) clearInterval(codePoll);
    closeServer();
    const handoff = handoffAppServers();
    try {
      if (managers) await managers.close();
    } finally {
      rmSync(runtime.managerSocket, { force: true });
      try {
        if (registrySafe && !handoff) await stopRecordedAppServers(registryPath, policy.appServer);
      } finally {
        try {
          if (!handoff) rmSync(handoffPath, { force: true });
          lease.release();
        } finally {
          process.off('SIGTERM', stop);
          process.off('SIGINT', stop);
        }
      }
    }
  }
}
