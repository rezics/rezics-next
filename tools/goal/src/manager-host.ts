import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, closeSync, existsSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { reapContainersAsync } from './containers.ts';
import { completedUtcHour } from './efficiency-report-time.ts';
import { SqliteManagerInbox } from './inbox.ts';
import type { HostRequest, IntegrationRuntime } from './integration-runtime.ts';
import { acquireDirectoryLease } from './lease.ts';
import { ManagerSessions } from './managers.ts';
import { defaultPolicy } from './policy.ts';
import { sameProcess, terminateProcessGroup, type ProcessIdentity } from './process.ts';
import { currentCodeVersion } from './runtime-version.ts';
import { startHostHeartbeat } from './service.ts';

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
  const identities = readAppServerRegistry(path);
  for (const identity of identities) await stopRecordedAppServer(identity, policy);
  rmSync(path, { force: true });
}

export async function serveManagers(runtime: IntegrationRuntime): Promise<void> {
  const policy = runtime.managerServices.policy ?? defaultPolicy;
  const stateSweepIntervalMs = runtime.hostSweepIntervalMs ?? policy.host.stateSweepIntervalMs;
  if (!Number.isSafeInteger(stateSweepIntervalMs) || stateSweepIntervalMs <= 0)
    throw new Error('Manager host state sweep interval must be a positive integer');
  const lease = acquireDirectoryLease(`${runtime.managerSocket}.lease`, policy.leases);
  let activeRequests = 0,
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
  const stop = () => {
    stopRequested = true;
    closeServer();
    stopWhenIdle();
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  let stopHeartbeat: (() => void) | undefined;
  let stateTimer: ReturnType<typeof setInterval> | undefined;
  let recoveryTimer: ReturnType<typeof setInterval> | undefined;
  let codePoll: ReturnType<typeof setInterval> | undefined;
  const recoverOrphans = () => {
    if (!runtime.recoverOrphans) return Promise.resolve();
    // A sweep may wait for adopted workers. Let later timer ticks start their own sweep so
    // newly orphaned tasks and retry intents are considered while those workers are running.
    return runtime.recoverOrphans();
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
      if (runtime.codeRetirement) runtime.codeRetirement.retiring = true;
      console.log(
        `tools/goal is published as ${published}; this host stops after its active requests so systemd restarts it.`,
      );
      stop();
    } finally {
      checkingCode = false;
    }
  };
  try {
    await stopRecordedAppServers(registryPath, policy.appServer);
    registrySafe = true;
    const inbox = runtime.inbox ?? new SqliteManagerInbox(runtime.db, runtime.stateDirectory, undefined, policy.inbox);
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
    if (stopRequested) return;
    // Readiness and the watchdog start with the socket: no recovery or scheduler pass can delay the heartbeat.
    stopHeartbeat = await startHostHeartbeat(undefined, undefined, policy.service);
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
        runtime.dispatchDailyStepAudit?.();
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
    // Containers that workers and checks leave running are removed every ten minutes, per <state>/containers.json.
    let reapedAt = 0;
    let reaping: Promise<unknown> | undefined;
    const reap = () => {
      if (reaping || Date.now() - reapedAt < policy.containers.cleanupIntervalMs) return;
      reapedAt = Date.now();
      // Docker runs in the background: a slow daemon must not hold the manager socket or the scheduler.
      reaping = reapContainersAsync(
        runtime.db,
        runtime.stateDirectory,
        Date.now(),
        runtime.managerServices.policy?.containers,
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
          .then(() => runtime.sweepWidth!())
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
    stopHeartbeat?.();
    if (recoveryTimer) clearInterval(recoveryTimer);
    if (stateTimer) clearInterval(stateTimer);
    if (codePoll) clearInterval(codePoll);
    closeServer();
    if (managers) await managers.close();
    rmSync(runtime.managerSocket, { force: true });
    if (registrySafe) rmSync(registryPath, { force: true });
    lease.release();
  }
}
