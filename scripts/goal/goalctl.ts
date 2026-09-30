// Goal worker-process control: exclusive claims, dispatch, waits, QA slots, scope and merge.
// The manager is the only caller of the state-changing commands; see docs/goals/README.md.
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { closeSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, readSync,
  renameSync, readlinkSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

export type State = 'running' | 'exited' | 'conflict' | 'merged' | 'stopped' | 'verified' | 'cancelled';
export type Engine = 'claude' | 'sonnet' | 'fable' | 'codex' | 'codex-1' | 'luna' | 'grok' | 'cursor';
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
// Fable runs through Claude Code. Its weekly allowance may be its own, but it shares the Claude 5h session
// limit (both hit 'session limit' together on 2026-09-28), so the 5h gate applies to it as to Opus.
export const FABLE_MODEL = 'claude-fable-5-1';
// Sonnet runs through Claude Code on the same subscription, so the Claude usage gate applies to it too.
// Claude Code 2.1.284 is the first release here that accepts claude-sonnet-5-5 (2.1.283 rejected it).
export const SONNET_MODEL = process.env.GOAL_SONNET_MODEL ?? 'claude-sonnet-5-5';
// GPT-6.1 Sol replaced GPT-6 Sol and GPT-6 Astra on 2026-09-30 (maintainer).
export const CODEX_MODEL = 'gpt-6.1-sol';
export const LUNA_MODEL = 'gpt-6-luna';
export const GROK_MODEL = 'grok-4.7';
const ENGINE_EFFORTS: Record<Engine, string[]> = {
  claude: ['low', 'medium', 'high', 'xhigh', 'max'],
  sonnet: ['low', 'medium', 'high', 'xhigh', 'max'],
  fable: ['low', 'medium', 'high', 'xhigh', 'max'],
  codex: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
  'codex-1': ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
  luna: ['low', 'medium', 'high', 'xhigh', 'max'],
  grok: ['low', 'medium', 'high'],
  // Cursor Agent selects Grok 4.7 through per-effort model IDs (grok-4.7-<effort>).
  cursor: ['low', 'medium', 'high', 'xhigh'],
};
const ENGINES = Object.keys(ENGINE_EFFORTS) as Engine[];
export const DEFAULT_ENGINE: Engine = (process.env.GOAL_ENGINE as Engine | undefined) ?? 'claude';
// `codex` (Sol) and `luna` use the default Codex account; `codex-1` runs Sol on the second account in a
// separate CODEX_HOME (the `codex-1` wrapper sets the same directory), so Sol work can continue on
// whichever account still has usage.
export const CODEX_HOME = process.env.GOAL_CODEX_HOME ?? join(homedir(), '.codex');
export const CODEX_1_HOME = process.env.GOAL_CODEX_1_HOME ?? join(homedir(), '.codex-1');
const engineOf = (item: { engine?: Engine }): Engine => item.engine ?? 'claude';
const MODELS: Record<Engine, string> = { claude: MODEL, sonnet: SONNET_MODEL, fable: FABLE_MODEL, codex: CODEX_MODEL, 'codex-1': CODEX_MODEL, luna: LUNA_MODEL,
  grok: GROK_MODEL, cursor: `${GROK_MODEL} (Cursor)` };
const modelOf = (engine: Engine): string => MODELS[engine];
const effortsOf = (engine: Engine): string[] => ENGINE_EFFORTS[engine] ?? [];
const isCodex = (engine: Engine): boolean =>
  engine === 'codex' || engine === 'codex-1' || engine === 'luna';
const isClaudeCode = (engine: Engine): boolean => engine === 'claude' || engine === 'sonnet' || engine === 'fable';
// Process name that /proc/<pid>/cmdline carries for a live worker of each engine.
const programOf = (engine: Engine): string =>
  isCodex(engine) ? 'codex' : engine === 'cursor' ? 'cursor-agent' : isClaudeCode(engine) ? 'claude' : engine;
const engineEnv = (engine: Engine): Record<string, string> =>
  engine === 'codex-1' ? { CODEX_HOME: CODEX_1_HOME } : isCodex(engine) ? { CODEX_HOME } : {};
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

function literalEnds(segment: string): [string, string] {
  const first = segment.search(/[*?[{]/);
  if (first < 0) return [segment, segment];
  let last = -1;
  for (let at = 0; at < segment.length; at++) if ('*?[]{}'.includes(segment[at]!)) last = at;
  return [segment.slice(0, first), segment.slice(last + 1)];
}

function segmentRegex(segment: string): RegExp {
  const body = segment.replace(/[.+^$()|\\]/g, '\\$&').replace(/\*+/g, '[^/]*').replace(/\?/g, '[^/]');
  return new RegExp(`^${body}$`);
}

// Route folders such as `[locale]` are claimed as `[[]locale]` or `\\[locale\\]`;
// map those escaped brackets to stand-in characters so they compare as literals.
function literalBrackets(segment: string): string {
  const escaped = segment.replace(/\[\[\]|\\\[/g, '\u0001').replace(/\[\]\]|\\\]/g, '\u0002');
  return escaped.includes('[') ? escaped : escaped.replaceAll(']', '\u0002');
}

// Two single path segments can match a common name. Exact for literals and for a
// literal against `*`/`?`; for two wildcard segments only the literal prefix and
// suffix are compared, which may report overlap where none exists (safe side).
function segmentsIntersect(rawA: string, rawB: string): boolean {
  const a = literalBrackets(rawA);
  const b = literalBrackets(rawB);
  const wildA = /[*?[{]/.test(a);
  const wildB = /[*?[{]/.test(b);
  if (!wildA && !wildB) return a === b;
  if (!wildA || !wildB) {
    const [literal, glob] = wildA ? [b, a] : [a, b];
    return /[[{]/.test(glob) || segmentRegex(glob).test(literal);
  }
  const [prefixA, suffixA] = literalEnds(a);
  const [prefixB, suffixB] = literalEnds(b);
  return (prefixA.startsWith(prefixB) || prefixB.startsWith(prefixA))
    && (suffixA.endsWith(suffixB) || suffixB.endsWith(suffixA));
}

function globsIntersect(a: string[], i: number, b: string[], j: number): boolean {
  if (i === a.length && j === b.length) return true;
  if (a[i] === '**') return globsIntersect(a, i + 1, b, j) || (j < b.length && globsIntersect(a, i, b, j + 1));
  if (b[j] === '**') return globsIntersect(a, i, b, j + 1) || (i < a.length && globsIntersect(a, i + 1, b, j));
  if (i === a.length || j === b.length) return false;
  return segmentsIntersect(a[i]!, b[j]!) && globsIntersect(a, i + 1, b, j + 1);
}

// Claims overlap when some file path could match both globs (segment-wise, with
// `**` spanning any number of segments). Uncertain wildcard pairs count as overlap.
export function pathsOverlap(a: string, b: string): boolean {
  return globsIntersect(a.split('/'), 0, b.split('/'), 0);
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
// The 7d window is spent up to WEEK_CAP, the share of the week the maintainer allows (2026-09-29: keep at
// least half the week unused, so 50). Below WEEK_TARGET at reset the report advises widening Claude work.
// New Claude work stops when the week would pass WEEK_PROJECTED_LIMIT before its reset or WEEK_CRITICAL_USED
// is reached; the five points below the cap carry the manager to the reset.
export const WEEK_CAP = Number(process.env.GOAL_CLAUDE_WEEK_CAP ?? 50);
export const WEEK_TARGET = WEEK_CAP - 10;
export const WEEK_PROJECTED_LIMIT = WEEK_CAP - 5;
export const WEEK_CRITICAL_USED = WEEK_CAP - 5;

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
  return ['claude', ['-p', prompt, '--model', MODELS[engine], '--effort', effort, '--dangerously-skip-permissions',
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
// Rollouts of the last three session days, newest first. A rollout records rate limits only after its
// first model response, so the newest one may carry none (2026-09-30: an idle session hid 87% used).
function recentRollouts(home: string): string[] {
  const children = (dir: string): string[] => {
    try { return readdirSync(dir).sort().reverse().map(name => join(dir, name)); } catch { return []; }
  };
  const days = children(join(home, 'sessions')).flatMap(children).flatMap(children).slice(0, 3);
  const files = days.flatMap(day => children(day).filter(file => file.endsWith('.jsonl')));
  return files.map(file => ({ file, at: statSync(file).mtimeMs })).sort((a, b) => b.at - a.at).map(item => item.file);
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
    { account: 'codex-1', home: CODEX_1_HOME, engines: ['codex-1'] },
  ];
  return accounts.map(account => {
    for (const file of recentRollouts(account.home)) {
      const usage = parseCodexUsage(tail(file, 512 * 1024), Date.now());
      if (usage.used !== undefined) return { ...account, ...usage };
    }
    return account;
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
      if (isClaudeCode(engine) && ['restricted', 'critical'].includes(usage.level)) {
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
    task.attempts.push(launch(task, brief.effort, isClaudeCode(engine) ? randomUUID() : '',
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
    const session = continuing ? previousSession : isClaudeCode(nextEngine) ? randomUUID() : '';
    const prompt = continuing ? message
      : `${workerPrompt(task, manager, nextEngine, nextEffort)}\n\nManager note:\n${message}`;
    task.attempts.push(launch(task, nextEffort, session, prompt, continuing, manager, nextEngine));
    task.engine = nextEngine;
    task.state = 'running';
    console.log(`${task.id} attempt ${task.attempts.length}: ${modelOf(nextEngine)}/${nextEffort}`
      + ` ${continuing ? 'resumed' : 'fresh session'}, pid ${lastAttempt(task).pid}`);
  });
}


/** Worker-started dev servers (task dev, Storybook, browsers) detach from the
 * worker's process group and outlive it; they held several GB each on a
 * 62 GB host. Terminate every process whose working directory is inside the
 * worktree. Linux only: reads /proc. */
export function killWorktreeProcesses(worktree: string): number {
  if (!existsSync('/proc')) return 0;
  const prefix = worktree.endsWith('/') ? worktree : `${worktree}/`;
  const victims: number[] = [];
  for (const entry of readdirSync('/proc')) {
    const pid = Number(entry);
    if (!Number.isInteger(pid) || pid === process.pid) continue;
    try {
      const cwd = readlinkSync(`/proc/${pid}/cwd`);
      if (cwd === worktree || cwd.startsWith(prefix)) victims.push(pid);
    } catch { /* exited or not ours */ }
  }
  for (const pid of victims) { try { process.kill(pid, 'SIGTERM'); } catch { /* gone */ } }
  return victims.length;
}

/** A worktree's `task dev -- --backend` stack is Compose project rezics-qa-wt-<dir>;
 * its containers live in Docker, not in the worker's process tree. */
export function removeWorktreeStack(worktree: string): void {
  const project = `rezics-qa-wt-${basename(worktree)}`;
  const listed = spawnSync('docker', ['ps', '-aq', '--filter', `label=com.docker.compose.project=${project}`],
    { encoding: 'utf8', timeout: 30_000 });
  if (listed.status !== 0 || !listed.stdout.trim()) return;
  spawnSync('docker', ['compose', '-p', project, 'down', '-v'], { encoding: 'utf8', timeout: 180_000 });
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
  killWorktreeProcesses(taskOf(readLedger(), id).worktree);
  removeWorktreeStack(taskOf(readLedger(), id).worktree);
  await withLedger(ledger => {
    const task = taskOf(ledger, id);
    lastAttempt(task).endedAt ??= new Date().toISOString();
    if (task.state === 'running') task.state = 'stopped';
  });
  console.log(`${id.toUpperCase()} stopped; its worktree and claims remain until close`);
}

// Main's union-merged composition roots (.gitattributes). `normalize-app.ts` is not used: it rebuilds
// function signatures and dropped `mountedReads` after the G-629 rebase (ee678f81, 2026-10-01).
export const COMPOSITION_ROOTS = [
  'services/main/src/app.ts',
  'services/main/src/index.ts',
  'services/main/src/routes/dependencies.ts',
] as const;

interface Lex {
  depth: number; block: boolean; single: boolean; double: boolean; template: boolean;
}

function freshLex(): Lex {
  return { depth: 0, block: false, single: false, double: false, template: false };
}

// One scanner for chain splitting and semicolon stripping, so both agree on where a call ends.
// Strings and comments are opaque; composition roots do not put `${}` braces in these chains.
function lexAdvance(text: string, lex: Lex, keep: boolean): { lex: Lex; text: string } {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    const next = text[i + 1];
    const copy = (value: string) => { if (keep) out += value; };
    if (lex.block) {
      copy(c);
      if (c === '*' && next === '/') { copy('/'); i++; lex.block = false; }
      continue;
    }
    if (lex.single || lex.double || lex.template) {
      copy(c);
      const quote = lex.single ? "'" : lex.double ? '"' : '`';
      if (c === '\\' && next !== undefined) { copy(next); i++; continue; }
      if (c === quote) { lex.single = lex.double = lex.template = false; }
      continue;
    }
    if (c === '/' && next === '/') {
      const nl = text.indexOf('\n', i);
      if (nl < 0) { copy(text.slice(i)); break; }
      copy(text.slice(i, nl));
      i = nl - 1;
      continue;
    }
    if (c === '/' && next === '*') { copy('/*'); i++; lex.block = true; continue; }
    if (c === "'") { copy(c); lex.single = true; continue; }
    if (c === '"') { copy(c); lex.double = true; continue; }
    if (c === '`') { copy(c); lex.template = true; continue; }
    if (c === '(' || c === '{' || c === '[') { copy(c); lex.depth++; continue; }
    if (c === ')' || c === '}' || c === ']') { copy(c); lex.depth = Math.max(0, lex.depth - 1); continue; }
    if (c === ';' && lex.depth === 0) continue;
    copy(c);
  }
  return { lex, text: out };
}

function stripDepth0Semicolons(text: string): string {
  return lexAdvance(text, freshLex(), true).text;
}

interface UseCall { lines: string[]; use: boolean }

function splitFluent(lines: string[]): { head: string[]; calls: UseCall[] } {
  const head: string[] = [];
  const calls: UseCall[] = [];
  let current: string[] | null = null;
  let use = false;
  let lex = freshLex();
  const push = () => {
    if (!current) return;
    calls.push({ lines: current, use });
    current = null;
  };
  for (const line of lines) {
    if (lex.depth === 0 && !lex.block && /^\s*\.\w+/.test(line)) {
      push();
      current = [line];
      use = /^\s*\.use\(/.test(line);
    } else if (current) current.push(line);
    else head.push(line);
    lex = lexAdvance(line, lex, false).lex;
  }
  push();
  return { head, calls };
}

function insertSemicolon(line: string): string {
  const comment = /[ \t]*\/\/.*$/.exec(line);
  const code = comment ? line.slice(0, comment.index) : line;
  return `${code.trimEnd()};${comment ? comment[0] : ''}`;
}

function renderCall(lines: string[], terminate: boolean): string[] {
  const stripped = stripDepth0Semicolons(lines.join('\n')).split('\n');
  if (!terminate) return stripped;
  const last = stripped.length - 1;
  stripped[last] = insertSemicolon(stripped[last] ?? '');
  return stripped;
}

const ELYSIA_HEAD = /^\s*(?:const|let)\s+\w+\s*=\s*new\s+Elysia\(\)\s*;?\s*$/;
const RETURN_ELYSIA = /^\s*return\s+new\s+Elysia\(\)\s*;?\s*$/;
const RETURN_IDENT = /^\s*return\s+[A-Za-z_$][\w$]*\s*;?\s*$/;

function isChainHead(line: string, next: string | undefined): boolean {
  if (ELYSIA_HEAD.test(line) || RETURN_ELYSIA.test(line)) return true;
  return RETURN_IDENT.test(line) && !!next && /^\s*\.\w+/.test(next);
}

function collectChain(lines: string[], start: number): { chain: string[]; next: number } {
  const chain = [lines[start]!];
  let lex = lexAdvance(lines[start]!, freshLex(), false).lex;
  let i = start + 1;
  while (i < lines.length) {
    const line = lines[i]!;
    if (lex.depth === 0 && !lex.block && !/^\s*\.\w+/.test(line)) break;
    chain.push(line);
    lex = lexAdvance(line, lex, false).lex;
    i++;
  }
  return { chain, next: i };
}

function renderChain(lines: string[]): string[] {
  const { head, calls } = splitFluent(lines);
  if (!calls.length) return lines;
  const seen = new Set<string>();
  const kept: UseCall[] = [];
  for (const call of calls) {
    if (call.use) {
      const key = stripDepth0Semicolons(call.lines.join('\n')).trim();
      if (seen.has(key)) continue;
      seen.add(key);
    }
    kept.push(call);
  }
  return [
    ...stripDepth0Semicolons(head.join('\n')).split('\n'),
    ...kept.flatMap((call, index) => renderCall(call.lines, index === kept.length - 1)),
  ];
}

/** Drop exact duplicate `.use(…)` calls inside each chain and leave one terminating semicolon.
 * Function signatures and every other line are copied through. */
export function normalizeUseChains(source: string): string {
  const lines = source.split('\n');
  const out: string[] = [];
  for (let i = 0; i < lines.length;) {
    if (!isChainHead(lines[i] ?? '', lines[i + 1])) {
      out.push(lines[i] ?? '');
      i++;
      continue;
    }
    const collected = collectChain(lines, i);
    out.push(...renderChain(collected.chain));
    i = collected.next;
  }
  return out.join('\n');
}

/** Parse diagnostics only (`bun build --no-bundle`). TypeScript 7 no longer exports `createSourceFile`.
 * Empty when the file parses. The message carries the repository path, line and error. */
export function compositionSyntaxFailure(file: string, source: string): string | undefined {
  const dir = mkdtempSync(join(tmpdir(), 'goalctl-parse-'));
  try {
    const path = join(dir, basename(file));
    writeFileSync(path, source);
    const run = spawnSync('bun', ['build', '--no-bundle', path, '--outdir', join(dir, 'out')],
      { encoding: 'utf8', timeout: 30_000 });
    if (run.status === 0) return undefined;
    const blob = `${run.stderr ?? ''}\n${run.stdout ?? ''}\n${run.error?.message ?? ''}`.trim();
    const message = /error: ([^\n]+)/.exec(blob)?.[1]?.trim()
      ?? blob.split('\n').map(line => line.trim()).filter(Boolean).at(-1)
      ?? 'parse failed';
    const at = /\bat [^\n]*:(\d+):(\d+)/.exec(blob);
    return `${file}:${at ? `${at[1]}:${at[2]}` : '1:1'}: ${message}`;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export interface CompositionMerge {
  files: { file: string; source: string }[];
  /** False means the task is `conflict` and main must not be fast-forwarded. */
  fastForward: boolean;
  state?: 'conflict';
  /** Each failing composition root's path and parse error. */
  error?: string;
}

/** Normalize, then parse. A failure here is the merge refusal: do not fast-forward `main`. */
export function prepareCompositionMerge(files: readonly { file: string; source: string }[]): CompositionMerge {
  const normalized = files.map(file => ({ file: file.file, source: normalizeUseChains(file.source) }));
  const failures = normalized.flatMap(file => {
    const failure = compositionSyntaxFailure(file.file, file.source);
    return failure ? [failure] : [];
  });
  if (!failures.length) return { files: normalized, fastForward: true };
  return { files: normalized, fastForward: false, state: 'conflict', error: failures.join('\n  ') };
}

async function mergeTask(id: string, flags: Set<string>): Promise<void> {
  // Return the refusal so withLedger writes `conflict` before the error is thrown. A throw inside the
  // callback would discard the state change, and main would stay eligible for a fast-forward retry.
  const failure = await withLedger((ledger): string | undefined => {
    const task = taskOf(ledger, id);
    if (running(task)) throw new Error(`${task.id} is still running`);
    if (!['exited', 'conflict', 'stopped'].includes(task.state)) throw new Error(`${task.id} is ${task.state}`);
    if (git(root, ['symbolic-ref', '--short', 'HEAD']) !== 'main') throw new Error('Main checkout is not on main');
    const { committed, dirty, ahead } = changedFiles(task);
    if (dirty.length) throw new Error(`${task.id} worktree has uncommitted files:\n  ${dirty.join('\n  ')}`);
    if (flags.has('--landed')) {
      // The manager already landed this work on main by hand (a cherry-pick, often with a conflict resolved).
      task.mergedCommit = git(root, ['rev-parse', 'HEAD']);
      task.state = 'merged';
      console.log(`${task.id} recorded as landed at ${task.mergedCommit.slice(0, 12)}`);
      return;
    }
    if (!ahead) {
      // A resumed task whose earlier commits already landed may hand off with nothing new.
      if (spawnSync('git', ['merge-base', '--is-ancestor', task.branch, 'main'], { cwd: root }).status === 0
        && task.mergedCommit) {
        task.state = 'merged';
        console.log(`${task.id} has nothing new; its branch is already in main`);
        return;
      }
      throw new Error(`${task.id} has no commits to merge`);
    }
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
    // Union merge concatenates both sides. Drop duplicate `.use()` lines and a mid-chain `;` on the task
    // branch, then parse. A composition root that still does not parse is `conflict` and is not merged.
    const originals = new Map<string, string>();
    for (const file of COMPOSITION_ROOTS) {
      const path = join(task.worktree, file);
      if (existsSync(path)) originals.set(file, readFileSync(path, 'utf8'));
    }
    const prepared = prepareCompositionMerge([...originals].map(([file, source]) => ({ file, source })));
    if (!prepared.fastForward) {
      task.state = 'conflict';
      return `${task.id} composition root does not parse; not merging:\n  ${prepared.error}`;
    }
    for (const file of prepared.files) {
      const path = join(task.worktree, file.file);
      if (readFileSync(path, 'utf8') !== file.source) writeFileSync(path, file.source);
    }
    const imports = spawnSync('bun', [join(root, 'scripts/goal/dedupe-imports.ts')],
      { cwd: task.worktree, encoding: 'utf8' });
    if (imports.status !== 0) {
      for (const [file, source] of originals) writeFileSync(join(task.worktree, file), source);
      throw new Error(`scripts/goal/dedupe-imports.ts failed in ${task.worktree}:\n${imports.stderr.slice(-2000)}`);
    }
    // Parse the bytes about to be committed. dedupe-imports runs after normalization and must not
    // be approved from a second, in-memory rewrite of those bytes.
    const failures = [...originals.keys()].flatMap(file => {
      const failure = compositionSyntaxFailure(file, readFileSync(join(task.worktree, file), 'utf8'));
      return failure ? [failure] : [];
    });
    if (failures.length) {
      for (const [file, source] of originals) writeFileSync(join(task.worktree, file), source);
      task.state = 'conflict';
      return `${task.id} composition root does not parse; not merging:\n  ${failures.join('\n  ')}`;
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
    return undefined;
  });
  if (failure) throw new Error(failure);
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
      killWorktreeProcesses(task.worktree);
      removeWorktreeStack(task.worktree);
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
        + ' | stop <id> | scope <id> | merge <id> [--allow-scope] [--landed] | close <id> verified|cancelled'
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
