// Goal worker-process control: exclusive claims, dispatch, waits, QA slots, scope and merge.
// The manager is the only caller of the state-changing commands; see docs/goals/README.md.
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync,
  rmSync, statSync,
  writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';

export type State = 'running' | 'exited' | 'conflict' | 'merged' | 'stopped' | 'verified' | 'cancelled';
export type Engine = 'claude' | 'codex' | 'luna' | 'astra' | 'grok' | 'cursor';
export interface Brief {
  id: string; title: string; effort: string; engine?: Engine; cases: string[]; paths: string[];
  migrations: string[]; shared: string[]; depends: string[];
}
export interface Attempt {
  n: number; effort: string; engine?: Engine; pid: number; session: string; output: string; lastMessage?: string;
  startedAt: string; endedAt?: string;
}
export interface Task extends Brief {
  brief: string; worktree: string; branch: string; base: string; state: State; attempts: Attempt[];
  mergedCommit?: string; closedAt?: string;
}
export interface Ledger { startedAt?: string; manager?: string; tasks: Record<string, Task> }
export interface UsageWindow { used_percentage?: number; resets_at?: string | number }
export interface UsageSnapshot {
  at?: number; rate_limits?: { five_hour?: UsageWindow | null; seven_day?: UsageWindow | null } | null;
}
export interface UsageSample { at: number; used: number; resets: number; week?: number; weekResets?: number }
export type UsageLevel = 'unknown' | 'normal' | 'restricted' | 'critical';
export interface UsageReport {
  level: UsageLevel; used?: number; ageSeconds?: number; resetInMinutes?: number;
  ratePerHour?: number; projected?: number; weekUsed?: number; weekProjected?: number;
  weekResetInHours?: number; weekAdvice?: string; reason?: string;
}
export interface AccountUsage {
  account: string; home: string; engines: Engine[]; used?: number; windowMinutes?: number;
  resetInHours?: number; plan?: string; reached?: boolean; ageSeconds?: number;
}

// Worker engines and the efforts each CLI and model accepts. Which engine and effort a task gets is
// the manager's decision from the need and the remaining usage (docs/goals/manager.md), not a rule here.
export const MODEL = 'claude-opus-5-5';
export const CODEX_MODEL = 'gpt-6-sol';
export const LUNA_MODEL = 'gpt-6-luna';
export const ASTRA_MODEL = 'gpt-6-astra';
export const GROK_MODEL = 'grok-4.7';
const ENGINE_EFFORTS: Record<Engine, string[]> = {
  claude: ['low', 'medium', 'high', 'xhigh', 'max'],
  codex: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
  luna: ['low', 'medium', 'high', 'xhigh', 'max'],
  astra: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
  grok: ['low', 'medium', 'high'],
  // Cursor Agent selects Grok 4.7 through per-effort model IDs (grok-4.7-<effort>).
  cursor: ['low', 'medium', 'high', 'xhigh'],
};
const ENGINES = Object.keys(ENGINE_EFFORTS) as Engine[];
export const DEFAULT_ENGINE: Engine = (process.env.GOAL_ENGINE as Engine | undefined) ?? 'claude';
// GPT-6 Sol and Luna use the default Codex account; GPT-6 Astra has its own account in a separate
// CODEX_HOME (the `codex-1` wrapper sets the same directory).
export const CODEX_HOME = process.env.GOAL_CODEX_HOME ?? join(homedir(), '.codex');
export const ASTRA_HOME = process.env.GOAL_ASTRA_CODEX_HOME ?? join(homedir(), '.codex-1');
const engineOf = (item: { engine?: Engine }): Engine => item.engine ?? 'claude';
const MODELS: Record<Engine, string> = { claude: MODEL, codex: CODEX_MODEL, luna: LUNA_MODEL, astra: ASTRA_MODEL,
  grok: GROK_MODEL, cursor: `${GROK_MODEL} (Cursor)` };
const modelOf = (engine: Engine): string => MODELS[engine];
const effortsOf = (engine: Engine): string[] => ENGINE_EFFORTS[engine] ?? [];
const isCodex = (engine: Engine): boolean => engine === 'codex' || engine === 'luna' || engine === 'astra';
// Process name that /proc/<pid>/cmdline carries for a live worker of each engine.
const programOf = (engine: Engine): string => isCodex(engine) ? 'codex' : engine === 'cursor' ? 'cursor-agent' : engine;
const engineEnv = (engine: Engine): Record<string, string> =>
  engine === 'astra' ? { CODEX_HOME: ASTRA_HOME } : isCodex(engine) ? { CODEX_HOME } : {};
const HOLDING: State[] = ['running', 'exited', 'conflict', 'merged', 'stopped'];

export function parseBrief(text: string): Brief {
  const block = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(text);
  if (!block) throw new Error('Brief needs a leading --- frontmatter block');
  const fields: Record<string, string> = {};
  for (const line of block[1]!.split(/\r?\n/)) {
    const clean = line.replace(/\s+#.*$/, '').trim();
    if (!clean) continue;
    const at = clean.indexOf(':');
    if (at < 1) throw new Error(`Bad frontmatter line: ${line}`);
    fields[clean.slice(0, at).trim()] = clean.slice(at + 1).trim();
  }
  const list = (key: string): string[] => {
    const value = fields[key];
    if (!value) return [];
    if (!value.startsWith('[') || !value.endsWith(']')) throw new Error(`${key} must be a [a, b] list`);
    return value.slice(1, -1).split(',').map(item => item.trim()).filter(Boolean);
  };
  return {
    id: fields.id ?? '', title: fields.title ?? '', effort: fields.effort ?? 'medium',
    engine: (fields.engine as Engine | undefined) ?? DEFAULT_ENGINE,
    cases: list('cases'), paths: list('paths'), migrations: list('migrations'), shared: list('shared'),
    depends: list('depends'),
  };
}

export function validateBrief(brief: Brief): string[] {
  const errors: string[] = [];
  if (!/^G-\d{3,}$/.test(brief.id)) errors.push(`id must look like G-038: ${brief.id || '(missing)'}`);
  if (!brief.title) errors.push('title is required');
  const engine = brief.engine ?? DEFAULT_ENGINE;
  if (!ENGINES.includes(engine)) errors.push(`engine must be one of ${ENGINES.join(', ')}: ${engine}`);
  else if (!effortsOf(engine).includes(brief.effort)) {
    errors.push(`${engine} effort must be one of ${effortsOf(engine).join(', ')}: ${brief.effort}`);
  }
  for (const id of brief.cases) if (!/^[A-Z]+\d{2}$/.test(id)) errors.push(`bad case ID: ${id}`);
  for (const path of brief.paths) {
    if (isAbsolute(path) || path.split('/').includes('..') || path.startsWith('.temp/')) {
      errors.push(`path claim must be repository-relative outside .temp: ${path}`);
    }
  }
  for (const range of brief.migrations) if (!parseRange(range)) errors.push(`bad migration range: ${range}`);
  for (const id of brief.depends) if (!/^G-\d{3,}$/.test(id)) errors.push(`bad dependency: ${id}`);
  return errors;
}

function parseRange(range: string): { dir: string; start: number; end: number } | undefined {
  const match = /^([a-z0-9/_-]+):(\d{3})-(\d{3})$/.exec(range);
  if (!match || Number(match[2]) > Number(match[3])) return undefined;
  return { dir: match[1]!, start: Number(match[2]), end: Number(match[3]) };
}

export function rangesOverlap(a: string, b: string): boolean {
  const left = parseRange(a);
  const right = parseRange(b);
  return !!left && !!right && left.dir === right.dir && left.start <= right.end && right.start <= left.end;
}

function literalPrefix(pattern: string): string {
  const at = pattern.search(/[*?[{]/);
  return at < 0 ? pattern : pattern.slice(0, at);
}

// Conservative: any shared literal prefix counts as overlap, so a false positive only delays dispatch.
export function pathsOverlap(a: string, b: string): boolean {
  const left = literalPrefix(a);
  const right = literalPrefix(b);
  return left.startsWith(right) || right.startsWith(left);
}

export function claimConflicts(brief: Brief, tasks: Task[]): string[] {
  const conflicts: string[] = [];
  for (const task of tasks) {
    if (task.id === brief.id || !HOLDING.includes(task.state)) continue;
    for (const id of brief.cases) if (task.cases.includes(id)) conflicts.push(`case ${id} is held by ${task.id}`);
    for (const path of brief.paths) {
      for (const held of task.paths) {
        if (pathsOverlap(path, held)) conflicts.push(`path ${path} overlaps ${task.id} ${held}`);
      }
    }
    for (const range of brief.migrations) {
      for (const held of task.migrations) {
        if (rangesOverlap(range, held)) conflicts.push(`migrations ${range} overlap ${task.id} ${held}`);
      }
    }
    for (const token of brief.shared) {
      if (task.shared.includes(token)) conflicts.push(`shared ${token} is held by ${task.id}`);
    }
  }
  return conflicts;
}

export function outOfScope(files: string[], patterns: string[]): string[] {
  const globs = patterns.map(pattern => new Bun.Glob(pattern));
  return files.filter(file => !globs.some(glob => glob.match(file)));
}

const FIVE_HOURS = 5 * 3600;
const SEVEN_DAYS = 7 * 24 * 3600;
// The 5h window keeps the manager alive: new Claude work stops while the burn rate would end the
// window at PROJECTED_LIMIT or more, and at CRITICAL_USED only merge and test continue.
export const PROJECTED_LIMIT = 95;
export const CRITICAL_USED = 95;
// The 7d window is a budget to spend, not one to save: below WEEK_TARGET at reset the report advises
// widening Claude work. New Claude work stops only when the week would run out before its reset or
// WEEK_CRITICAL_USED is reached, so the rest still carries the manager to the reset.
export const WEEK_TARGET = 95;
export const WEEK_PROJECTED_LIMIT = 100;
export const WEEK_CRITICAL_USED = 97;

function resetSeconds(value: string | number | undefined): number | undefined {
  if (typeof value === 'number') return value > 1e12 ? value / 1000 : value;
  if (typeof value === 'string') { const ms = Date.parse(value); return Number.isNaN(ms) ? undefined : ms / 1000; }
  return undefined;
}

// Percent per second: the recent slope of the current window when goalctl has at least ten
// minutes of samples from the last half hour (it tracks the present worker width), otherwise
// the window average, counted over at least 15 minutes so an early spike is not extrapolated.
export function burnRate(used: number, now: number, resets: number, windowSeconds: number,
  history: UsageSample[] = []): number {
  const recent = history.filter(s => s.resets === resets && s.at >= now - 1800 && s.at <= now - 600);
  if (recent.length) {
    const first = recent.reduce((a, b) => (a.at <= b.at ? a : b));
    return Math.max(0, used - first.used) / (now - first.at);
  }
  return used / Math.max(900, now - (resets - windowSeconds));
}

// The same for the 7d window: the slope over goalctl's samples from the last six hours once one is at
// least an hour old, otherwise the window average over at least six hours.
export function weekBurnRate(used: number, now: number, resets: number, history: UsageSample[] = []): number {
  const recent = history.filter(s => s.weekResets === resets && typeof s.week === 'number'
    && s.at >= now - 6 * 3600 && s.at <= now - 3600);
  if (recent.length) {
    const first = recent.reduce((a, b) => (a.at <= b.at ? a : b));
    return Math.max(0, used - first.week!) / (now - first.at);
  }
  return used / Math.max(6 * 3600, now - (resets - SEVEN_DAYS));
}

export function usageLevel(snapshot: UsageSnapshot | undefined, nowMs: number,
  history: UsageSample[] = []): UsageReport {
  const five = snapshot?.rate_limits?.five_hour;
  const used = five?.used_percentage;
  if (!snapshot?.at || typeof used !== 'number') return { level: 'unknown' };
  const now = nowMs / 1000;
  const ageSeconds = Math.round(now - snapshot.at);
  if (ageSeconds > 1800) return { level: 'unknown', used, ageSeconds };
  const report: UsageReport = { level: 'normal', used, ageSeconds };
  const week = snapshot.rate_limits?.seven_day;
  const weekResets = resetSeconds(week?.resets_at);
  if (typeof week?.used_percentage === 'number' && weekResets !== undefined && weekResets > now) {
    report.weekUsed = week.used_percentage;
    report.weekResetInHours = Math.round((weekResets - now) / 360) / 10;
    report.weekProjected = Math.round(week.used_percentage
      + weekBurnRate(week.used_percentage, now, weekResets, history) * (weekResets - now));
    report.weekAdvice = report.weekProjected < WEEK_TARGET
      ? `widen: the week lands at ${report.weekProjected}%; add Claude width or effort`
      : 'on target';
  }
  if (used >= CRITICAL_USED) return { ...report, level: 'critical', reason: `5h used >= ${CRITICAL_USED}%` };
  if ((report.weekUsed ?? 0) >= WEEK_CRITICAL_USED) {
    return { ...report, level: 'critical', reason: `7d used >= ${WEEK_CRITICAL_USED}%; the rest carries the manager` };
  }
  const resets = resetSeconds(five?.resets_at);
  // Without a reset time the window cannot be paced; fall back to the fixed 80% threshold.
  if (resets === undefined || resets <= now) {
    return { ...report, level: used >= 80 ? 'restricted' : 'normal', reason: 'no reset time; fixed 80%' };
  }
  const rate = burnRate(used, now, resets, FIVE_HOURS, history);
  const projected = Math.round(used + rate * (resets - now));
  Object.assign(report, { resetInMinutes: Math.round((resets - now) / 60), ratePerHour: Math.round(rate * 36000) / 10,
    projected });
  if (projected >= PROJECTED_LIMIT) {
    return { ...report, level: 'restricted', reason: `5h projected ${projected}% at reset` };
  }
  if ((report.weekProjected ?? 0) >= WEEK_PROJECTED_LIMIT) {
    return { ...report, level: 'restricted', reason: `7d projected ${report.weekProjected}% before its reset` };
  }
  return report;
}

// Codex CLIs record the account's rate limits with each turn in their session rollouts, so the newest
// rollout line that carries them is the account's current usage.
export function parseCodexUsage(text: string, nowMs: number): Partial<AccountUsage> {
  const now = nowMs / 1000;
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i]!.includes('"rate_limits"')) continue;
    try {
      type Window = { used_percent?: number; window_minutes?: number; resets_at?: number };
      const event = JSON.parse(lines[i]!) as { timestamp?: string; payload?: { rate_limits?: {
        primary?: Window | null; secondary?: Window | null; plan_type?: string; rate_limit_reached_type?: string | null } } };
      const limits = event.payload?.rate_limits;
      const windows = [limits?.primary, limits?.secondary].filter((w): w is Window => typeof w?.used_percent === 'number');
      if (!limits || !windows.length) continue;
      const at = event.timestamp ? Date.parse(event.timestamp) / 1000 : undefined;
      const ageSeconds = at === undefined ? undefined : Math.round(now - at);
      // A window whose reset has passed starts empty again.
      const live = windows.filter(w => (w.resets_at ?? Infinity) > now);
      if (!live.length) return { used: 0, reached: false, plan: limits.plan_type, ageSeconds };
      const fullest = live.reduce((a, b) => (b.used_percent! > a.used_percent! ? b : a));
      return { used: fullest.used_percent, windowMinutes: fullest.window_minutes, plan: limits.plan_type, ageSeconds,
        resetInHours: fullest.resets_at === undefined ? undefined : Math.round((fullest.resets_at - now) / 360) / 10,
        reached: fullest.used_percent! >= 100 || !!limits.rate_limit_reached_type };
    } catch { /* partial line */ }
  }
  return {};
}

// Workers run in bypass permission mode, as the manager does, and accept no inbound session
// messages; the manager changes a worker's instructions only by stopping or resuming it.
export function launchCommand(options: { id: string; effort: string; session: string; prompt: string;
  resume: boolean; engine?: Engine; worktree?: string; lastMessage?: string }): [string, string[]] {
  const { id, effort, session, prompt, resume } = options;
  const engine = options.engine ?? 'claude';
  if (engine === 'grok') {
    return ['grok', ['-p', prompt, '-m', GROK_MODEL, '--reasoning-effort', effort,
      '--permission-mode', 'bypassPermissions', '--no-subagents', '--output-format', 'json',
      '--cwd', options.worktree ?? '.', ...(resume ? ['-r', session] : [])]];
  }
  if (engine === 'cursor') {
    return ['cursor-agent', ['-p', prompt, '--model', `${GROK_MODEL}-${effort}`, '--force', '--trust',
      '--sandbox', 'disabled', '--output-format', 'json', '--workspace', options.worktree ?? '.',
      ...(resume ? ['--resume', session] : [])]];
  }
  if (isCodex(engine)) {
    const common = ['-m', MODELS[engine], '-c', `model_reasoning_effort=${effort}`,
      '--dangerously-bypass-approvals-and-sandbox', '--json', '-o', options.lastMessage ?? '/dev/null'];
    return ['codex', resume ? ['exec', 'resume', session, ...common, prompt]
      : ['exec', ...common, '-C', options.worktree ?? '.', prompt]];
  }
  return ['claude', ['-p', prompt, '--model', MODEL, '--effort', effort, '--dangerously-skip-permissions',
    ...(resume ? ['--resume', session] : ['--session-id', session]), '-n', id.toLowerCase(),
    '--output-format', 'json']];
}

function workerPrompt(task: Task, manager: string, engine: Engine = engineOf(task), effort = task.effort): string {
  return [
    `You are REZICS Goal worker ${task.id} (${modelOf(engine)}/${effort}). Work only inside ${task.worktree}.`,
    `Edit, create and delete files only under ${task.worktree} (and /tmp). The main checkout ${root} and every`
      + ' other worktree are read-only for you, even when a brief or handoff cites an absolute path there;'
      + ` translate such paths to ${task.worktree}.`,
    'goalctl commands you run (test, owner, slot) may write their own bookkeeping under the main checkout\'s'
      + ' .temp/goal-orchestration; that is allowed. Use `bun scripts/goal/goalctl.ts test` for QA.',
    'Read docs/goals/worker.md there, then your brief at .temp/goal/brief.md, and follow both.',
    `The manager session is "${manager}". End with the handoff that the worker protocol specifies.`,
  ].join('\n');
}

function git(cwd: string, args: string[], allowFail = false): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0 && !allowFail) throw new Error(`git ${args.join(' ')} failed:\n${result.stderr}`);
  return result.status === 0 ? result.stdout.trim() : '';
}

const root = dirname(git(process.cwd(), ['rev-parse', '--path-format=absolute', '--git-common-dir']));
const stateDir = join(root, '.temp', 'goal-orchestration');
const ledgerPath = join(stateDir, 'ledger.json');
const usagePath = process.env.GOAL_USAGE_FILE ?? join(homedir(), '.claude', 'usage', 'latest.json');
const usageHistoryPath = join(stateDir, 'usage-history.json');

function readLedger(): Ledger {
  return existsSync(ledgerPath) ? JSON.parse(readFileSync(ledgerPath, 'utf8')) as Ledger : { tasks: {} };
}

function writeLedger(ledger: Ledger): void {
  writeFileSync(`${ledgerPath}.tmp`, `${JSON.stringify(ledger, null, 2)}\n`);
  renameSync(`${ledgerPath}.tmp`, ledgerPath);
}

function pidAlive(pid: number, program?: string): boolean {
  if (!pid) return false;
  try { process.kill(pid, 0); } catch { return false; }
  if (!program) return true;
  try { return readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes(program); } catch { return false; }
}

async function acquireDir(path: string, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let announced = false;
  for (;;) {
    try {
      mkdirSync(path);
      writeFileSync(join(path, 'pid'), String(process.pid));
      return;
    } catch {
      const owner = existsSync(join(path, 'pid')) ? Number(readFileSync(join(path, 'pid'), 'utf8')) : 0;
      const young = existsSync(path) && Date.now() - statSync(path).mtimeMs < 10_000;
      if (!pidAlive(owner) && !young) { rmSync(path, { recursive: true, force: true }); continue; }
      if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
      if (!announced && timeoutMs > 60_000) { console.error(`waiting for ${label}`); announced = true; }
      await Bun.sleep(label === 'ledger lock' ? 100 : 3000);
    }
  }
}

async function withLedger<T>(change: (ledger: Ledger) => T | Promise<T>): Promise<T> {
  mkdirSync(stateDir, { recursive: true });
  const lock = join(stateDir, 'ledger.lock');
  await acquireDir(lock, 120_000, 'ledger lock');
  try {
    const ledger = readLedger();
    const result = await change(ledger);
    writeLedger(ledger);
    return result;
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

function readUsage(): UsageSnapshot | undefined {
  try { return JSON.parse(readFileSync(usagePath, 'utf8')) as UsageSnapshot; } catch { return undefined; }
}

// The status line keeps only the latest snapshot, so goalctl records its own six-hour history
// to measure the recent 5h and 7d burn rates.
function currentUsage(): UsageReport {
  const snapshot = readUsage();
  let history: UsageSample[] = [];
  try { history = JSON.parse(readFileSync(usageHistoryPath, 'utf8')) as UsageSample[]; } catch { /* first sample */ }
  const five = snapshot?.rate_limits?.five_hour;
  const week = snapshot?.rate_limits?.seven_day;
  const resets = resetSeconds(five?.resets_at);
  if (snapshot?.at && typeof five?.used_percentage === 'number' && resets !== undefined
    && !history.some(s => s.at === snapshot.at)) {
    history = [...history.filter(s => s.at >= snapshot.at! - 6 * 3600),
      { at: snapshot.at, used: five.used_percentage, resets, week: week?.used_percentage,
        weekResets: resetSeconds(week?.resets_at) }];
    try { mkdirSync(stateDir, { recursive: true }); writeFileSync(usageHistoryPath, JSON.stringify(history)); }
    catch { /* history is an optimisation */ }
  }
  return usageLevel(snapshot, Date.now(), history);
}

// Rollouts live under sessions/YYYY/MM/DD/; a resumed session keeps appending to its first day's file,
// so look at the newest few days and take the most recently written rollout.
function newestRollout(home: string): string | undefined {
  const children = (dir: string): string[] => {
    try { return readdirSync(dir).sort().reverse().map(name => join(dir, name)); } catch { return []; }
  };
  const days = children(join(home, 'sessions')).flatMap(children).flatMap(children).slice(0, 3);
  const files = days.flatMap(day => children(day).filter(file => file.endsWith('.jsonl')));
  return files.map(file => ({ file, at: statSync(file).mtimeMs })).sort((a, b) => b.at - a.at)[0]?.file;
}

function tail(file: string, bytes: number): string {
  const fd = openSync(file, 'r');
  try {
    const size = statSync(file).size;
    const buffer = Buffer.alloc(Math.min(bytes, size));
    readSync(fd, buffer, 0, buffer.length, size - buffer.length);
    return buffer.toString('utf8');
  } finally {
    closeSync(fd);
  }
}

function codexAccounts(): AccountUsage[] {
  const accounts: AccountUsage[] = [
    { account: 'codex', home: CODEX_HOME, engines: ['codex', 'luna'] },
    { account: 'codex-1', home: ASTRA_HOME, engines: ['astra'] },
  ];
  return accounts.map(account => {
    const file = newestRollout(account.home);
    return file ? { ...account, ...parseCodexUsage(tail(file, 512 * 1024), Date.now()) } : account;
  });
}

function describeAccount(account: AccountUsage): string {
  return `${account.account} (${account.engines.join('/')}): `
    + (account.used === undefined ? 'no usage recorded yet'
      : `${account.used}% of ${account.windowMinutes ? `${Math.round(account.windowMinutes / 1440)}d` : 'window'}`
        + `${account.reached ? ' EXHAUSTED' : ''}`
        + (account.resetInHours !== undefined ? `, resets in ${account.resetInHours}h` : '')
        + (account.ageSeconds !== undefined ? ` (${Math.round(account.ageSeconds / 60)}m old)` : ''));
}

function taskOf(ledger: Ledger, id: string): Task {
  const task = ledger.tasks[id.toUpperCase()];
  if (!task) throw new Error(`Unknown task ${id}`);
  return task;
}

function lastAttempt(task: Task): Attempt {
  const attempt = task.attempts.at(-1);
  if (!attempt) throw new Error(`${task.id} has no attempt`);
  return attempt;
}

function running(task: Task): boolean {
  return task.state === 'running' && pidAlive(lastAttempt(task).pid, programOf(engineOf(lastAttempt(task))));
}

function launch(task: Task, effort: string, session: string, prompt: string, resume: boolean,
  manager: string, engine: Engine = engineOf(task)): Attempt {
  const n = task.attempts.length + 1;
  const runDir = join(stateDir, 'runs', task.id);
  mkdirSync(runDir, { recursive: true });
  const output = join(runDir, `attempt-${n}.json`);
  const lastMessage = isCodex(engine) ? join(runDir, `attempt-${n}.last.md`) : undefined;
  const [program, args] = launchCommand({ id: task.id, effort, session, prompt, resume, engine,
    worktree: task.worktree, lastMessage });
  const child = spawn(program, args, {
    cwd: task.worktree, detached: true,
    stdio: ['ignore', openSync(output, 'w'), openSync(join(runDir, `attempt-${n}.err`), 'w')],
    env: { ...process.env, ...engineEnv(engine), GOAL_TASK_ID: task.id, GOAL_MANAGER: manager },
  });
  child.unref();
  if (!child.pid) throw new Error(`Could not start ${program}`);
  return { n, effort, engine, pid: child.pid, session, output, lastMessage, startedAt: new Date().toISOString() };
}

function changedFiles(task: Task): { committed: string[]; dirty: string[]; ahead: number } {
  if (!existsSync(task.worktree)) return { committed: [], dirty: [], ahead: 0 };
  const committed = git(root, ['diff', '--name-only', `main...${task.branch}`], true).split('\n').filter(Boolean);
  const dirty = git(task.worktree, ['status', '--porcelain', '--untracked-files=all'], true).split('\n')
    .filter(Boolean).map(line => line.slice(3).replace(/^.* -> /, ''));
  const ahead = Number(git(root, ['rev-list', '--count', `main..${task.branch}`], true) || 0);
  return { committed, dirty, ahead };
}

function describe(task: Task): string {
  const { committed, dirty, ahead } = changedFiles(task);
  const violations = outOfScope([...new Set([...committed, ...dirty])], task.paths);
  return [
    `${task.branch}: ${ahead} commit(s) ahead of main; worktree ${dirty.length ? `DIRTY (${dirty.length} files)` : 'clean'}`,
    violations.length ? `scope: VIOLATIONS\n  ${violations.join('\n  ')}` : 'scope: ok',
  ].join('\n');
}

function readCodexResult(attempt: Attempt): { text: string; session?: string; error: boolean; tokens?: string } {
  const lines = existsSync(attempt.output) ? readFileSync(attempt.output, 'utf8').split('\n') : [];
  let session: string | undefined;
  let input = 0, cached = 0, output = 0;
  for (const line of lines) {
    if (!line.startsWith('{')) continue;
    try {
      const event = JSON.parse(line) as { type?: string; thread_id?: string;
        usage?: { input_tokens?: number; cached_input_tokens?: number; output_tokens?: number } };
      if (event.type === 'thread.started') session ??= event.thread_id;
      if (event.type === 'turn.completed') {
        input += event.usage?.input_tokens ?? 0; cached += event.usage?.cached_input_tokens ?? 0;
        output += event.usage?.output_tokens ?? 0;
      }
    } catch { /* partial line */ }
  }
  const text = attempt.lastMessage && existsSync(attempt.lastMessage) ? readFileSync(attempt.lastMessage, 'utf8') : '';
  const errPath = attempt.output.replace(/\.json$/, '.err');
  const tail = !text && existsSync(errPath) ? readFileSync(errPath, 'utf8').slice(-3000) : '';
  return { text: text || `(no final message)\n${tail}`, session, error: !text,
    tokens: `input ${input} (cached ${cached}), output ${output}` };
}

function readResult(attempt: Attempt): { text: string; session?: string; error: boolean; cost?: number; tokens?: string } {
  const engine = engineOf(attempt);
  if (isCodex(engine)) return readCodexResult(attempt);
  try {
    const data = JSON.parse(readFileSync(attempt.output, 'utf8')) as Record<string, unknown>;
    const text = String(data.result ?? data.text ?? '');
    const session = (data.session_id ?? data.sessionId) as string | undefined;
    return { text, session, error: data.is_error === true || !text, cost: data.total_cost_usd as number | undefined };
  } catch {
    const errPath = attempt.output.replace(/\.json$/, '.err');
    const tail = existsSync(errPath) ? readFileSync(errPath, 'utf8').slice(-3000) : '';
    return { text: `(no parsable output)\n${tail}`, error: true };
  }
}

function elapsed(fromIso: string): string {
  const minutes = Math.round((Date.now() - Date.parse(fromIso)) / 60_000);
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, '0')}m`;
}

async function dispatch(briefPath: string, flags: Set<string>): Promise<void> {
  const absolute = resolve(briefPath);
  const brief = parseBrief(readFileSync(absolute, 'utf8'));
  const errors = validateBrief(brief);
  if (errors.length) throw new Error(`Invalid brief ${briefPath}:\n  ${errors.join('\n  ')}`);
  await withLedger(ledger => {
    if (ledger.tasks[brief.id]) throw new Error(`${brief.id} already exists (${ledger.tasks[brief.id]!.state}); use resume`);
    const tasks = Object.values(ledger.tasks);
    const conflicts = claimConflicts(brief, tasks);
    if (conflicts.length) throw new Error(`Claim conflict for ${brief.id}:\n  ${conflicts.join('\n  ')}`);
    for (const id of brief.depends) {
      const dependency = ledger.tasks[id];
      if (dependency && !['merged', 'verified'].includes(dependency.state)) {
        throw new Error(`${brief.id} depends on ${id}, which is ${dependency.state}`);
      }
    }
    const live = tasks.filter(running).length;
    const limit = Number(process.env.GOAL_MAX_WORKERS ?? 25);
    if (live >= limit) throw new Error(`Concurrency limit reached: ${live}/${limit} live workers`);
    const usage = currentUsage();
    const engine = brief.engine ?? DEFAULT_ENGINE;
    const account = codexAccounts().find(candidate => candidate.engines.includes(engine));
    if (!flags.has('--force-usage')) {
      if (engine === 'claude' && ['restricted', 'critical'].includes(usage.level)) {
        throw new Error(`Claude usage is ${usage.level} (${usage.reason}); let running workers finish, `
          + 'use another engine or pass --force-usage');
      }
      if (account?.reached) {
        throw new Error(`${describeAccount(account)}; use another engine or pass --force-usage`);
      }
    }
    if (flags.has('--dry-run')) {
      console.log(`${brief.id}: claims ok; ${live}/${limit} live; ${account ? describeAccount(account) : `Claude usage ${usage.level}`}`);
      return;
    }
    const worktree = join(root, '.temp', 'worktrees', brief.id.toLowerCase());
    const branch = `goal/${brief.id.toLowerCase()}`;
    if (existsSync(worktree)) throw new Error(`${worktree} already exists; remove it or use another ID`);
    git(root, ['worktree', 'add', '-q', worktree, '-b', branch, 'main']);
    const install = spawnSync('corepack', ['yarn', 'install', '--immutable'], { cwd: worktree, encoding: 'utf8' });
    mkdirSync(join(stateDir, 'runs', brief.id), { recursive: true });
    writeFileSync(join(stateDir, 'runs', brief.id, 'install.log'), `${install.stdout}\n${install.stderr}`);
    if (install.status !== 0) throw new Error(`yarn install failed in ${worktree}; see runs/${brief.id}/install.log`);
    mkdirSync(join(worktree, '.temp', 'goal'), { recursive: true });
    copyFileSync(absolute, join(worktree, '.temp', 'goal', 'brief.md'));
    const task: Task = { ...brief, brief: absolute, worktree, branch, base: git(root, ['rev-parse', 'main']),
      state: 'running', attempts: [] };
    const manager = ledger.manager ?? process.env.GOAL_MANAGER ?? 'goal-manager';
    task.attempts.push(launch(task, brief.effort, engine === 'claude' ? randomUUID() : '',
      workerPrompt(task, manager, engine), false, manager, engine));
    ledger.tasks[brief.id] = task;
    ledger.startedAt ??= new Date().toISOString();
    console.log(`${brief.id} started: ${modelOf(engine)}/${brief.effort} pid ${lastAttempt(task).pid} in ${worktree}`);
    console.log(`Next: run \`bun scripts/goal/goalctl.ts wait ${brief.id}\` in the background.`);
  });
}

async function waitFor(id: string): Promise<void> {
  // A killed waiter must never record the worker as ended (an expired monitor once marked live workers exited).
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) process.on(signal, () => process.exit(143));
  const initial = taskOf(readLedger(), id);
  const attempt = lastAttempt(initial);
  const alive = () => pidAlive(attempt.pid, programOf(engineOf(attempt)));
  while (alive() || (await Bun.sleep(3000), alive())) await Bun.sleep(5000);
  const result = readResult(attempt);
  const task = await withLedger(ledger => {
    const current = taskOf(ledger, id);
    const last = lastAttempt(current);
    if (last.n === attempt.n) {
      last.endedAt ??= new Date().toISOString();
      if (result.session && !last.session) last.session = result.session;
      if (current.state === 'running') current.state = 'exited';
    }
    return current;
  });
  console.log(`${task.id} attempt ${attempt.n} ended after ${elapsed(attempt.startedAt)}`
    + `${result.error ? ' WITH ERROR' : ''}${result.cost !== undefined ? `; cost $${result.cost.toFixed(2)}` : ''}`
    + `${result.tokens ? `; ${modelOf(engineOf(attempt))} tokens ${result.tokens}` : ''}`);
  console.log(describe(task));
  console.log(`--- handoff ---\n${result.text.length > 8000 ? `${result.text.slice(0, 8000)}\n[truncated]` : result.text}`);
}

async function resumeTask(id: string, args: string[]): Promise<void> {
  let message = '';
  let effort: string | undefined;
  let engine: Engine | undefined;
  let fresh = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-m') message = args[++i] ?? '';
    else if (args[i] === '--file') message = readFileSync(args[++i] ?? '', 'utf8');
    else if (args[i] === '--effort') effort = args[++i];
    else if (args[i] === '--engine') engine = args[++i] as Engine;
    else if (args[i] === '--fresh') fresh = true;
    else throw new Error(`Unsupported resume option: ${args[i]}`);
  }
  if (!message.trim()) throw new Error('resume needs -m <message> or --file <path>');
  await withLedger(ledger => {
    const task = taskOf(ledger, id);
    if (running(task)) throw new Error(`${task.id} is still running; stop it first or message it`);
    if (['verified', 'cancelled'].includes(task.state)) throw new Error(`${task.id} is closed`);
    const previous = lastAttempt(task);
    const nextEngine = engine ?? engineOf(previous);
    const nextEffort = effort ?? previous.effort;
    if (!effortsOf(nextEngine).includes(nextEffort)) {
      throw new Error(`${nextEngine} effort must be one of ${effortsOf(nextEngine).join(', ')}`);
    }
    const manager = ledger.manager ?? process.env.GOAL_MANAGER ?? 'goal-manager';
    // A session continues only on its own engine: switching back resumes that engine's latest session,
    // and an engine without one starts fresh on the same worktree.
    const sameEngine = [...task.attempts].reverse().find(attempt => engineOf(attempt) === nextEngine
      && (attempt.session || readResult(attempt).session));
    const previousSession = sameEngine ? sameEngine.session || readResult(sameEngine).session || '' : '';
    const continuing = !fresh && !!previousSession;
    const session = continuing ? previousSession : nextEngine === 'claude' ? randomUUID() : '';
    const prompt = continuing ? message
      : `${workerPrompt(task, manager, nextEngine, nextEffort)}\n\nManager note:\n${message}`;
    task.attempts.push(launch(task, nextEffort, session, prompt, continuing, manager, nextEngine));
    task.engine = nextEngine;
    task.state = 'running';
    console.log(`${task.id} attempt ${task.attempts.length}: ${modelOf(nextEngine)}/${nextEffort}`
      + ` ${continuing ? 'resumed' : 'fresh session'}, pid ${lastAttempt(task).pid}`);
  });
}

async function stopTask(id: string): Promise<void> {
  const attempt = lastAttempt(taskOf(readLedger(), id));
  const program = programOf(engineOf(attempt));
  if (pidAlive(attempt.pid, program)) {
    process.kill(-attempt.pid, 'SIGTERM');
    const deadline = Date.now() + 30_000;
    while (pidAlive(attempt.pid, program) && Date.now() < deadline) await Bun.sleep(500);
    if (pidAlive(attempt.pid, program)) process.kill(-attempt.pid, 'SIGKILL');
  }
  await withLedger(ledger => {
    const task = taskOf(ledger, id);
    lastAttempt(task).endedAt ??= new Date().toISOString();
    if (task.state === 'running') task.state = 'stopped';
  });
  console.log(`${id.toUpperCase()} stopped; its worktree and claims remain until close`);
}

async function mergeTask(id: string, flags: Set<string>): Promise<void> {
  await withLedger(ledger => {
    const task = taskOf(ledger, id);
    if (running(task)) throw new Error(`${task.id} is still running`);
    if (!['exited', 'conflict', 'stopped'].includes(task.state)) throw new Error(`${task.id} is ${task.state}`);
    if (git(root, ['symbolic-ref', '--short', 'HEAD']) !== 'main') throw new Error('Main checkout is not on main');
    const { committed, dirty, ahead } = changedFiles(task);
    if (dirty.length) throw new Error(`${task.id} worktree has uncommitted files:\n  ${dirty.join('\n  ')}`);
    if (!ahead) throw new Error(`${task.id} has no commits to merge`);
    // Files merged with git's union driver take concurrent appends (route registrations), so any task may add to them.
    const union = new Set(committed.filter(file =>
      git(root, ['check-attr', 'merge', '--', file], true).endsWith(': merge: union')));
    const violations = outOfScope(committed.filter(file => !union.has(file)), task.paths);
    if (violations.length && !flags.has('--allow-scope')) {
      throw new Error(`${task.id} changed files outside its claim:\n  ${violations.join('\n  ')}`);
    }
    const rebase = spawnSync('git', ['rebase', 'main'], { cwd: task.worktree, encoding: 'utf8' });
    if (rebase.status !== 0) {
      const conflicted = git(task.worktree, ['diff', '--name-only', '--diff-filter=U'], true);
      git(task.worktree, ['rebase', '--abort'], true);
      task.state = 'conflict';
      throw new Error(`${task.id} does not rebase onto main; conflicts:\n  ${conflicted.split('\n').join('\n  ')}`);
    }
    // Union-merged composition roots can keep a stale chain after the rebase; normalize them on the task
    // branch itself so main and the worktree end up identical.
    for (const script of ['scripts/goal/normalize-app.ts', 'scripts/goal/dedupe-imports.ts']) {
      const run = spawnSync('bun', [join(root, script)], { cwd: task.worktree, encoding: 'utf8' });
      if (run.status !== 0) throw new Error(`${script} failed in ${task.worktree}:\n${run.stderr.slice(-2000)}`);
    }
    if (git(task.worktree, ['status', '--porcelain', '--', 'services/main/src'], true)) {
      git(task.worktree, ['commit', '-q', '-am', 'Normalize Main composition roots after rebase (goalctl)']);
    }
    const merge = spawnSync('git', ['merge', '--ff-only', task.branch], { cwd: root, encoding: 'utf8' });
    if (merge.status !== 0) throw new Error(`Fast-forward failed in the main checkout:\n${merge.stderr}`);
    task.state = 'merged';
    task.mergedCommit = git(root, ['rev-parse', 'HEAD']);

    console.log(`${task.id} merged at ${task.mergedCommit.slice(0, 12)}; ${committed.length} file(s):`);
    console.log(`  ${committed.join('\n  ')}`);
  });
}

// Re-read an updated brief for an open task (for example a schema task continuing to its template) and
// replace its claims after the same conflict checks as dispatch; the new brief is copied into the worktree.
async function reclaimTask(id: string, briefPath: string): Promise<void> {
  const absolute = resolve(briefPath);
  const brief = parseBrief(readFileSync(absolute, 'utf8'));
  const errors = validateBrief(brief);
  if (errors.length) throw new Error(`Invalid brief ${briefPath}:\n  ${errors.join('\n  ')}`);
  await withLedger(ledger => {
    const task = taskOf(ledger, id);
    if (brief.id !== task.id) throw new Error(`${briefPath} is for ${brief.id}, not ${task.id}`);
    if (running(task)) throw new Error(`${task.id} is still running`);
    if (['verified', 'cancelled'].includes(task.state)) throw new Error(`${task.id} is closed`);
    const conflicts = claimConflicts(brief, Object.values(ledger.tasks));
    if (conflicts.length) throw new Error(`Claim conflict for ${brief.id}:\n  ${conflicts.join('\n  ')}`);
    Object.assign(task, { title: brief.title, effort: brief.effort, cases: brief.cases, paths: brief.paths,
      migrations: brief.migrations, shared: brief.shared, depends: brief.depends, brief: absolute });
    if (existsSync(task.worktree)) copyFileSync(absolute, join(task.worktree, '.temp', 'goal', 'brief.md'));
    console.log(`${task.id} claims replaced from ${briefPath}`);
  });
}

async function closeTask(id: string, outcome: string): Promise<void> {
  if (outcome !== 'verified' && outcome !== 'cancelled') throw new Error('close needs verified or cancelled');
  await withLedger(ledger => {
    const task = taskOf(ledger, id);
    if (running(task)) throw new Error(`${task.id} is still running; stop it first`);
    // A read-only task (no path claims, nothing committed) is verified by its accepted handoff.
    const readOnly = !task.paths.length && task.state === 'exited' && !changedFiles(task).ahead;
    if (outcome === 'verified' && task.state !== 'merged' && !readOnly) {
      throw new Error(`${task.id} is ${task.state}, not merged`);
    }
    if (existsSync(task.worktree)) {
      // Tasks may leave intentionally read-only artifacts (for example immutable release trees).
      spawnSync('chmod', ['-R', 'u+w', task.worktree]);
      git(root, ['worktree', 'remove', '--force', task.worktree]);
    }
    if (task.state === 'merged') git(root, ['branch', '-d', task.branch], true);
    task.state = outcome;
    task.closedAt = new Date().toISOString();
    console.log(`${task.id} ${outcome}; claims released${outcome === 'cancelled' ? `, branch ${task.branch} kept` : ''}`);
  });
}

async function status(): Promise<void> {
  const ledger = await withLedger(current => {
    for (const task of Object.values(current.tasks)) {
      if (task.state === 'running' && !running(task)) {
        task.state = 'exited';
        lastAttempt(task).endedAt ??= new Date().toISOString();
      }
    }
    return current;
  });
  const tasks = Object.values(ledger.tasks);
  const usage = currentUsage();
  const live = tasks.filter(running);
  console.log(`program elapsed ${ledger.startedAt ? elapsed(ledger.startedAt) : 'not started'}; `
    + `live ${live.length}/${process.env.GOAL_MAX_WORKERS ?? 25}; `
    + `Claude 5h ${usage.used ?? '?'}% ${usage.level}`
    + (usage.projected !== undefined ? `, projected ${usage.projected}% at reset in ${usage.resetInMinutes}m` : '')
    + (usage.ageSeconds !== undefined ? ` (${usage.ageSeconds}s old)` : ''));
  if (usage.weekUsed !== undefined) {
    console.log(`Claude 7d ${usage.weekUsed}%, projected ${usage.weekProjected}% at reset in ${usage.weekResetInHours}h: `
      + `${usage.weekAdvice}`);
  }
  for (const account of codexAccounts()) console.log(describeAccount(account));
  for (const task of tasks.filter(t => !['verified', 'cancelled'].includes(t.state))) {
    const attempt = lastAttempt(task);
    console.log(`${task.id} ${task.state.padEnd(8)} ${engineOf(attempt)}/${attempt.effort} #${attempt.n} `
      + `${elapsed(attempt.startedAt)} [${task.cases.join(' ')}] ${task.title}`);
  }
  const closed = tasks.length - tasks.filter(t => !['verified', 'cancelled'].includes(t.state)).length;
  if (closed) console.log(`${closed} closed task(s) omitted`);
}

async function withSlot(command: string[]): Promise<number> {
  const slots = Number(process.env.GOAL_QA_SLOTS ?? 4);
  const dir = join(stateDir, 'qa-slots');
  mkdirSync(dir, { recursive: true });
  let held: string | undefined;
  const deadline = Date.now() + 3_600_000;
  while (!held) {
    for (let k = 0; k < slots && !held; k++) {
      const path = join(dir, String(k));
      try { await acquireDir(path, 0, 'slot'); held = path; } catch { /* busy */ }
    }
    if (!held) {
      if (Date.now() > deadline) throw new Error('No QA slot became free within one hour');
      await Bun.sleep(3000);
    }
  }
  const slot = held;
  const release = () => rmSync(slot, { recursive: true, force: true });
  try {
    const child = spawn(command[0]!, command.slice(1), { cwd: process.cwd(), stdio: 'inherit' });
    const forward = (signal: NodeJS.Signals) => child.kill(signal);
    process.on('SIGINT', forward);
    process.on('SIGTERM', forward);
    return await new Promise<number>(done => child.on('exit', code => done(code ?? 1)));
  } finally {
    release();
  }
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  const flags = new Set(rest.filter(arg => arg.startsWith('--')));
  const positional = rest.filter(arg => !arg.startsWith('--'));
  switch (command) {
    case 'init': {
      const at = rest.indexOf('--manager');
      await withLedger(ledger => {
        if (at >= 0) ledger.manager = rest[at + 1];
        ledger.startedAt ??= new Date().toISOString();
        console.log(`program started ${ledger.startedAt}; manager ${ledger.manager ?? 'goal-manager'}`);
      });
      return 0;
    }
    case 'dispatch': await dispatch(positional[0] ?? '', flags); return 0;
    case 'wait': await waitFor(positional[0] ?? ''); return 0;
    case 'resume': await resumeTask(rest[0] ?? '', rest.slice(1)); return 0;
    case 'stop': await stopTask(positional[0] ?? ''); return 0;
    case 'scope': console.log(describe(taskOf(readLedger(), positional[0] ?? ''))); return 0;
    case 'merge': await mergeTask(positional[0] ?? '', flags); return 0;
    case 'close': await closeTask(positional[0] ?? '', positional[1] ?? ''); return 0;
    case 'reclaim': await reclaimTask(positional[0] ?? '', positional[1] ?? ''); return 0;
    case 'owner': {
      // Read-only: which open task claims a repository path (workers check before editing outside their claim).
      const path = positional[0] ?? '';
      const holders = Object.values(readLedger().tasks).filter(task => HOLDING.includes(task.state)
        && task.paths.some(pattern => new Bun.Glob(pattern).match(path) || pathsOverlap(pattern, path)));
      console.log(holders.length ? `${path}: claimed by ${holders.map(task => `${task.id} (${task.state})`).join(', ')}`
        : `${path}: unclaimed`);
      return holders.length ? 1 : 0;
    }
    case 'status': await status(); return 0;
    case 'usage':
      console.log(JSON.stringify({ claude: { ...currentUsage(), file: usagePath }, codex: codexAccounts() }, null, 2));
      return 0;
    case 'test': return withSlot(['bun', 'scripts/qa/test.ts', ...rest]);
    case 'slot': return withSlot(rest[0] === '--' ? rest.slice(1) : rest);
    default:
      console.error('Usage: goalctl init [--manager <name>] | dispatch <brief.md> [--dry-run] [--force-usage]'
        + ' | wait <id> | owner <path> | reclaim <id> <brief> | resume <id> (-m <text> | --file <path>) [--effort e]'
        + ` [--engine ${ENGINES.join('|')}] [--fresh]`
        + ' | stop <id> | scope <id> | merge <id> [--allow-scope] | close <id> verified|cancelled'
        + ' | status | usage | test <task test args> | slot -- <command>');
      return 2;
  }
}

if (import.meta.main) {
  try {
    process.exit(await main(process.argv.slice(2)));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
