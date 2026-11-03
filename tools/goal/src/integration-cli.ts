import type { Database } from 'bun:sqlite';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, createConnection } from 'node:net';
import { createInterface } from 'node:readline';
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type {
  AttemptFence,
  GateOutcomeSink,
  InboxDocumentReference,
  InboxEscalation,
  LandingRequest,
  ManagerEventKind,
} from './contracts.ts';
import { reapContainers } from './containers.ts';
import { SqliteLandingQueue } from './land.ts';
import { MergeTrain } from './merge-train.ts';
import { SqliteManagerInbox } from './inbox.ts';
import { SharedInboxQueries, type SharedInboxFilter } from './inbox-shared.ts';
import { backlogStatus, formatBacklogStatus } from './backlog.ts';
import { ManagerSessions, recordManagerDecision, type ManagerServices, type ManagerSpec } from './managers.ts';
import { acquireDirectoryLease } from './lease.ts';
import { ensureHostRunning, startHostSupervisor, recordHostLiveness } from './host-liveness.ts';
import { sameProcess, type ProcessIdentity } from './process.ts';
import { authenticatedManager, type AuthenticatedManager } from './priority-authority.ts';
import { isPendingContinuationHandshake } from './manager-continuation.ts';
import { completedUtcHour } from './efficiency-report.ts';
import { defaultPolicy } from './policy.ts';

/** Composition belongs to the caller; this module never reads worker configuration or tables. */
export type IntegrationRuntime = {
  queue?: SqliteLandingQueue;
  train?: Pick<MergeTrain, 'runWaiting'>;
  inbox?: SqliteManagerInbox;
  /** Pure shared read API for authenticated managers and report consumers. */
  sharedInbox?: SharedInboxQueries;
  pump?(): Promise<void>;
  drain?(): Promise<void>;
  drainJobs?(): Promise<void>;
  /** Enqueue manager-owned accepted work through the durable landing queue. */
  managerLand?(task: string, manager: string): boolean;
  /** Start the existing controller train without running gates in the manager command process. */
  handoffTrain?(): Promise<void>;
  hostCommand?: string[];
  hostSweepIntervalMs?: number;
  hourlyEfficiencyReport?: { enabled: boolean; timeoutMs: number };
  codeIsCurrent?(): boolean;
  recoverOrphans?(options?: { adoptRunning?: boolean }): Promise<void>;
  deliverReminders?(): number;
  /** Periodic, bounded scan of current worker ownership that may wake an under-width Goal manager. */
  sweepWidth?(): Promise<void>;
  /** One backlog run; the host runs it in a single-flight `backlog dispatch` child process. */
  backlog?(): Promise<unknown>;
  /** One promotion step; returns at once when a promotion holds the lease or nothing changed. */
  promote?(): Promise<void>;
  verify?(): Promise<void>;
  evaluateFlow?(): void | Promise<void>;
  dispatchDailyStepAudit?(): void;
  db: Database;
  mainCheckout: string;
  stateDirectory: string;
  worktreeRoot: string;
  managerSocket: string;
  supermanager?: string;
  fence: AttemptFence;
  sink: GateOutcomeSink;
  landing(task: string): LandingRequest;
  manager(goal: string, engine: 'codex' | 'claude', budget: number): ManagerSpec;
  managerServices: ManagerServices;
};
export type HostRequest = {
  command:
    | 'start'
    | 'renew'
    | 'stop'
    | 'complete'
    | 'decision'
    | 'turn-start'
    | 'turn-end'
    | 'outgoing-message'
    | 'register-supermanager';
  manager?: string;
  spec?: ManagerSpec;
  recipient?: string;
  summary?: string;
  sessionId?: string;
};

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

function readAppServerRegistry(path: string): ProcessIdentity[] {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (!Array.isArray(parsed) || !parsed.every(isProcessIdentity))
      throw new Error(`Invalid app-server process registry: ${path}`);
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

function writeAppServerRegistry(path: string, identities: ProcessIdentity[]): void {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(identities), { mode: 0o600 });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

async function waitForProcessExit(identity: ProcessIdentity, timeoutMs: number, pollMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (sameProcess(identity) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, pollMs));
  return !sameProcess(identity);
}

async function stopRecordedAppServer(identity: ProcessIdentity, policy: typeof defaultPolicy.appServer): Promise<void> {
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

async function stopRecordedAppServers(path: string, policy: typeof defaultPolicy.appServer): Promise<void> {
  const identities = readAppServerRegistry(path);
  for (const identity of identities) await stopRecordedAppServer(identity, policy);
  rmSync(path, { force: true });
}

export function hostRequest(
  socketPath: string,
  request: HostRequest,
  timeoutMs?: number,
  retryDelayMs?: number,
  policy = defaultPolicy.host,
): Promise<any> {
  const timeout = timeoutMs ?? policy.requestTimeoutMs;
  const retryDelay = retryDelayMs ?? policy.requestRetryMs;
  return new Promise((resolve, reject) => {
    if (!Number.isSafeInteger(timeout) || timeout <= 0 || !Number.isSafeInteger(retryDelay) || retryDelay < 0) {
      reject(new Error('Manager host request timeout and retry delay must be valid milliseconds'));
      return;
    }
    const deadline = Date.now() + timeout;
    const timeoutError = () => new Error(`Manager host request timed out after ${timeout}ms`);
    let socket: ReturnType<typeof createConnection> | undefined;
    let lines: ReturnType<typeof createInterface> | undefined;
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    let connected = false;
    let connect: () => void = () => {};

    const cleanupAttempt = () => {
      lines?.close();
      lines = undefined;
      if (socket) {
        const closing = socket;
        closing.removeAllListeners('connect');
        closing.removeAllListeners('end');
        closing.removeAllListeners('close');
        closing.removeAllListeners('error');
        if (!closing.destroyed) {
          // A pending write can report EPIPE while destroy is closing the descriptor. Keep one guard until close.
          closing.once('error', () => {});
          closing.once('close', () => closing.removeAllListeners('error'));
          closing.destroy();
        }
        socket = undefined;
      }
    };
    const finish = (error?: unknown, result?: unknown) => {
      if (settled) return;
      settled = true;
      if (deadlineTimer) clearTimeout(deadlineTimer);
      if (retryTimer) clearTimeout(retryTimer);
      cleanupAttempt();
      if (error !== undefined) reject(error instanceof Error ? error : new Error(String(error)));
      else resolve(result);
    };
    const retryConnection = (error: NodeJS.ErrnoException) => {
      if (connected || !['ENOENT', 'ECONNREFUSED'].includes(error.code ?? '')) {
        finish(error);
        return;
      }
      cleanupAttempt();
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        finish(timeoutError());
        return;
      }
      retryTimer = setTimeout(connect, Math.min(retryDelay, remaining));
    };
    const onLine = (line: string) => {
      try {
        const response = JSON.parse(line);
        if (response.error) finish(new Error(response.error));
        else finish(undefined, response.result);
      } catch (error) {
        finish(error);
      }
    };
    connect = () => {
      if (settled) return;
      connected = false;
      let attempt: ReturnType<typeof createConnection>;
      try {
        attempt = createConnection(socketPath);
      } catch (error) {
        finish(error);
        return;
      }
      socket = attempt;
      attempt.once('connect', () => {
        connected = true;
        lines = createInterface({ input: attempt, crlfDelay: Infinity });
        lines.once('line', onLine);
        attempt.once('end', () => finish(new Error('Manager host closed without a response')));
        attempt.once('close', () => finish(new Error('Manager host closed without a response')));
        try {
          attempt.write(`${JSON.stringify(request)}\n`, (error) => {
            if (error) finish(error);
          });
        } catch (error) {
          finish(error);
        }
      });
      attempt.once('error', (error) => retryConnection(error as NodeJS.ErrnoException));
    };

    deadlineTimer = setTimeout(() => finish(timeoutError()), timeout);
    connect();
  });
}

const hostRestartPath = (stateDirectory: string) => join(stateDirectory, 'manager-host-restart.json');
export function managerHostRestartAllowed(
  stateDirectory: string,
  now = Date.now(),
  policy = defaultPolicy.host,
): boolean {
  const path = hostRestartPath(stateDirectory);
  try {
    const previous = JSON.parse(readFileSync(path, 'utf8')) as { at?: unknown };
    if (typeof previous.at === 'number' && now - previous.at < policy.restartIntervalMs) return false;
  } catch {
    // The first restart has no saved timestamp.
  }
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify({ at: now }), { mode: 0o600 });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
  return true;
}

async function ensureHost(runtime: IntegrationRuntime): Promise<void> {
  mkdirSync(runtime.stateDirectory, { recursive: true });
  const config = {
    policy: runtime.managerServices.policy?.host ?? defaultPolicy.host,
    stateDirectory: runtime.stateDirectory,
    managerSocket: runtime.managerSocket,
    mainCheckout: runtime.mainCheckout,
    command: runtime.hostCommand ?? [process.execPath, join(runtime.mainCheckout, 'tools/goal/src/cli.ts')],
  };
  await ensureHostRunning(config);
  await startHostSupervisor(config);
}

export async function serveManagers(runtime: IntegrationRuntime): Promise<void> {
  const policy = runtime.managerServices.policy ?? defaultPolicy;
  const stateSweepIntervalMs = runtime.hostSweepIntervalMs ?? policy.host.stateSweepIntervalMs;
  if (!Number.isSafeInteger(stateSweepIntervalMs) || stateSweepIntervalMs <= 0)
    throw new Error('Manager host state sweep interval must be a positive integer');
  const lease = acquireDirectoryLease(`${runtime.managerSocket}.lease`);
  let activeRequests = 0,
    restart = false,
    stopServer: (() => void) | undefined;
  let stopRequested = false;
  let registrySafe = false;
  let managers!: ManagerSessions;
  const registryPath = join(runtime.stateDirectory, appServerRegistryName);
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
            if (!request.sessionId) throw new Error('Missing resident Claude session ID');
            if (!runtime.supermanager) throw new Error('Configured supermanager identity is missing');
            result = await managers.registerResidentSupermanager(runtime.supermanager, request.sessionId);
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
  const requestRestart = () => {
    if (!managerHostRestartAllowed(runtime.stateDirectory, Date.now(), policy.host)) return;
    restart = true;
    stopRequested = true;
    closeServer();
    stopWhenIdle();
  };
  const stop = () => {
    stopRequested = true;
    closeServer();
    stopWhenIdle();
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  let codeTimer: ReturnType<typeof setInterval> | undefined;
  let stateTimer: ReturnType<typeof setInterval> | undefined;
  let recoveryTimer: ReturnType<typeof setInterval> | undefined;
  const recoverOrphans = () => {
    if (!runtime.recoverOrphans) return Promise.resolve();
    // A sweep may wait for adopted workers. Let later timer ticks start their own sweep so
    // newly orphaned tasks and retry intents are considered while those workers are running.
    return runtime.recoverOrphans();
  };
  try {
    recordHostLiveness(runtime.stateDirectory, true);
    await stopRecordedAppServers(registryPath, policy.appServer);
    registrySafe = true;
    const inbox = runtime.inbox ?? new SqliteManagerInbox(runtime.db, runtime.stateDirectory);
    const onAppServerStart = runtime.managerServices.onAppServerStart;
    managers = new ManagerSessions(runtime.db, inbox, {
      ...runtime.managerServices,
      onAppServerStart(identity) {
        const records = readAppServerRegistry(registryPath).filter((record) => record.pid !== identity.pid);
        records.push(identity);
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
    await startHostSupervisor({
      policy: policy.host,
      stateDirectory: runtime.stateDirectory,
      managerSocket: runtime.managerSocket,
      mainCheckout: runtime.mainCheckout,
      command: runtime.hostCommand ?? [process.execPath, join(runtime.mainCheckout, 'tools/goal/src/cli.ts')],
    });
    if (stopRequested) return;
    let reportRecoveryProgress!: () => void;
    const recoveryProgress = new Promise<void>((resolve) => (reportRecoveryProgress = resolve));
    void managers.recover(reportRecoveryProgress).catch((error) => {
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
        runtime.deliverReminders?.();
      } catch (error) {
        console.error(error);
      }
    };
    let lastFlowReview = 0;
    const reviewFlow = () => {
      if (Date.now() - lastFlowReview >= policy.host.flowReviewIntervalMs) {
        lastFlowReview = Date.now();
        if (runtime.evaluateFlow)
          setImmediate(() => {
            void Promise.resolve()
              .then(() => runtime.evaluateFlow!())
              .catch((error) => console.error('flow review failed:', error));
          });
      }
      try {
        runtime.dispatchDailyStepAudit?.();
      } catch (error) {
        console.error(error);
      }
    };
    remind();
    reviewFlow();
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
    let verifier: ReturnType<typeof spawn> | undefined;
    const verify = () => {
      if (!runtime.verify || (verifier && verifier.exitCode === null && verifier.signalCode === null)) return;
      const log = openSync(join(runtime.stateDirectory, 'dev-verifier-runner.log'), 'a');
      verifier = spawn(process.execPath, [process.argv[1]!, 'verify'], {
        cwd: runtime.mainCheckout,
        stdio: ['ignore', log, log],
      });
      verifier.once('exit', () => closeSync(log));
      verifier.unref();
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
    const publishHourlyReport = runtime.hourlyEfficiencyReport?.enabled
      ? createHourlyReportScheduler((bucket) => {
          const configured = runtime.hourlyEfficiencyReport!;
          let child: ReturnType<typeof spawn>;
          try {
            child = spawn(
              process.execPath,
              [
                join(runtime.mainCheckout, 'tools/goal/scripts/efficiency-report.ts'),
                '--send',
                '--scheduled',
                '--bucket',
                bucket,
              ],
              { cwd: runtime.mainCheckout, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true },
            );
          } catch {
            console.error(`Hourly report ${bucket}: runner could not start; no outcome recorded.`);
            return;
          }
          let output = '';
          let finished = false;
          let timedOut = false;
          let killTimer: ReturnType<typeof setTimeout> | undefined;
          const timeout = setTimeout(
            () => {
              timedOut = true;
              child.kill('SIGTERM');
              killTimer = setTimeout(() => child.kill('SIGKILL'), policy.host.reportTerminationGraceMs);
              killTimer.unref();
            },
            Math.min(policy.host.reportTimeoutMs, configured.timeoutMs + policy.host.reportOverheadMs),
          );
          timeout.unref();
          const finish = (message: string, error = false) => {
            if (finished) return;
            finished = true;
            clearTimeout(timeout);
            if (killTimer) clearTimeout(killTimer);
            (error ? console.error : console.info)(`Hourly report ${bucket}: ${message}`);
          };
          child.stdout?.on('data', (chunk: Buffer | string) => {
            if (output.length < policy.host.reportOutputCharacters)
              output += chunk.toString().slice(0, policy.host.reportOutputCharacters - output.length);
          });
          child.once('error', () => finish('runner could not start; no outcome recorded.', true));
          child.once('close', (code, signal) => {
            const match =
              /^Delivery: (disabled|sent|failed|unknown|claimed|already-sent|already-failed|already-unknown)\b/m.exec(
                output,
              );
            if (timedOut) finish('runner timed out; delivery outcome unknown.', true);
            else if (match) finish(match[1]! + '.');
            else finish(`no outcome recorded (runner ${code ?? signal ?? 'unknown'}).`, true);
          });
          child.unref();
        })
      : undefined;
    // Containers that workers and checks leave running are removed every ten minutes, per <state>/containers.json.
    let reapedAt = 0;
    const reap = () => {
      if (Date.now() - reapedAt < policy.containers.cleanupIntervalMs) return;
      reapedAt = Date.now();
      try {
        reapContainers(runtime.db, runtime.stateDirectory, Date.now(), runtime.managerServices.policy?.containers);
      } catch (error) {
        console.error(error);
      }
    };
    let widthSweepRunning = false;
    const scheduleWidthSweep = () => {
      if (!runtime.sweepWidth || widthSweepRunning) return;
      setImmediate(() => {
        if (widthSweepRunning) return;
        widthSweepRunning = true;
        void Promise.resolve()
          .then(() => runtime.sweepWidth!())
          .catch((error) => console.error('width sweep failed:', error))
          .finally(() => {
            widthSweepRunning = false;
          });
      });
    };
    scheduleWidthSweep();
    runBacklog();
    publishHourlyReport?.();
    recoveryTimer = startOrphanRecoveryTimer(recoverOrphans, policy.host.recoveryIntervalMs, () => {
      remind();
      reviewFlow();
      scheduleWidthSweep();
      runBacklog();
      publishHourlyReport?.();
      promote();
      verify();
      reap();
    });
    await new Promise<void>((resolve) => {
      stopServer = resolve;
      if (stopRequested) stopWhenIdle();
      if (runtime.codeIsCurrent) {
        codeTimer = setInterval(() => {
          try {
            if (!runtime.codeIsCurrent!()) requestRestart();
          } catch {}
        }, policy.host.codePollMs);
        codeTimer.unref();
        try {
          if (!runtime.codeIsCurrent()) requestRestart();
        } catch {}
      }
      stateTimer = setInterval(() => {
        if (!existsSync(runtime.stateDirectory)) {
          stop();
          return;
        }
        if (runtime.codeIsCurrent) {
          try {
            if (!runtime.codeIsCurrent()) requestRestart();
          } catch {}
        }
      }, stateSweepIntervalMs);
      stateTimer.unref();
    });
  } finally {
    // Intentional shutdown must not be interpreted as a crash. Code handoff keeps restart desired.
    if (stopRequested && !restart && existsSync(runtime.stateDirectory))
      recordHostLiveness(runtime.stateDirectory, false);
    if (recoveryTimer) clearInterval(recoveryTimer);
    if (codeTimer) clearInterval(codeTimer);
    if (stateTimer) clearInterval(stateTimer);
    closeServer();
    if (managers) await managers.close();
    rmSync(runtime.managerSocket, { force: true });
    if (registrySafe) rmSync(registryPath, { force: true });
    lease.release();
  }
  if (restart) await ensureHost(runtime);
}

export async function runIntegration(argv: string[], runtime: IntegrationRuntime): Promise<number> {
  const [command, subcommand, id, ...flags] = argv;
  const policy = runtime.managerServices.policy ?? defaultPolicy;
  const requestHost = (request: HostRequest, timeoutMs?: number) =>
    hostRequest(runtime.managerSocket, request, timeoutMs, undefined, policy.host);
  const inbox = runtime.inbox ?? new SqliteManagerInbox(runtime.db, runtime.stateDirectory);
  const sharedInbox = runtime.sharedInbox ?? new SharedInboxQueries(runtime.db);
  const queue = runtime.queue ?? new SqliteLandingQueue(runtime.db, runtime.fence);
  if (command === 'land' && subcommand) {
    if (flags.length) throw new Error('usage: land <task>');
    if (process.env.GOAL_TASK_ID || process.env.GOAL_ATTEMPT)
      throw new Error('Workers cannot use the manager-owned land command');
    const manager = callingManager(runtime);
    await recordManagerCommand(runtime);
    if (manager) {
      if (!runtime.managerLand) throw new Error('Manager-owned landing is unavailable in this runtime');
      if (!runtime.managerLand(subcommand, manager)) return 0;
      await runtime.handoffTrain?.();
      return 0;
    }
    queue.enqueue(runtime.landing(subcommand));
    if (runtime.pump) {
      await runtime.pump();
      await runtime.drain?.();
    }
    return 0;
  }
  if (command === 'promote') {
    await runtime.promote?.();
    return 0;
  }
  if (command === 'verify') {
    await runtime.verify?.();
    return 0;
  }
  if (command === 'backlog') {
    const usage = 'usage: backlog status [--json] | backlog dispatch';
    if (subcommand === 'dispatch') {
      if (id !== undefined || flags.length) throw new Error(usage);
      if (process.env.GOAL_TASK_ID || process.env.GOAL_ATTEMPT)
        throw new Error('Workers cannot use the manager-owned backlog command');
      if (!runtime.backlog) throw new Error('The backlog run is unavailable in this runtime');
      console.log(JSON.stringify({ at: new Date().toISOString(), ...((await runtime.backlog()) as object) }));
      return 0;
    }
    const json = flags.length === 0 && id === '--json';
    if (subcommand !== 'status' || flags.length || (id !== undefined && !json)) throw new Error(usage);
    const rows = backlogStatus(runtime.stateDirectory);
    console.log(json ? JSON.stringify(rows) : formatBacklogStatus(rows));
    return 0;
  }
  if (command === 'train') {
    await recordManagerCommand(runtime);
    if (runtime.train) {
      await runtime.train.runWaiting();
      await runtime.drainJobs?.();
    } else {
      await new MergeTrain({ ...runtime, queue }).runWaiting();
      await runtime.drain?.();
    }
    return 0;
  }
  if (command === '_manager-host') {
    await serveManagers(runtime);
    return 0;
  }
  if (command === 'manager' && subcommand === 'register-supermanager') {
    if (id || flags.length) throw new Error('usage: manager register-supermanager');
    const manager = runtime.supermanager?.trim();
    if (!manager || manager !== runtime.supermanager)
      throw new Error('Configured supermanager identity is missing or malformed');
    const env = process.env;
    if (env.GOAL_TASK_ID || env.GOAL_ATTEMPT)
      throw new Error('Workers cannot register a resident supermanager session');
    const claudeSession = env.CLAUDE_CODE_SESSION_ID;
    const codexSession = env.CODEX_THREAD_ID;
    if (claudeSession && codexSession) throw new Error('Provider session identity is ambiguous');
    if (
      !claudeSession ||
      claudeSession.trim() !== claudeSession ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(claudeSession)
    )
      throw new Error('Run this command from the resident Claude session with a valid CLAUDE_CODE_SESSION_ID');
    const authenticated = authenticatedManager(runtime.db, env);
    if (authenticated && authenticated.id !== manager)
      throw new Error(`Authenticated manager ${authenticated.id} cannot register the configured supermanager`);
    if (env.GOAL_MANAGER && env.GOAL_MANAGER !== manager)
      throw new Error('GOAL_MANAGER does not match the configured supermanager identity');

    await ensureHost(runtime);
    let result: unknown;
    try {
      result = await requestHost({
        command: 'register-supermanager',
        sessionId: claudeSession,
      });
    } catch (error) {
      if (String(error).includes('Unknown manager host command'))
        throw new Error('The running manager host does not support resident registration; retry after it restarts');
      throw error;
    }
    console.log(JSON.stringify(result));
    return 0;
  }
  if (command === 'inbox' && subcommand) {
    if (subcommand === 'send') {
      if (!id)
        throw new Error(
          'usage: inbox send <manager> <kind> <summary> [--task <task>] [--evidence <path>] [--reply <id>]',
        );
      const [kind, summary, ...options] = flags;
      if (!kind || !summary)
        throw new Error(
          'usage: inbox send <manager> <kind> <summary> [--task <task>] [--evidence <path>] [--reply <id>] [--document <reference>] [--escalation <metadata>]',
        );
      const values = new Map<string, string[]>();
      for (let index = 0; index < options.length; index += 2) {
        const option = options[index];
        const value = options[index + 1];
        const repeatable = option === '--document';
        if (
          !['--task', '--evidence', '--reply', '--document', '--escalation'].includes(option ?? '') ||
          !value ||
          (!repeatable && values.has(option!))
        )
          throw new Error(`invalid inbox send option: ${option ?? '(missing value)'}`);
        values.set(option!, [...(values.get(option!) ?? []), value]);
      }
      const allowed = [
        'question',
        'decision',
        'blocker',
        'handoff',
        'info',
        'spec-conflict',
        'scope-growth',
        'environment',
        'round-limit',
        'stalled',
        'failed-after-consult',
        'goal-unmet',
        'goal-met',
        'instruction',
      ];
      if (!allowed.includes(kind))
        throw new Error(`unknown inbox event kind: ${kind}. Valid kinds: ${allowed.join(', ')}`);
      if (/[\r\n]/.test(summary)) throw new Error('inbox event summary must be one line');
      let replyToId: number | undefined;
      if (values.has('--reply')) {
        const reference = values.get('--reply')![0]!;
        if (!/^\d+$/.test(reference) || !Number.isSafeInteger(Number(reference)) || Number(reference) <= 0)
          throw new Error('inbox --reply must be an existing positive message id');
        replyToId = Number(reference);
      }
      const documentRefs = (values.get('--document') ?? []).map(parseDocumentReference);
      const escalation = values.has('--escalation') ? parseEscalation(values.get('--escalation')![0]!) : undefined;
      const taskId = values.get('--task')?.[0];
      if (values.has('--task') && !taskId?.trim()) throw new Error('inbox --task must be nonempty');
      if (values.has('--evidence') && !values.get('--evidence')?.[0]?.trim())
        throw new Error('inbox --evidence must be nonempty');
      // A completed Goal has no lead reading its inbox; what it owned returns to the supermanager.
      const recipient = runtime.db
        .query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'manager_sessions'")
        .get()
        ? (runtime.db.query('SELECT state FROM manager_sessions WHERE id = ?').get(id) as { state: string } | null)
        : null;
      if (recipient && JSON.parse(recipient.state).status === 'complete')
        throw new Error(
          `manager ${id} has completed its Goal and reads no inbox; send to ${runtime.supermanager || 'supermanager'}`,
        );
      const deliver = (sender: ResolvedInboxSender): ResolvedInboxSender => {
        if (sender.worker && !['instruction', 'question', 'blocker', 'handoff', 'info'].includes(kind))
          throw new Error('workers may send only instruction, question, blocker, handoff, or info inbox messages');
        inbox.deliver({
          managerId: id,
          kind: kind as ManagerEventKind,
          summary,
          from: sender.from,
          ...(kind === 'decision' && sender.sessionId ? { senderSessionId: sender.sessionId } : {}),
          ...(sender.worker ? { senderProvenance: sender.worker } : {}),
          ...(taskId ? { taskId } : sender.worker ? { taskId: sender.worker.taskId } : {}),
          ...(values.get('--evidence')?.[0] ? { evidencePath: values.get('--evidence')![0] } : {}),
          ...(replyToId !== undefined ? { replyToId } : {}),
          ...(documentRefs.length ? { documentRefs } : {}),
          ...(escalation ? { escalation } : {}),
        });
        return sender;
      };
      let sender: ResolvedInboxSender;
      if (hasWorkerIdentityMarkers(process.env)) {
        // Keep the attempt fence valid through insert so a concurrent retry cannot race source attribution.
        sender = runtime.db.transaction(() => deliver(resolveInboxSender(runtime))).immediate();
      } else {
        const manager = resolveInboxSender(runtime);
        sender = manager;
        await recordManagerCommand(runtime);
        // Goal managers send decisions, questions and handoffs only; the supermanager directs every Goal.
        if (manager.managerId !== runtime.supermanager && !isResidentSupermanagerRecord(runtime, manager.managerId))
          runtime.db
            .transaction(() => {
              inbox.assertManagerSend(manager.from, summary, id);
              deliver(manager);
            })
            .immediate();
        else deliver(manager);
      }
      if (
        !sender.worker &&
        /continuation written/i.test(summary) &&
        runtime.db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'manager_sessions'").get()
      ) {
        const source = runtime.db.query('SELECT state FROM manager_sessions WHERE id = ?').get(sender.managerId) as {
          state: string;
        } | null;
        let state: unknown = null;
        try {
          state = source ? JSON.parse(source.state) : null;
        } catch {
          state = null;
        }
        if (isPendingContinuationHandshake(summary, id, state)) {
          await ensureHost(runtime);
          // The durable local decision is authoritative. Keep the host's legacy audit view in sync with a short,
          // isolated delivery attempt; its failure must not change the inbox-send or continuation result.
          await requestHost(
            { command: 'decision', manager: sender.managerId },
            policy.host.decisionAuditTimeoutMs,
          ).catch((error) => console.error(`manager decision audit delivery failed: ${String(error)}`));
          await requestHost({
            command: 'outgoing-message',
            manager: sender.managerId,
            recipient: id,
            summary,
          });
        }
      }
    } else if (subcommand === 'log' || subcommand === 'thread' || subcommand === 'digest') {
      const args =
        subcommand === 'thread'
          ? [id, ...flags].filter((value): value is string => value !== undefined)
          : argv.slice(2);
      const options = parseInboxQueryOptions(args);
      if (subcommand !== 'thread' && options.reference !== undefined)
        throw new Error(`unexpected inbox argument: ${options.reference}`);
      if (hasWorkerIdentityMarkers(process.env)) throw new Error('workers cannot read the shared manager inbox');
      if (!authenticatedCallingManager(runtime))
        throw new Error('shared inbox reads require an authenticated manager session');
      if (subcommand === 'log') printInboxResult(sharedInbox.log(options), options.json);
      else if (subcommand === 'thread') {
        const reference = options.reference;
        if (!reference) throw new Error('usage: inbox thread <id|task> [--limit <n>] [--cursor <id>] [--json]');
        printInboxResult(
          sharedInbox.thread(reference, {
            ...(options.limit !== undefined ? { limit: options.limit } : {}),
            ...(options.cursor !== undefined ? { cursor: options.cursor } : {}),
          }),
          options.json,
        );
      } else {
        if (options.since === undefined)
          throw new Error('usage: inbox digest --since <time> [--limit <n>] [--cursor <id>] [--json]');
        printInboxResult(
          sharedInbox.digest(options.since, {
            ...(options.limit !== undefined ? { limit: options.limit } : {}),
            ...(options.cursor !== undefined ? { cursor: options.cursor } : {}),
          }),
          options.json,
        );
      }
    } else {
      if (!id) throw new Error(`usage: inbox ${subcommand} <manager>`);
      await recordManagerCommand(runtime);
      if (subcommand === 'wait') {
        const at = flags.indexOf('--settle');
        const settle = at < 0 ? 0 : Number(flags[at + 1]);
        if (!Number.isFinite(settle) || settle < 0) throw new Error('usage: inbox wait <manager> [--settle <seconds>]');
        console.log(JSON.stringify(await inbox.wait(id, undefined, settle * 1000)));
      } else if (subcommand === 'read') console.log(JSON.stringify(inbox.readPage(id, parseInboxReadOptions(flags))));
      else if (subcommand === 'ack') inbox.acknowledge(id, flags.length ? flags.map(Number) : undefined);
      else throw new Error(`unknown inbox command: ${subcommand ?? '(missing)'}`);
    }
    return 0;
  }
  if (command === 'manager' && id) {
    if (subcommand === 'start') {
      const option = (name: string) => flags[flags.indexOf(name) + 1];
      const engine = option('--engine');
      const budget = Number(option('--budget'));
      if (
        !flags.includes('--engine') ||
        (engine !== 'codex' && engine !== 'claude') ||
        !flags.includes('--budget') ||
        !Number.isSafeInteger(budget) ||
        budget <= 0
      )
        throw new Error('usage: manager start <goal> --engine <codex|claude> --budget <positive integer>');
      if (isResidentSupermanagerRecord(runtime, id))
        throw new Error(`Resident supermanager ${id} is an external session and cannot be started`);
      await ensureHost(runtime);
      await recordManagerCommand(runtime);
      console.log(JSON.stringify(await requestHost({ command: 'start', spec: runtime.manager(id, engine, budget) })));
    } else if (subcommand === 'renew') {
      // --engine moves a manager to another engine, for example to keep a weekly allowance within its week.
      const engineAt = flags.indexOf('--engine');
      const engineFlag = engineAt < 0 ? undefined : flags[engineAt + 1];
      if (
        (engineAt < 0 && flags.length) ||
        (engineAt >= 0 && (flags.length !== 2 || (engineFlag !== 'codex' && engineFlag !== 'claude')))
      )
        throw new Error('usage: manager renew <manager> [--engine <codex|claude>]');
      const hasManagerTable = runtime.db
        .query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'manager_sessions'")
        .get();
      const row = hasManagerTable
        ? (runtime.db.query('SELECT state FROM manager_sessions WHERE id = ?').get(id) as { state: string } | null)
        : null;
      if (!row) throw new Error(`Unknown manager: ${id}`);
      const current = JSON.parse(row.state) as {
        kind?: string;
        engine?: 'codex' | 'claude';
        budget?: number;
      };
      if (current.kind === 'resident-supermanager')
        throw new Error(`Resident supermanager ${id} is an external session and cannot be renewed`);
      if (!current.engine || !current.budget)
        throw new Error(`Manager ${id} does not have a renewable managed session`);
      await ensureHost(runtime);
      await recordManagerCommand(runtime);
      console.log(
        JSON.stringify(
          await requestHost({
            command: 'renew',
            manager: id,
            spec: runtime.manager(id, (engineFlag as 'codex' | 'claude' | undefined) ?? current.engine, current.budget),
          }),
        ),
      );
    } else if (subcommand === 'decision') {
      await ensureHost(runtime);
      recordManagerDecision(runtime.db, id);
    } else if (subcommand && ['stop', 'complete', 'turn-start', 'turn-end'].includes(subcommand)) {
      await ensureHost(runtime);
      if (subcommand === 'complete' || subcommand === 'stop') await recordManagerCommand(runtime);
      const result = await requestHost({
        command: subcommand as HostRequest['command'],
        manager: id,
      });
      if (subcommand === 'complete' && result === false) return 1;
    } else throw new Error(`unknown manager command: ${subcommand ?? '(missing)'}`);
    return 0;
  }
  throw new Error(`invalid command arguments: ${argv.join(' ')}`);
}

function parseInboxReadOptions(args: string[]): { limit?: number; cursor?: number } {
  const options: { limit?: number; cursor?: number } = {};
  for (let index = 0; index < args.length; index++) {
    const option = args[index]!;
    const value = args[++index];
    if ((option !== '--limit' && option !== '--cursor') || !value || value.startsWith('--'))
      throw new Error('usage: inbox read <manager> [--limit <n>] [--cursor <id>]');
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`inbox ${option} must be a positive integer`);
    if (option === '--limit') {
      if (options.limit !== undefined) throw new Error('duplicate inbox option: --limit');
      options.limit = parsed;
    } else {
      if (options.cursor !== undefined) throw new Error('duplicate inbox option: --cursor');
      options.cursor = parsed;
    }
  }
  return options;
}

/** Public control-plane command modules use this to attribute a manager's command to its turn. */
type InboxCliOptions = SharedInboxFilter & { json: boolean; reference?: string };

function parseInboxQueryOptions(args: string[]): InboxCliOptions {
  const options: InboxCliOptions = { json: false };
  const seen = new Set<string>();
  for (let index = 0; index < args.length; index++) {
    const option = args[index]!;
    if (!option.startsWith('--')) {
      if (options.reference !== undefined) throw new Error(`unexpected inbox argument: ${option}`);
      options.reference = option;
      continue;
    }
    if (seen.has(option)) throw new Error(`duplicate inbox option: ${option}`);
    seen.add(option);
    if (option === '--json') {
      options.json = true;
      continue;
    }
    const value = args[++index];
    if (!value || value.startsWith('--')) throw new Error(`missing value for inbox option ${option}`);
    switch (option) {
      case '--from':
        options.from = value;
        break;
      case '--to':
        options.to = value;
        break;
      case '--goal':
        options.goal = value;
        break;
      case '--task':
        options.task = value;
        break;
      case '--since':
        options.since = value;
        break;
      case '--grep':
        options.grep = value;
        break;
      case '--limit':
        options.limit = Number(value);
        if (!Number.isSafeInteger(options.limit) || options.limit < 1)
          throw new Error('inbox --limit must be a positive integer');
        break;
      case '--cursor':
        options.cursor = Number(value);
        if (!Number.isSafeInteger(options.cursor) || options.cursor < 1)
          throw new Error('inbox --cursor must be a positive integer');
        break;
      default:
        throw new Error(`unknown inbox query option: ${option}`);
    }
  }
  return options;
}

type ResolvedInboxSender = {
  from: string;
  managerId: string;
  sessionId?: string;
  worker?: { kind: 'worker'; taskId: string; attempt: number; ownerManager: string };
};

function hasWorkerIdentityMarkers(env: NodeJS.ProcessEnv): boolean {
  return env.GOAL_TASK_ID !== undefined || env.GOAL_ATTEMPT !== undefined;
}

function resolveInboxSender(runtime: IntegrationRuntime): ResolvedInboxSender {
  const env = process.env;
  if (hasWorkerIdentityMarkers(env)) return resolveWorkerInboxSender(runtime, env);
  const hasProviderIdentity = Boolean(env.CODEX_THREAD_ID || env.CLAUDE_CODE_SESSION_ID);
  const authenticated = authenticatedCallingManager(runtime, env);
  if (authenticated) return { from: authenticated.id, managerId: authenticated.id, sessionId: authenticated.sessionId };
  if (hasProviderIdentity) throw new Error('inbox sender identity does not match an authenticated manager session');
  throw new Error('inbox send requires an authenticated manager session');
}

function resolveWorkerInboxSender(runtime: IntegrationRuntime, env: NodeJS.ProcessEnv): ResolvedInboxSender {
  const taskId = env.GOAL_TASK_ID;
  const attemptText = env.GOAL_ATTEMPT;
  if (!taskId || taskId.trim() !== taskId || !attemptText || !/^[1-9]\d*$/.test(attemptText))
    throw new Error('worker inbox sender requires a valid task and attempt identity');
  const attempt = Number(attemptText);
  if (!Number.isSafeInteger(attempt)) throw new Error('worker inbox sender requires a valid task and attempt identity');

  const taskTables = runtime.db
    .query(
      "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name IN ('worker_tasks', 'worker_attempts')",
    )
    .get() as { count: number };
  if (taskTables.count !== 2) throw new Error('worker inbox sender has no persisted task fence');

  // Apply the control plane's current-attempt and cancellation fence before reading source ownership.
  runtime.fence.assertCurrent({ taskId, attempt });
  const row = runtime.db
    .query(`SELECT task.current_attempt, task.body AS task_body, attempt.body AS attempt_body
      FROM worker_tasks AS task JOIN worker_attempts AS attempt
        ON attempt.task_id = task.id AND attempt.attempt = ?
      WHERE task.id = ?`)
    .get(attempt, taskId) as {
    current_attempt: number;
    task_body: string;
    attempt_body: string;
  } | null;
  if (!row) throw new Error('worker inbox sender is not a persisted task attempt');

  let task: { id?: unknown; currentAttempt?: unknown; state?: unknown; brief?: { manager?: unknown } };
  let sourceAttempt: { taskId?: unknown; attempt?: unknown; state?: unknown };
  try {
    task = JSON.parse(row.task_body) as typeof task;
    sourceAttempt = JSON.parse(row.attempt_body) as typeof sourceAttempt;
  } catch {
    throw new Error('worker inbox sender has malformed persisted task data');
  }
  const ownerManager = task.brief?.manager;
  if (
    task.id !== taskId ||
    task.currentAttempt !== attempt ||
    row.current_attempt !== attempt ||
    sourceAttempt.taskId !== taskId ||
    sourceAttempt.attempt !== attempt ||
    sourceAttempt.state !== 'running' ||
    (task.state !== 'running' && task.state !== 'held') ||
    typeof ownerManager !== 'string' ||
    !ownerManager.trim()
  )
    throw new Error('worker inbox sender is not the current running task attempt');

  return {
    from: `worker:${taskId}/${attempt}`,
    managerId: ownerManager,
    worker: { kind: 'worker', taskId, attempt, ownerManager },
  };
}

function parseDocumentReference(value: string): InboxDocumentReference {
  let parsed: unknown = value;
  if (value.trimStart().startsWith('{')) {
    try {
      parsed = JSON.parse(value) as unknown;
    } catch {
      throw new Error('inbox --document must be a path or a JSON document reference');
    }
  }
  if (typeof parsed === 'string') {
    if (!parsed.trim() || /[\r\n]/.test(parsed)) throw new Error('inbox --document path must be one line');
    return { path: parsed };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new Error('inbox --document must be a path or a JSON document reference');
  const reference = parsed as Record<string, unknown>;
  if (
    Object.keys(reference).some((key) => key !== 'path' && key !== 'change') ||
    typeof reference.path !== 'string' ||
    !reference.path.trim() ||
    (reference.change !== undefined && (typeof reference.change !== 'string' || /[\r\n]/.test(reference.change)))
  )
    throw new Error('inbox --document JSON must contain a nonempty path and optional one-line change');
  return { path: reference.path, ...(typeof reference.change === 'string' ? { change: reference.change } : {}) };
}

function parseEscalation(value: string): InboxEscalation {
  let parsed: unknown = value;
  if (value.trimStart().startsWith('{')) {
    try {
      parsed = JSON.parse(value) as unknown;
    } catch {
      throw new Error('inbox --escalation must be a reason or a JSON escalation object');
    }
  }
  if (typeof parsed === 'string') {
    if (!parsed.trim() || /[\r\n]/.test(parsed)) throw new Error('inbox --escalation reason must be one line');
    return { reason: parsed };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new Error('inbox --escalation must be a reason or a JSON escalation object');
  const escalation = parsed as Record<string, unknown>;
  if (
    Object.keys(escalation).some((key) => key !== 'reason' && key !== 'target') ||
    typeof escalation.reason !== 'string' ||
    !escalation.reason.trim() ||
    /[\r\n]/.test(escalation.reason) ||
    (escalation.target !== undefined && (typeof escalation.target !== 'string' || !escalation.target.trim()))
  )
    throw new Error('inbox --escalation JSON must contain a reason and optional target');
  return { reason: escalation.reason, ...(typeof escalation.target === 'string' ? { target: escalation.target } : {}) };
}

function printInboxResult(value: unknown, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(value));
    return;
  }
  if (value && typeof value === 'object' && 'entries' in value && Array.isArray(value.entries)) {
    const page = value as {
      entries: {
        id: number;
        from: string | null;
        to: string;
        goal: string | null;
        task: string | null;
        kind: string | null;
        summary: string | null;
      }[];
      hasMore: boolean;
      nextCursor: number | null;
    };
    for (const entry of page.entries)
      console.log(
        `#${entry.id} ${entry.kind ?? 'unknown'} Goal=${entry.goal ?? 'unknown'} task=${entry.task ?? 'unknown'} ${entry.from ?? 'unknown'} -> ${entry.to}: ${entry.summary ?? 'unknown summary'}`,
      );
    if (page.hasMore) console.log(`More results: continue with --cursor ${page.nextCursor}`);
    if (!page.entries.length) console.log('No inbox messages.');
    return;
  }
  if (
    value &&
    typeof value === 'object' &&
    'groups' in value &&
    Array.isArray(value.groups) &&
    'details' in value &&
    typeof value.details === 'object' &&
    value.details !== null
  ) {
    const digest = value as {
      since: number;
      groups: { goal: string | null; counts: Record<string, number> }[];
      details: {
        entries: { id: number; category: string; goal: string | null; summary: string | null }[];
        hasMore: boolean;
        nextCursor: number | null;
      };
    };
    console.log(`Inbox digest since ${new Date(digest.since).toISOString()}`);
    for (const group of digest.groups)
      console.log(
        `Goal=${group.goal ?? 'unknown'} ${Object.entries(group.counts)
          .map(([name, count]) => `${name}=${count}`)
          .join(' ')}`,
      );
    for (const entry of digest.details.entries)
      console.log(
        `#${entry.id} ${entry.category} Goal=${entry.goal ?? 'unknown'}: ${entry.summary ?? 'unknown summary'}`,
      );
    if (digest.details.hasMore) console.log(`More results: continue with --cursor ${digest.details.nextCursor}`);
    return;
  }
  console.log(JSON.stringify(value));
}

export async function recordManagerCommand(runtime: IntegrationRuntime): Promise<void> {
  const manager = callingManager(runtime);
  if (!manager) return;
  const hasSessions = runtime.db
    .query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'manager_sessions'")
    .get();
  if (!hasSessions || !runtime.db.query('SELECT 1 FROM manager_sessions WHERE id = ?').get(manager)) return;
  recordManagerDecision(runtime.db, manager);
}

function callingManager(runtime: IntegrationRuntime): string | undefined {
  if (process.env.GOAL_MANAGER) return process.env.GOAL_MANAGER;
  if (
    !process.env.CODEX_THREAD_ID ||
    !runtime.db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'manager_sessions'").get()
  )
    return undefined;
  const rows = runtime.db.query('SELECT state FROM manager_sessions').all() as { state: string }[];
  return rows.map((row) => JSON.parse(row.state)).find((state) => state.threadId === process.env.CODEX_THREAD_ID)?.id;
}

function isResidentSupermanagerRecord(runtime: IntegrationRuntime, id: string): boolean {
  if (!runtime.db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'manager_sessions'").get())
    return false;
  const row = runtime.db.query('SELECT state FROM manager_sessions WHERE id = ?').get(id) as { state: string } | null;
  if (!row) return false;
  try {
    return (JSON.parse(row.state) as { kind?: unknown }).kind === 'resident-supermanager';
  } catch {
    return false;
  }
}

/** Priority authorization uses the same persisted manager-session identity, never GOAL_MANAGER by itself. */
export function authenticatedCallingManager(
  runtime: IntegrationRuntime,
  env: NodeJS.ProcessEnv = process.env,
): AuthenticatedManager | undefined {
  return authenticatedManager(runtime.db, env);
}
