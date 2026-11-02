import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import defaults from '../defaults.json';
import type { DerivedFile, Pool, PromotionPlacementSettings, Settings } from './types.ts';
import { validatePath } from './briefs.ts';
import { readWebModules } from './workspace.ts';
import { readPoolPolicies } from './pools.ts';
import {
  configurationProblem,
  loadLocalSettings,
  readLocalFile,
  reportedConfigurationProblem,
} from './local-settings.ts';

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
import { deliverDueReminders, parseNotes } from './notes.ts';
import { alertUnspentAllowances, refreshCodexSchedule } from './pacing.ts';
import { watch } from './watchdog.ts';
import { readRouting } from './routing.ts';
import { FORMAT_FLAGS, MergeTrain, type IntegrationCheck, type TrainOptions } from './merge-train.ts';
import { promote, PROMOTION_GATE_TIMEOUT_MS } from './promotion.ts';
import { preparePromotionGate } from './promotion-placement.ts';
import { verifyDev } from './dev-verifier.ts';
import { gateRunner, processGroupRunner, type GateRunner } from './merge.ts';
import { codeVersion } from './runtime-version.ts';
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

export type SettingsOptions = { cwd?: string; env?: NodeJS.ProcessEnv; localFile?: string };
export type ConfiguredSettings = Settings & { integrationChecks: IntegrationCheck[] };
export function readDerivedFiles(value: unknown = defaults.derivedFiles): DerivedFile[] {
  if (!Array.isArray(value)) throw new Error('derivedFiles must be an array');
  return value.map((item, index) => {
    const file = object(item, `derivedFiles[${index}]`);
    keys(file, ['path', 'stage', 'command', 'inputs'], `derivedFiles[${index}]`);
    const path = text(file.path, `derivedFiles[${index}].path`);
    validatePath(path);
    if (file.stage !== 'integration' && file.stage !== 'promotion')
      throw new Error(`invalid derivedFiles[${index}].stage`);
    if (
      !Array.isArray(file.command) ||
      !file.command.length ||
      file.command.some((part) => typeof part !== 'string' || !part)
    )
      throw new Error(`derivedFiles[${index}].command must be a command array`);
    if (
      file.inputs !== undefined &&
      (!Array.isArray(file.inputs) || file.inputs.some((input) => typeof input !== 'string' || !input))
    )
      throw new Error(`derivedFiles[${index}].inputs must be a path array`);
    const inputs = (file.inputs as string[] | undefined)?.map((input) => {
      validatePath(input);
      return input;
    });
    return { path, stage: file.stage, command: [...file.command], ...(inputs ? { inputs } : {}) };
  });
}
export function readIntegrationChecks(
  value: unknown = defaults.integrationChecks,
  label = 'integrationChecks',
): IntegrationCheck[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value.map((item, index) => {
    const check = object(item, `${label}[${index}]`);
    keys(check, ['paths', 'command'], `${label}[${index}]`);
    if (
      !Array.isArray(check.paths) ||
      !check.paths.length ||
      check.paths.some((part) => typeof part !== 'string' || !part)
    )
      throw new Error(`${label}[${index}].paths must be a path list`);
    for (const path of check.paths) validatePath(path);
    if (
      !Array.isArray(check.command) ||
      !check.command.length ||
      check.command.some((part) => typeof part !== 'string' || !part)
    )
      throw new Error(`${label}[${index}].command must be a command array`);
    return { paths: [...check.paths], command: [...check.command] };
  });
}
function readSiblingTests(value: unknown = defaults.siblingTests, label = 'siblingTests') {
  const sibling = object(value, label);
  keys(sibling, ['command'], label);
  if (
    !Array.isArray(sibling.command) ||
    !sibling.command.length ||
    sibling.command.some((part) => typeof part !== 'string' || !part)
  )
    throw new Error(`${label}.command must be a command array`);
  return { command: [...sibling.command] as string[] };
}

function uniqueChecks(checks: readonly IntegrationCheck[]): IntegrationCheck[] {
  const byCommand = new Map<string, IntegrationCheck>();
  for (const check of checks) {
    const key = JSON.stringify(check.command);
    const existing = byCommand.get(key);
    if (existing) existing.paths = [...new Set([...existing.paths, ...check.paths])];
    else byCommand.set(key, { paths: [...check.paths], command: [...check.command] });
  }
  return [...byCommand.values()];
}

function verifierChecksFromLegacy(
  defaultsChecks: readonly IntegrationCheck[],
  defaultsAffected: readonly IntegrationCheck[],
  legacyAffected: readonly IntegrationCheck[],
  legacyIntegration: readonly IntegrationCheck[] | undefined,
  affectedWasOverridden: boolean,
): IntegrationCheck[] {
  const replacedAffected = new Set(defaultsAffected.map((check) => JSON.stringify(check)));
  const retainedDefaults = affectedWasOverridden
    ? defaultsChecks.filter((check) => !replacedAffected.has(JSON.stringify(check)))
    : [...defaultsChecks];
  const additional =
    legacyIntegration?.filter(
      (check) =>
        !check.command.some((part) => part === 'install') &&
        !check.command.some((part) => part.includes('scripts/typecheck.ts')),
    ) ?? [];
  return uniqueChecks([...retainedDefaults, ...legacyAffected, ...additional]);
}
const packageDerivedFiles = readDerivedFiles();

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}
function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must be a nonempty string`);
  return value;
}
function positive(value: unknown, label: string, zero = false): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < (zero ? 0 : 1))
    throw new Error(`invalid ${label}`);
  return value;
}
function positiveInteger(value: unknown, label: string): number {
  const parsed = positive(value, label);
  if (!Number.isInteger(parsed)) throw new Error(`invalid ${label}`);
  return parsed;
}
function keys(value: Record<string, unknown>, allowed: string[], label: string): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Error(`unknown ${label}.${key}`);
}
/** The common Git directory identifies the main checkout even when invoked from a linked worktree. */
export function mainCheckout(cwd = process.cwd()): string {
  const result = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
    cwd,
    encoding: 'utf8',
  });
  if (result.status !== 0) throw new Error('Run inside a Git repository or set GOAL_MAIN_CHECKOUT');
  const common = result.stdout.trim();
  return dirname(common);
}

type SettingsSource = { env: NodeJS.ProcessEnv; initialMain: string; localFile: string };
function settingsSource(options: SettingsOptions): SettingsSource {
  const env = options.env ?? process.env;
  const cwd = resolve(options.cwd ?? process.cwd());
  const initialMain = resolve(cwd, env.GOAL_MAIN_CHECKOUT || mainCheckout(cwd));
  const localFile = resolve(
    cwd,
    options.localFile ?? env.GOAL_LOCAL_CONFIG ?? join(initialMain, '.temp/goal/local.json'),
  );
  return { env, initialMain, localFile };
}
/** The live local file the options resolve to. */
export function settingsFile(options: SettingsOptions = {}): string {
  return settingsSource(options).localFile;
}

/**
 * Package defaults < untracked local settings < explicit environment paths. No account fallback is implicit.
 * When the live file is invalid, the last version of that same file that validated is used instead (see
 * `local-settings.ts`), so one bad edit does not stop every command; the error is reported by `createRuntime`.
 */
export function loadSettings(options: SettingsOptions = {}): ConfiguredSettings {
  const source = settingsSource(options);
  return loadLocalSettings(source.localFile, source.initialMain, (local) => settingsFromLocal(local, source));
}
/** Validate a candidate strictly: no last-valid fallback, and the live state is neither read nor written. */
export function checkSettings(options: SettingsOptions = {}): ConfiguredSettings {
  const source = settingsSource(options);
  return settingsFromLocal(readLocalFile(source.localFile), source);
}

function settingsFromLocal(value: unknown, { env, initialMain, localFile }: SettingsSource): ConfiguredSettings {
  const local = object(value, 'local settings');
  keys(
    local,
    [
      'version',
      'mainCheckout',
      'stateDirectory',
      'worktreeRoot',
      'sharedWebModules',
      'mainBranch',
      'integrationBranch',
      'stabilizeBranch',
      'promotionParallelism',
      'promotionPlacement',
      'branchPrefix',
      'terminationGraceMs',
      'silenceMs',
      'gate',
      'formatCommand',
      'integrationChecks',
      'affectedTests',
      'verifierChecks',
      'siblingTests',
      'derivedFiles',
      'codex',
      'routingFile',
      'riskAreasFile',
      'integration',
      'pools',
      'notes',
      'flow',
    ],
    'settings',
  );
  if (local.version !== undefined && local.version !== 1) throw new Error('unsupported local settings version');
  const main = resolve(dirname(localFile), env.GOAL_MAIN_CHECKOUT ?? String(local.mainCheckout ?? initialMain));
  // Keeping credentials and account policy untracked is checked even for an explicitly selected file.
  const tracked = spawnSync('git', ['ls-files', '--error-unmatch', '--', localFile], { cwd: main, encoding: 'utf8' });
  if (tracked.status === 0) throw new Error('local settings must be untracked');
  const path = (value: unknown, fallback: string, variable?: string) =>
    resolve(main, variable ?? (value === undefined ? fallback : text(value, 'path')));
  const stateDirectory = path(local.stateDirectory, '.temp/goal', env.GOAL_STATE_DIRECTORY);
  const promotionPlacement: PromotionPlacementSettings | undefined =
    local.promotionPlacement === undefined
      ? undefined
      : (() => {
          const placement = object(local.promotionPlacement, 'promotionPlacement');
          keys(placement, ['ordinaryHostsFile'], 'promotionPlacement');
          return {
            ordinaryHostsFile: path(text(placement.ordinaryHostsFile, 'promotionPlacement.ordinaryHostsFile'), ''),
          };
        })();
  const integration: Record<string, unknown> = {
    ...defaults.integration,
    ...object(local.integration ?? {}, 'integration'),
  };
  keys(
    integration,
    [
      ...Object.keys(defaults.integration),
      'managerDirectory',
      'inboxDirectory',
      'managerSocket',
      'tmuxSocket',
      'operationsManager',
      'checkScriptReaderRoot',
      'devPrelandingTypecheck',
    ],
    'integration',
  );
  const managerLimits = {
    ...defaults.integration.managerLimits,
    ...object(integration.managerLimits, 'managerLimits'),
  };
  keys(managerLimits, Object.keys(defaults.integration.managerLimits), 'managerLimits');
  const gate = local.gate ?? defaults.gate;
  if (!Array.isArray(gate) || !gate.length || gate.some((item) => typeof item !== 'string' || !item))
    throw new Error('gate must be a command array');
  const formatCommand = local.formatCommand ?? [resolve(main, 'node_modules/.bin/oxfmt'), ...FORMAT_FLAGS];
  if (
    !Array.isArray(formatCommand) ||
    !formatCommand.length ||
    formatCommand.some((item) => typeof item !== 'string' || !item)
  )
    throw new Error('formatCommand must be a command array');
  const integrationChecks = readIntegrationChecks(
    local.integrationChecks === undefined ? defaults.integrationChecks : local.integrationChecks,
  );
  const affectedTests = readIntegrationChecks(
    local.affectedTests === undefined ? defaults.affectedTests : local.affectedTests,
    'affectedTests',
  );
  const defaultVerifierChecks = readIntegrationChecks(defaults.verifierChecks ?? [], 'verifierChecks');
  const verifierChecks =
    local.verifierChecks === undefined
      ? verifierChecksFromLegacy(
          defaultVerifierChecks,
          readIntegrationChecks(defaults.affectedTests),
          local.affectedTests === undefined ? [] : affectedTests,
          local.integrationChecks === undefined ? undefined : readIntegrationChecks(local.integrationChecks),
          local.affectedTests !== undefined,
        )
      : readIntegrationChecks(local.verifierChecks, 'verifierChecks');
  const siblingTests = readSiblingTests(local.siblingTests === undefined ? defaults.siblingTests : local.siblingTests);
  const codex: Record<string, unknown> = { ...defaults.codex, ...object(local.codex ?? {}, 'codex') };
  keys(codex, Object.keys(defaults.codex), 'codex');
  const compact = { ...defaults.codex.compactTokens, ...object(codex.compactTokens, 'compactTokens') };
  keys(compact, ['sol', 'luna'], 'compactTokens');
  const pools: Pool[] = readPoolPolicies(local.pools ?? [], localFile);
  const flowOverrides = object(local.flow ?? {}, 'flow');
  keys(flowOverrides, ['efficiencyBelow', 'oldestQueueMs', 'landingP90Ms', 'attemptsPerIntegrated'], 'flow');
  const flowThresholds = { ...DEFAULT_FLOW_THRESHOLDS, ...flowOverrides } as typeof DEFAULT_FLOW_THRESHOLDS;
  if (
    !Number.isFinite(flowThresholds.efficiencyBelow) ||
    flowThresholds.efficiencyBelow < 0 ||
    flowThresholds.efficiencyBelow > 1 ||
    !Number.isFinite(flowThresholds.oldestQueueMs) ||
    flowThresholds.oldestQueueMs <= 0 ||
    !Number.isFinite(flowThresholds.landingP90Ms) ||
    flowThresholds.landingP90Ms <= 0 ||
    !Number.isFinite(flowThresholds.attemptsPerIntegrated) ||
    flowThresholds.attemptsPerIntegrated <= 0
  )
    throw new Error('invalid flow alarm thresholds');
  return {
    version: 1,
    mainCheckout: main,
    stateDirectory,
    worktreeRoot: path(local.worktreeRoot, '.temp/worktrees', env.GOAL_WORKTREE_ROOT),
    ...(local.sharedWebModules === undefined ? {} : { sharedWebModules: readWebModules(local.sharedWebModules) }),
    localFile,
    mainBranch: text(local.mainBranch ?? defaults.mainBranch, 'mainBranch'),
    branchPrefix: text(local.branchPrefix ?? defaults.branchPrefix, 'branchPrefix'),
    integrationBranch: text(local.integrationBranch ?? 'dev', 'integrationBranch'),
    stabilizeBranch: text(local.stabilizeBranch ?? 'stabilize', 'stabilizeBranch'),
    promotionParallelism: positive(local.promotionParallelism ?? 4, 'promotionParallelism'),
    ...(promotionPlacement === undefined ? {} : { promotionPlacement }),
    routingFile: path(local.routingFile, join(import.meta.dir, '../routing.json')),
    gate: gate as string[],
    formatCommand: formatCommand as string[],
    integrationChecks,
    verifierChecks,
    siblingTests,
    affectedTests,
    derivedFiles: readDerivedFiles(local.derivedFiles === undefined ? defaults.derivedFiles : local.derivedFiles),
    riskAreasFile: path(local.riskAreasFile, join(import.meta.dir, '../risk-areas.json')),
    pools,
    notes: parseNotes(local.notes),
    flowThresholds,
    terminationGraceMs: positive(local.terminationGraceMs ?? defaults.terminationGraceMs, 'terminationGraceMs', true),
    silenceMs: positive(local.silenceMs ?? defaults.silenceMs, 'silenceMs'),
    codex: {
      serviceTier: text(env.GOAL_CODEX_SERVICE_TIER ?? codex.serviceTier, 'serviceTier'),
      compactTokens: {
        sol: positive(compact.sol, 'compactTokens.sol'),
        luna: positive(compact.luna, 'compactTokens.luna'),
      },
      solContextWindow: positive(codex.solContextWindow, 'solContextWindow'),
      toolOutputTokens: positive(codex.toolOutputTokens, 'toolOutputTokens'),
      backgroundTerminalMaxTimeoutMs: positive(codex.backgroundTerminalMaxTimeoutMs, 'backgroundTerminalMaxTimeoutMs'),
    },
    integration: {
      managerSocket: path(integration.managerSocket, join(stateDirectory, 'manager.sock')),
      tmuxSocket: path(integration.tmuxSocket, join(stateDirectory, 'tmux.sock')),
      termspacesCommand: text(integration.termspacesCommand, 'termspacesCommand'),
      supermanager: text(integration.supermanager, 'supermanager'),
      ...(integration.operationsManager === undefined
        ? {}
        : { operationsManager: text(integration.operationsManager, 'operationsManager') }),
      ...(integration.checkScriptReaderRoot === undefined
        ? {}
        : { checkScriptReaderRoot: path(integration.checkScriptReaderRoot, '') }),
      managerLimits: {
        turns: positive(managerLimits.turns, 'managerLimits.turns'),
        turnsWithoutDecision: positive(managerLimits.turnsWithoutDecision, 'managerLimits.turnsWithoutDecision'),
        wallMs: positive(managerLimits.wallMs, 'managerLimits.wallMs'),
      },
      gateConcurrency: positive(integration.gateConcurrency, 'gateConcurrency'),
      gateTimeoutMs: positive(integration.gateTimeoutMs, 'gateTimeoutMs'),
      managerDirectory: path(integration.managerDirectory, join(stateDirectory, 'managers')),
      inboxDirectory: path(integration.inboxDirectory, join(stateDirectory, 'inboxes')),
      batchSize: positiveInteger(integration.batchSize, 'batchSize'),
      batchAcceptanceConcurrency: positiveInteger(integration.batchAcceptanceConcurrency, 'batchAcceptanceConcurrency'),
      devLandingChecks: (() => {
        if (typeof integration.devLandingChecks !== 'boolean') throw new Error('devLandingChecks must be a boolean');
        return integration.devLandingChecks;
      })(),
      ...(integration.devPrelandingTypecheck === undefined
        ? {}
        : {
            devPrelandingTypecheck: (() => {
              if (typeof integration.devPrelandingTypecheck !== 'boolean')
                throw new Error('devPrelandingTypecheck must be a boolean');
              return integration.devPrelandingTypecheck;
            })(),
          }),
      tmuxCommand: text(integration.tmuxCommand, 'tmuxCommand'),
      tmuxSession: text(integration.tmuxSession, 'tmuxSession'),
      managerCompactTokens: positive(integration.managerCompactTokens, 'managerCompactTokens'),
      checkResultReuse:
        typeof integration.checkResultReuse === 'boolean'
          ? integration.checkResultReuse
          : (() => {
              throw new Error('invalid checkResultReuse');
            })(),
    },
  };
}

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
    'merge' | 'beforeRelease' | 'beforeIntegrationAdvance' | 'beforePromotionAdvance' | 'promote' | 'derivedFiles'
  >;
};

/** The only production composition: every module shares this database connection and worker fence. */
export const LANDING_CHECK_ENVIRONMENT = { REMOTE_CHECK_PRIORITY: 'landing' } as const;
export function createRuntime(options: RuntimeOptions = {}): Runtime {
  const settings = options.settings ?? options.tasks?.settings ?? loadSettings();
  const flowThresholds = settings.flowThresholds ?? DEFAULT_FLOW_THRESHOLDS;
  // Synthetic runtime fixtures may not contain the control-plane tree in their main checkout.
  const startedCodeVersion = existsSync(join(settings.mainCheckout, 'tools/goal'))
    ? codeVersion(settings.mainCheckout, 'tools/goal')
    : undefined;
  const codeIsCurrent = () =>
    startedCodeVersion === undefined || codeVersion(settings.mainCheckout, 'tools/goal') === startedCodeVersion;
  const databasePath = join(settings.stateDirectory, 'goal.sqlite');
  mkdirSync(settings.stateDirectory, { recursive: true });
  const db = options.db ?? options.tasks?.store.db ?? openDb(databasePath);
  if (options.tasks && options.tasks.store.db !== db)
    throw new Error('Runtime modules must share one database connection');
  const store = options.tasks?.store ?? new WorkerStore(db);
  const tasks = options.tasks ?? new WorkerTasks(settings, store);
  const queue = new SqliteLandingQueue(db, store);
  const inbox = new SqliteManagerInbox(db, settings.integration.inboxDirectory);
  const problem = configurationProblem(settings);
  if (problem && !problem.reported) {
    const summary = `Local settings ${problem.file} are invalid: ${problem.error}. Goal keeps using the last valid version of that file until it changes; validate an edit with \`goal config check\` first.`;
    for (const managerId of new Set([settings.integration.operationsManager, settings.integration.supermanager]))
      if (managerId) inbox.deliver({ managerId, kind: 'instruction', summary });
    reportedConfigurationProblem(problem);
  }
  const sharedInbox = new SharedInboxQueries(db);
  const checkResultOptions = {
    root: settings.mainCheckout,
    results: store.checkResults,
    shadow: !settings.integration.checkResultReuse,
    enabled: settings.integration.checkResultReuse,
    alert: (summary: string) =>
      inbox.deliver({
        managerId: settings.integration.supermanager,
        kind: 'instruction',
        summary: `Check result reuse alert: ${summary}`,
      }),
  };
  // Landing checks unblock every other task, so remote checks admit them before workers' checks (promotion uses --gate).
  const execute = gateRunner(
    settings.integration.gateTimeoutMs,
    settings.stateDirectory,
    LANDING_CHECK_ENVIRONMENT,
    checkResultOptions,
  );
  const runGate: GateRunner = options.runGate ?? execute;
  // Promotion runs the full root gate, which outlasts the integration gate's limit.
  const promotionGate: GateRunner =
    options.runGate ??
    gateRunner(
      Math.max(settings.integration.gateTimeoutMs, PROMOTION_GATE_TIMEOUT_MS),
      settings.stateDirectory,
      {},
      checkResultOptions,
    );
  // The dev verifier checks after integration at ordinary priority: at landing priority its checks held every host's
  // ordinary admission at zero, and workers waited an hour behind one run (2026-10-30).
  const verifierGate: GateRunner =
    options.runGate ??
    gateRunner(
      Math.max(settings.integration.gateTimeoutMs, PROMOTION_GATE_TIMEOUT_MS),
      undefined,
      {},
      checkResultOptions,
    );
  // The prelanding compiler guard is a direct process group. It never enters remote check-host slot admission.
  const typecheckGate = processGroupRunner(settings.integration.gateTimeoutMs, settings.stateDirectory, process.env);
  let train!: MergeTrain;
  const pump = () => train.pump();
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
  const job = new WorkerJob(tasks, queue, inbox, undefined, afterSettle);
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
    mainCheckout: settings.mainCheckout,
    stateDirectory: settings.stateDirectory,
    worktreeRoot: settings.worktreeRoot,
    mainBranch: settings.mainBranch,
    integrationBranch: settings.integrationBranch,
    integration: settings.integration,
    formatCommand: settings.formatCommand,
    // The configured list, not the package default: local configuration switches landing affected checks off.
    affectedTests: settings.affectedTests ?? [],
    integrationChecks: () => {
      const configured = (settings as Settings & { integrationChecks?: IntegrationCheck[] }).integrationChecks ?? [];
      // The local file is read for every landing, so checks can be switched off or on without restarting the train.
      try {
        const file = join(settings.stateDirectory, 'local.json');
        const local = existsSync(file)
          ? (JSON.parse(readFileSync(file, 'utf8')) as { integrationChecks?: unknown })
          : {};
        return local.integrationChecks === undefined
          ? readIntegrationChecks()
          : readIntegrationChecks(local.integrationChecks);
      } catch {
        return configured;
      }
    },
    queue,
    fence: store,
    sink: job,
    trainResolver: new TrainResolver(store, tasks),
    derivedFiles: options.train?.derivedFiles ?? settings.derivedFiles ?? packageDerivedFiles,
    promote: () => promoteNow(),
    runGate,
    // Every control-plane release must execute its complete mandatory proof on the exact final candidate.
    runControlPlaneGate:
      options.runGate ??
      gateRunner(settings.integration.gateTimeoutMs, settings.stateDirectory, LANDING_CHECK_ENVIRONMENT),
    gateIdentity: JSON.stringify(settings.gate),
    codeIsCurrent,
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
      protectedPaths: tasks.protectedPaths(task.brief),
      gate: task.brief.acceptance.command,
    };
  };
  const managerLand: NonNullable<IntegrationRuntime['managerLand']> = (taskId, managerId) =>
    requestManagerLanding(taskId, managerId, store, queue, landing);
  const checkCompletion = completionChecker({
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
    command,
    backlogDirectory: backlogDirectory(settings.stateDirectory),
    checkCompletion,
    windows: new TermspacesWindows({
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
    managerServices,
    landing,
    managerLand,
    handoffTrain: handOff,
    manager,
    pump,
    hostCommand: command,
    codeIsCurrent,
    deliverReminders: () => {
      const deliver = (summary: string) =>
        inbox.deliver({ managerId: settings.integration.supermanager, kind: 'instruction', summary } as never);
      refreshCodexSchedule(settings.stateDirectory);
      return (
        deliverDueReminders(settings.notes ?? [], settings.stateDirectory, deliver) +
        alertUnspentAllowances(settings.pools, (pool) => tasks.reader(pool), settings.stateDirectory, deliver) +
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
          undefined,
          (task) =>
            readRouting(settings.routingFile).classes[task.taskClass as Exclude<typeof task.taskClass, 'mechanical'>]
              .maxMs,
        )
      );
    },
    sweepWidth: async () => {
      await sweepWidthGovernor(db, inbox);
    },
    // Runs in the host's single-flight `backlog dispatch` child: dispatch is synchronous Git and install work.
    backlog: () =>
      sweepBacklog({
        db,
        stateDirectory: settings.stateDirectory,
        inbox,
        async dispatch(brief) {
          // The `goal dispatch` path. Its first start is a durable request that the host's sweep runs and follows,
          // so this short-lived process never waits for host capacity or a worker.
          const task = tasks.dispatch(brief, null);
          if (task.state !== 'held') store.saveRetryIntent({ taskId: task.id, attempt: 0 }, {});
          return task.id;
        },
        cancel: (taskId) => tasks.cancel(taskId),
      }),
    promote: () => promoteNow(),
    verify: () => verifyDev({ settings, store, inbox, runGate: verifierGate }),
    async evaluateFlow() {
      const flowInbox = new SqliteManagerInbox(db, settings.integration.inboxDirectory);
      const now = new Date();
      const metrics = await lifecycleMetricsAsync(db, now);
      const flow = flowReport(
        readFlow(db, new Date(now.getTime() - 30 * 86400_000).toISOString()),
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
