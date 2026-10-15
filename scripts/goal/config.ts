import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import schema from '../../.goalctl/settings.schema.json';
import { tryAcquireDirectoryLease } from '../qa/process/lease.ts';

export interface CodexAccount {
  engine: string; launcher?: string; home?: string; weight: number; pastAllowance?: string[];
}
export interface Settings {
  version: 1; accounts: CodexAccount[]; codexServiceTier: string; reviewEngine: string;
  codexCompactTokens: { sol: number; luna: number };
  confirmIntervalMinutes: number; gateLanes: number; qaSlots: number; regressLaneCount: number;
  unitGateScope: 'affected' | 'changed'; unitGateShards: number; telegramChat: string;
}
const defaults: Settings = { version: 1, accounts: [], codexServiceTier: 'fast', reviewEngine: 'sol',
  codexCompactTokens: { sol: 160_000, luna: 200_000 },
  confirmIntervalMinutes: 90, gateLanes: 2, qaSlots: 3, regressLaneCount: 2,
  unitGateScope: 'affected', unitGateShards: 4, telegramChat: '' };
type Schema = { type?: string; const?: unknown; enum?: unknown[]; minimum?: number; minLength?: number;
  pattern?: string; required?: string[]; anyOf?: Schema[]; properties?: Record<string, Schema>;
  additionalProperties?: boolean; items?: Schema; uniqueItems?: boolean };

/** Validate the vocabulary used by the checked-in schema, which is the single format definition. */
function validate(value: unknown, rule: Schema, field: string, file: string): void {
  const fail = (reason: string): never => { throw new Error(`${file}: ${field} ${reason}`); };
  if ('const' in rule && value !== rule.const) fail(`must be ${JSON.stringify(rule.const)}`);
  if (rule.enum && !rule.enum.includes(value)) fail(`must be one of ${rule.enum.join(', ')}`);
  if (rule.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail('must be an object');
    const object = value as Record<string, unknown>;
    for (const key of rule.required ?? []) if (!(key in object)) fail(`requires ${key}`);
    if (rule.anyOf && !rule.anyOf.some(option => (option.required ?? []).every(key => key in object))) fail('requires launcher or home');
    for (const [key, item] of Object.entries(object)) {
      const property = rule.properties?.[key];
      if (!property && rule.additionalProperties === false) throw new Error(`${file}: ${field}.${key} is unknown`);
      if (property) validate(item, property, `${field}.${key}`, file);
    }
  } else if (rule.type === 'array') {
    if (!Array.isArray(value)) fail('must be an array');
    const array = value as unknown[];
    if (rule.uniqueItems && new Set(array.map(item => JSON.stringify(item))).size !== array.length) fail('must contain unique values');
    array.forEach((item, index) => validate(item, rule.items!, `${field}[${index}]`, file));
  } else if (rule.type === 'string') {
    if (typeof value !== 'string') fail('must be a string');
    const string = value as string;
    if (rule.minLength !== undefined && string.trim().length < rule.minLength) fail('must not be empty');
    if (rule.pattern && !new RegExp(rule.pattern).test(string)) fail(`must match ${rule.pattern}`);
  } else if (rule.type === 'number' || rule.type === 'integer') {
    if (typeof value !== 'number' || !Number.isFinite(value) || (rule.type === 'integer' && !Number.isSafeInteger(value))) fail(`must be a finite ${rule.type}`);
    if (rule.minimum !== undefined && (value as number) < rule.minimum) fail(`must be at least ${rule.minimum}`);
  }
}

export interface SettingsOptions {
  cwd?: string; stateDirectory?: string; directory?: string; env?: NodeJS.ProcessEnv; report?: (message: string) => void;
}
const roots = new Map<string, { worktree: string; common: string }>();
function repositoryRoots(cwd: string): { worktree: string; common: string } {
  const cached = roots.get(cwd);
  if (cached) return cached;
  const git = spawnSync('git', ['rev-parse', '--show-toplevel', '--path-format=absolute', '--git-common-dir'], { cwd, encoding: 'utf8' });
  const [worktree, common] = git.status === 0 ? git.stdout.trim().split('\n') : [];
  const result = { worktree: worktree ?? cwd, common: common ? dirname(common) : cwd };
  roots.set(cwd, result);
  return result;
}
export function settingsDirectory(options: SettingsOptions = {}): string {
  if (options.directory) return resolve(options.directory);
  if (options.env?.GOAL_SETTINGS_DIRECTORY ?? process.env.GOAL_SETTINGS_DIRECTORY)
    return resolve((options.env?.GOAL_SETTINGS_DIRECTORY ?? process.env.GOAL_SETTINGS_DIRECTORY)!);
  const cwd = options.cwd ?? process.cwd();
  const roots = repositoryRoots(cwd);
  if (options.stateDirectory) {
    const repository = dirname(dirname(resolve(options.stateDirectory)));
    return join(repository === roots.common ? roots.worktree : repository, '.goalctl');
  }
  return join(roots.worktree, '.goalctl');
}
const legacy: Record<string, keyof Omit<Settings, 'version' | 'accounts'>> = {
  'codex-service-tier': 'codexServiceTier', 'review-engine': 'reviewEngine',
  'confirm-interval-minutes': 'confirmIntervalMinutes', 'gate-lane-count': 'gateLanes',
  'qa-slot-count': 'qaSlots', 'regress-lane-count': 'regressLaneCount',
  'unit-gate-scope': 'unitGateScope', 'unit-gate-shards': 'unitGateShards', 'telegram-chat': 'telegramChat',
};
function readLayer(file: string): Partial<Settings> {
  if (!existsSync(file)) return {};
  let value: unknown;
  try { value = JSON.parse(readFileSync(file, 'utf8')); }
  catch (error) { throw new Error(`${file}: settings ${String(error)}`); }
  validate(value, schema as Schema, 'settings', file);
  const { $schema: _schema, ...layer } = value as Partial<Settings> & { $schema?: string };
  const engines = new Set<string>();
  for (const [index, account] of (layer.accounts ?? []).entries()) {
    if (['claude', 'sonnet', 'haiku', 'fable', 'sol', 'luna', 'grok', 'cursor'].includes(account.engine) || engines.has(account.engine))
      throw new Error(`${file}: settings.accounts[${index}].engine must be unique and must not shadow a model engine`);
    engines.add(account.engine);
  }
  return layer;
}

export function loadSettings(options: SettingsOptions = {}): { settings: Settings; sources: Record<keyof Settings, string>; directory: string } {
  validate(defaults, schema as Schema, 'settings', 'built-in');
  const directory = settingsDirectory(options);
  const sharedFile = join(directory, 'settings.json'), userFile = join(directory, 'settings.user.json');
  const shared = readLayer(sharedFile);
  if (shared.accounts?.length) throw new Error(`${sharedFile}: settings.accounts belongs in settings.user.json`);
  let user = readLayer(userFile);
  const localState = join(dirname(directory), '.temp/goal-orchestration');
  const state = options.stateDirectory && dirname(dirname(resolve(options.stateDirectory))) === dirname(directory)
    ? options.stateDirectory : localState;
  const pending = Object.keys(legacy).some(name => existsSync(join(state, name)) && !existsSync(join(state, `${name}.migrated`)));
  if (pending) {
    mkdirSync(state, { recursive: true });
    const lock = join(state, 'settings-migration.lock');
    const deadline = Date.now() + 10_000;
    let lease = tryAcquireDirectoryLease(lock);
    while (lease === 'held') {
      if (Date.now() >= deadline) throw new Error(`${userFile}: settings migration is busy`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
      lease = tryAcquireDirectoryLease(lock);
    }
    try { user = migrateSettings(state, directory, userFile, options.report); }
    finally { lease.release(); }
  }
  const settings = { ...defaults, ...shared, ...user };
  const sources = Object.fromEntries(Object.keys(defaults).map(key => [key,
    key in user ? userFile : key in shared ? sharedFile : 'built-in'])) as Record<keyof Settings, string>;
  return { settings, sources, directory };
}

function migrateSettings(state: string, directory: string, userFile: string, report = console.error): Partial<Settings> {
  let user = readLayer(userFile);
  const migrated: string[] = [];
  for (const [name, key] of Object.entries(legacy)) {
    const file = join(state, name);
    if (!existsSync(file) || !lstatSync(file).isFile() || existsSync(`${file}.migrated`)) continue;
    const stored = readFileSync(file, 'utf8').trim();
    if (user[key] === undefined) {
      const value = typeof defaults[key] === 'number' ? Number(stored) : stored;
      validate(value, (schema.properties as Record<string, Schema>)[key]!, `settings.${key}`, file);
      user = { ...user, [key]: value };
    }
    migrated.push(file);
  }
  if (migrated.length) {
    mkdirSync(directory, { recursive: true });
    const temporary = join(state, `settings.${process.pid}.user.json`);
    writeFileSync(temporary, `${JSON.stringify({ version: 1, ...user }, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, userFile);
    for (const file of migrated) {
      renameSync(file, `${file}.migrated`);
      report(`Migrated ${file} to ${userFile}`);
    }
  }
  return user;
}

/** Relative account paths are anchored to the settings directory, never a worker's cwd. */
export function configuredAccounts(options: SettingsOptions = {}): CodexAccount[] {
  const { settings, directory } = loadSettings(options);
  const env = options.env ?? process.env;
  const accounts = settings.accounts.length ? settings.accounts : [{ engine: 'codex', launcher: 'codex',
    home: env.GOAL_CODEX_HOME ?? env.CODEX_HOME ?? join(homedir(), '.codex'), weight: 1 }];
  const path = (value: string) => value.startsWith('~/') ? join(homedir(), value.slice(2)) : resolve(directory, value);
  return accounts.map(account => ({ ...account, pastAllowance: account.pastAllowance ?? [],
    home: account.home ? path(account.home) : undefined,
    launcher: account.launcher && (isAbsolute(account.launcher) || account.launcher.includes('/')) ? path(account.launcher) : account.launcher ?? 'codex' }));
}
