import { agentAdapter } from './agents.ts';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadSettings, createRuntime, type Runtime } from './config.ts';
import { openDb } from './db.ts';
import { WorkerStore } from './store.ts';
import { BriefContractUnchangedError, WorkerTasks } from './tasks.ts';
import { WorkerJob } from './job.ts';
import { importAttempt, importRunDirectory } from './import-attempt.ts';
import { formatLifecycleMetrics, formatUsageReport, report } from './report.ts';
import { flowReport, formatPageDataFlowRuns, readFlow, readFlowTasks } from './flow.ts';
import { formatGuardLedger, guardLedger } from './guards.ts';
import { lifecycleMetrics } from './lifecycle-metrics.ts';
import type { LandingQueue, ManagerInbox } from './contracts.ts';
import type { Attempt, AttemptRecord, Effort, Settings, Task, TaskState, Tokens } from './types.ts';
import { devVerificationState } from './dev-verifier.ts';
import { retryWait } from './watchdog.ts';
import { authenticatedCallingManager } from './integration-cli.ts';
import { authenticatedManager } from './priority-authority.ts';
import { submitOwnerDecision } from './owner-decisions.ts';
import { projectToolIncidentStatus } from './tool-incidents.ts';
import { parseWorkerCommandArguments, type ParsedWorkerCommandArguments } from './command-arguments.ts';
import { trainLaneStatus } from './lease.ts';
import { countAllowanceWaiting, poolBurnStatus } from './allowance.ts';
import { defaultPolicy } from './policy.ts';
import { readRetainedPoolReadings } from './pacing.ts';
import { admissionProfiles, readRouting } from './routing.ts';
import {
  workerCheckBudgetDirectory,
  workerCheckHostBudgetLimit,
  workerCheckHostRunsUsed,
} from './worker-check-budget.ts';

export type WorkerCommandOptions = {
  runtime?: Runtime;
  settings?: Settings;
  store?: WorkerStore;
  tasks?: WorkerTasks;
  landing?: LandingQueue;
  inbox?: ManagerInbox;
  print?: (value: string) => void;
  env?: NodeJS.ProcessEnv;
  parsedArguments?: ParsedWorkerCommandArguments;
};

export const READ_ONLY_WORKER_COMMANDS = new Set(['status', 'attempts', 'report']);

const taskStates = new Set<TaskState>([
  'ready',
  'held',
  'running',
  'landing',
  'integrated',
  'merged',
  'stopped',
  'cancelled',
  'verified',
]);

function isTaskState(value: unknown): value is TaskState {
  return typeof value === 'string' && taskStates.has(value as TaskState);
}

function heldDependencies(task: Task, tasks: WorkerTasks, store: WorkerStore) {
  const after: unknown = task.brief.after;
  if (after === undefined) return [];
  if (!Array.isArray(after)) return [{ id: 'unknown', state: 'unknown' as const, ready: false }];
  return after.map((id: unknown, index: number) => {
    if (typeof id !== 'string' || !id)
      return { id: `dependency-${index + 1}`, state: 'unknown' as const, ready: false };

    let state: TaskState | 'unknown' = 'unknown';
    try {
      const dependency = store.dependency(id);
      if (isTaskState(dependency?.state)) state = dependency.state;
    } catch {
      // A missing or malformed dependency should not prevent other task statuses from being displayed.
    }

    let ready = false;
    if (state !== 'unknown') {
      try {
        ready = tasks.dependenciesMet({ brief: { ...task.brief, after: [id] } });
      } catch {
        state = 'unknown';
      }
    }
    return { id, state, ready };
  });
}

/** Tests may inject individual services. Production commands always use the shared runtime. */
export async function runWorkerCommand(
  command: string,
  argv: string[],
  options: WorkerCommandOptions = {},
): Promise<number> {
  const parsedArguments = options.parsedArguments ?? parseWorkerCommandArguments(command, argv);
  if (parsedArguments.command !== command) {
    throw new Error(`parsed worker arguments do not match ${command}`);
  }
  const settings =
    options.runtime?.settings ??
    options.settings ??
    options.tasks?.settings ??
    loadSettings({ ...(options.env ? { env: options.env } : {}) });
  const databasePath = join(settings.stateDirectory, 'goal.sqlite');
  if (!READ_ONLY_WORKER_COMMANDS.has(command)) mkdirSync(settings.stateDirectory, { recursive: true });
  const runtime =
    options.runtime ??
    (!options.store && !options.tasks && !options.landing && !options.inbox ? createRuntime({ settings }) : undefined);
  const store =
    runtime?.store ??
    options.store ??
    options.tasks?.store ??
    new WorkerStore(openDb(databasePath, settings.policy?.storage), settings.policy);
  const tasks = runtime?.tasks ?? options.tasks ?? new WorkerTasks(settings, store);
  const print = options.print ?? console.log;
  const job =
    runtime?.job ?? new WorkerJob(tasks, options.landing ?? { enqueue() {} }, options.inbox ?? { deliver() {} });
  const env = options.env ?? process.env;
  // The real CLI always supplies its shared runtime. Service injection without a runtime is the trusted
  // programmatic test seam and deliberately does not confer a CLI manager identity.
  const priorityActor = options.runtime ? (authenticatedCallingManager(options.runtime, env) ?? null) : undefined;
  try {
    // A worker's inherited sequence fences every mutating command before it can dispatch another task or retry itself.
    if (!READ_ONLY_WORKER_COMMANDS.has(command) && env.GOAL_TASK_ID && env.GOAL_ATTEMPT) {
      store.assertCurrent({ taskId: env.GOAL_TASK_ID, attempt: Number(env.GOAL_ATTEMPT) });
    }
    if (parsedArguments.command === 'dispatch') {
      const task = tasks.dispatch(parsedArguments.brief, priorityActor, parsedArguments.urgent);
      print(task.id);
      if (task.state === 'held') return 0;
      // The first start only: if the host already started the task, this command leaves it alone.
      await job.start(task.id, { expectedAttempt: 0 });
    } else if (parsedArguments.command === 'urgent') {
      const actor = authenticatedManager(store.db, env);
      if (!actor) throw new Error('urgent grants require an authenticated manager session');
      tasks.setUrgentGrant(parsedArguments.managerId, parsedArguments.action === 'grant', actor);
      print(
        `Urgent grant ${parsedArguments.action === 'grant' ? 'enabled' : 'revoked'} for ${parsedArguments.managerId}.`,
      );
    } else if (parsedArguments.command === 'amend') {
      print(
        JSON.stringify(
          tasks.amend(
            parsedArguments.taskId,
            { expectedAttempt: parsedArguments.expectedAttempt, brief: parsedArguments.brief },
            authenticatedManager(store.db, env) ?? null,
          ),
        ),
      );
    } else if (parsedArguments.command === 'status') {
      const arg = parsedArguments.taskId;
      const cohort = arg ? [store.task(arg)] : store.tasks();
      const references = new Map<string, { attempt: Attempt; intent: ReturnType<WorkerStore['retryIntent']> }>();
      for (const task of cohort) {
        if (!task.currentAttempt) continue;
        const ref = { taskId: task.id, attempt: task.currentAttempt };
        references.set(task.id, { attempt: store.attempt(ref), intent: store.retryIntent(ref) });
      }
      const incidentProjection = projectToolIncidentStatus(store, cohort);
      const show = (task: Task) => {
        const current = references.get(task.id);
        const terminationRequest = current?.attempt.terminationIntent;
        const intent = current?.intent;
        const incident = current ? incidentProjection.forAttempt(task, current.attempt) : null;
        const dependencies =
          task.state === 'held' || intent?.status === 'pending' ? heldDependencies(task, tasks, store) : [];
        const wait = incident
          ? {
              reason: 'environment-incident',
              incidentId: incident.id,
              nextProbeAt: incident.nextProbeAt,
              isProbe: incident.probe.taskId === task.id && incident.probe.attempt === task.currentAttempt,
            }
          : intent?.status === 'pending'
            ? (retryWait(
                intent,
                { brief: { ...task.brief, after: dependencies.map(({ id }) => id) } },
                (id) => (dependencies.find((dependency) => dependency.id === id)?.ready ? 'merged' : undefined),
                Date.now(),
                settings.stateDirectory,
                settings.policy,
              ) ?? {
                reason: 'start',
              })
            : undefined;
        const liveAttempt = current?.attempt.state === 'running' || current?.attempt.state === 'waiting';
        return {
          ...task,
          urgent: task.brief.urgent === true,
          ...(liveAttempt
            ? {
                checksUsed: workerCheckHostRunsUsed(
                  workerCheckBudgetDirectory(settings.stateDirectory, task.id, task.currentAttempt),
                ),
                checkBudget: workerCheckHostBudgetLimit(task, task.currentAttempt),
              }
            : {}),
          ...(terminationRequest ? { terminationRequest } : {}),
          ...(task.state === 'held'
            ? {
                dependencies,
                waitingFor: dependencies.filter((dependency) => !dependency.ready).map(({ id }) => id),
              }
            : {}),
          ...(wait ? { pendingRetry: wait } : {}),
        };
      };
      const selectedTasks = cohort.map(show);
      const trains = trainLaneStatus(settings.stateDirectory);
      const spanMs = settings.policy?.pacing.burnSpanMs ?? defaultPolicy.pacing.burnSpanMs;
      const now = Date.now();
      const readings = readRetainedPoolReadings(settings.stateDirectory);
      const live = store.runningAttemptsByPool();
      const parked = store.waitingAttemptsByPool();
      const table = settings.routingFile ? readRouting(settings.routingFile, settings.policy?.routing) : undefined;
      const allowanceWaiting = table
        ? countAllowanceWaiting(
            selectedTasks.flatMap((task) => {
              if (task.state !== 'ready' || task.brief.urgent === true) return [];
              try {
                return [admissionProfiles(task.brief, table, task.sequence)];
              } catch {
                // Status already shows malformed task rows; they are not allowance waiters.
                return [];
              }
            }),
            settings.pools ?? [],
            readings,
            {
              now,
              spanMs,
              history: readings,
              policy: settings.policy?.provider,
              running: live,
            },
          )
        : {};
      const pools = poolBurnStatus(settings.pools ?? [], readings, now, spanMs, live, parked).map((pool) =>
        pool.maxConcurrent === undefined ? { ...pool, waiting: allowanceWaiting[pool.name] ?? 0 } : pool,
      );
      print(
        JSON.stringify(
          arg
            ? { ...selectedTasks[0]!, toolIncidents: incidentProjection.toolIncidents, trains, pools }
            : {
                devVerification: devVerificationState(
                  settings.mainCheckout,
                  settings.stateDirectory,
                  settings.integrationBranch,
                  cohort,
                ),
                toolIncidents: incidentProjection.toolIncidents,
                trains,
                pools,
                tasks: selectedTasks,
              },
          null,
          2,
        ),
      );
    } else if (parsedArguments.command === 'attempts') {
      const args = parsedArguments;
      if (args.taskId) {
        if (args.json) {
          const page = store.recordsPage(args.taskId, { afterAttempt: args.afterAttempt, limit: args.limit });
          print(
            JSON.stringify(
              {
                records: page.items,
                hasMore: page.hasMore,
                ...(page.nextAfter !== undefined ? { nextAfter: page.nextAfter } : {}),
              },
              null,
              2,
            ),
          );
        } else {
          const page = store.attemptsPage(args.taskId, { afterAttempt: args.afterAttempt, limit: args.limit });
          const lines = page.items.map(
            (attempt) =>
              `${attempt.taskId} ${attempt.attempt} ${attempt.state} ${attempt.profile.model}/${attempt.profile.effort} ${attempt.pool}`,
          );
          if (!lines.length) lines.push('No attempts in this page.');
          lines.push(
            page.hasMore ? `More attempts remain; continue after attempt ${page.nextAfter}.` : 'No more attempts.',
          );
          print(lines.join('\n'));
        }
      } else {
        // Keep --json as the original full export; --all makes that intent explicit for scripts.
        print(
          args.json
            ? JSON.stringify(store.records(), null, 2)
            : store
                .attempts()
                .map(
                  (attempt) =>
                    `${attempt.taskId} ${attempt.attempt} ${attempt.state} ${attempt.profile.model}/${attempt.profile.effort} ${attempt.pool}`,
                )
                .join('\n'),
        );
      }
    } else if (parsedArguments.command === 'report') {
      const { flow, since, json } = parsedArguments;
      if (flow) {
        const now = new Date();
        const metrics = lifecycleMetrics(store.db, now, settings.policy);
        const records = store.records();
        // Landed lines come from the latest passing attempt of each task, the one that integrated it.
        const landed = new Map<string, { attempt: number; lines: number }>();
        for (const record of records) {
          if (record.outcome !== 'passed' || record.diffLines === null) continue;
          const seen = landed.get(record.taskId);
          if (!seen || record.attempt > seen.attempt)
            landed.set(record.taskId, { attempt: record.attempt, lines: record.diffLines });
        }
        const tasks = readFlowTasks(store.db).map((task) => ({
          ...task,
          diffLines: landed.get(task.id)?.lines ?? null,
        }));
        const result = {
          ...flowReport(readFlow(store.db, since), tasks, now.getTime()),
          guards: guardLedger(records, store.attempts(), now.getTime()),
          lifecycle: metrics,
        };
        if (json) print(JSON.stringify(result, null, 2));
        else
          print(
            [
              `Flow efficiency: ${result.flowEfficiency === null ? 'unknown' : `${(result.flowEfficiency * 100).toFixed(1)}%`}`,
              `Bottleneck: ${result.bottleneck ?? 'unknown'}`,
              `Over-budget launches by layer: ${JSON.stringify(result.overBudgetLaunchesByLayer)}`,
              `Attempts per integrated task: ${result.attemptsPerIntegrated ?? 'unknown'}`,
              `Chained: ${result.chain.chained.tasks} tasks, ${result.chain.chained.integrated} integrated, ${result.chain.chained.linesPerWorkerHour === null ? 'unknown' : result.chain.chained.linesPerWorkerHour.toFixed(1)} lines per worker-hour; unchained: ${result.chain.unchained.tasks} tasks, ${result.chain.unchained.integrated} integrated, ${result.chain.unchained.linesPerWorkerHour === null ? 'unknown' : result.chain.unchained.linesPerWorkerHour.toFixed(1)} lines per worker-hour; offers ${result.chain.offered}, declined ${JSON.stringify(result.chain.declined)}`,
              `Dev landing transpile: ${result.devTranspile.successfulChecks} passed, ${result.devTranspile.repairHandbacks} repair handbacks, ${result.devTranspile.unavailable} unavailable; ${result.devTranspile.measuredChecks} measured checks, ${result.devTranspile.totalMs === null ? 'cost unavailable' : `${result.devTranspile.totalMs}ms total`}.`,
              `Dev landing architecture: ${result.devArchitecture.successfulChecks} passed, ${result.devArchitecture.repairHandbacks} repair handbacks, ${result.devArchitecture.unavailable} unavailable; ${result.devArchitecture.measuredChecks} measured checks, ${result.devArchitecture.totalMs === null ? 'cost unavailable' : `${result.devArchitecture.totalMs}ms total`}.`,
              `Dev landing Kernel import: ${result.devKernelImport.successfulChecks} passed, ${result.devKernelImport.repairHandbacks} repair handbacks, ${result.devKernelImport.unavailable} unavailable; ${result.devKernelImport.measuredChecks} measured checks, setup ${result.devKernelImport.setupMs === null ? 'unavailable' : `${result.devKernelImport.setupMs}ms`}, import ${result.devKernelImport.importMs === null ? 'unavailable' : `${result.devKernelImport.importMs}ms`}, cleanup ${result.devKernelImport.cleanupMs === null ? 'unavailable' : `${result.devKernelImport.cleanupMs}ms`}, ${result.devKernelImport.totalMs === null ? 'cost unavailable' : `${result.devKernelImport.totalMs}ms total`}.`,
              `Urgent: ${result.urgent.tasks.length} tasks; ${result.urgent.integrated} integrated (${result.urgent.tasks.join(', ') || 'none'}); excluded from throughput.`,
              ...formatPageDataFlowRuns(result.pageDataRuns),
              ...result.stages.map((s) => `${s.stage}: total ${s.totalMs}ms, p50 ${s.p50Ms}ms, p90 ${s.p90Ms}ms`),
              ...result.queues.map(
                (q) => `Queue ${q.stage}: ${q.length}, oldest ${Math.round(q.oldestAgeMs / 60000)}m`,
              ),
              ...formatGuardLedger(result.guards),
              ...formatLifecycleMetrics(metrics),
            ].join('\n'),
          );
        return 0;
      }
      const result = report(store.records());
      if (json) print(JSON.stringify(result, null, 2));
      else {
        const rate = (value: number | null) => (value === null ? 'n/a' : `${(value * 100).toFixed(1)}%`);
        const duration = (value: number | null) => (value === null ? 'n/a' : `${(value / 60_000).toFixed(1)} min`);
        print(
          [
            `Attempts: ${result.attempts}; tasks: ${result.tasks}; passed: ${result.passedTasks}.`,
            `Urgent: ${result.urgent.tasks.length} tasks; ${result.urgent.attempts} attempts; ${result.urgent.passedTasks} passed (${result.urgent.tasks.join(', ') || 'none'}); excluded from throughput.`,
            `Attempts per passed task: ${result.attemptsPerPassedTask?.toFixed(2) ?? 'n/a'}; first-attempt pass rate: ${rate(result.firstAttemptPassRate)}.`,
            `Consult hit rate: ${rate(result.consultHitRate)}; early-stop rate: ${rate(result.earlyStopRate)}.`,
            `Wall clock to pass p50/p90: critical path ${duration(result.wallClockToPassMs.criticalPath.p50)}/${duration(result.wallClockToPassMs.criticalPath.p90)}; other ${duration(result.wallClockToPassMs.other.p50)}/${duration(result.wallClockToPassMs.other.p90)}.`,
            ...formatUsageReport(result),
          ].join('\n'),
        );
      }
    } else if (parsedArguments.command === 'retry') {
      const { taskId, brief, expectedAttempt, removeAfter, proofStart, releaseProof, freshSession } = parsedArguments;
      if (releaseProof) {
        print(JSON.stringify(tasks.releaseProof(taskId, expectedAttempt!, priorityActor)));
      } else if (
        proofStart ||
        // Generation zero of product work on the integration branch is an ordinary retry, not a proof start.
        (expectedAttempt === 0 && (removeAfter.length > 0 || !tasks.devProductRetry(taskId, brief)))
      ) {
        print(
          JSON.stringify(
            tasks.queueProofStart(
              taskId,
              { expectedAttempt: expectedAttempt!, ...(brief ? { brief } : {}), removeAfter },
              priorityActor,
            ),
          ),
        );
      } else {
        try {
          await tasks.resumeTermination(taskId);
          tasks.queueRetry(
            taskId,
            {
              ...(brief ? { brief } : {}),
              ...(expectedAttempt === undefined ? {} : { expectedAttempt }),
              ...(freshSession ? { freshSession } : {}),
            },
            priorityActor,
          );
        } catch (error) {
          if (!(error instanceof BriefContractUnchangedError)) throw error;
          print(error.message);
        }
      }
    } else if (parsedArguments.command === 'priority') {
      if (parsedArguments.action === 'grant') {
        if (!priorityActor) throw new Error('priority grants require an authenticated manager session');
        print(JSON.stringify(tasks.grantPriority(parsedArguments.taskId, priorityActor)));
      } else if (parsedArguments.action === 'revoke') {
        if (!priorityActor) throw new Error('priority revocation requires an authenticated manager session');
        print(JSON.stringify(tasks.revokePriority(parsedArguments.taskId, parsedArguments.grantId, priorityActor)));
      } else {
        if (options.runtime && !priorityActor)
          throw new Error('priority changes require an authenticated manager session');
        tasks.setPriority(parsedArguments.taskId, parsedArguments.priority, priorityActor);
      }
    } else if (
      parsedArguments.command === 'stop' ||
      parsedArguments.command === 'cancel' ||
      parsedArguments.command === 'consult'
    ) {
      if (parsedArguments.command === 'stop') await tasks.stop(parsedArguments.taskId);
      else if (parsedArguments.command === 'cancel') await tasks.cancel(parsedArguments.taskId);
      else await job.consultTask(parsedArguments.taskId);
    } else if (parsedArguments.command === 'event') {
      const { taskId, attempt, kind, body } = parsedArguments;
      if (kind === 'owner-contract-decision') submitOwnerDecision(store, { taskId, attempt }, body, env);
      else {
        if (kind === 'owner-contract-decision-accepted' || kind === 'owner-contract-decision-delivery')
          throw new Error('owner decision acceptance and delivery events are controller-owned');
        store.event({ taskId, attempt }, kind, body);
      }
    } else if (parsedArguments.command === 'import-attempt') {
      if (parsedArguments.captureDirectory) {
        const { path } = parsedArguments;
        print(JSON.stringify(importRunDirectory(tasks, path), null, 2));
        return 0;
      }
      const { path, flags } = parsedArguments;
      const pool = settings.pools.find((p) => p.name === flags.pool);
      if (!pool || agentAdapter(pool.cli).canImport === false) throw new Error('unknown worker import pool');
      const profile = {
        cli: pool.cli,
        model: flags.model,
        effort: flags.effort as Effort,
        poolClass: pool.classes[0]!,
      };
      const taskId = flags.task ?? tasks.dispatch(flags.brief!).id;
      print(
        JSON.stringify(
          importAttempt(tasks, path, {
            taskId,
            startedAt: flags.start,
            endedAt: flags.end,
            profile,
            pool: pool.name,
            ...(flags.outcome ? { outcome: flags.outcome as AttemptRecord['outcome'] } : {}),
            ...(flags.baseline ? { baseline: flags.baseline as Tokens } : {}),
            ...(flags.tableVersion ? { tableVersion: flags.tableVersion } : {}),
          }),
          null,
          2,
        ),
      );
    } else throw new Error(`unknown worker command: ${command}`);
    if (!READ_ONLY_WORKER_COMMANDS.has(command)) await job.drain();
    // The command's own change is committed; work drained after it can belong to other tasks, whose failure must not
    // turn this command's exit into an error (a retry exited 1 over an unrelated held task on 2026-10-29).
    if (runtime && ['dispatch', 'retry', 'consult'].includes(command))
      await runtime
        .drain()
        .catch((error) =>
          console.error(`work drained after ${command} failed; this command's change is kept: ${String(error)}`),
        );
    return 0;
  } finally {
    if (!options.runtime && runtime) runtime.close();
    else if (!options.store && !options.tasks && !runtime) store.db.close();
  }
}
