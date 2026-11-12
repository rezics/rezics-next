import { createConnection } from 'node:net';
import { createInterface } from 'node:readline';
import {
  backlogStatus,
  clearBacklogNoWorkDisposition,
  formatBacklogStatus,
  recordBacklogNoWorkDisposition,
} from './backlog.ts';
import { controlPlaneReleaseBrief } from './briefs.ts';
import { runInboxCommand } from './inbox-cli.ts';
import type { HostRequest, IntegrationRuntime } from './integration-runtime.ts';
import { SqliteLandingQueue } from './land.ts';
import {
  authenticatedCallingManager,
  callingManager,
  isResidentSupermanagerRecord,
  recordManagerCommand,
} from './manager-command-context.ts';
import { createHourlyReportScheduler, serveManagers, singleFlight, startOrphanRecoveryTimer } from './manager-host.ts';
import { readManagerOwnership, recordManagerDecision } from './managers.ts';
import { MergeTrain } from './merge-train.ts';
import { git } from './merge.ts';
import { defaultPolicy } from './policy.ts';
import { authenticatedManager } from './priority-authority.ts';
import { WorkerStore } from './store.ts';
import { ensureServiceHost } from './service.ts';

export type { HostRequest, IntegrationRuntime };
export { authenticatedCallingManager, recordManagerCommand };
export { createHourlyReportScheduler, serveManagers, singleFlight, startOrphanRecoveryTimer };

export async function hostRequest(
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

async function ensureHost(runtime: IntegrationRuntime): Promise<void> {
  await ensureServiceHost(runtime.managerSocket, undefined, runtime.managerServices.policy?.service);
}

export async function runIntegration(argv: string[], runtime: IntegrationRuntime): Promise<number> {
  const [command, subcommand, id, ...flags] = argv;
  const policy = runtime.managerServices.policy ?? defaultPolicy;
  const requestHost = (request: HostRequest, timeoutMs?: number) =>
    hostRequest(runtime.managerSocket, request, timeoutMs, undefined, policy.host);
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
  if (command === 'recover' && subcommand === 'false-integration' && id) {
    if (flags.length !== 1 || !/^\d+$/.test(flags[0]!))
      throw new Error('usage: recover false-integration <task> <attempt>');
    if (process.env.GOAL_TASK_ID || process.env.GOAL_ATTEMPT)
      throw new Error('Workers cannot reconcile an integrated landing');
    await recordManagerCommand(runtime);
    if (!(runtime.fence instanceof WorkerStore)) throw new Error('Landing recovery requires the worker outcome store');
    const store = runtime.fence;
    const attempt = Number(flags[0]);
    if (!Number.isSafeInteger(attempt) || attempt <= 0)
      throw new Error('usage: recover false-integration <task> <attempt>');
    const ref = { taskId: id, attempt };
    store.assertCurrent(ref);
    if (store.events(ref.taskId, ref.attempt).some((event) => event.kind === 'false-integration-reconciled')) return 0;
    const task = store.task(ref.taskId);
    const entry = queue.entry(ref);
    if (!entry?.outcome || !entry.candidate) throw new Error('False integration has no retained landing candidate');
    const publishedCommit = task.integratedCommit;
    const { request, outcome, candidate } = entry;
    if (
      task.state !== 'integrated' ||
      !publishedCommit ||
      task.currentAttempt !== ref.attempt ||
      task.brief.target === 'main' ||
      task.brief.target === 'stabilize' ||
      controlPlaneReleaseBrief(task.brief) ||
      request.branch !== task.branch ||
      request.worktree !== task.worktree ||
      !request.workerCommit ||
      outcome.mergedCommit !== publishedCommit ||
      !outcome.passed ||
      outcome.stage !== 'merge' ||
      outcome.changedFiles.length === 0 ||
      entry.delivered !== 1 ||
      entry.batchId
    )
      throw new Error('Landing is not the expected false integrated result');
    if (git(runtime.mainCheckout, 'rev-parse', `${request.branch}^{commit}`) !== request.workerCommit)
      throw new Error('The original accepted source branch changed before landing recovery');
    git(runtime.mainCheckout, 'merge-base', '--is-ancestor', publishedCommit, candidate);
    if (!git(runtime.mainCheckout, 'diff', '--name-only', publishedCommit, candidate))
      throw new Error('The retained landing candidate has no changes beyond its reported commit');
    store.reconcileFalseIntegratedLanding(ref, { publishedCommit, candidate, request, outcome });
    return 0;
  }
  if (command === 'promote' || command === 'verify') {
    const usage = `usage: ${command}`;
    if (argv.length === 2 && (argv[1] === '--help' || argv[1] === '-h')) {
      console.log(usage);
      return 0;
    }
    if (argv.length > 1) throw new Error(usage);
    if (command === 'promote') await runtime.promote?.();
    else await runtime.verify?.();
    return 0;
  }
  if (command === 'backlog') {
    const usage = 'usage: backlog status [--json] | backlog dispatch | backlog disposition <goal> no-work|clear';
    if (subcommand === 'dispatch') {
      if (id !== undefined || flags.length) throw new Error(usage);
      if (process.env.GOAL_TASK_ID || process.env.GOAL_ATTEMPT)
        throw new Error('Workers cannot use the manager-owned backlog command');
      if (!runtime.backlog) throw new Error('The backlog run is unavailable in this runtime');
      console.log(JSON.stringify({ at: new Date().toISOString(), ...((await runtime.backlog()) as object) }));
      return 0;
    }
    if (subcommand === 'disposition') {
      if (!id || !/^[a-z][a-z0-9-]*$/.test(id) || flags.length !== 1 || !['no-work', 'clear'].includes(flags[0]!))
        throw new Error(usage);
      if (process.env.GOAL_TASK_ID || process.env.GOAL_ATTEMPT)
        throw new Error('Workers cannot set a backlog disposition');
      const actor = authenticatedCallingManager(runtime);
      if (!actor) throw new Error('Backlog disposition requires an authenticated manager session');
      const result =
        flags[0] === 'no-work'
          ? recordBacklogNoWorkDisposition(runtime.db, runtime.stateDirectory, id, actor)
          : clearBacklogNoWorkDisposition(runtime.db, id, actor);
      await recordManagerCommand(runtime);
      console.log(JSON.stringify(result));
      return 0;
    }
    const json = flags.length === 0 && id === '--json';
    if (subcommand !== 'status' || flags.length || (id !== undefined && !json)) throw new Error(usage);
    const rows = backlogStatus(runtime.stateDirectory, runtime.db, runtime.policy?.goalMaxInFlight);
    console.log(json ? JSON.stringify(rows) : formatBacklogStatus(rows));
    return 0;
  }
  if (command === 'train') {
    await recordManagerCommand(runtime);
    if (runtime.train) {
      await runtime.train.runWaiting(runtime.refreshTrainConfiguration);
      await runtime.drainJobs?.();
    } else {
      await new MergeTrain({ ...runtime, queue }).runWaiting(runtime.refreshTrainConfiguration);
      await runtime.drain?.();
    }
    return 0;
  }
  if (command === '_manager-host') {
    await serveManagers(runtime);
    return 0;
  }
  if (command === 'manager' && subcommand === 'status') {
    if (id || flags.length) throw new Error('usage: manager status');
    console.log(JSON.stringify(readManagerOwnership(runtime.db), null, 2));
    return 0;
  }
  if (command === 'manager' && subcommand === 'assign') {
    const to = flags[0];
    if (!id || !to || flags.length !== 1) throw new Error('usage: manager assign <goal> <manager>');
    await ensureHost(runtime);
    await recordManagerCommand(runtime);
    console.log(JSON.stringify(await requestHost({ command: 'assign', goal: id, manager: to })));
    return 0;
  }
  if (command === 'manager' && subcommand === 'register-supermanager') {
    if (id !== undefined && (id !== '--replace-session' || flags.length !== 1))
      throw new Error('usage: manager register-supermanager [--replace-session <previous-thread-id>]');
    if (id === undefined && flags.length)
      throw new Error('usage: manager register-supermanager [--replace-session <previous-thread-id>]');
    const replaceSession = id === '--replace-session' ? flags[0] : undefined;
    const validSession = (value: string) =>
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
    if (replaceSession !== undefined && !validSession(replaceSession))
      throw new Error('Previous resident session ID is malformed');
    const manager = runtime.supermanager?.trim();
    if (!manager || manager !== runtime.supermanager)
      throw new Error('Configured supermanager identity is missing or malformed');
    const env = process.env;
    if (env.GOAL_TASK_ID || env.GOAL_ATTEMPT)
      throw new Error('Workers cannot register a resident supermanager session');
    const claudeSession = env.CLAUDE_CODE_SESSION_ID;
    const codexSession = env.CODEX_THREAD_ID;
    if (claudeSession && codexSession) throw new Error('Provider session identity is ambiguous');
    const sessionId = codexSession || claudeSession;
    const provider = codexSession ? 'codex' : 'claude';
    if (!sessionId || !validSession(sessionId))
      throw new Error(
        'Run this command from the resident session with a valid CODEX_THREAD_ID or CLAUDE_CODE_SESSION_ID',
      );
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
        sessionId,
        residentProvider: provider,
        ...(replaceSession !== undefined ? { replaceSession } : {}),
      });
    } catch (error) {
      if (String(error).includes('Unknown manager host command'))
        throw new Error('The running manager host does not support resident registration; retry after it restarts');
      throw error;
    }
    if (
      !result ||
      typeof result !== 'object' ||
      !('kind' in result) ||
      result.kind !== 'resident-supermanager' ||
      !('id' in result) ||
      result.id !== manager ||
      !('provider' in result) ||
      result.provider !== provider ||
      !('threadId' in result) ||
      result.threadId !== sessionId
    )
      throw new Error(
        'The manager host did not register the requested resident identity; restart it on updated code and retry',
      );
    console.log(JSON.stringify(result));
    return 0;
  }
  if (command === 'inbox' && subcommand) {
    return runInboxCommand(argv, runtime, {
      requestHost,
      ensureHost: () => ensureHost(runtime),
    });
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
