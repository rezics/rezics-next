import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import defaults from '../defaults.json';
import { defaultPolicy, readControlPolicy } from './policy.ts';
export { readControlPolicy } from './policy.ts';
import type { DerivedFile, Pool, PromotionPlacementSettings, Settings } from './types.ts';
import { validatePath } from './briefs.ts';
import { readWebModules } from './workspace.ts';
import { readPoolPolicies } from './pools.ts';
import { ignoreUnknownKeys, loadLocalSettings, readLocalFile } from './local-settings.ts';
import { parseNotes } from './notes.ts';
import { DEFAULT_FLOW_THRESHOLDS } from './flow.ts';
import { FORMAT_FLAGS } from './merge-train.ts';
import type { IntegrationCheck } from './merge-train.ts';

export type SettingsOptions = { cwd?: string; env?: NodeJS.ProcessEnv; localFile?: string };
export type ConfiguredSettings = Settings & { integrationChecks: IntegrationCheck[] };
export function readDerivedFiles(value: unknown = defaults.derivedFiles, policy = defaultPolicy.brief): DerivedFile[] {
  if (!Array.isArray(value)) throw new Error('derivedFiles must be an array');
  return value.map((item, index) => {
    const file = object(item, `derivedFiles[${index}]`);
    keys(file, ['path', 'stage', 'command', 'inputs'], `derivedFiles[${index}]`);
    const path = text(file.path, `derivedFiles[${index}].path`);
    validatePath(path, policy);
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
      validatePath(input, policy);
      return input;
    });
    return { path, stage: file.stage, command: [...file.command], ...(inputs ? { inputs } : {}) };
  });
}
export function readIntegrationChecks(
  value: unknown = defaults.integrationChecks,
  label = 'integrationChecks',
  policy = defaultPolicy.brief,
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
    for (const path of check.paths) validatePath(path, policy);
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
function readBootSmoke(value: unknown = defaults.bootSmoke, label = 'bootSmoke', policy = defaultPolicy.brief) {
  const smoke = object(value, label);
  keys(smoke, ['tests'], label);
  if (!Array.isArray(smoke.tests) || smoke.tests.some((path) => typeof path !== 'string' || !path.trim()))
    throw new Error(`${label}.tests must be a path list`);
  for (const path of smoke.tests as string[]) validatePath(path, policy);
  return { tests: [...(smoke.tests as string[])] };
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
export const packageDerivedFiles = readDerivedFiles();

export function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}
export function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must be a nonempty string`);
  return value;
}
export function positive(value: unknown, label: string, zero = false): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < (zero ? 0 : 1))
    throw new Error(`invalid ${label}`);
  return value;
}
function positiveInteger(value: unknown, label: string): number {
  const parsed = positive(value, label);
  if (!Number.isInteger(parsed)) throw new Error(`invalid ${label}`);
  return parsed;
}
function readArgvPrefix(
  value: unknown,
  policy: ReturnType<typeof readControlPolicy>['validation'],
): string[] | undefined {
  if (value === undefined || value === null || (Array.isArray(value) && value.length === 0)) return undefined;
  if (
    !Array.isArray(value) ||
    value.length > policy.notifierArguments ||
    value.some(
      (part) =>
        typeof part !== 'string' ||
        !part.trim() ||
        part.length > policy.notifierArgumentCharacters ||
        part.includes('\0'),
    )
  )
    throw new Error(
      `hourlyReportNotifier must be a nonempty command array with at most ${policy.notifierArguments} arguments of ${policy.notifierArgumentCharacters} characters`,
    );
  return value as string[];
}
function keys(value: Record<string, unknown>, allowed: string[], label: string): void {
  ignoreUnknownKeys(value, allowed, label);
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
      'bootSmoke',
      'derivedFiles',
      'codex',
      'routingFile',
      'riskAreasFile',
      'integration',
      'pools',
      'notes',
      'flow',
      'policy',
    ],
    'settings',
  );
  if (local.version !== undefined && local.version !== 1) throw new Error('unsupported local settings version');
  const policy = readControlPolicy(local.policy);
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
      'devLandingBootCheck',
      'devKernelImport',
      'hourlyReportNotifier',
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
    'integrationChecks',
    policy.brief,
  );
  const affectedTests = readIntegrationChecks(
    local.affectedTests === undefined ? defaults.affectedTests : local.affectedTests,
    'affectedTests',
    policy.brief,
  );
  const defaultVerifierChecks = readIntegrationChecks(defaults.verifierChecks ?? [], 'verifierChecks', policy.brief);
  const verifierChecks =
    local.verifierChecks === undefined
      ? verifierChecksFromLegacy(
          defaultVerifierChecks,
          readIntegrationChecks(defaults.affectedTests, 'affectedTests', policy.brief),
          local.affectedTests === undefined ? [] : affectedTests,
          local.integrationChecks === undefined
            ? undefined
            : readIntegrationChecks(local.integrationChecks, 'integrationChecks', policy.brief),
          local.affectedTests !== undefined,
        )
      : readIntegrationChecks(local.verifierChecks, 'verifierChecks', policy.brief);
  const siblingTests = readSiblingTests(local.siblingTests === undefined ? defaults.siblingTests : local.siblingTests);
  const bootSmoke = readBootSmoke(local.bootSmoke === undefined ? defaults.bootSmoke : local.bootSmoke);
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
  const hourlyReportNotifier = readArgvPrefix(integration.hourlyReportNotifier, policy.validation);
  const hourlyReportTimeoutMs = positiveInteger(integration.hourlyReportTimeoutMs, 'hourlyReportTimeoutMs');
  if (hourlyReportTimeoutMs > policy.validation.hourlyReportMaxTimeoutMs)
    throw new Error(`hourlyReportTimeoutMs must be at most ${policy.validation.hourlyReportMaxTimeoutMs}`);
  return {
    version: 1,
    mainCheckout: main,
    stateDirectory,
    worktreeRoot: path(local.worktreeRoot, '.temp/worktrees', env.GOAL_WORKTREE_ROOT),
    ...(local.sharedWebModules === undefined
      ? {}
      : { sharedWebModules: readWebModules(local.sharedWebModules, policy.brief) }),
    localFile,
    mainBranch: text(local.mainBranch ?? defaults.mainBranch, 'mainBranch'),
    branchPrefix: text(local.branchPrefix ?? defaults.branchPrefix, 'branchPrefix'),
    integrationBranch: text(local.integrationBranch ?? 'dev', 'integrationBranch'),
    stabilizeBranch: text(local.stabilizeBranch ?? 'stabilize', 'stabilizeBranch'),
    promotionParallelism: positive(local.promotionParallelism ?? defaults.promotionParallelism, 'promotionParallelism'),
    ...(promotionPlacement === undefined ? {} : { promotionPlacement }),
    routingFile: path(local.routingFile, join(import.meta.dir, '../routing.json')),
    gate: gate as string[],
    formatCommand: formatCommand as string[],
    integrationChecks,
    verifierChecks,
    siblingTests,
    bootSmoke,
    affectedTests,
    derivedFiles: readDerivedFiles(
      local.derivedFiles === undefined ? defaults.derivedFiles : local.derivedFiles,
      policy.brief,
    ),
    riskAreasFile: path(local.riskAreasFile, join(import.meta.dir, '../risk-areas.json')),
    pools,
    notes: parseNotes(local.notes),
    flowThresholds,
    policy,
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
      ...(hourlyReportNotifier ? { hourlyReportNotifier } : {}),
      hourlyReportTimeoutMs,
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
      ...(integration.devLandingBootCheck === undefined
        ? {}
        : {
            devLandingBootCheck: (() => {
              if (typeof integration.devLandingBootCheck !== 'boolean')
                throw new Error('devLandingBootCheck must be a boolean');
              return integration.devLandingBootCheck;
            })(),
          }),
      ...(integration.devKernelImport === undefined
        ? {}
        : {
            devKernelImport: (() => {
              if (typeof integration.devKernelImport !== 'boolean')
                throw new Error('devKernelImport must be a boolean');
              return integration.devKernelImport;
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
