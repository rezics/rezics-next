import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import defaults from '../defaults.json';
import { defaultPolicy } from './policy.ts';
import type { Settings } from './types.ts';
import { configurationProblem, reportedConfigurationProblem } from './local-settings.ts';
import {
  checkSettings,
  loadSettings,
  mainCheckout,
  packageDerivedFiles,
  object,
  positive,
  readDerivedFiles,
  readIntegrationChecks,
  readControlPolicy,
  settingsFile,
  text,
} from './settings.ts';
export {
  checkSettings,
  loadSettings,
  mainCheckout,
  readDerivedFiles,
  readIntegrationChecks,
  readControlPolicy,
  settingsFile,
};
export type { ConfiguredSettings, SettingsOptions } from './settings.ts';

import type { Database } from 'bun:sqlite';
import { openDb } from './db.ts';
import { WorkerStore } from './store.ts';
import { WorkerTasks } from './tasks.ts';
import { TrainResolver } from './train-resolver.ts';
import { WorkerJob } from './job.ts';
import { SqliteLandingQueue } from './land.ts';
import { requestManagerLanding } from './manager-landing.ts';
import { SqliteManagerInbox } from './inbox.ts';
import { SharedInboxQueries } from './inbox-shared.ts';
import { deliverDueReminders } from './notes.ts';
import { alertUnspentAllowances, refreshCodexSchedule } from './pacing.ts';
import { watch, sshProbe } from './watchdog.ts';
import { readRiskOwnership } from './briefs.ts';
import { readRouting } from './routing.ts';
import { MergeTrain, type IntegrationCheck, type TrainOptions } from './merge-train.ts';
import { promote } from './promotion.ts';
import { preparePromotionGate } from './promotion-placement.ts';
import { verifyDev } from './dev-verifier.ts';
import { runPageDataCycle } from './page-data.ts';
import { createRuntimeRepairRouting } from './runtime-repair-routing.ts';
export { routePageDataRepair } from './runtime-repair-routing.ts';
import type { GateRunner } from './merge.ts';
import { createCheckRuntime } from './config-check-runtime.ts';
export { LANDING_CHECK_ENVIRONMENT } from './config-check-runtime.ts';
import { captureLoadedCodeVersion, codeVersion } from './runtime-version.ts';
import { completionChecker } from './completion.ts';
import { TermspacesWindows } from './windows.ts';
import type { IntegrationRuntime } from './integration-cli.ts';
import type { ManagerServices, ManagerSpec } from './managers.ts';
import {
  DEFAULT_FLOW_THRESHOLDS,
  checkFlowAlarms,
  dispatchDailyStepAudit,
  flowReport,
  readFlow,
  readFlowTasks,
} from './flow.ts';
import { emitHourlyLifecycleMetrics, lifecycleMetricsAsync } from './lifecycle-metrics.ts';
import { sweepWidthGovernor } from './width-governor.ts';
import { backlogDirectory, sweepBacklog } from './backlog.ts';
import { authenticatedManager, type AuthenticatedManager } from './priority-authority.ts';
import type { BriefContinuation } from './types.ts';

export type Runtime = IntegrationRuntime & {
  settings: Settings;
  store: WorkerStore;
  tasks: WorkerTasks;
  job: WorkerJob;
  queue: SqliteLandingQueue;
  inbox: SqliteManagerInbox;
  sharedInbox: SharedInboxQueries;
  train: MergeTrain;
  pump(): Promise<void>;
  drain(): Promise<void>;
  close(): void;
};
export type RuntimeOptions = {
  trainMode?: 'detached' | 'inline';
  settings?: Settings;
  db?: Database;
  tasks?: WorkerTasks;
  runGate?: GateRunner;
  managerServices?: Partial<ManagerServices>;
  train?: Pick<
    TrainOptions,
    | 'merge'
    | 'beforeRelease'
    | 'beforeIntegrationAdvance'
    | 'beforePromotionAdvance'
    | 'promote'
    | 'derivedFiles'
    | 'handOff'
  >;
};

function backlogManagerActor(db: Database, managerId: string): AuthenticatedManager | undefined {
  if (!db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='manager_sessions'").get()) return undefined;
  const row = db.query('SELECT state FROM manager_sessions WHERE id=?').get(managerId) as { state: string } | null;
  if (!row) return undefined;
  try {
    const state = JSON.parse(row.state) as { engine?: unknown; kind?: unknown; provider?: unknown; threadId?: unknown };
    if (!state || typeof state !== 'object' || Array.isArray(state) || typeof state.threadId !== 'string')
      return undefined;
    const engine = state.engine ?? (state.kind === 'resident-supermanager' ? state.provider : undefined);
    const env =
      engine === 'claude'
        ? { GOAL_MANAGER: managerId, CLAUDE_CODE_SESSION_ID: state.threadId }
        : engine === 'codex'
          ? { GOAL_MANAGER: managerId, CODEX_THREAD_ID: state.threadId }
          : undefined;
    return env ? authenticatedManager(db, env) : undefined;
  } catch {
    return undefined;
  }
}

/** The only production composition: every module shares this database connection and worker fence. */
export function createRuntime(options: RuntimeOptions = {}): Runtime {
  const settings = options.settings ?? options.tasks?.settings ?? loadSettings();
  const flowThresholds = settings.flowThresholds ?? DEFAULT_FLOW_THRESHOLDS;
  // Synthetic runtime fixtures may not contain the control-plane tree in their main checkout.
  // Snapshot once: later settings reloads and moved refs must not recapture this process's loaded identity.
  const startedCodeVersion = existsSync(join(settings.mainCheckout, 'tools/goal'))
    ? captureLoadedCodeVersion(settings.mainCheckout)
    : undefined;
  const codeIsCurrent = () =>
    startedCodeVersion === undefined || codeVersion(settings.mainCheckout, 'tools/goal') === startedCodeVersion;
  // A host that retires for a newer revision starts no new attempt; see manager-host.ts.
  const codeRetirement = { retiring: false };
  const databasePath = join(settings.stateDirectory, 'goal.sqlite');
  mkdirSync(settings.stateDirectory, { recursive: true });
  const db = options.db ?? options.tasks?.store.db ?? openDb(databasePath, settings.policy?.storage);
  if (options.tasks && options.tasks.store.db !== db)
    throw new Error('Runtime modules must share one database connection');
  const store = options.tasks?.store ?? new WorkerStore(db, settings.policy);
  const tasks = options.tasks ?? new WorkerTasks(settings, store);
  const queue = new SqliteLandingQueue(db, store);
  const inbox = new SqliteManagerInbox(db, settings.integration.inboxDirectory, undefined, settings.policy?.inbox);
  const problem = configurationProblem(settings);
  if (problem && !problem.reported) {
    const summary = `Local settings ${problem.file} are invalid: ${problem.error}. Goal keeps using the last valid version of that file until it changes; validate an edit with \`goal config check\` first.`;
    for (const managerId of new Set([settings.integration.operationsManager, settings.integration.supermanager]))
      if (managerId) inbox.deliver({ managerId, kind: 'instruction', summary });
    reportedConfigurationProblem(problem);
  }
  const sharedInbox = new SharedInboxQueries(db, settings.policy?.inbox);
  const checkRuntime = createCheckRuntime({
    settings,
    results: store.checkResults,
    ...(options.train?.derivedFiles ? { derivedFiles: options.train.derivedFiles } : {}),
    ...(options.runGate ? { runGate: options.runGate } : {}),
    deliverReuseAlert: (managerId, summary) => inbox.deliver({ managerId, kind: 'instruction', summary }),
  });
  const {
    runGate,
    promotionGate,
    verifierGate,
    bootSmokeGate,
    typecheckGate,
    runControlPlaneGate,
    refreshTrainConfiguration,
  } = checkRuntime;
  let train!: MergeTrain;
  const pump = () => train.pump(refreshTrainConfiguration);
  const managerContext = () => {
    if (process.env.GOAL_MANAGER) return true;
    const threadId = process.env.CODEX_THREAD_ID;
    if (!threadId) return false;
    try {
      if (!db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='manager_sessions'").get()) return false;
      return (db.query('SELECT state FROM manager_sessions').all() as { state: string }[]).some(
        ({ state }) => JSON.parse(state).threadId === threadId,
      );
    } catch {
      return false;
    }
  };
  // A manager must authorize its accepted landing before the controller starts the train; that request hands off the
  // same durable queue entry. Worker and orphan recovery still start the ordinary train as before.
  const afterSettle = () => {
    if (managerContext()) return Promise.resolve();
    // Short commands hand the train to a detached process, so recovering an orphan never makes `status` wait for a gate.
    return options.trainMode === 'detached' ? handOff() : pump();
  };
  const job = new WorkerJob(
    tasks,
    queue,
    inbox,
    undefined,
    afterSettle,
    undefined,
    undefined,
    () => !codeRetirement.retiring,
  );
  const repairRouting = createRuntimeRepairRouting({ tasks, store, job, inbox, settings });
  const handOff = () =>
    new Promise<void>((resolve, reject) => {
      const env = { ...process.env };
      for (const key of Object.keys(env)) if (key.startsWith('GOAL_')) delete env[key];
      delete env.CODEX_THREAD_ID;
      const child = spawn(process.execPath, [join(settings.mainCheckout, 'tools/goal/src/cli.ts'), 'train'], {
        cwd: settings.mainCheckout,
        detached: true,
        stdio: 'ignore',
        env,
      });
      child.once('error', reject);
      child.once('spawn', () => {
        child.unref();
        resolve();
      });
    });
  train = new MergeTrain({
    policy: settings.policy,
    mainCheckout: settings.mainCheckout,
    stateDirectory: settings.stateDirectory,
    worktreeRoot: settings.worktreeRoot,
    mainBranch: settings.mainBranch,
    integrationBranch: settings.integrationBranch,
    integration: settings.integration,
    formatCommand: settings.formatCommand,
    // The configured list, not the package default: local configuration switches landing affected checks off.
    affectedTests: settings.affectedTests ?? [],
    integrationChecks: (settings as Settings & { integrationChecks?: IntegrationCheck[] }).integrationChecks ?? [],
    queue,
    fence: store,
    sink: job,
    trainResolver: new TrainResolver(store, tasks),
    derivedFiles: options.train?.derivedFiles ?? settings.derivedFiles ?? packageDerivedFiles,
    promote: () => promoteNow(),
    runGate,
    // Every control-plane release must execute its complete mandatory proof on the exact final candidate.
    runControlPlaneGate,
    gateIdentity: JSON.stringify(settings.gate),
    codeIsCurrent,
    ...(startedCodeVersion ? { startedCodeVersion } : {}),
    handOff,
    ...options.train,
    runTypecheck: typecheckGate,
  });
  function promoteNow(): Promise<void> {
    return promote({
      settings,
      job,
      runGate: promotionGate,
      prepareGateCommand: (run, command) => preparePromotionGate(settings, run, command)?.command ?? null,
      derivedFiles: options.train?.derivedFiles ?? settings.derivedFiles ?? packageDerivedFiles,
      ...(options.train?.beforePromotionAdvance ? { beforeAdvance: options.train.beforePromotionAdvance } : {}),
    });
  }
  const landing: IntegrationRuntime['landing'] = (taskId) => {
    const task = store.task(taskId),
      ref = { taskId, attempt: task.currentAttempt };
    store.assertCurrent(ref);
    return {
      ...ref,
      branch: task.branch,
      worktree: task.worktree,
      declaredPaths: task.brief.paths,
      protectedRiskAreas: tasks.protectedRiskAreas(task.brief),
      gate: task.brief.acceptance.command,
    };
  };
  const managerLand: NonNullable<IntegrationRuntime['managerLand']> = (taskId, managerId) =>
    requestManagerLanding(taskId, managerId, store, queue, landing);
  const checkCompletion = completionChecker({
    policy: settings.policy,
    ...settings,
    runGate,
    condition(goal) {
      return { taskIds: tasks.completionScope(goal), gate: settings.gate };
    },
    async mergedTasks(goal) {
      return new Set(tasks.completionScope(goal).filter((taskId) => store.task(taskId).state === 'merged'));
    },
  });
  const command = [
    'env',
    `GOAL_MAIN_CHECKOUT=${settings.mainCheckout}`,
    `GOAL_LOCAL_CONFIG=${settings.localFile}`,
    process.execPath,
    join(settings.mainCheckout, 'tools/goal/src/cli.ts'),
  ];
  const managerServices: ManagerServices = {
    policy: settings.policy ?? defaults.policy,
    command,
    backlogDirectory: backlogDirectory(settings.stateDirectory),
    checkCompletion,
    windows: new TermspacesWindows({
      policy: settings.policy?.windows,
      socket: settings.integration.tmuxSocket,
      session: settings.integration.tmuxSession,
      tmuxCommand: settings.integration.tmuxCommand,
      termspacesCommand: settings.integration.termspacesCommand,
    }),
    ...options.managerServices,
  };
  const manager = (goal: string, engine: 'codex' | 'claude', budget: number): ManagerSpec => {
    const file = join(settings.integration.managerDirectory, `${encodeURIComponent(goal)}.json`);
    const local = existsSync(file) ? object(JSON.parse(readFileSync(file, 'utf8')), 'manager') : {};
    const pool = settings.pools.find(
      (p) => p.cli === engine && (local.pool ? p.name === local.pool : p.classes.includes('manager')),
    );
    if (!pool) throw new Error(`Configure a local ${engine} manager pool`);
    const scoped = store.tasks().filter((task) => task.brief.goal === goal);
    const limits = { ...settings.integration.managerLimits, ...object(local.limits ?? {}, 'manager limits') };
    return {
      id: goal,
      goal,
      engine,
      budget,
      cwd: settings.mainCheckout,
      pool: { id: pool.name, codexHome: pool.configDirectory, executable: pool.command },
      objective: text(local.objective ?? `Complete Goal ${goal}`, 'manager objective'),
      brief: text(local.brief ?? scoped.map((task) => task.brief.markdown).join('\n\n'), 'manager brief'),
      compactTokens: settings.integration.managerCompactTokens,
      effort: (local.effort ?? 'high') as ManagerSpec['effort'],
      supermanager: text(local.supermanager ?? settings.integration.supermanager, 'supermanager'),
      limits: {
        turns: positive(limits.turns, 'turns'),
        turnsWithoutDecision: positive(limits.turnsWithoutDecision, 'turnsWithoutDecision'),
        wallMs: positive(limits.wallMs, 'wallMs'),
      },
    };
  };
  return {
    db,
    ...settings,
    settings,
    loadedCodeVersion: startedCodeVersion,
    codeRetirement,
    store,
    tasks,
    job,
    queue,
    inbox,
    sharedInbox,
    train,
    fence: store,
    sink: job,
    managerSocket: settings.integration.managerSocket,
    supermanager: settings.integration.supermanager,
    ...(settings.integration.hourlyReportNotifier
      ? {
          hourlyEfficiencyReport: {
            enabled: true,
            timeoutMs: settings.integration.hourlyReportTimeoutMs,
          },
        }
      : {}),
    managerServices,
    landing,
    managerLand,
    refreshTrainConfiguration,
    handoffTrain: handOff,
    manager,
    pump,
    deliverReminders: async () => {
      const probes: Promise<void>[] = [];
      const deliver = (summary: string) =>
        inbox.deliver({ managerId: settings.integration.supermanager, kind: 'instruction', summary } as never);
      refreshCodexSchedule(settings.stateDirectory, Date.now(), undefined, settings.policy?.pacing);
      const delivered =
        deliverDueReminders(settings.notes ?? [], settings.stateDirectory, deliver) +
        alertUnspentAllowances(
          settings.pools,
          (pool) => tasks.reader(pool),
          settings.stateDirectory,
          deliver,
          Date.now(),
          settings.policy?.pacing,
        ) +
        watch(
          tasks.store,
          settings.mainCheckout,
          { stabilize: settings.stabilizeBranch, integration: settings.integrationBranch },
          settings.stateDirectory,
          (summary, managerId, kind) =>
            inbox.deliver({
              managerId: managerId ?? settings.integration.supermanager,
              kind: kind ?? 'instruction',
              summary,
            }),
          Date.now(),
          (host, complete) => {
            probes.push(
              new Promise<void>((resolve) => {
                sshProbe(
                  host,
                  (result) => {
                    try {
                      complete(result);
                    } finally {
                      resolve();
                    }
                  },
                  spawn,
                  undefined,
                  settings.policy,
                );
              }),
            );
          },
          (task) =>
            readRouting(settings.routingFile, settings.policy?.routing).classes[
              task.taskClass as Exclude<typeof task.taskClass, 'mechanical'>
            ].maxMs,
          settings.policy,
        );
      // A oneshot CLI exits after this method: persist every bounded probe before closing the runtime.
      await Promise.all(probes);
      return delivered;
    },
    sweepWidth: async () => {
      await sweepWidthGovernor(db, inbox, new Date(), { policy: settings.policy });
    },
    // Runs in the host's single-flight `backlog dispatch` child: dispatch is synchronous Git and install work.
    backlog: () =>
      sweepBacklog({
        db,
        stateDirectory: settings.stateDirectory,
        policy: settings.policy,
        inbox,
        async dispatch(brief) {
          // The `goal dispatch` path. Its first start is a durable request that the host's sweep runs and follows,
          // so this short-lived process never waits for host capacity or a worker.
          const task = tasks.dispatch(brief, null);
          if (task.state !== 'held') store.saveRetryIntent({ taskId: task.id, attempt: 0 }, {});
          return { taskId: task.id, lintWarnings: task.brief.lintWarnings ?? [] };
        },
        async continueTask(goal: string, continuation: BriefContinuation, briefFile: string) {
          const task = store.task(continuation.taskId);
          if (task.brief.goal !== goal)
            throw new Error(`task ${task.id} belongs to Goal ${task.brief.goal}, not backlog Goal ${goal}`);
          const actor = backlogManagerActor(db, task.brief.manager);
          if (!actor) throw new Error(`cannot authenticate the current session for task manager ${task.brief.manager}`);
          tasks.queueBacklogContinuation(task.id, goal, continuation.expectedAttempt, briefFile, actor);
        },
        cancel: (taskId) => tasks.cancel(taskId),
        routing: {
          table: readRouting(settings.routingFile, settings.policy?.routing),
          ownership: readRiskOwnership(settings.riskAreasFile, settings.policy?.brief),
          pools: settings.pools,
          running: store.runningAttemptsByPool(),
        },
      }),
    promote: () => promoteNow(),
    verify: () =>
      verifyDev({
        settings,
        store,
        inbox,
        runGate: verifierGate,
        runBootSmoke: bootSmokeGate,
        dispatchRepair: repairRouting.dispatchBootSmokeRepair,
        runPageData: async () =>
          runPageDataCycle({
            settings,
            db,
            tasks: store,
            inbox,
            routeDefect: repairRouting.routePageDataRepair,
          }),
      }),
    async evaluateFlow() {
      const flowInbox = new SqliteManagerInbox(
        db,
        settings.integration.inboxDirectory,
        undefined,
        settings.policy?.inbox,
      );
      const now = new Date();
      const metrics = await lifecycleMetricsAsync(db, now, settings.policy);
      const flow = flowReport(
        readFlow(db, new Date(now.getTime() - (settings.policy ?? defaults.policy).flowHistoryMs).toISOString()),
        readFlowTasks(db),
        now.getTime(),
      );
      emitHourlyLifecycleMetrics(db, metrics, now);
      checkFlowAlarms(
        db,
        flow,
        (summary) => flowInbox.deliver({ managerId: settings.integration.supermanager, kind: 'environment', summary }),
        now,
        flowThresholds,
        settings.policy,
      );
    },
    dispatchDailyStepAudit() {
      const template = join(import.meta.dir, '../templates/daily-step-audit.md');
      dispatchDailyStepAudit(
        db,
        store.tasks(),
        () => tasks.dispatch(template),
        new Date(),
        (summary) => inbox.deliver({ managerId: settings.integration.supermanager, kind: 'environment', summary }),
      );
    },
    recoverOrphans: async (options?: { adoptRunning?: boolean }) => {
      await job.recoverOrphans(options);
      await afterSettle();
    },
    async drain() {
      await pump();
      await job.drain();
    },
    drainJobs: () => job.drain(),
    close() {
      db.close();
    },
  };
}
