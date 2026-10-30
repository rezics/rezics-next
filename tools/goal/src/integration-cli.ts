import type { Database } from 'bun:sqlite';
import { spawn } from 'node:child_process';
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
import type { AttemptFence, GateOutcomeSink, LandingRequest, ManagerEventKind } from './contracts.ts';
import { reapContainers } from './containers.ts';
import { SqliteLandingQueue } from './land.ts';
import { MergeTrain } from './merge-train.ts';
import { SqliteManagerInbox } from './inbox.ts';
import { ManagerSessions, recordManagerDecision, type ManagerServices, type ManagerSpec } from './managers.ts';
import { acquireDirectoryLease } from './lease.ts';
import { processIdentity, sameProcess, type ProcessIdentity } from './process.ts';
import { authenticatedManager, type AuthenticatedManager } from './priority-authority.ts';

/** Composition belongs to the caller; this module never reads worker configuration or tables. */
export type IntegrationRuntime = {
  queue?: SqliteLandingQueue;
  train?: Pick<MergeTrain, 'runWaiting'>;
  inbox?: SqliteManagerInbox;
  pump?(): Promise<void>;
  drain?(): Promise<void>;
  drainJobs?(): Promise<void>;
  /** Enqueue manager-owned accepted work through the durable landing queue. */
  managerLand?(task: string, manager: string): boolean;
  /** Start the existing controller train without running gates in the manager command process. */
  handoffTrain?(): Promise<void>;
  hostCommand?: string[];
  hostSweepIntervalMs?: number;
  codeIsCurrent?(): boolean;
  recoverOrphans?(options?: { adoptRunning?: boolean }): Promise<void>;
  deliverReminders?(): number;
  /** One promotion step; returns at once when a promotion holds the lease or nothing changed. */
  promote?(): Promise<void>;
  verify?(): Promise<void>;
  evaluateFlow?(): void;
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
  command: 'start' | 'renew' | 'stop' | 'complete' | 'decision' | 'turn-start' | 'turn-end' | 'outgoing-message';
  manager?: string;
  spec?: ManagerSpec;
  recipient?: string;
  summary?: string;
};

export function startOrphanRecoveryTimer(
  recoverOrphans: () => Promise<void>,
  intervalMs = 60_000,
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

async function waitForProcessExit(identity: ProcessIdentity, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (sameProcess(identity) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
  return !sameProcess(identity);
}

async function stopRecordedAppServer(identity: ProcessIdentity): Promise<void> {
  if (!sameProcess(identity)) return;
  try {
    process.kill(identity.pid, 'SIGTERM');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
  if (await waitForProcessExit(identity, 500)) return;
  if (sameProcess(identity)) {
    try {
      process.kill(identity.pid, 'SIGKILL');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
  }
  if (!(await waitForProcessExit(identity, 5000))) throw new Error(`App-server process did not exit: ${identity.pid}`);
}

async function stopRecordedAppServers(path: string): Promise<void> {
  const identities = readAppServerRegistry(path);
  for (const identity of identities) await stopRecordedAppServer(identity);
  rmSync(path, { force: true });
}

export function hostRequest(
  socketPath: string,
  request: HostRequest,
  timeoutMs = 60_000,
  retryDelayMs = 25,
): Promise<any> {
  return new Promise((resolve, reject) => {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || !Number.isSafeInteger(retryDelayMs) || retryDelayMs < 0) {
      reject(new Error('Manager host request timeout and retry delay must be valid milliseconds'));
      return;
    }
    const deadline = Date.now() + timeoutMs;
    const timeoutError = () => new Error(`Manager host request timed out after ${timeoutMs}ms`);
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
      retryTimer = setTimeout(connect, Math.min(retryDelayMs, remaining));
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

    deadlineTimer = setTimeout(() => finish(timeoutError()), timeoutMs);
    connect();
  });
}

const HOST_RESTART_INTERVAL_MS = 10 * 60_000;
const hostRestartPath = (stateDirectory: string) => join(stateDirectory, 'manager-host-restart.json');
export function managerHostRestartAllowed(stateDirectory: string, now = Date.now()): boolean {
  const path = hostRestartPath(stateDirectory);
  try {
    const previous = JSON.parse(readFileSync(path, 'utf8')) as { at?: unknown };
    if (typeof previous.at === 'number' && now - previous.at < HOST_RESTART_INTERVAL_MS) return false;
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
  try {
    await new Promise<void>((resolve, reject) => {
      const socket = createConnection(runtime.managerSocket);
      socket.on('connect', () => {
        socket.end();
        resolve();
      });
      socket.on('error', reject);
    });
    return;
  } catch {}
  const argv = [
    ...(runtime.hostCommand ?? [process.execPath, join(runtime.mainCheckout, 'tools/goal/src/cli.ts')]),
    '_manager-host',
  ];
  mkdirSync(runtime.stateDirectory, { recursive: true });
  const logPath = join(runtime.stateDirectory, 'manager-host.log');
  const log = openSync(logPath, 'a', 0o600);
  const child = spawn(argv[0]!, argv.slice(1), { env: process.env, detached: true, stdio: ['ignore', 'pipe', log] });
  closeSync(log);
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error('Manager host startup timed out'));
    }, 45_000);
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('exit', (code) => {
      clearTimeout(timeout);
      reject(new Error(`Manager host exited (${code}): ${readFileSync(logPath, 'utf8').slice(-4000)}`));
    });
    const lines = createInterface({ input: child.stdout! });
    lines.once('line', (line) => {
      clearTimeout(timeout);
      lines.close();
      if (line !== 'ready') {
        child.kill();
        reject(new Error(`Manager host startup: ${line}`));
        return;
      }
      child.stdout!.destroy();
      child.unref();
      resolve();
    });
  });
}

export async function serveManagers(runtime: IntegrationRuntime): Promise<void> {
  const stateSweepIntervalMs = runtime.hostSweepIntervalMs ?? 60_000;
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
    if (!managerHostRestartAllowed(runtime.stateDirectory)) return;
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
    await stopRecordedAppServers(registryPath);
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
        readinessTimer = setTimeout(resolve, 100);
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
      if (Date.now() - lastFlowReview >= 3_600_000) {
        lastFlowReview = Date.now();
        try {
          runtime.evaluateFlow?.();
        } catch (error) {
          console.error(error);
        }
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
    // Containers that workers and checks leave running are removed every ten minutes, per <state>/containers.json.
    let reapedAt = 0;
    const reap = () => {
      if (Date.now() - reapedAt < 600_000) return;
      reapedAt = Date.now();
      try {
        reapContainers(runtime.db, runtime.stateDirectory);
      } catch (error) {
        console.error(error);
      }
    };
    recoveryTimer = startOrphanRecoveryTimer(recoverOrphans, 60_000, () => {
      remind();
      reviewFlow();
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
        }, 1000);
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
    if (recoveryTimer) clearInterval(recoveryTimer);
    if (codeTimer) clearInterval(codeTimer);
    if (stateTimer) clearInterval(stateTimer);
    closeServer();
    if (managers) await managers.close();
    rmSync(runtime.managerSocket, { force: true });
    if (registrySafe) rmSync(registryPath, { force: true });
    lease.release();
  }
  if (restart) {
    const argv = [
      ...(runtime.hostCommand ?? [process.execPath, join(runtime.mainCheckout, 'tools/goal/src/cli.ts')]),
      '_manager-host',
    ];
    // The new host writes where the first one does: errors it prints must stay readable after the handoff.
    const log = openSync(join(runtime.stateDirectory, 'manager-host.log'), 'a', 0o600);
    const child = spawn(argv[0]!, argv.slice(1), {
      cwd: runtime.mainCheckout,
      env: process.env,
      detached: true,
      stdio: ['ignore', log, log],
    });
    closeSync(log);
    await new Promise<void>((resolve, reject) => {
      child.once('error', reject);
      child.once('spawn', () => {
        child.unref();
        resolve();
      });
    });
  }
}

export async function runIntegration(argv: string[], runtime: IntegrationRuntime): Promise<number> {
  const [command, subcommand, id, ...flags] = argv;
  const inbox = runtime.inbox ?? new SqliteManagerInbox(runtime.db, runtime.stateDirectory);
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
  if (command === 'inbox' && id) {
    if (subcommand === 'send') {
      const [kind, summary, ...options] = flags;
      if (!kind || !summary)
        throw new Error('usage: inbox send <manager> <kind> <summary> [--task <task>] [--evidence <path>]');
      const values = new Map<string, string>();
      for (let index = 0; index < options.length; index += 2) {
        const option = options[index];
        const value = options[index + 1];
        if ((option !== '--task' && option !== '--evidence') || !value || values.has(option))
          throw new Error(`invalid inbox send option: ${option ?? '(missing value)'}`);
        values.set(option, value);
      }
      const allowed = [
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
      const sender = callingManager(runtime);
      await recordManagerCommand(runtime);
      inbox.deliver({
        managerId: id,
        kind: kind as ManagerEventKind,
        summary,
        from: sender || runtime.supermanager || 'supermanager',
        ...(values.has('--task') ? { taskId: values.get('--task')! } : {}),
        ...(values.has('--evidence') ? { evidencePath: values.get('--evidence')! } : {}),
      });
      if (
        sender &&
        /continuation written/i.test(summary) &&
        runtime.db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'manager_sessions'").get()
      ) {
        const source = runtime.db.query('SELECT state FROM manager_sessions WHERE id = ?').get(sender) as {
          state: string;
        } | null;
        const state = source
          ? (JSON.parse(source.state) as {
              engine?: string;
              supermanager?: string;
              continuationAsked?: boolean;
              continuationRenewed?: boolean;
            })
          : null;
        if (
          state?.engine === 'codex' &&
          state.supermanager === id &&
          state.continuationAsked &&
          !state.continuationRenewed
        ) {
          await ensureHost(runtime);
          // The durable local decision is authoritative. Keep the host's legacy audit view in sync with a short,
          // isolated delivery attempt; its failure must not change the inbox-send or continuation result.
          await hostRequest(runtime.managerSocket, { command: 'decision', manager: sender }, 500).catch((error) =>
            console.error(`manager decision audit delivery failed: ${String(error)}`),
          );
          await hostRequest(runtime.managerSocket, {
            command: 'outgoing-message',
            manager: sender,
            recipient: id,
            summary,
          });
        }
      }
    } else {
      await recordManagerCommand(runtime);
      if (subcommand === 'wait') {
        const at = flags.indexOf('--settle');
        const settle = at < 0 ? 0 : Number(flags[at + 1]);
        if (!Number.isFinite(settle) || settle < 0) throw new Error('usage: inbox wait <manager> [--settle <seconds>]');
        console.log(JSON.stringify(await inbox.wait(id, undefined, settle * 1000)));
      } else if (subcommand === 'read') console.log(JSON.stringify(inbox.read(id)));
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
      await ensureHost(runtime);
      await recordManagerCommand(runtime);
      console.log(
        JSON.stringify(
          await hostRequest(runtime.managerSocket, { command: 'start', spec: runtime.manager(id, engine, budget) }),
        ),
      );
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
      const current = JSON.parse(row.state) as { engine: 'codex' | 'claude'; budget: number };
      await ensureHost(runtime);
      await recordManagerCommand(runtime);
      console.log(
        JSON.stringify(
          await hostRequest(runtime.managerSocket, {
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
      const result = await hostRequest(runtime.managerSocket, {
        command: subcommand as HostRequest['command'],
        manager: id,
      });
      if (subcommand === 'complete' && result === false) return 1;
    } else throw new Error(`unknown manager command: ${subcommand ?? '(missing)'}`);
    return 0;
  }
  throw new Error(`invalid command arguments: ${argv.join(' ')}`);
}

/** Public control-plane command modules use this to attribute a manager's command to its turn. */
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

/** Priority authorization uses the same persisted manager-session identity, never GOAL_MANAGER by itself. */
export function authenticatedCallingManager(
  runtime: IntegrationRuntime,
  env: NodeJS.ProcessEnv = process.env,
): AuthenticatedManager | undefined {
  return authenticatedManager(runtime.db, env);
}
