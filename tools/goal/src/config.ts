import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import defaults from '../defaults.json';
import type { Pool, Settings } from './types.ts';

export type SettingsOptions = { cwd?: string; env?: NodeJS.ProcessEnv; localFile?: string };
function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}
function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must be a nonempty string`);
  return value;
}
function positive(value: unknown, label: string, zero = false): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < (zero ? 0 : 1)) throw new Error(`invalid ${label}`);
  return value;
}
function keys(value: Record<string, unknown>, allowed: string[], label: string): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Error(`unknown ${label}.${key}`);
}
/** The common Git directory identifies the main checkout even when invoked from a linked worktree. */
export function mainCheckout(cwd = process.cwd()): string {
  const result = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error('Run inside a Git repository or set GOAL_MAIN_CHECKOUT');
  const common = result.stdout.trim();
  return dirname(common);
}

/** Package defaults < untracked local settings < explicit environment paths. No account fallback is implicit. */
export function loadSettings(options: SettingsOptions = {}): Settings {
  const env = options.env ?? process.env;
  const cwd = resolve(options.cwd ?? process.cwd());
  const initialMain = resolve(cwd, env.GOAL_MAIN_CHECKOUT || mainCheckout(cwd));
  const localFile = resolve(cwd, options.localFile ?? env.GOAL_LOCAL_CONFIG ?? join(initialMain, '.temp/goal/local.json'));
  const local = existsSync(localFile) ? object(JSON.parse(readFileSync(localFile, 'utf8')), 'local settings') : {};
  keys(local, ['version', 'mainCheckout', 'stateDirectory', 'worktreeRoot', 'databasePath', 'mainBranch', 'branchPrefix',
    'terminationGraceMs', 'codex', 'routingFile', 'riskAreasFile', 'integration', 'pools'], 'settings');
  if (local.version !== undefined && local.version !== 1) throw new Error('unsupported local settings version');
  const main = resolve(dirname(localFile), env.GOAL_MAIN_CHECKOUT ?? String(local.mainCheckout ?? initialMain));
  // Keeping credentials and account policy untracked is checked even for an explicitly selected file.
  const tracked = spawnSync('git', ['ls-files', '--error-unmatch', '--', localFile], { cwd: main, encoding: 'utf8' });
  if (tracked.status === 0) throw new Error('local settings must be untracked');
  const path = (value: unknown, fallback: string, variable?: string) => resolve(main, variable ?? (value === undefined ? fallback : text(value, 'path')));
  const stateDirectory = path(local.stateDirectory, '.temp/goal', env.GOAL_STATE_DIRECTORY);
  const integration: Record<string, unknown> = { ...defaults.integration, ...object(local.integration ?? {}, 'integration') };
  keys(integration, [...Object.keys(defaults.integration), 'managerDirectory', 'inboxDirectory'], 'integration');
  const codex: Record<string, unknown> = { ...defaults.codex, ...object(local.codex ?? {}, 'codex') };
  keys(codex, Object.keys(defaults.codex), 'codex');
  const compact = { ...defaults.codex.compactTokens, ...object(codex.compactTokens, 'compactTokens') };
  keys(compact, ['sol', 'luna'], 'compactTokens');
  const poolValues = local.pools ?? [];
  if (!Array.isArray(poolValues)) throw new Error('pools must be an array');
  const pools: Pool[] = poolValues.map((raw: unknown) => {
    const pool = object(raw, 'pool');
    keys(pool, ['name', 'cli', 'classes', 'configDirectory', 'command', 'allowanceKey', 'usageFile', 'policy'], 'pool');
    if (!['codex', 'grok', 'cursor', 'claude'].includes(String(pool.cli))) throw new Error('unsupported pool CLI');
    if (!Array.isArray(pool.classes) || !pool.classes.length || pool.classes.some(c => typeof c !== 'string' || !c)) throw new Error('pool classes required');
    const policy = object(pool.policy, 'pool policy');
    keys(policy, ['weight', 'reservePercent', 'allowUnknown', 'maxAgeMs', 'maxBurnPerHour'], 'pool policy');
    if (typeof policy.allowUnknown !== 'boolean') throw new Error('allowUnknown must be explicit');
    const reservePercent = positive(policy.reservePercent, 'reservePercent', true);
    if (reservePercent >= 100) throw new Error('reservePercent must be less than 100');
    const command = text(pool.command, 'pool command');
    return {
      name: text(pool.name, 'pool name'), cli: pool.cli as Pool['cli'], classes: pool.classes as string[],
      configDirectory: resolve(dirname(localFile), text(pool.configDirectory, 'configDirectory')),
      command: command.includes('/') ? resolve(dirname(localFile), command) : command,
      allowanceKey: text(pool.allowanceKey, 'allowanceKey'),
      ...(pool.usageFile === undefined ? {} : { usageFile: resolve(dirname(localFile), text(pool.usageFile, 'usageFile')) }),
      policy: { weight: positive(policy.weight, 'weight'), reservePercent, allowUnknown: policy.allowUnknown,
        maxAgeMs: positive(policy.maxAgeMs, 'maxAgeMs'),
        ...(policy.maxBurnPerHour === undefined ? {} : { maxBurnPerHour: positive(policy.maxBurnPerHour, 'maxBurnPerHour') }) },
    };
  });
  if (new Set(pools.map(p => p.name)).size !== pools.length) throw new Error('duplicate pool name');
  return {
    version: 1, mainCheckout: main, stateDirectory, worktreeRoot: path(local.worktreeRoot, '.temp/worktrees', env.GOAL_WORKTREE_ROOT),
    databasePath: path(local.databasePath, join(stateDirectory, 'goal.sqlite'), env.GOAL_DATABASE_PATH), localFile,
    mainBranch: text(local.mainBranch ?? defaults.mainBranch, 'mainBranch'), branchPrefix: text(local.branchPrefix ?? defaults.branchPrefix, 'branchPrefix'),
    routingFile: path(local.routingFile, join(import.meta.dir, '../routing.json')),
    riskAreasFile: path(local.riskAreasFile, join(import.meta.dir, '../risk-areas.json')), pools,
    terminationGraceMs: positive(local.terminationGraceMs ?? defaults.terminationGraceMs, 'terminationGraceMs', true),
    codex: { serviceTier: text(env.GOAL_CODEX_SERVICE_TIER ?? codex.serviceTier, 'serviceTier'),
      compactTokens: { sol: positive(compact.sol, 'compactTokens.sol'), luna: positive(compact.luna, 'compactTokens.luna') },
      solContextWindow: positive(codex.solContextWindow, 'solContextWindow'), toolOutputTokens: positive(codex.toolOutputTokens, 'toolOutputTokens') },
    integration: {
      gateConcurrency: positive(integration.gateConcurrency, 'gateConcurrency'), gateTimeoutMs: positive(integration.gateTimeoutMs, 'gateTimeoutMs'),
      managerDirectory: path(integration.managerDirectory, join(stateDirectory, 'managers')),
      inboxDirectory: path(integration.inboxDirectory, join(stateDirectory, 'inboxes')),
      tmuxCommand: text(integration.tmuxCommand, 'tmuxCommand'), tmuxSession: text(integration.tmuxSession, 'tmuxSession'),
      managerCompactTokens: positive(integration.managerCompactTokens, 'managerCompactTokens'),
    },
  };
}
