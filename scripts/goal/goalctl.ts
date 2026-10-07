// Goal worker-process control: exclusive claims, dispatch, waits, QA slots, scope and merge.
// The manager is the only caller of the state-changing commands; see docs/goals/README.md.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, closeSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, readSync,
  renameSync, readlinkSync, realpathSync, rmSync, statSync, lstatSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { testArgs, unitHarnessFiles } from '../qa/acceptance.ts';
import { repositoryGuards } from '../qa/repository-guards.ts';
import { appendInbox, inboxEntries, parseRegressArgs, runRegression, type MergeEvent } from './regress.ts';
import { land, type LandScope } from './land.ts';
import { GoalMailStore } from './mail.ts';
import { GoalCoordinator, nativeSession, processIdentity, tmuxServer, WAKE_LAST_MESSAGE, WAKE_PROMPT,
  type LaunchDescriptor, type WakeEvent } from './coordinator.ts';

export type State = 'running' | 'exited' | 'conflict' | 'merged' | 'stopped' | 'verified' | 'cancelled';
export type Engine = 'claude' | 'sonnet' | 'fable' | 'codex' | 'codex-1' | 'luna' | 'grok' | 'cursor';
export interface Brief {
  id: string; title: string; effort: string; engine?: Engine; cases: string[]; paths: string[];
  migrations: string[]; shared: string[]; depends: string[];
  /** A shared worktree name within a Goal: its tasks work concurrently in one tree and branch. */
  worktree?: string;
  /** Opt in to review, merge and close when the worker's waiter sees a done handoff. */
  land?: 'auto';
}
export interface Attempt {
  n: number; effort: string; engine?: Engine; pid: number; session: string; output: string; lastMessage?: string;
  startedAt: string; endedAt?: string;
}
export interface Task extends Omit<Brief, 'worktree'> {
  brief: string; worktree: string; branch: string; base: string; state: State; attempts: Attempt[];
  /** Set when the task works in a shared worktree. */
  worktreeName?: string;
  mergedCommit?: string; closedAt?: string;
  /** The Goal that owns the task. Tasks dispatched before several Goals ran at once have none. */
  goal?: string;
  /** Merge refuses files and lines that name tasks (`historyIntroductions`). Unset on tasks dispatched before
   * 2026-10-04, whose briefs still asked for task-named tests. */
  historyGate?: boolean;
  /** Normalized migration paths retain the original claim when a failed unit gate is retried. */
  migrationOrigins?: Record<string, string>;
}
/** One running Goal. Its intent and areas live in `docs/goals/<slug>/GOAL.md`; the ledger keeps only runtime state. */
export interface GoalRecord { manager: string; startedAt: string; closedAt?: string; archive?: string }
export interface Ledger {
  startedAt?: string;
  /** The single manager of the ledger's first Goal; GoalRecord.manager replaces it. */
  manager?: string;
  goals?: Record<string, GoalRecord>;
  /** IDs handed out by `new` and not yet dispatched, with the Goal each belongs to. */
  reserved?: Record<string, string>;
  /** The highest ID ever used, so IDs stay unique after closed Goals leave the ledger. */
  lastId?: number;
  tasks: Record<string, Task>;
}
export interface UsageWindow { used_percentage?: number; resets_at?: string | number }
export interface UsageSnapshot {
  at?: number; rate_limits?: { five_hour?: UsageWindow | null; seven_day?: UsageWindow | null } | null;
}
export interface UsageSample { at: number; used: number; resets: number; week?: number; weekResets?: number }
export type UsageLevel = 'unknown' | 'normal' | 'restricted' | 'critical';
export interface UsageReport {
  level: UsageLevel; used?: number; ageSeconds?: number; resetInMinutes?: number;
  ratePerHour?: number; projected?: number; weekUsed?: number; weekProjected?: number; weekProjectedHigh?: number;
  weekResetInHours?: number; weekAdvice?: string; reason?: string;
}
export interface AccountUsage {
  account: string; home: string; engines: Engine[]; used?: number; windowMinutes?: number;
  resetInHours?: number; windowResetsAt?: number; sampledAt?: number; plan?: string; reached?: boolean; ageSeconds?: number;
}
export interface CodexResetStatus {
  data?: {
    latest_reset?: { announced_at?: string } | null;
    stats?: { avg_interval_days?: number } | null;
  };
}
export interface CodexResetLoad { status?: CodexResetStatus; fetchedAt?: number; available: boolean }

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

/** The leading `---` block of a brief or Goal file as flat `key: value` fields. `#` at the start of a line or after a
 * space begins a comment. A key with no value may be followed by `- item` lines, read as the list `[item, ...]`. */
export function parseFrontmatter(text: string): Record<string, string> | undefined {
  const block = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(text);
  if (!block) return undefined;
  const fields: Record<string, string> = {};
  const items: Record<string, string[]> = {};
  let last: string | undefined;
  for (const line of block[1]!.split(/\r?\n/)) {
    const clean = line.replace(/(?:^|\s+)#.*$/, '').trim();
    if (!clean) continue;
    const item = /^-\s+(.+)$/.exec(clean);
    if (item && last !== undefined && (fields[last] === '' || items[last])) {
      (items[last] ??= []).push(item[1]!.trim());
      continue;
    }
    const at = clean.indexOf(':');
    if (at < 1) throw new Error(`Bad frontmatter line: ${line}`);
    last = clean.slice(0, at).trim();
    fields[last] = clean.slice(at + 1).trim();
  }
  for (const [key, list] of Object.entries(items)) fields[key] = `[${list.join(', ')}]`;
  return fields;
}

function listField(fields: Record<string, string>, key: string): string[] {
  const value = fields[key];
  if (!value) return [];
  if (!value.startsWith('[') || !value.endsWith(']')) throw new Error(`${key} must be a [a, b] list`);
  return value.slice(1, -1).split(',').map(item => item.trim()).filter(Boolean);
}

export function parseBrief(text: string): Brief {
  const fields = parseFrontmatter(text);
  if (!fields) throw new Error('Brief needs a leading --- frontmatter block');
  const list = (key: string): string[] => listField(fields, key);
  return {
    id: fields.id ?? '', title: fields.title ?? '', effort: fields.effort ?? 'medium',
    engine: (fields.engine as Engine | undefined) ?? DEFAULT_ENGINE,
    cases: list('cases'), paths: list('paths'), migrations: list('migrations'), shared: list('shared'),
    depends: list('depends'), ...fields.worktree ? { worktree: fields.worktree } : {},
    ...fields.land !== undefined ? { land: fields.land as Brief['land'] } : {},
  };
}

export function validateBrief(brief: Brief): string[] {
  const errors: string[] = [];
  if (!/^G-\d{3,}$/.test(brief.id)) errors.push(`id must look like G-038: ${brief.id || '(missing)'}`);
  if (!brief.title) errors.push('title is required');
  if (brief.land !== undefined && brief.land !== 'auto') errors.push(`land must be auto: ${brief.land}`);
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
  if (brief.worktree !== undefined && !/^[a-z][a-z0-9-]{1,40}$/.test(brief.worktree)) {
    errors.push(`worktree must be a lower-case name: ${brief.worktree}`);
  }
  return errors;
}

function parseRange(range: string): { dir: string; start: number; end: number } | undefined {
  const match = /^([a-z0-9/_-]+):(\d{3,})-(\d{3,})$/.exec(range);
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
  // A whole Next.js dynamic folder (`[handle]`, `[...path]`, `[[...path]]`) names a
  // literal directory; claims never use it as a one-character class.
  if (/^\[\[?(?:\.\.\.)?[A-Za-z][\w-]*\]\]?$/.test(segment)) {
    return segment.replaceAll('[', '\u0001').replaceAll(']', '\u0002');
  }
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

// Several Goals run at once, one manager each. A Goal is the directory docs/goals/<slug>/: GOAL.md states it and
// lists its areas, state.md keeps its checkpoint, and tasks/ holds its open briefs. The whole directory leaves the
// tree when the Goal closes; docs/goals/{README,manager,worker}.md are the program and stay.
export const GOALS_DIR = 'docs/goals';
const GOAL_SLUG = /^[a-z][a-z0-9-]{1,40}$/;

export function validGoalSlug(slug: string): boolean {
  return GOAL_SLUG.test(slug) && slug !== 'tasks';
}

export const goalFile = (slug: string): string => `${GOALS_DIR}/${slug}/GOAL.md`;
export const goalBriefFile = (slug: string, id: string): string => `${GOALS_DIR}/${slug}/tasks/${id}.md`;

/** The Goal a repository-relative brief path belongs to; undefined for briefs outside a Goal directory. */
export function goalOfBriefPath(path: string): string | undefined {
  const slug = /^docs\/goals\/([^/]+)\/tasks\/G-\d{3,}\.md$/.exec(path)?.[1];
  return slug && validGoalSlug(slug) ? slug : undefined;
}

/** A Goal's areas: coarse path globs that other Goals' briefs may not claim. Brace and bracket globs compare as
 * overlapping almost everything (`pathsOverlap` errs on the safe side), so list each directory instead. */
export function goalAreas(goalText: string): string[] {
  const fields = parseFrontmatter(goalText);
  return fields ? listField(fields, 'areas') : [];
}

/** Claims that fall in another active Goal's areas. Paths in no Goal's areas belong to whoever claims them. */
export function areaConflicts(paths: string[], goal: string | undefined, areas: Record<string, string[]>): string[] {
  const conflicts: string[] = [];
  for (const [other, globs] of Object.entries(areas)) {
    if (other === goal) continue;
    for (const path of paths) {
      for (const area of globs) if (pathsOverlap(path, area)) conflicts.push(`path ${path} lies in Goal ${other}'s area ${area}`);
    }
  }
  return conflicts;
}

/** The next task ID after every one in use, reserved or recorded as the high-water mark. */
export function nextTaskId(ids: Iterable<string>, lastId = 0): string {
  let highest = lastId;
  for (const id of ids) {
    const number = /^G-(\d{3,})$/.exec(id)?.[1];
    if (number) highest = Math.max(highest, Number(number));
  }
  return `G-${String(highest + 1).padStart(3, '0')}`;
}

// Task IDs are history: they belong in commit messages, branches, the ledger and archive/goals. In the tree they
// become dangling pointers once a brief is archived (comments citing G-051 or G-314 outlived their briefs), and
// files named after tasks organize code by when it was written instead of what it covers.
export const HISTORY_EXEMPT = ['GOAL.md', `${GOALS_DIR}/**`, 'scripts/goal/**'];
const TASK_ID = /\bG-\d{3,}\b/g;
const taskSegment = (path: string): boolean => path.split('/').some(segment => /^g-\d{3,}(?!\d)/i.test(segment));

export interface ChangedFile {
  path: string; status: 'A' | 'M' | 'D' | 'R';
  /** The previous path of a rename. */
  from?: string;
  before?: string; after?: string;
}

function idCounts(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const id of text.match(TASK_ID) ?? []) counts.set(id, (counts.get(id) ?? 0) + 1);
  return counts;
}

/** What a change adds that names a task: new task-named files and task IDs a file did not carry before.
 * Existing names and mentions may stay or be moved within their file; renaming them away is always allowed. */
export function historyIntroductions(files: readonly ChangedFile[]): string[] {
  const exempt = HISTORY_EXEMPT.map(pattern => new Bun.Glob(pattern));
  const found: string[] = [];
  for (const file of files) {
    if (file.status === 'D' || exempt.some(glob => glob.match(file.path))) continue;
    const renamedFromTask = file.status === 'R' && !!file.from && taskSegment(file.from);
    if ((file.status === 'A' || file.status === 'R') && taskSegment(file.path) && !renamedFromTask) {
      found.push(`${file.path}: named after a task; name it by the capability it covers`);
    }
    if (file.after === undefined || file.after.includes('\0')) continue;
    const before = idCounts(file.before ?? '');
    const added = [...idCounts(file.after)].filter(([id, count]) => count > (before.get(id) ?? 0)).map(([id]) => id);
    if (added.length) found.push(`${file.path}: adds ${added.join(', ')}; state the reason itself instead of citing the task`);
  }
  return found;
}

/** A state-changing command on another Goal's task. GOAL_ID is set in each manager's environment. */
export function ownerRefusal(task: Pick<Task, 'id' | 'goal'>, caller = process.env.GOAL_ID): string | undefined {
  return caller && task.goal && task.goal !== caller
    ? `${task.id} belongs to Goal ${task.goal}; ask its manager (GOAL_ID is ${caller})` : undefined;
}

/** A QA run heavy enough that only one may run on the host at a time: affected sets, whole tiers, or `--heavy`. */
export function isHeavyTest(args: readonly string[]): boolean {
  if (args.includes('--heavy')) return true;
  if (args.includes('--list')) return false;
  const tierIndex = args.indexOf('--tier');
  if (tierIndex >= 0) {
    // Only known nonbrowser tiers may share slots when their file selection is bounded.
    const lightTier = ['unit', 'owner', 'model', 'integration', 'fault/recovery', 'load'].includes(args[tierIndex + 1] ?? '');
    if (!args.includes('--file') || !lightTier) return true;
  }
  return args.some(arg => arg === '--affected' || arg.startsWith('--affected='));
}

const FIVE_HOURS = 5 * 3600;
const SEVEN_DAYS = 7 * 24 * 3600;
// The 5h window keeps the manager alive: new Claude work stops while the burn rate would end the
// window at PROJECTED_LIMIT or more, and at CRITICAL_USED only merge and test continue.
export const PROJECTED_LIMIT = 95;
export const CRITICAL_USED = 95;
// The 7d window is spent up to WEEK_CAP, the share of the week the maintainer allows (2026-09-29: keep at
// least half the week unused; 2026-10-04: that limit is lifted, so the whole week). Below WEEK_TARGET at
// reset the report advises widening Claude work.
// New Claude work stops when the week would pass WEEK_PROJECTED_LIMIT before its reset or WEEK_CRITICAL_USED
// is reached; the five points below the cap carry the manager to the reset.
export const WEEK_CAP = Number(process.env.GOAL_CLAUDE_WEEK_CAP ?? 100);
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

// Whole-point readings leave one point of uncertainty in a difference. Use its low end for
// admission and retain its high end for status; a one-point tick alone must not halt dispatch.
function weekBurnRange(used: number, now: number, resets: number, history: UsageSample[]): [number, number] {
  const recent = history.filter(s => s.weekResets === resets && typeof s.week === 'number'
    && s.at >= now - 6 * 3600 && s.at <= now - 3600);
  if (recent.length) {
    const first = recent.reduce((a, b) => (a.at <= b.at ? a : b));
    const difference = used - first.week!;
    const elapsed = now - first.at;
    return [Math.max(0, difference - 1) / elapsed, Math.max(0, difference + 1) / elapsed];
  }
  const elapsed = Math.max(6 * 3600, now - (resets - SEVEN_DAYS));
  return [Math.max(0, used - 0.5) / elapsed, (used + 0.5) / elapsed];
}

export function weekBurnRate(used: number, now: number, resets: number, history: UsageSample[] = []): number {
  return weekBurnRange(used, now, resets, history)[0];
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
    const [low, high] = weekBurnRange(week.used_percentage, now, weekResets, history);
    report.weekProjected = Math.round(week.used_percentage + low * (weekResets - now));
    report.weekProjectedHigh = Math.round(week.used_percentage + high * (weekResets - now));
    report.weekAdvice = report.weekProjectedHigh >= WEEK_PROJECTED_LIMIT
      ? `warning: the week's high projection reaches ${report.weekProjectedHigh}%; watch Claude usage`
      : report.weekProjected < WEEK_TARGET
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
      const parsedAt = event.timestamp ? Date.parse(event.timestamp) / 1000 : undefined;
      const at = parsedAt !== undefined && Number.isFinite(parsedAt) ? parsedAt : undefined;
      const ageSeconds = at === undefined ? undefined : Math.round(now - at);
      // A window whose reset has passed starts empty again.
      const live = windows.filter(w => (w.resets_at ?? Infinity) > now);
      if (!live.length) return { used: 0, reached: false, plan: limits.plan_type, ageSeconds };
      const fullest = live.reduce((a, b) => (b.used_percent! > a.used_percent! ? b : a));
      return { used: fullest.used_percent, windowMinutes: fullest.window_minutes, plan: limits.plan_type, ageSeconds,
        sampledAt: at, windowResetsAt: fullest.resets_at,
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
    // Maintainer, 2026-10-03: Codex workers run on the fast service tier unless GOAL_CODEX_SERVICE_TIER says otherwise.
    const tier = process.env.GOAL_CODEX_SERVICE_TIER ?? codexServiceTier();
    const common = ['-m', MODELS[engine], '-c', `model_reasoning_effort=${effort}`,
      ...(tier ? ['-c', `service_tier="${tier}"`] : []),
      '--dangerously-bypass-approvals-and-sandbox', '--json', '-o', options.lastMessage ?? '/dev/null'];
    // `--` ends options: a prompt may start with `---` (brief frontmatter) or `-`.
    return ['codex', resume ? ['exec', 'resume', session, ...common, '--', prompt]
      : ['exec', ...common, '-C', options.worktree ?? '.', '--', prompt]];
  }
  return ['claude', ['-p', prompt, '--model', MODELS[engine], '--effort', effort, '--dangerously-skip-permissions',
    ...(resume ? ['--resume', session] : ['--session-id', session]), '-n', id.toLowerCase(),
    '--output-format', 'json']];
}

/** The manager switches Codex between `fast` and `default` by writing this state file (fast when
 * absent); `GOAL_CODEX_SERVICE_TIER` overrides it for one invocation. */
function codexServiceTier(): string {
  const override = process.env.GOAL_CODEX_SERVICE_TIER?.trim();
  if (override) return override;
  const file = join(stateDir, 'codex-service-tier');
  return existsSync(file) ? readFileSync(file, 'utf8').trim() : 'fast';
}

/** Where a task's brief lives in its worktree; shared worktrees hold one brief per task. */
export function briefFile(task: Pick<Task, 'id' | 'worktree'> & { shared?: boolean }): string {
  return task.shared ? `.temp/goal/brief-${task.id.toLowerCase()}.md` : '.temp/goal/brief.md';
}

function workerPrompt(task: Task, manager: string, engine: Engine = engineOf(task), effort = task.effort): string {
  return [
    `You are REZICS Goal worker ${task.id} (${modelOf(engine)}/${effort}). Work only inside ${task.worktree}.`,
    `Edit, create and delete files only under ${task.worktree} (and /tmp). The main checkout ${root} and every`
      + ' other worktree are read-only for you, even when a brief or handoff cites an absolute path there;'
      + ` translate such paths to ${task.worktree}.`,
    'goalctl commands you run (test, owner, slot) may write their own bookkeeping under the main checkout\'s'
      + ' .temp/goal-orchestration; that is allowed. Use `bun scripts/goal/goalctl.ts test` for QA.',
    `Read docs/goals/worker.md there, then your brief at ${briefFile({ ...task, shared: !!task.worktreeName })}, and follow both.`,
    ...task.worktreeName ? [`Other workers share this worktree at the same time (shared worktree "${task.worktreeName}").`
      + ' Change only your claimed paths; commit only them with `git commit --only <paths>` (retry if index.lock is held);'
      + ' never reset, checkout, stash or reformat files you did not change. Start no dev server, Storybook,'
      + ' type-check watcher or browser: use the shared ones listed in .temp/goal/shared.md, and leave Storybook'
      + ' and browser runs to the manager unless your brief asks you to run them. Run the unit and integration'
      + ' files (and any stories) your task adds or fixes through'
      + ' `bun scripts/goal/goalctl.ts test <files>`, one run at a time; an unverified fix is not done.'] : [],
    `${task.goal ? `Your Goal is ${task.goal}; its manager` : 'The manager'} session is "${manager}".`
      + ' End with the handoff that the worker protocol specifies.',
  ].join('\n');
}

/** A peer may briefly hold the shared index. Retry only that conflict; the lock belongs to Git, never us. */
export function retryGitIndexLock<T extends { status: number | null; stderr: string | null }>(run: () => T,
  sleep: (ms: number) => void = ms => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }): T {
  const waits = [250, 500, 1000, 2000];
  let result = run();
  for (const wait of waits) {
    if (result.status === 0 || !/index\.lock['"]?:\s*File exists/i.test(result.stderr ?? '')) break;
    sleep(wait);
    result = run();
  }
  return result;
}

function git(cwd: string, args: string[], allowFail = false, options: { env?: Record<string, string>; input?: string } = {}): string {
  const run = () => spawnSync('git', args, { cwd, encoding: 'utf8', input: options.input, maxBuffer: 256 * 1024 * 1024,
    env: options.env ? { ...process.env, ...options.env } : undefined });
  const result = args[0] === 'commit' && args.includes('--only') ? retryGitIndexLock(run) : run();
  if (result.status !== 0 && !allowFail) throw new Error(`git ${args.join(' ')} failed:\n${result.stderr}`);
  return result.status === 0 ? result.stdout.trim() : '';
}

export const ARCHIVE_BRANCH = 'archive/goals';

/** Adds files to the orphan archive branch without a checkout: the main checkout's HEAD never moves (the shared
 * stack hot-reloads from it). The ref update compares against the parent read, so a concurrent writer fails
 * instead of being overwritten. */
export function archiveFiles(repo: string, files: readonly { path: string; content: string }[], message: string,
  branch = ARCHIVE_BRANCH): string {
  const ref = `refs/heads/${branch}`;
  const parent = git(repo, ['rev-parse', '--verify', '--quiet', ref], true);
  const dir = mkdtempSync(join(tmpdir(), 'goalctl-archive-'));
  const env = { GIT_INDEX_FILE: join(dir, 'index') };
  try {
    git(repo, ['read-tree', ...parent ? [parent] : ['--empty']], false, { env });
    for (const file of files) {
      const blob = git(repo, ['hash-object', '-w', '--stdin'], false, { input: file.content });
      git(repo, ['update-index', '--add', '--cacheinfo', `100644,${blob},${file.path}`], false, { env });
    }
    const tree = git(repo, ['write-tree'], false, { env });
    const commit = git(repo, ['commit-tree', tree, ...parent ? ['-p', parent] : [], '-m', message]);
    git(repo, ['update-ref', '-m', message, ref, commit, parent]);
    return commit;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Deletes files from the working tree and commits only their removal, leaving whatever else peers have staged. */
export function removeFromTree(repo: string, paths: readonly string[], message: string): string | undefined {
  const tracked = paths.filter(path => git(repo, ['ls-files', '--', path], true) !== '');
  for (const path of paths) {
    rmSync(join(repo, path), { force: true });
    // A closed Goal leaves no empty directory behind.
    for (let dir = dirname(path); dir !== '.' && existsSync(join(repo, dir)) && !readdirSync(join(repo, dir)).length; dir = dirname(dir)) {
      rmSync(join(repo, dir), { recursive: true });
    }
  }
  if (!tracked.length) return undefined;
  git(repo, ['commit', '-q', '--only', '-m', message, '--', ...tracked]);
  return git(repo, ['rev-parse', 'HEAD']);
}

/** `file:line:text` of tracked files that mention any of `needles` (fixed strings), outside `exclude` globs
 * (the history-exempt paths by default). */
export function treeMentions(repo: string, needles: readonly string[],
  options: { words?: boolean; exclude?: readonly string[] } = {}): string[] {
  if (!needles.length) return [];
  const excludes = (options.exclude ?? HISTORY_EXEMPT).map(pattern => `:(exclude,glob)${pattern}`);
  const found = git(repo, ['grep', '-n', '-I', '-F', ...options.words ? ['-w'] : [],
    ...needles.flatMap(needle => ['-e', needle]), '--', '.', ...excludes], true);
  return found.split('\n').filter(Boolean);
}

const root = dirname(git(process.cwd(), ['rev-parse', '--path-format=absolute', '--git-common-dir']));
const stateDir = join(root, '.temp', 'goal-orchestration');
const ledgerPath = join(stateDir, 'ledger.json');
const usagePath = process.env.GOAL_USAGE_FILE ?? join(homedir(), '.claude', 'usage', 'latest.json');
const usageHistoryPath = join(stateDir, 'usage-history.json');
const CODEX_RESET_URL = 'https://codex-resets.com/api/v1/status';
const CODEX_RESET_CACHE_MS = 30 * 60 * 1000;
const codexResetCachePath = join(stateDir, 'codex-resets-status.json');

function readLedger(): Ledger {
  return existsSync(ledgerPath) ? JSON.parse(readFileSync(ledgerPath, 'utf8')) as Ledger : { tasks: {} };
}

function writeLedger(ledger: Ledger): void {
  writeFileSync(`${ledgerPath}.tmp`, `${JSON.stringify(ledger, null, 2)}\n`);
  renameSync(`${ledgerPath}.tmp`, ledgerPath);
}

const activeGoals = (ledger: Ledger): string[] =>
  Object.entries(ledger.goals ?? {}).filter(([, goal]) => !goal.closedAt).map(([slug]) => slug);

function managerOf(ledger: Ledger, goal: string | undefined): string {
  return (goal && ledger.goals?.[goal]?.manager) || ledger.manager || process.env.GOAL_MANAGER || 'goal-manager';
}

/** The Goal a brief belongs to: its directory, else the caller's GOAL_ID, else the only active Goal. Briefs in the
 * pre-Goal `docs/goals/tasks/` keep working while one Goal runs. */
function briefGoal(ledger: Ledger, absolute: string): string | undefined {
  const active = activeGoals(ledger);
  const path = relative(root, absolute);
  const fromPath = goalOfBriefPath(path);
  const caller = process.env.GOAL_ID;
  const goal = fromPath ?? caller ?? (active.length > 1 ? undefined : active[0]);
  if (!goal && active.length > 1) {
    throw new Error(`Several Goals are active (${active.join(', ')}); put the brief in ${GOALS_DIR}/<slug>/tasks/ (\`new\` writes it there)`);
  }
  if (goal && !active.includes(goal)) throw new Error(`Goal ${goal} is not started; run \`goal start ${goal} --manager <session>\``);
  if (fromPath && caller && fromPath !== caller) throw new Error(`${path} belongs to Goal ${fromPath}, not ${caller}`);
  return goal;
}

/** Areas are read from each Goal file at every check, so the maintainer's edits apply at once. */
function areasOf(slugs: readonly string[]): Record<string, string[]> {
  return Object.fromEntries(slugs.map(slug => {
    const path = join(root, goalFile(slug));
    return [slug, existsSync(path) ? goalAreas(readFileSync(path, 'utf8')) : []];
  }));
}

function assertOwner(task: Task): void {
  const refusal = ownerRefusal(task);
  if (refusal) throw new Error(refusal);
}

/** Where a task's brief is now: its recorded path, else its Goal directory, else the pre-Goal tasks directory. */
function briefPathOf(task: Task): string | undefined {
  const candidates = [task.brief, ...task.goal ? [join(root, goalBriefFile(task.goal, task.id))] : [],
    join(root, GOALS_DIR, 'tasks', `${task.id}.md`)];
  return candidates.find(path => path && existsSync(path));
}

/** A Goal's directory on archive/goals, named like the earlier `frontend-goal-2026-09-27`. */
function archiveDirOf(ledger: Ledger, goal: string): string {
  return ledger.goals?.[goal]?.archive ?? `${goal}-${(ledger.goals?.[goal]?.startedAt ?? new Date().toISOString()).slice(0, 10)}`;
}

function handoffText(task: Task): string {
  return [`# ${task.id} handoffs: ${task.title}`, '',
    ...task.attempts.flatMap(attempt => [`## Attempt ${attempt.n} (${modelOf(engineOf(attempt))}/${attempt.effort}, `
      + `${attempt.startedAt})`, '', readResult(attempt).text.trim(), ''])].join('\n');
}

function outOfClaimFiles(committed: string[], sharers: Task[]): string[] {
  const migrationOrigins = Object.assign({}, ...sharers.map(sharer => sharer.migrationOrigins ?? {})) as Record<string, string>;
  return outOfScope(committed.map(file => migrationOrigins[file] ?? file), sharers.flatMap(sharer => sharer.paths));
}

function scopeViolations(committed: string[], task: Task, sharers: Task[]): string[] {
  const union = new Set(committed.filter(file =>
    git(root, ['check-attr', 'merge', '--', file], true).endsWith(': merge: union')));
  const sharedTree = !!task.worktreeName || sharers.length > 1;
  return outOfClaimFiles(committed.filter(file => sharedTree || !union.has(file)), sharers);
}

function claimingTasks(ledger: Ledger, files: readonly string[], excludedIds: ReadonlySet<string>): { file: string; id: string }[] {
  return files.flatMap(file => Object.values(ledger.tasks)
    .filter(task => !excludedIds.has(task.id) && HOLDING.includes(task.state)
      && task.paths.some(pattern => new Bun.Glob(pattern).match(file) || pathsOverlap(pattern, file)))
    .map(task => ({ file, id: task.id })));
}

async function landScope(id: string): Promise<LandScope> {
  return withLedger(ledger => {
    const task = taskOf(ledger, id);
    assertOwner(task);
    const sharers = Object.values(ledger.tasks).filter(other => other.worktree === task.worktree && HOLDING.includes(other.state));
    const outOfClaim = outOfClaimFiles(changedFiles(task).committed, sharers);
    const claimedByOthers = [...new Set(claimingTasks(ledger, outOfClaim, new Set([task.id])).map(item => item.file))];
    return { outOfClaim, claimedByOthers };
  });
}

function landScopeRefusal(ledger: Ledger, task: Task, sharers: Task[], committed: string[], permittedFiles: readonly string[]): string | undefined {
  const violations = outOfClaimFiles(committed, sharers);
  const permitted = new Set(permittedFiles);
  const noLongerUnclaimed = permittedFiles.filter(file => !violations.includes(file));
  const unreviewed = violations.filter(file => !permitted.has(file));
  const claimed = claimingTasks(ledger, violations, new Set([task.id]));
  if (claimed.length) {
    return `${task.id} out-of-claim files are claimed by another task:\n  `
      + claimed.map(item => `${item.file} (${item.id})`).join('\n  ');
  }
  if (noLongerUnclaimed.length || unreviewed.length) {
    return `${task.id} scope changed during landing review; review again:\n  `
      + [...new Set([...noLongerUnclaimed, ...unreviewed])].sort().join('\n  ');
  }
  return undefined;
}

/** Moves the briefs and handoffs of closed tasks to archive/goals and removes the briefs from the tree in one commit.
 * Briefs that tracked files still cite are kept and reported: the citing file must point at an owner first.
 * Idempotent, so `tidy` repairs a close that stopped part-way. */
function archiveClosedBriefs(ledger: Ledger, tasks: readonly Task[], legacyDir?: string): string[] {
  const notes: string[] = [];
  const files: { path: string; content: string }[] = [];
  const removed: string[] = [];
  const goals = new Set<string>();
  const candidates = tasks.flatMap(task => {
    const path = ['verified', 'cancelled'].includes(task.state) ? briefPathOf(task) : undefined;
    return path?.startsWith(`${join(root, GOALS_DIR)}/`) ? [{ task, path, relativePath: relative(root, path) }] : [];
  });
  // One search for every candidate: the cost follows the tree once, not once per brief.
  const citations = treeMentions(root, candidates.map(item => item.relativePath), { exclude: [`${GOALS_DIR}/**`, 'scripts/goal/**'] });
  for (const { task, path, relativePath } of candidates) {
    const dir = task.goal ? archiveDirOf(ledger, task.goal) : legacyDir;
    if (!dir) { notes.push(`${task.id}: no Goal; pass tidy --legacy <archive directory>`); continue; }
    const cited = citations.filter(line => line.includes(relativePath));
    if (cited.length) { notes.push(`${task.id}: kept; cited by\n    ${cited.join('\n    ')}`); continue; }
    files.push({ path: `${dir}/tasks/${task.id}.md`, content: readFileSync(path, 'utf8') },
      { path: `${dir}/handoffs/${task.id}.md`, content: handoffText(task) });
    removed.push(relativePath);
    if (task.goal) goals.add(task.goal);
  }
  if (!removed.length) return notes;
  if (git(root, ['symbolic-ref', '--short', 'HEAD']) !== 'main') throw new Error('Main checkout is not on main');
  const subject = removed.length === 1 ? `Archive the closed brief ${basename(removed[0]!, '.md')}`
    : `Archive ${removed.length} closed briefs`;
  const trailer = goals.size ? `\n\n${[...goals].map(goal => `Goal: ${goal}`).join('\n')}` : '';
  archiveFiles(root, files, `${subject}${trailer}`);
  removeFromTree(root, removed, `${subject}\n\nThey are on ${ARCHIVE_BRANCH}.${trailer}`);
  notes.push(`${subject} (on ${ARCHIVE_BRANCH}, removed from the tree)`);
  return notes;
}

function pidAlive(pid: number, program?: string): boolean {
  if (!pid) return false;
  try { process.kill(pid, 0); } catch { return false; }
  if (!program) return true;
  try { return readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes(program); } catch { return false; }
}

/** A directory lock is still taken when its pid is alive, or it is new enough that the owner may not have written that pid yet. */
function dirLockHeld(path: string, alive: (pid: number) => boolean): boolean {
  if (!existsSync(path)) return false;
  const owner = existsSync(join(path, 'pid')) ? Number(readFileSync(join(path, 'pid'), 'utf8')) : 0;
  const young = Date.now() - statSync(path).mtimeMs < 10_000;
  return alive(owner) || young;
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
      // Same staleness rule as the heavy queue: a dead owner loses the directory once it is no longer young.
      if (!dirLockHeld(path, pidAlive)) { rmSync(path, { recursive: true, force: true }); continue; }
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

function resetStatusFrom(value: unknown): CodexResetStatus | undefined {
  if (!value || typeof value !== 'object' || !('data' in value) || !value.data || typeof value.data !== 'object') return undefined;
  return value as CodexResetStatus;
}

/** Read a public GET-only status snapshot, with a local 30-minute cache and no credentials. */
export async function loadCodexResetStatus(options: {
  fetcher?: (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>; cacheFile?: string; nowMs?: number;
} = {}): Promise<CodexResetLoad> {
  const nowMs = options.nowMs ?? Date.now();
  const cacheFile = options.cacheFile ?? codexResetCachePath;
  try {
    const cached = JSON.parse(readFileSync(cacheFile, 'utf8')) as { fetchedAt?: number; status?: unknown };
    const status = resetStatusFrom(cached.status);
    if (status && typeof cached.fetchedAt === 'number' && nowMs >= cached.fetchedAt
      && nowMs - cached.fetchedAt < CODEX_RESET_CACHE_MS) {
      return { status, fetchedAt: cached.fetchedAt, available: true };
    }
  } catch { /* no usable cache */ }
  try {
    const response = await (options.fetcher ?? fetch)(CODEX_RESET_URL, {
      method: 'GET', headers: { accept: 'application/json' }, signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) return { available: false };
    const status = resetStatusFrom(await response.json());
    if (!status) return { available: false };
    try {
      mkdirSync(dirname(cacheFile), { recursive: true });
      writeFileSync(cacheFile, JSON.stringify({ fetchedAt: nowMs, status }));
    } catch { /* a cache write is best effort */ }
    return { status, fetchedAt: nowMs, available: true };
  } catch { return { available: false }; }
}

export function codexHoursUntil100(account: AccountUsage, announcedAt: string | undefined, nowMs: number): number | undefined {
  if (typeof account.used !== 'number') return undefined;
  const paceStart = codexPaceStartSeconds(account, announcedAt);
  if (account.windowMinutes === undefined || paceStart === undefined || account.used <= 0) return undefined;
  const now = nowMs / 1000;
  const sampleAt = account.sampledAt ?? (account.ageSeconds === undefined ? Number.NaN : now - account.ageSeconds);
  if (!Number.isFinite(sampleAt) || sampleAt < paceStart) return undefined;
  if (account.used >= 100) return 0;
  const elapsedAtSample = (sampleAt - paceStart) / 3600;
  if (elapsedAtSample <= 0) return undefined;
  const percentPerHour = account.used / elapsedAtSample;
  if (percentPerHour <= 0) return undefined;
  const remaining = (100 - account.used) / percentPerHour - (now - sampleAt) / 3600;
  return Math.round(Math.max(0, remaining) * 10) / 10;
}

function codexPaceStartSeconds(account: AccountUsage, announcedAt: string | undefined): number | undefined {
  if (account.windowMinutes === undefined || account.windowResetsAt === undefined) return undefined;
  const windowStart = account.windowResetsAt - account.windowMinutes * 60;
  const latestReset = announcedAt ? Date.parse(announcedAt) / 1000 : Number.NaN;
  return Number.isFinite(latestReset) ? Math.max(windowStart, latestReset) : windowStart;
}

export interface GoalUsageReport {
  claude: UsageReport & { file: string };
  codex: (Omit<AccountUsage, 'windowResetsAt' | 'sampledAt'> & {
    pace_since: string | 'unavailable'; hours_until_100_percent: number | 'unavailable';
  })[];
  codex_resets: {
    source: 'Data from codex-resets.com'; status?: 'unavailable';
    latest_reset?: { announced_at: string | 'unavailable'; age_hours: number | 'unavailable' };
    stats?: { avg_interval_days: number | 'unavailable' };
  };
}

export async function usageReport(options: {
  fetcher?: (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>; cacheFile?: string; nowMs?: number;
} = {}): Promise<GoalUsageReport> {
  const nowMs = options.nowMs ?? Date.now();
  const reset = await loadCodexResetStatus({ ...options, nowMs });
  const announcedAt = reset.status?.data?.latest_reset?.announced_at;
  const announcedMs = announcedAt ? Date.parse(announcedAt) : Number.NaN;
  const ageHours = Number.isFinite(announcedMs) ? Math.round(Math.max(0, nowMs - announcedMs) / 360_000) / 10 : 'unavailable';
  const interval = reset.status?.data?.stats?.avg_interval_days;
  const accounts = codexAccounts();
  return {
    claude: { ...currentUsage(), file: usagePath },
    codex: accounts.map(account => {
      const paceStart = reset.available ? codexPaceStartSeconds(account, announcedAt) : undefined;
      const publicAccount = Object.fromEntries(Object.entries(account)
        .filter(([key]) => key !== 'windowResetsAt' && key !== 'sampledAt')) as Omit<AccountUsage, 'windowResetsAt' | 'sampledAt'>;
      return { ...publicAccount,
        pace_since: paceStart === undefined ? 'unavailable' : new Date(paceStart * 1000).toISOString(),
        hours_until_100_percent: paceStart === undefined ? 'unavailable'
          : codexHoursUntil100(account, announcedAt, nowMs) ?? 'unavailable' };
    }),
    codex_resets: reset.available ? {
      source: 'Data from codex-resets.com',
      latest_reset: { announced_at: announcedAt ?? 'unavailable', age_hours: ageHours },
      stats: { avg_interval_days: typeof interval === 'number' ? interval : 'unavailable' },
    } : { source: 'Data from codex-resets.com', status: 'unavailable' },
  };
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

export function memoryFloorRefusal(meminfo: string, floorGiB = 12): string | undefined {
  if (!Number.isFinite(floorGiB) || floorGiB < 0) throw new Error('GOAL_MEMORY_FLOOR_GIB must be a finite non-negative number');
  const availableKiB = /^MemAvailable:\s+(\d+)\s+kB\s*$/m.exec(meminfo)?.[1];
  if (availableKiB === undefined) throw new Error('Cannot determine host MemAvailable from /proc/meminfo; refusing to launch');
  const availableGiB = Number(availableKiB) / (1024 * 1024);
  return availableGiB < floorGiB
    ? `Memory floor reached: host MemAvailable ${availableGiB.toFixed(2)} GiB is below GOAL_MEMORY_FLOOR_GIB=${floorGiB}; let running workers finish`
    : undefined;
}

/** Dispatch and resume consume the same host capacity and the selected engine's account. */
function launchGates(tasks: Task[], engine: Engine, forceUsage: boolean) {
  const live = tasks.filter(running).length;
  const limit = Number(process.env.GOAL_MAX_WORKERS ?? 25);
  if (live >= limit) throw new Error(`Concurrency limit reached: ${live}/${limit} live workers`);
  const memory = memoryFloorRefusal(readFileSync('/proc/meminfo', 'utf8'), Number(process.env.GOAL_MEMORY_FLOOR_GIB ?? 12));
  if (memory) throw new Error(memory);
  const usage = currentUsage();
  const account = codexAccounts().find(candidate => candidate.engines.includes(engine));
  if (!forceUsage) {
    if (isClaudeCode(engine) && ['restricted', 'critical'].includes(usage.level)) {
      throw new Error(`Claude usage is ${usage.level} (${usage.reason}); let running workers finish, `
        + 'use another engine or pass --force-usage');
    }
    if (account?.reached) throw new Error(`${describeAccount(account)}; use another engine or pass --force-usage`);
  }
  return { live, limit, usage, account };
}

export function workerSessionEnvironment(parent: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...parent };
  // A new worker has its own native session; inherited manager IDs misidentify it and its tools as that session's owner.
  delete env.CODEX_SESSION_ID;
  delete env.CODEX_THREAD_ID;
  return env;
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
    env: { ...workerSessionEnvironment(process.env), ...engineEnv(engine), GOAL_TASK_ID: task.id, GOAL_MANAGER: manager },
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

/** The branch's changes since it left main, with each file's content on both sides for `historyIntroductions`. */
function branchChanges(task: Task): ChangedFile[] {
  const base = git(root, ['merge-base', 'main', task.branch]);
  const show = (revision: string, path: string) => git(root, ['show', `${revision}:${path}`], true);
  return git(root, ['diff', '--name-status', '-M', `${base}..${task.branch}`]).split('\n').filter(Boolean).map(line => {
    const [code = 'M', first = '', second] = line.split('\t');
    const status = (['A', 'D', 'R'].includes(code[0]!) ? code[0] : 'M') as ChangedFile['status'];
    const path = second ?? first;
    const from = status === 'R' ? first : undefined;
    return { path, status, from, before: status === 'A' ? undefined : show(base, from ?? path),
      after: status === 'D' ? undefined : show(task.branch, path) };
  });
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
    const goal = briefGoal(ledger, absolute);
    const reservedBy = ledger.reserved?.[brief.id];
    if (reservedBy && reservedBy !== goal) throw new Error(`${brief.id} is reserved for Goal ${reservedBy}; take an ID with \`new\``);
    const tasks = Object.values(ledger.tasks);
    const conflicts = claimConflicts(brief, tasks);
    if (!flags.has('--allow-area')) conflicts.push(...areaConflicts(brief.paths, goal, areasOf(activeGoals(ledger))));
    if (conflicts.length) throw new Error(`Claim conflict for ${brief.id}:\n  ${conflicts.join('\n  ')}`);
    for (const id of brief.depends) {
      const dependency = ledger.tasks[id];
      if (!dependency) {
        throw new Error(`Unknown dependency ${id}; cross-Goal dependencies are contracts on the program's board `
          + '(docs/goals/program/state.md), not task IDs');
      }
      if (!['merged', 'verified'].includes(dependency.state)) {
        throw new Error(`${brief.id} depends on ${id}, which is ${dependency.state}`);
      }
    }
    const engine = brief.engine ?? DEFAULT_ENGINE;
    const { live, limit, usage, account } = launchGates(tasks, engine, flags.has('--force-usage'));
    const name = brief.worktree ? `${goal ?? 'legacy'}-${brief.worktree}` : brief.id.toLowerCase();
    const worktree = join(root, '.temp', 'worktrees', name);
    const branch = `goal/${name}`;
    if (brief.worktree && tasks.some(task => task.worktree === worktree && HOLDING.includes(task.state) && task.goal !== goal)) {
      throw new Error(`${worktree} has open tasks belonging to another Goal; use a different shared worktree`);
    }
    if (flags.has('--dry-run')) {
      console.log(`${brief.id}: claims ok; ${live}/${limit} live; ${account ? describeAccount(account) : `Claude usage ${usage.level}`}`);
      return;
    }
    const reuse = brief.worktree !== undefined && existsSync(worktree);
    if (existsSync(worktree) && !reuse) throw new Error(`${worktree} already exists; remove it or use another ID`);
    mkdirSync(join(stateDir, 'runs', brief.id), { recursive: true });
    if (!reuse) {
      // A shared branch outlives its worktree once its last task closes; reattach to it.
      const branchExists = git(root, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], true) !== '';
      git(root, branchExists && brief.worktree !== undefined ? ['worktree', 'add', '-q', worktree, branch]
        : ['worktree', 'add', '-q', worktree, '-b', branch, 'main']);
      const install = spawnSync('corepack', ['yarn', 'install', '--immutable'], { cwd: worktree, encoding: 'utf8' });
      writeFileSync(join(stateDir, 'runs', brief.id, 'install.log'), `${install.stdout}\n${install.stderr}`);
      if (install.status !== 0) throw new Error(`yarn install failed in ${worktree}; see runs/${brief.id}/install.log`);
    }
    mkdirSync(join(worktree, '.temp', 'goal'), { recursive: true });
    const { worktree: _shared, ...claims } = brief;
    const task: Task = { ...claims, brief: absolute, worktree, branch,
      base: reuse ? git(worktree, ['merge-base', 'HEAD', 'main']) : git(root, ['rev-parse', 'main']),
      state: 'running', attempts: [], ...brief.worktree ? { worktreeName: brief.worktree } : {},
      ...goal ? { goal } : {}, historyGate: true };
    copyFileSync(absolute, join(worktree, briefFile({ ...task, shared: !!task.worktreeName })));
    const manager = managerOf(ledger, goal);
    task.attempts.push(launch(task, brief.effort, isClaudeCode(engine) ? randomUUID() : '',
      workerPrompt(task, manager, engine), false, manager, engine));
    ledger.tasks[brief.id] = task;
    if (ledger.reserved) delete ledger.reserved[brief.id];
    ledger.lastId = Math.max(ledger.lastId ?? 0, Number(brief.id.slice(2)));
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
  if (task.land === 'auto' && lastAttempt(task).n === attempt.n) await landTask(task.id);
}

async function landTask(id: string): Promise<void> {
  const initial = taskOf(readLedger(), id);
  assertOwner(initial);
  const runDir = join(stateDir, 'runs', initial.id);
  mkdirSync(runDir, { recursive: true });
  const lock = join(runDir, 'land.lock');
  await acquireDir(lock, 120_000, `${initial.id} landing lock`);
  try {
    const snapshot = await withLedger(ledger => {
      const task = taskOf(ledger, id);
      assertOwner(task);
      if (running(task) || task.state !== 'exited') throw new Error(`${task.id}: land requires an exited task (${task.state})`);
      const sharers = Object.values(ledger.tasks).filter(other => other.id !== task.id
        && other.worktree === task.worktree && HOLDING.includes(other.state));
      if (sharers.length) throw new Error(`${task.id}: land requires a task with its own branch; open sharers: ${sharers.map(other => other.id).join(', ')}`);
      if (changedFiles(task).dirty.length) throw new Error(`${task.id}: land requires a clean worktree`);
      const attempt = lastAttempt(task);
      const result = readResult(attempt);
      if (result.error) throw new Error(`${task.id}: land stopped: worker handoff is missing or reports an error`);
      const brief = briefPathOf(task);
      if (!brief) throw new Error(`${task.id}: land stopped: assigned brief is missing`);
      const head = git(root, ['rev-parse', task.branch]);
      if (git(task.worktree, ['rev-parse', 'HEAD']) !== head
        || git(task.worktree, ['symbolic-ref', '--short', 'HEAD']) !== task.branch) {
        throw new Error(`${task.id}: land stopped: worktree is not on the task branch`);
      }
      return { task, attempt: attempt.n, handoff: result.text, brief: readFileSync(brief, 'utf8'),
        head, base: git(root, ['merge-base', 'main', task.branch]) };
    });
    await land({ id: snapshot.task.id, worktree: snapshot.task.worktree, runDir,
      brief: snapshot.brief, handoff: snapshot.handoff, base: snapshot.base, head: snapshot.head,
      scope: () => landScope(id),
      merge: permittedFiles => mergeTask(id, new Set(), snapshot.head, current => {
        if (current.state !== 'exited' || lastAttempt(current).n !== snapshot.attempt
          || current.branch !== snapshot.task.branch || current.worktree !== snapshot.task.worktree
          || readResult(lastAttempt(current)).text !== snapshot.handoff
          || readFileSync(briefPathOf(current) ?? '', 'utf8') !== snapshot.brief) {
          throw new Error(`${current.id}: task or brief changed during review; review again`);
        }
      }, permittedFiles), close: () => closeTasks([id], 'verified') });
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

async function resumeTask(id: string, args: string[]): Promise<void> {
  let message = '';
  let effort: string | undefined;
  let engine: Engine | undefined;
  let fresh = false;
  let forceUsage = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-m') message = args[++i] ?? '';
    else if (args[i] === '--file') message = readFileSync(args[++i] ?? '', 'utf8');
    else if (args[i] === '--effort') effort = args[++i];
    else if (args[i] === '--engine') engine = args[++i] as Engine;
    else if (args[i] === '--fresh') fresh = true;
    else if (args[i] === '--force-usage') forceUsage = true;
    else throw new Error(`Unsupported resume option: ${args[i]}`);
  }
  if (!message.trim()) throw new Error('resume needs -m <message> or --file <path>');
  await withLedger(ledger => {
    const task = taskOf(ledger, id);
    assertOwner(task);
    if (running(task)) throw new Error(`${task.id} is still running; stop it first or message it`);
    if (['verified', 'cancelled'].includes(task.state)) throw new Error(`${task.id} is closed`);
    const previous = lastAttempt(task);
    const nextEngine = engine ?? engineOf(previous);
    const nextEffort = effort ?? previous.effort;
    if (!effortsOf(nextEngine).includes(nextEffort)) {
      throw new Error(`${nextEngine} effort must be one of ${effortsOf(nextEngine).join(', ')}`);
    }
    launchGates(Object.values(ledger.tasks), nextEngine, forceUsage);
    const manager = managerOf(ledger, task.goal);
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


/** Detached children inherit the launcher's task marker even if they change cwd.
 * Without a task ID, sweep the worktree only when its last live worker has stopped.
 * Linux only: reads /proc. */
export function killWorktreeProcesses(worktree: string, taskId?: string, signal: NodeJS.Signals = 'SIGTERM'): number {
  if (!existsSync('/proc')) return 0;
  const prefix = worktree.endsWith('/') ? worktree : `${worktree}/`;
  const victims: number[] = [];
  for (const entry of readdirSync('/proc')) {
    const pid = Number(entry);
    if (!Number.isInteger(pid) || pid === process.pid) continue;
    try {
      if (taskId) {
        if (readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0').includes(`GOAL_TASK_ID=${taskId}`)) victims.push(pid);
      } else {
        const cwd = readlinkSync(`/proc/${pid}/cwd`);
        if (cwd === worktree || cwd.startsWith(prefix)) victims.push(pid);
      }
    } catch { /* exited or not ours */ }
  }
  for (const pid of victims) { try { process.kill(pid, signal); } catch { /* gone */ } }
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

/** Handoffs cite files under the worktree's `.temp` (profiles, corpus backups,
 * prepared patches); keep them beside the task's run records when the worktree goes. */
export function preserveWorktreeArtifacts(worktree: string, runDir: string): string | null {
  const source = join(worktree, '.temp');
  if (!existsSync(source)) return null;
  mkdirSync(runDir, { recursive: true });
  let target = join(runDir, 'worktree-temp');
  if (existsSync(target)) target = `${target}-${Date.now()}`;
  renameSync(source, target);
  return target;
}

async function stopTask(id: string): Promise<void> {
  // Keep dispatch/resume from adding a live sharer between the last-worker check and the cwd sweep.
  await withLedger(async ledger => {
    const task = taskOf(ledger, id);
    assertOwner(task);
    const attempt = lastAttempt(task);
    const program = programOf(engineOf(attempt));
    const signalGroup = (signal: NodeJS.Signals) => {
      if (!pidAlive(attempt.pid, program)) return;
      try { process.kill(-attempt.pid, signal); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
    };
    signalGroup('SIGTERM');
    const deadline = Date.now() + 30_000;
    let children = killWorktreeProcesses(task.worktree, task.id);
    while ((pidAlive(attempt.pid, program) || children) && Date.now() < deadline) {
      await Bun.sleep(100);
      children = killWorktreeProcesses(task.worktree, task.id);
    }
    signalGroup('SIGKILL');
    killWorktreeProcesses(task.worktree, task.id, 'SIGKILL');
    const liveSharers = Object.values(ledger.tasks).some(other => other.id !== task.id
      && other.worktree === task.worktree && HOLDING.includes(other.state) && running(other));
    if (!liveSharers) {
      killWorktreeProcesses(task.worktree);
      removeWorktreeStack(task.worktree);
    }
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

/**
 * Migrations a branch adds that sort before a migration already on main. Fixture manifests refuse a
 * migration inserted before applied ones, so such a branch must renumber before it merges.
 */
export function migrationsBelowMain(added: readonly string[], listMain: (directory: string) => string[]): string[] {
  const late: string[] = [];
  const byDirectory = new Map<string, string[]>();
  for (const path of added) {
    const match = /^(.*\/migrations\/[^/]+)\/(\d+)_[^/]+\.sql$/.exec(path);
    if (match) byDirectory.set(match[1]!, [...byDirectory.get(match[1]!) ?? [], path]);
  }
  for (const [directory, paths] of byDirectory) {
    const own = new Set(paths.map(path => path.slice(directory.length + 1)));
    const highest = Math.max(0, ...listMain(directory).filter(name => !own.has(name))
      .map(name => Number(/^(\d+)_/.exec(name)?.[1] ?? 0)));
    for (const path of paths) {
      const number = Number(/\/(\d+)_[^/]+\.sql$/.exec(path)![1]);
      if (number <= highest) late.push(`${path} (main already has ${highest})`);
    }
  }
  return late;
}

interface MigrationRename { from: string; to: string; number: number; next: number }

const migrationPath = /^(.*\/migrations\/[^/]+)\/(\d+)_[^/]+\.sql$/;
const escapePattern = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const numberToken = (number: number) => `(?<![\\w$])0*${number}(?![\\w$]|\\.\\d)`;

/** Numeric data alone cannot prove a reference: only named migration/version declarations qualify. */
function migrationNumberContexts(number: number): RegExp[] {
  const token = numberToken(number);
  return [new RegExp(`\\bmigration\\s+(${token})`, 'gi'),
    new RegExp(`\\b(?:const|let|var)\\s+(?:[\\w$]*(?:migration|version)[\\w$]*)(?:\\s*:\\s*number)?\\s*=\\s*(['"]?)(${token})\\1(?![\\d.])`, 'gi')];
}

/** Plan every rewrite before mutating: uncertainty leaves a clean branch for manual renumbering. */
function normalizeMigrations(worktree: string, branch: string): string | MigrationRename[] {
  // https://git-scm.com/docs/git-diff documents the A filter; existing main migrations may not move.
  const added = git(worktree, ['diff', '--find-renames', '--diff-filter=A', '--name-only', `main..${branch}`])
    .split('\n').filter(path => migrationPath.test(path));
  const listMain = (directory: string) => git(worktree, ['ls-tree', '--name-only', 'main', `${directory}/`])
    .split('\n').filter(Boolean).map(path => basename(path));
  const directories = new Set(added.map(path => dirname(path)));
  const renames: MigrationRename[] = [];
  for (const directory of directories) {
    const highest = Math.max(0, ...listMain(directory).map(name => Number(/^(\d+)_/.exec(name)?.[1] ?? 0)));
    const own = added.filter(path => dirname(path) === directory)
      .sort((a, b) => Number(migrationPath.exec(a)![2]) - Number(migrationPath.exec(b)![2]) || a.localeCompare(b));
    if (!own.some(path => Number(migrationPath.exec(path)![2]) <= highest)) continue;
    // Move the directory's entire added sequence to keep its order, including additions above main.
    const occupied = new Set(readdirSync(join(worktree, directory)).map(name => Number(/^(\d+)_/.exec(name)?.[1] ?? 0)));
    let next = highest;
    for (const from of own) {
      do { next++; } while (occupied.has(next));
      if (!Number.isSafeInteger(next)) return `${directory}: migration number exceeds the safe integer range; renumber by hand`;
      occupied.add(next);
      const digits = migrationPath.exec(from)![2]!;
      const to = join(directory, basename(from).replace(/^\d+/, String(next).padStart(Math.max(3, digits.length), '0')));
      renames.push({ from, to, number: Number(digits), next });
    }
  }
  if (!renames.length) return [];
  const plannedPaths = new Map(renames.map(rename => [rename.from, rename.to]));
  const early = migrationsBelowMain(added.map(path => plannedPaths.get(path) ?? path), listMain);
  if (early.length) return `planned migrations still fall below main:\n  ${early.join('\n  ')}`;
  const changed = new Set(git(worktree, ['diff', '--name-only', `main..${branch}`]).split('\n').filter(Boolean));
  const files = git(worktree, ['ls-files', '-z']).split('\0').filter(Boolean);
  const writes = new Map<string, string>();
  const numbers = new Set(renames.map(rename => rename.number));
  for (const file of files) {
    const path = join(worktree, file);
    const kind = lstatSync(path);
    if (!kind.isFile() && !kind.isSymbolicLink()) continue;
    const source = kind.isSymbolicLink() ? readlinkSync(path) : readFileSync(path, 'utf8');
    const self = renames.find(rename => rename.from === file);
    const selfToken = self ? new RegExp(`(?<!\\d)0*${self.number}(?!\\d)`, 'g') : undefined;
    const mentions = [...numbers].filter(number => migrationNumberContexts(number).some(pattern => pattern.test(source))
      || renames.some(rename => rename.number === number
        && new RegExp(`(?<![\\w.-])${escapePattern(basename(rename.from))}(?![\\w.-])`).test(source))
      || (self?.number === number && selfToken?.test(source)));
    if (!mentions.length) continue;
    if (!changed.has(file)) return `${file} references old migration number ${mentions.join(', ')} outside the task's changed files; renumber by hand`;
    if (!kind.isFile()) return `${file}: migration reference is in a symbolic link; renumber by hand`;
    const edits = new Map<number, { end: number; value: string }>();
    const addEdit = (start: number, end: number, value: string) => {
      const existing = edits.get(start);
      if (existing && (existing.end !== end || existing.value !== value)) throw new Error(`${file}: ambiguous migration reference; renumber by hand`);
      edits.set(start, { end, value });
    };
    // Qualified filenames select the directory even when two owners used the same basename.
    for (const rename of renames) {
      const pattern = new RegExp(`(?<![\\w.-])${escapePattern(rename.from)}(?![\\w.-])`, 'g');
      for (const match of source.matchAll(pattern)) {
        const start = match.index + rename.from.length - basename(rename.from).length;
        addEdit(start, start + /^\d+/.exec(basename(rename.from))![0].length, /^\d+/.exec(basename(rename.to))![0]);
      }
    }
    for (const rename of renames) {
      const pattern = new RegExp(`(?<![\\w.-])${escapePattern(basename(rename.from))}(?![\\w.-])`, 'g');
      for (const match of source.matchAll(pattern)) {
        if (edits.has(match.index)) continue;
        const qualified = /([\w./-]+\/migrations\/[^/]+)\/$/.exec(source.slice(0, match.index));
        if (qualified) return `${file}: filename ${basename(rename.from)} refers to a directory not being renumbered (${qualified[1]}); renumber by hand`;
        const targets = new Set(renames.filter(other => basename(other.from) === basename(rename.from)).map(other => other.to));
        if (targets.size !== 1) return `${file}: filename ${basename(rename.from)} is ambiguous across directories; renumber by hand`;
        addEdit(match.index, match.index + /^\d+/.exec(match[0])![0].length, /^\d+/.exec(basename(rename.to))![0]);
      }
    }
    for (const number of mentions) {
      // These contexts identify a migration reference without guessing what other numeric data means.
      for (const pattern of migrationNumberContexts(number)) {
        for (const match of source.matchAll(pattern)) {
          const old = match[match.length - 1]!;
          const start = match.index + match[0].lastIndexOf(old);
          if ([...edits].some(([offset, edit]) => start >= offset && start < edit.end)) continue;
          const candidates = self ? renames.filter(rename => dirname(rename.from) === dirname(file)) : renames;
          const targets = new Set(candidates.filter(rename => rename.number === number).map(rename => rename.next));
          if (targets.size !== 1) return `${file}: migration ${number} is ambiguous across directories; renumber by hand`;
          addEdit(start, start + old.length, String([...targets][0]));
        }
      }
    }
    if (self && selfToken) {
      selfToken.lastIndex = 0;
      for (const match of source.matchAll(selfToken)) {
        if (![...edits].some(([start, edit]) => match.index >= start && match.index < edit.end)) {
          return `${file}: its own migration number ${self.number} occurs outside a proven migration context; renumber by hand`;
        }
      }
    }
    let rewritten = source;
    for (const [start, edit] of [...edits].sort(([a], [b]) => b - a)) rewritten = rewritten.slice(0, start) + edit.value + rewritten.slice(edit.end);
    if (rewritten !== source) {
      if (!Buffer.from(source).equals(readFileSync(path))) return `${file}: migration references are not UTF-8 text; renumber by hand`;
      writes.set(file, rewritten);
    }
  }
  for (const rename of renames) {
    if (!lstatSync(join(worktree, rename.from)).isFile()) return `${rename.from}: migration is not a regular file; renumber by hand`;
  }
  for (const [file, source] of writes) writeFileSync(join(worktree, file), source);
  for (const rename of renames) renameSync(join(worktree, rename.from), join(worktree, rename.to));
  git(worktree, ['add', '--', ...new Set([...writes.keys(), ...renames.flatMap(rename => [rename.from, rename.to])])]);
  git(worktree, ['commit', '-q', '-m', 'Normalize migration numbers after rebase (goalctl)']);
  console.log(`Migration normalization:\n  ${renames.map(rename => `${rename.from} -> ${rename.to}`).join('\n  ')}`);
  return renames;
}

/** A hand-landed cherry-pick is attributable only across its contiguous patch-equivalent suffix.
 * An unknown boundary is recorded with zero width, so unrelated manager commits cannot be blamed on this task. */
export function landedBoundary(repo: string, task: Pick<Task, 'base' | 'branch'>, after: string): string {
  const patch = (commit: string) => {
    const diff = git(repo, ['show', '--format=', commit]);
    // Whitespace can change strings and indentation-sensitive files; stable patch IDs discard it.
    return git(repo, ['patch-id', '--verbatim'], false, { input: diff }).split(' ')[0];
  };
  const patches = new Set(git(repo, ['rev-list', `${task.base}..${task.branch}`, '--not', 'main']).split('\n').filter(Boolean).map(patch));
  patches.delete('');
  if (!patches.size && git(repo, ['rev-parse', task.branch]) === after) {
    const reflog = git(repo, ['reflog', 'show', 'main', '--format=%H%x09%gs']).split('\n');
    if (reflog[0]?.startsWith(`${after}\tmerge ${task.branch}: Fast-forward`) && reflog[1]) return reflog[1].split('\t')[0]!;
  }
  let before = after;
  for (const commit of git(repo, ['rev-list', '--first-parent', `${task.base}..${after}`]).split('\n').filter(Boolean)) {
    if (!patches.has(patch(commit))) break;
    before = git(repo, ['rev-parse', `${commit}^`]);
  }
  return before;
}

/** Add inventory guards to backend units from the public affected plan;
 * whole-unit widening uses its registered defaults. Both share the existing gate. */
export function mergeUnitFiles(worktree: string, plan: string): string[] {
  if (!/^Affected since /m.test(plan)) throw new Error('Affected unit plan was not produced');
  const entries = [...plan.matchAll(/^  unit: (.+)$/gm)].map(match => match[1]!);
  const selected = new Set<string>();
  const collect = (file: string) => {
    const path = resolve(worktree, file);
    if (relative(worktree, path).startsWith('..') || isAbsolute(file)) throw new Error(`Unit file outside worktree: ${file}`);
    // A file the branch deleted, or one main added after the branch's base, has nothing to run here.
    if (!existsSync(path)) return;
    if (statSync(path).isDirectory()) {
      for (const entry of readdirSync(path, { withFileTypes: true })) {
        if (entry.isDirectory() || /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(entry.name)) collect(join(file, entry.name));
      }
    } else selected.add(file);
  };
  for (const entry of entries) {
    if (entry.startsWith('whole tier (')) {
      for (const file of [...testArgs('unit'), ...unitHarnessFiles]) collect(file);
    } else collect(entry);
  }
  for (const guard of repositoryGuards) collect(guard.file);
  return [...selected].sort();
}

/** Files a failing bun run names: in AGENT mode bun prints a `path:` header only for files with failures or errors. */
export function failingTestFiles(output: string, candidates: readonly string[], root?: string): string[] {
  // bun prints a `path:` header before each file's results, including passing files next to a failure, so a
  // file counts only when a `(fail)` line or an unhandled error appears in its own section.
  const known = new Set(candidates);
  const found = new Set<string>();
  let current: string | undefined;
  for (const line of output.split('\n')) {
    const header = /^(\S+\.(?:test|spec)\.[cm]?[jt]sx?):$/.exec(line);
    if (header) {
      let file = header[1]!.replace(/^\.\//, '');
      if (root && isAbsolute(file)) file = relative(root, file);
      current = known.has(file) ? file : undefined;
    } else if (current && (/^\(fail\) /.test(line) || /^# Unhandled error/.test(line))) {
      found.add(current);
    }
  }
  return [...found].sort();
}

function positiveInteger(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  if (!/^[1-9]\d*$/.test(raw)) throw new Error(`${name} must be a positive integer`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) throw new Error(`${name} must be a positive integer`);
  return value;
}

/** Deal files so shard sizes differ by at most one. Fewer files than shards leaves no empty shard. */
export function balanceUnitShards(files: readonly string[], shards: number): string[][] {
  if (!files.length) return [];
  const count = Math.min(files.length, Math.max(1, Math.floor(shards)));
  const groups = Array.from({ length: count }, () => [] as string[]);
  for (let index = 0; index < files.length; index++) groups[index % count]!.push(files[index]!);
  return groups;
}

function unitGateShards(): number {
  return positiveInteger('GOAL_UNIT_GATE_SHARDS', 4);
}

/** Wall clock for every shard of one side. Twelve minutes: one Access-sized run previously waited past 25. */
function unitGateBudgetMs(): number {
  return positiveInteger('GOAL_UNIT_GATE_BUDGET_MS', 12 * 60 * 1000);
}

const UNIT_GATE_OUTPUT_CAP = 256 * 1024 * 1024;

async function within(limitMs: number, done: Promise<void>): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), limitMs); });
  const finished = await Promise.race([done.then(() => true as const), timeout]);
  if (timer) clearTimeout(timer);
  return finished;
}

/** `task` is not the test process. A new session lets the budget signal reach bun underneath it. */
async function stopProcessGroup(child: ChildProcess): Promise<void> {
  const pid = child.pid;
  if (!pid) return;
  const closed = new Promise<void>(resolve => {
    if (child.exitCode !== null || child.signalCode !== null) { resolve(); return; }
    child.once('close', () => resolve());
  });
  const signal = (name: NodeJS.Signals) => {
    try { process.kill(-pid, name); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
  };
  if (child.exitCode === null && child.signalCode === null) signal('SIGTERM');
  if (!(await within(2_000, closed)) && child.exitCode === null && child.signalCode === null) signal('SIGKILL');
  await within(5_000, closed);
}

interface UnitShardResult {
  done: boolean; failing: string[]; timedOut: string[]; failures: UnitFailureDetail[]; fileErrors: UnitFileErrorDetail[];
  runnerErrors: UnitRunnerError[]; files: string[]; output: string; ms: number;
}

function unitFileFromHeader(output: string, files: readonly string[], cwd: string): string | undefined {
  const known = new Set(files);
  const headers = [...output.matchAll(/^(\S+\.(?:test|spec)\.[cm]?[jt]sx?):$/gm)];
  for (let index = headers.length - 1; index >= 0; index--) {
    let file = headers[index]![1]!.replace(/^\.\//, '');
    if (isAbsolute(file)) file = relative(cwd, file);
    if (known.has(file)) return file;
  }
  return files.length === 1 ? files[0] : undefined;
}

/** Bun prints its test timeout as a failed test, so it needs a retry before it can decide a side. */
export function timedOutTestFiles(output: string, candidates: readonly string[], root?: string): string[] {
  const known = new Set(candidates);
  const found = new Set<string>();
  let current: string | undefined;
  for (const line of output.split('\n')) {
    const header = /^(\S+\.(?:test|spec)\.[cm]?[jt]sx?):$/.exec(line);
    if (header) {
      current = header[1]!.replace(/^\.\//, '');
      if (root && isAbsolute(current)) current = relative(root, current);
      if (!known.has(current)) current = undefined;
    } else if (current && /(?:timed out after\s+\d+(?:\.\d+)?\s*(?:ms|s)\b|timed out\s*\([^)]*\bagainst\b[^)]*\)|timeout of\s+\d+(?:\.\d+)?\s*(?:ms|s)\s+(?:was\s+)?exceeded)/i.test(line)) {
      found.add(current);
    }
  }
  return [...found].sort();
}

export function shardTimeoutFiles(output: string, candidates: readonly string[], root: string): string[] {
  return [...new Set([...timedOutTestFiles(output, candidates, root), ...[unitFileFromHeader(output, candidates, root)].filter(
    (file): file is string => file !== undefined)])].sort();
}

export interface UnitFailureDetail { file: string; test: string; detail?: string }
export interface UnitFileErrorDetail { file: string; detail: string }
export interface UnitRunnerError { files: string[]; diagnostic: string }

function isUnitErrorLine(line: string): boolean {
  return /^(?:error|Error|[A-Z][\w$]*(?:Error|Exception)):\s*/i.test(line.trim());
}

/** Capture each failed test's assertion detail without file-specific stack locations. */
export function unitFailureDetails(output: string, candidates: readonly string[], root?: string): UnitFailureDetail[] {
  const known = new Set(candidates);
  const found: UnitFailureDetail[] = [];
  const plain = output.replace(/\u001b\[[\d;]*m/g, '');
  let current: string | undefined;
  let errorLines: string[] | undefined;
  let collectingError = false;
  for (const line of plain.split('\n')) {
    const header = /^(\S+\.(?:test|spec)\.[cm]?[jt]sx?):$/.exec(line);
    if (header) {
      current = header[1]!.replace(/^\.\//, '');
      if (root && isAbsolute(current)) current = relative(root, current);
      if (!known.has(current)) current = undefined;
      errorLines = undefined;
      collectingError = false;
      continue;
    }
    const failure = /^\(fail\)\s+(.+?)(?:\s+\[[^\]]+\])?$/.exec(line);
    if (failure) {
      if (current) {
        const detail = errorLines?.join('\n').trim();
        found.push({ file: current, test: failure[1]!.trim(), ...(detail ? { detail: normalizeUnitFileError(detail, root) } : {}) });
      }
      errorLines = undefined;
      collectingError = false;
      continue;
    }
    if (isUnitErrorLine(line)) { errorLines = [line.trim()]; collectingError = true; }
    else if (collectingError && /^\s*at\s/.test(line)) collectingError = false;
    else if (collectingError) errorLines!.push(line.trimEnd());
  }
  return found;
}

export function normalizeUnitFileError(error: string, root?: string): string {
  let normalized = error.replace(/\u001b\[[\d;]*m/g, '').replace(/\r/g, '');
  if (root) normalized = normalized.split(root).join('<worktree>');
  return normalized
    .replace(/((?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.(?:tsx?|jsx?|sql|json|mjs|cjs)):\d+:\d+/g,
      '$1:<line>:<column>')
    .replace(/^(\s*(?:>\s*)?)\d+\s*\|\s?/gm, '$1<line> | ')
    .replace(/\b\d+(?:\.\d+)?\s*(?:ms|msec|milliseconds?|s|sec|seconds?)\b/gi, '<duration>')
    .trim();
}

function bunRunSummaryLine(line: string): boolean {
  return /^\s*(?:\d+\s+(?:pass|fail|skip|todo|error)\b|Ran\s+\d+\s+tests?\b|(?:Test Suites|Tests|Time|Duration):|Completed in\b)/i.test(line);
}

/** Retain file-scoped unhandled errors, separate from named assertion failures. */
export function unitFileErrorDetails(output: string, candidates: readonly string[], root?: string,
  failingFiles: readonly string[] = []): UnitFileErrorDetail[] {
  const known = new Set(candidates);
  const errors = new Map<string, string[][]>();
  const sections = new Map<string, string[]>();
  const plain = output.replace(/\u001b\[[\d;]*m/g, '');
  const namedFailures = new Set(unitFailureDetails(output, candidates, root).map(failure => failure.file));
  let current: string | undefined;
  let collecting = false;
  for (const line of plain.split('\n')) {
    const header = /^(\S+\.(?:test|spec)\.[cm]?[jt]sx?):$/.exec(line);
    if (header) {
      current = header[1]!.replace(/^\.\//, '');
      if (root && isAbsolute(current)) current = relative(root, current);
      if (!known.has(current)) current = undefined;
      if (current) sections.set(current, []);
      collecting = false;
      continue;
    }
    if (!current) continue;
    sections.get(current)!.push(line);
    if (/^# Unhandled error/i.test(line)) {
      const bucket = errors.get(current) ?? [];
      bucket.push([line.trim()]);
      errors.set(current, bucket);
      collecting = true;
    } else if (isUnitErrorLine(line)) {
      if (collecting || !namedFailures.has(current)) {
        const bucket = errors.get(current) ?? [];
        if (!collecting) bucket.push([]);
        bucket[bucket.length - 1]!.push(line.trim());
        errors.set(current, bucket);
        collecting = true;
      }
    } else if (collecting && bunRunSummaryLine(line)) collecting = false;
    else if (collecting && /^\((?:pass|fail|skip|todo)\)/.test(line)) collecting = false;
    else if (collecting && /^\s*at\s/.test(line)) {
      errors.get(current)!.at(-1)!.push(line.trimEnd());
    } else if (collecting && /^\(fail\)/.test(line)) collecting = false;
    else if (collecting) errors.get(current)!.at(-1)!.push(line.trimEnd());
  }
  for (const file of failingFiles) {
    if (errors.has(file) || namedFailures.has(file)) continue;
    const diagnostic = (sections.get(file) ?? []).filter(line => !bunRunSummaryLine(line)
      && !/^\((?:pass|fail|skip|todo)\)/.test(line)).join('\n').trim();
    if (diagnostic) errors.set(file, [[diagnostic]]);
  }
  return [...errors].flatMap(([file, blocks]) => blocks.map(lines => ({ file,
    detail: normalizeUnitFileError(lines.join('\n'), root) })));
}

interface UnitFinding { path: string[]; text: string }

function diffContainerKey(line: string): string | undefined {
  const match = /^(?:"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|([A-Za-z_$][\w$.-]*))\s*:\s*[\[{]\s*,?$/.exec(line.trim());
  return match?.[1] ?? match?.[2] ?? match?.[3];
}

function normalizedFindingLines(detail: string | undefined): UnitFinding[] {
  if (!detail) return [];
  const contexts: { indent: number; key: string }[] = [];
  const findings: UnitFinding[] = [];
  const updateContext = (indent: number, text: string) => {
    if (/^[}\]],?$/.test(text.trim())) {
      while (contexts.length && contexts.at(-1)!.indent >= indent) contexts.pop();
      return;
    }
    const key = diffContainerKey(text);
    if (!key) return;
    while (contexts.length && contexts.at(-1)!.indent >= indent) contexts.pop();
    contexts.push({ indent, key });
  };
  const normalizeText = (value: string) => value.replace(
    /((?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.(?:tsx?|jsx?|sql|json)):\d+(?::\d+)?/g, '$1:<line>');
  for (const line of detail.split('\n')) {
    const diff = /^(\s*)([+-])(\s*)(.*)$/.exec(line);
    if (diff) {
      // Bun replaces a leading space with the diff marker; the subject indentation follows it.
      const indent = diff[1]!.length + 1 + diff[3]!.length;
      const text = diff[4]!.trim();
      if (diff[2] === '+' && text && !/^(?:Received|Expected)(?:\s|$)/i.test(text)) {
        findings.push({ path: contexts.filter(frame => frame.indent < indent).map(frame => frame.key),
          text: normalizeText(text) });
      }
      updateContext(indent, text);
      continue;
    }
    const whitespace = /^(\s*)/.exec(line)![1]!;
    updateContext(whitespace.length, line.slice(whitespace.length));
  }
  return findings;
}

function unitFailureSignatures(file: string, failures: readonly UnitFailureDetail[], errors: readonly UnitFileErrorDetail[]): Map<string, number> {
  const signatures = new Map<string, number>();
  const add = (signature: string) => signatures.set(signature, (signatures.get(signature) ?? 0) + 1);
  for (const failure of failures.filter(item => item.file === file)) {
    const findings = normalizedFindingLines(failure.detail);
    if (findings.length) {
      for (const finding of findings) add(JSON.stringify(['test-finding', failure.test, finding.path, finding.text]));
    } else {
      add(JSON.stringify(['test-error', failure.test, normalizeUnitFileError(failure.detail ?? '')]));
    }
  }
  for (const error of errors.filter(item => item.file === file)) {
    add(JSON.stringify(['file-error', normalizeUnitFileError(error.detail)]));
  }
  return signatures;
}

export function introducedUnitFailureFiles(branchFiles: readonly string[], branch: readonly UnitFailureDetail[],
  main: readonly UnitFailureDetail[], branchErrors: readonly UnitFileErrorDetail[] = [],
  mainErrors: readonly UnitFileErrorDetail[] = []): string[] {
  return [...new Set(branchFiles.filter(file => {
    const mainSignatures = unitFailureSignatures(file, main, mainErrors);
    const branchSignatures = unitFailureSignatures(file, branch, branchErrors);
    return [...branchSignatures].some(([signature, count]) => count > (mainSignatures.get(signature) ?? 0));
  }))].sort();
}

async function runUnitShard(cwd: string, files: readonly string[], deadline: number): Promise<UnitShardResult> {
  const startedAt = Date.now();
  const unfinished = (output: string, timedOut: string[] = timedOutTestFiles(output, files, cwd)): UnitShardResult =>
    ({ done: false, failing: [], timedOut, failures: unitFailureDetails(output, files, cwd),
      fileErrors: unitFileErrorDetails(output, files, cwd),
      runnerErrors: [], files: [...files], output, ms: Date.now() - startedAt });
  // Inventory guards include owner files. Run the selected Bun files directly
  // through Task so the public selector's tier-mixing refusal cannot mask them.
  const child = spawn('task', ['goal:unit-files', '--', ...files.map(file => `./${file}`)], {
    cwd, env: { ...process.env, AGENT: '1' }, stdio: ['ignore', 'pipe', 'pipe'], detached: true,
  });
  const stdout: string[] = [];
  const stderr: string[] = [];
  let launchError: string | undefined;
  let bytes = 0;
  let truncated = false;
  const take = (bucket: string[]) => (chunk: string) => {
    bytes += chunk.length;
    if (truncated || bytes > UNIT_GATE_OUTPUT_CAP) { truncated = true; return; }
    bucket.push(chunk);
  };
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', take(stdout));
  child.stderr?.on('data', take(stderr));
  const output = () => `${stdout.join('')}\n${stderr.join('')}`;
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => {
    child.once('error', error => {
      launchError = `Unable to start unit runner: ${error.message}`;
      resolve({ code: null, signal: null });
    });
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  // Node fires a delay above 2^31-1 immediately; the budget is a deadline, not an overflow.
  const delay = Math.min(Math.max(0, deadline - Date.now()), 2_147_483_647);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'timeout'>(resolve => { timer = setTimeout(() => resolve('timeout'), delay); });
  try {
    const outcome = await Promise.race([closed.then(result => ({ kind: 'close' as const, ...result })), timeout]);
    if (outcome === 'timeout' || truncated || outcome.code === null) {
      await stopProcessGroup(child);
      const text = output();
      if (outcome !== 'timeout' && !truncated && outcome.code === null) {
        return { ...unfinished(text), runnerErrors: [{ files: [...files], diagnostic: launchError ?? (text.trim() || 'Unit runner could not be started') }] };
      }
      const timedOut = outcome === 'timeout'
        ? shardTimeoutFiles(text, files, cwd)
        : timedOutTestFiles(text, files, cwd);
      return unfinished(text, timedOut);
    }
    const text = output();
    const timedOut = timedOutTestFiles(text, files, cwd);
    const failures = unitFailureDetails(text, files, cwd);
    const namedFailing = outcome.code === 0 ? [] : failingTestFiles(text, files, cwd);
    const failing = [...new Set([...namedFailing, ...timedOut,
      ...failures.map(failure => failure.file)])];
    const fileErrors = unitFileErrorDetails(text, files, cwd, failing);
    const runnerErrors = outcome.code !== 0 && !namedFailing.length && !timedOut.length && !failures.length && !fileErrors.length
      ? [{ files: [...files], diagnostic: text.trim() || `task goal:unit-files exited with status ${outcome.code}` }]
      : [];
    // A failure bun did not attribute to a file counts against that shard.
    return { done: true, failing: outcome.code !== 0 && !failing.length ? [...files] : failing, timedOut, failures, fileErrors,
      runnerErrors, files: [...files], output: text,
      ms: Date.now() - startedAt };
  } catch {
    // A shard that cannot be reaped is unfinished, not a merge-blocking failure.
    try { await stopProcessGroup(child); } catch { /* already unfinished */ }
    return unfinished(output());
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Parallel `task test` shards under one wall-clock budget. An unfinished shard makes the side inconclusive:
 * failures from shards that did finish are not a verdict, because the set was not fully run. */
export async function runUnitGate(cwd: string, files: readonly string[], shards?: number): Promise<{
  done: boolean; failing: string[]; timedOut: string[]; failures: UnitFailureDetail[];
  fileErrors: UnitFileErrorDetail[]; runnerErrors: UnitRunnerError[]; unfinished: string[]; output: string;
}> {
  if (!files.length) return { done: true, failing: [], timedOut: [], failures: [], fileErrors: [], runnerErrors: [], unfinished: [], output: '' };
  const groups = balanceUnitShards(files, shards ?? unitGateShards());
  const budget = unitGateBudgetMs();
  console.log(`Unit gate: ${files.length} file(s) in ${groups.length} shard(s), budget ${budget}ms`);
  const deadline = Date.now() + budget;
  const results = await Promise.all(groups.map(group => runUnitShard(cwd, group, deadline)));
  for (const result of results) {
    console.log(`Unit gate shard: ${result.files.length} file(s), ${result.done ? `${result.failing.length} failing` : 'unfinished'} in ${result.ms}ms`);
  }
  const output = results.map(result => result.output).join('\n');
  const unfinished = results.filter(result => !result.done).flatMap(result => result.files).sort();
  const timedOut = [...new Set(results.flatMap(result => result.timedOut))].sort();
  const completed = results.filter(result => result.done);
  const failing = [...new Set(completed.flatMap(result => result.failing))].sort();
  const failures = completed.flatMap(result => result.failures);
  const fileErrors = completed.flatMap(result => result.fileErrors);
  const runnerErrors = results.flatMap(result => result.runnerErrors);
  if (unfinished.length) return { done: false, failing, timedOut, failures, fileErrors, runnerErrors, unfinished, output };
  return { done: true, failing, timedOut, failures, fileErrors, runnerErrors, unfinished: [], output };
}

function reportUnfinished(side: 'affected' | 'main', unfinished: readonly string[]): void {
  const count = `${unfinished.length} file${unfinished.length === 1 ? '' : 's'}`;
  const lead = side === 'main'
    ? `Unit gate inconclusive: main's run of ${count} did not finish`
    : `Unit gate inconclusive: the affected run did not finish (${count})`;
  console.log(`${lead}\n  ${unfinished.join('\n  ')}`);
}

interface TimeoutRetryResult {
  failing: string[]; passing: string[]; unfinished: string[]; inconclusive: string[];
  failures: UnitFailureDetail[]; fileErrors: UnitFileErrorDetail[]; runnerErrors: UnitRunnerError[];
}

async function retryTimedOutFiles(cwd: string, files: readonly string[], side: 'affected' | 'main'): Promise<TimeoutRetryResult> {
  const result: TimeoutRetryResult = { failing: [], passing: [], unfinished: [], inconclusive: [], failures: [], fileErrors: [], runnerErrors: [] };
  for (const file of [...new Set(files)].sort()) {
    console.log(`Unit gate: ${file} timed out on ${side}; rerunning alone`);
    const retry = await runUnitGate(cwd, [file], 1);
    if (retry.runnerErrors.length) {
      result.inconclusive.push(file);
      result.runnerErrors.push(...retry.runnerErrors);
      console.log(`Unit gate inconclusive: runner failure when retrying ${file} alone on ${side}:\n${retry.runnerErrors.map(error => error.diagnostic).join('\n')}`);
    } else if (!retry.done) {
      result.unfinished.push(...retry.unfinished);
      result.inconclusive.push(file);
      reportUnfinished(side, retry.unfinished);
    } else if (retry.timedOut.includes(file)) {
      result.inconclusive.push(file);
      console.log(`Unit gate inconclusive: ${file} timed out again when run alone on ${side}`);
    } else if (retry.failing.includes(file)) {
      result.failing.push(file);
      result.failures.push(...retry.failures.filter(failure => failure.file === file));
      result.fileErrors.push(...retry.fileErrors.filter(error => error.file === file));
    } else result.passing.push(file);
  }
  return result;
}

function runnerErrorRefusal(side: 'affected' | 'main', errors: readonly UnitRunnerError[]): string {
  const detail = errors.map(error => {
    const diagnostic = error.diagnostic.length > 12_000
      ? `[showing the last 12,000 characters]\n${error.diagnostic.slice(-12_000)}` : error.diagnostic;
    return `  ${error.files.join(', ')}:\n${diagnostic}`;
  }).join('\n');
  return `unit gate inconclusive: unattributed ${side} runner failure; not merging:\n${detail}`;
}

/** Streams retain responsibility for failures from earlier merges, including shared-branch merges. */
export function streamUnitBaseline(events: readonly MergeEvent[], taskIds: readonly string[], current: string): string {
  return events.find(event => event.before !== event.after && event.taskIds.some(id => taskIds.includes(id)))?.before ?? current;
}

/** A branch failure is inherited only when main has the same failing test and assertion detail. */
async function preMergeUnitGate(worktree: string, mainRoot: string, before: string, skip: boolean, gatedFiles: Set<string>): Promise<string | undefined> {
  if (skip) {
    console.log('Unit gate skipped: --skip-unit-gate explicitly requested by the manager');
    return;
  }
  // For a stream this includes its earlier landed changes, so failures from those changes are selected again.
  // The first-merge boundary also prevents earlier guard failures from being classified as inherited.
  const base = spawnSync('git', ['merge-base', 'HEAD', before], { cwd: worktree, encoding: 'utf8' }).stdout.trim() || before;
  const plan = spawnSync('task', ['test', '--', '--affected', base, '--list'],
    { cwd: worktree, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (plan.status !== 0) throw new Error(`Affected unit selection failed:\n${plan.stderr || plan.error?.message}`);
  const files = mergeUnitFiles(worktree, plan.stdout);
  for (const file of files) gatedFiles.add(file);
  console.log(`Pre-merge unit gate: ${files.length} affected/guard file(s) against main ${before.slice(0, 12)}`);
  if (!files.length) return;
  // Run the branch first. A timeout is retried alone; any still-unresolved file keeps this merge inconclusive.
  const branch = await runUnitGate(worktree, files);
  let branchFailureFiles = branch.failing;
  let branchTimedOut = branch.timedOut;
  let branchTimeoutRetry: TimeoutRetryResult = { failing: [], passing: [], unfinished: [], inconclusive: [], failures: [], fileErrors: [], runnerErrors: [] };
  if (branch.runnerErrors.length) return runnerErrorRefusal('affected', branch.runnerErrors);
  if (!branch.done) {
    branchTimeoutRetry = await retryTimedOutFiles(worktree, branch.timedOut, 'affected');
    if (branchTimeoutRetry.runnerErrors.length) return runnerErrorRefusal('affected', branchTimeoutRetry.runnerErrors);
    branchFailureFiles = [...new Set([...branch.failing, ...branchTimeoutRetry.failing])].sort();
    const unresolved = [...new Set([
      ...branch.unfinished.filter(file => !branch.timedOut.includes(file)),
      ...branchTimeoutRetry.inconclusive,
    ])].sort();
    if (unresolved.length) {
      reportUnfinished('affected', unresolved);
      return `unit gate remains inconclusive after isolated timeout retry:\n  ${unresolved.join('\n  ')}`;
    }
    branchTimedOut = branch.timedOut;
  }
  if (!branchFailureFiles.length) {
    console.log(`Pre-merge unit gate: every affected unit file and repository guard ${branch.done ? 'passes' : 'passes after isolated retry'}`);
    return;
  }
  console.log(`Unit gate: ${branchFailureFiles.length} file(s) fail on the branch:\n${branch.output.slice(-20_000)}`);
  // A file can fail beside its shard-mates and pass when those failures run together. Confirm those together,
  // then retry every timeout alone so the side's decision comes from its isolated run.
  const together = branchFailureFiles.filter(file => !branchTimedOut.includes(file));
  const confirmed = together.length ? await runUnitGate(worktree, together, 1)
    : { done: true, failing: [], timedOut: [], failures: [], fileErrors: [], runnerErrors: [], unfinished: [], output: '' };
  if (confirmed.runnerErrors.length) return runnerErrorRefusal('affected', confirmed.runnerErrors);
  const alreadyRetried = new Set(branch.done ? [] : branch.timedOut);
  const retryNewTimeouts = (files: readonly string[]) => files.filter(file => !alreadyRetried.has(file));
  let retry: TimeoutRetryResult;
  if (!confirmed.done) {
    retry = await retryTimedOutFiles(worktree, retryNewTimeouts([...branchTimedOut, ...confirmed.timedOut]), 'affected');
  } else retry = await retryTimedOutFiles(worktree, retryNewTimeouts([...branchTimedOut, ...confirmed.timedOut]), 'affected');
  const confirmedFailures = [...new Set([
    ...(!branch.done ? branchTimeoutRetry.failing : []),
    ...(confirmed.done ? confirmed.failing.filter(file => !confirmed.timedOut.includes(file)) : []),
    ...retry.failing,
  ])].sort();
  const branchUnresolved = [...new Set([
    ...(!confirmed.done ? confirmed.unfinished.filter(file => !confirmed.timedOut.includes(file)) : []),
    ...retry.inconclusive,
  ])].sort();
  if (retry.runnerErrors.length) return runnerErrorRefusal('affected', retry.runnerErrors);
  if (branchUnresolved.length) {
    reportUnfinished('affected', branchUnresolved);
    return `unit gate remains inconclusive after isolated timeout retry:\n  ${branchUnresolved.join('\n  ')}`;
  }
  const confirmedDetails = [
    ...(!branch.done ? branchTimeoutRetry.failures : []),
    ...(confirmed.done ? confirmed.failures.filter(failure => !confirmed.timedOut.includes(failure.file)) : []),
    ...retry.failures,
  ];
  const confirmedFileErrors = [
    ...(!branch.done ? branchTimeoutRetry.fileErrors : []),
    ...confirmed.fileErrors.filter(error => !confirmed.timedOut.includes(error.file)),
    ...retry.fileErrors,
  ];
  const orderDependent = branch.done && confirmed.done ? together.filter(file => !confirmed.failing.includes(file)) : [];
  if (orderDependent.length) {
    console.log(`Unit gate: ${orderDependent.length} file(s) failed only across shards; order-dependent, reported, not blocking\n  ${orderDependent.join('\n  ')}`);
  }
  if (!confirmedFailures.length) return;
  const introduced = confirmedFailures.filter(file =>
    spawnSync('git', ['cat-file', '-e', `${before}:${file}`], { cwd: mainRoot }).status !== 0);
  const existing = confirmedFailures.filter(file => !introduced.includes(file));
  let directory: string | undefined;
  try {
    if (existing.length) {
      // Keep the checkout shallow: owner unit gates bind PostgreSQL sockets below it.
      mkdirSync(join(mainRoot, '.temp'), { recursive: true });
      directory = mkdtempSync(join(mainRoot, '.temp/unit-gate-'));
      git(mainRoot, ['worktree', 'add', '--detach', directory, before]);
      // Own workspace links keep the baseline on HEAD even when main has local source edits.
      const install = spawnSync('task', ['install'], { cwd: directory, encoding: 'utf8', timeout: 120_000 });
      if (install.status !== 0) throw new Error(`Unit baseline dependency install failed:\n${install.stdout}\n${install.stderr}`);
      const main = await runUnitGate(directory, existing);
      if (main.runnerErrors.length) return runnerErrorRefusal('main', main.runnerErrors);
      const mainRetry = await retryTimedOutFiles(directory, main.timedOut, 'main');
      if (mainRetry.runnerErrors.length) return runnerErrorRefusal('main', mainRetry.runnerErrors);
      const mainUnresolved = [...new Set([
        ...main.unfinished.filter(file => !main.timedOut.includes(file)),
        ...mainRetry.inconclusive,
      ])].sort();
      const affecting = existing.filter(file => mainUnresolved.includes(file));
      if (affecting.length) {
        reportUnfinished('main', affecting);
        return `unit gate remains inconclusive on main after isolated timeout retry:\n  ${affecting.join('\n  ')}`;
      }
      for (const file of existing) {
        const mainDetails = mainRetry.failing.includes(file)
          ? mainRetry.failures.filter(failure => failure.file === file)
          : mainRetry.passing.includes(file) ? []
          : main.failures.filter(failure => failure.file === file && !main.timedOut.includes(failure.file));
        const mainFileErrors = mainRetry.failing.includes(file)
          ? mainRetry.fileErrors.filter(error => error.file === file)
          : mainRetry.passing.includes(file) ? []
          : main.fileErrors.filter(error => error.file === file && !main.timedOut.includes(error.file));
        if (introducedUnitFailureFiles([file], confirmedDetails.filter(failure => failure.file === file),
          mainDetails, confirmedFileErrors.filter(error => error.file === file), mainFileErrors).includes(file)) introduced.push(file);
        else console.log(`Unit gate: ${file} also fails on main ${before.slice(0, 12)} with identical failure details; reported, not blocking`);
      }
    }
  } finally {
    if (directory) {
      git(mainRoot, ['worktree', 'remove', '--force', directory]);
      rmSync(directory, { recursive: true, force: true });
    }
  }
  return introduced.length ? `introduced unit failures; not merging:\n  ${introduced.sort().join('\n  ')}` : undefined;
}

async function mergeTask(id: string, flags: Set<string>, expectedHead?: string,
  reviewGuard?: (task: Task) => void, landPermittedFiles?: readonly string[]): Promise<void> {
  type PreparedMerge = { before: string; baseline: string; after: string; worktree: string; branch: string; sharers: string[]; committed: string[] };
  // Return the refusal so withLedger writes `conflict` before the error is thrown. A throw inside the
  // callback would discard the state change, and main would stay eligible for a fast-forward retry.
  const prepareMerge = (ledger: Ledger): string | PreparedMerge | undefined => {
    const task = taskOf(ledger, id);
    assertOwner(task);
    reviewGuard?.(task);
    if (expectedHead && git(root, ['rev-parse', task.branch]) !== expectedHead) {
      throw new Error(`${task.id} review is stale: task branch changed after review; not merging`);
    }
    const sharers = Object.values(ledger.tasks).filter(other => other.worktree === task.worktree
      && HOLDING.includes(other.state));
    if (expectedHead && sharers.length !== 1) {
      throw new Error(`${task.id} review is stale: worktree gained an unreviewed sharer; not merging`);
    }
    for (const sharer of sharers) {
      if (sharer.goal !== task.goal) throw new Error(`${sharer.id} belongs to another Goal; cannot merge a shared branch`);
      if (sharer.branch !== task.branch) throw new Error(`${sharer.id} uses another branch in ${task.worktree}`);
      if (running(sharer)) throw new Error(`${sharer.id} is still running`);
    }
    if (!['exited', 'conflict', 'stopped', 'merged'].includes(task.state)) throw new Error(`${task.id} is ${task.state}`);
    const recordMerged = (commit: string, before?: string) => {
      if (before !== undefined) {
        const event: MergeEvent = { before, after: commit, goal: task.goal ?? 'program',
          taskIds: sharers.map(sharer => sharer.id).sort(), at: new Date().toISOString() };
        appendFileSync(join(stateDir, 'merges.jsonl'), `${JSON.stringify(event)}\n`);
      }
      for (const sharer of sharers) { sharer.state = 'merged'; sharer.mergedCommit = commit; }
    };
    if (git(root, ['symbolic-ref', '--short', 'HEAD']) !== 'main') throw new Error('Main checkout is not on main');
    const { committed, dirty, ahead } = changedFiles(task);
    if (dirty.length) throw new Error(`${task.id} worktree has uncommitted files:\n  ${dirty.join('\n  ')}`);
    if (flags.has('--landed')) {
      // The manager already landed this work on main by hand (a cherry-pick, often with a conflict resolved).
      const commit = git(root, ['rev-parse', 'HEAD']);
      if (!sharers.every(sharer => sharer.mergedCommit === commit)) recordMerged(commit, landedBoundary(root, task, commit));
      else recordMerged(commit);
      console.log(`${sharers.map(sharer => sharer.id).join(', ')} recorded as landed at ${commit.slice(0, 12)}`);
      return;
    }
    if (!ahead) {
      // A resumed task whose earlier commits already landed may hand off with nothing new.
      if (spawnSync('git', ['merge-base', '--is-ancestor', task.branch, 'main'], { cwd: root }).status === 0
        && task.mergedCommit) {
        recordMerged(task.mergedCommit);
        console.log(`${task.id} has nothing new; its branch is already in main`);
        return;
      }
      throw new Error(`${task.id} has no commits to merge`);
    }
    // Single-task branches may append to union registries without a claim; shared branches use their full claim union.
    const migrationOrigins = Object.assign({}, ...sharers.map(sharer => sharer.migrationOrigins ?? {})) as Record<string, string>;
    const violations = scopeViolations(committed, task, sharers);
    if (landPermittedFiles !== undefined) {
      const refusal = landScopeRefusal(ledger, task, sharers, committed, landPermittedFiles);
      if (refusal) throw new Error(refusal);
    } else if (violations.length && !flags.has('--allow-scope')) {
      throw new Error(`${task.id} changed files outside its claim:\n  ${violations.join('\n  ')}`);
    }
    const history = sharers.some(sharer => sharer.historyGate) && !flags.has('--allow-ids') ? historyIntroductions(branchChanges(task)) : [];
    if (history.length) {
      throw new Error(`${task.id} names tasks in the tree; task IDs belong in commit messages:\n  ${history.join('\n  ')}`);
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
    let normalization: string | MigrationRename[];
    try { normalization = normalizeMigrations(task.worktree, task.branch); }
    catch (error) { normalization = error instanceof Error ? error.message : String(error); }
    if (typeof normalization === 'string') {
      task.state = 'conflict';
      return `${task.id} migration normalization refused; not merging:\n  ${normalization}`;
    }
    if (normalization.length) {
      for (const rename of normalization) {
        migrationOrigins[rename.to] = migrationOrigins[rename.from] ?? rename.from;
        delete migrationOrigins[rename.from];
      }
      task.migrationOrigins = migrationOrigins;
    }
    const before = git(root, ['rev-parse', 'HEAD']);
    const after = git(root, ['rev-parse', task.branch]);
    const eventPath = join(stateDir, 'merges.jsonl');
    const events = existsSync(eventPath) ? readFileSync(eventPath, 'utf8').split('\n').filter(Boolean)
      .map(line => JSON.parse(line) as MergeEvent) : [];
    const baseline = streamUnitBaseline(events, sharers.map(sharer => sharer.id), before);
    if (spawnSync('git', ['merge-base', '--is-ancestor', baseline, before], { cwd: root }).status !== 0) {
      task.state = 'conflict';
      return `${task.id} first merge boundary ${baseline} is unavailable or outside main history; cannot classify inherited unit failures`;
    }
    return { before, baseline, after, worktree: task.worktree, branch: task.branch,
      sharers: sharers.map(sharer => sharer.id).sort(), committed: changedFiles(task).committed };
  };
  let preparedMerge = await withLedger(prepareMerge);
  // The reviewed head may be rewritten by our own rebase/normalization on a busy main.
  expectedHead = undefined;
  if (typeof preparedMerge === 'string') throw new Error(preparedMerge);
  if (!preparedMerge) return;
  // The gate runs without the ledger lock. A busy main can advance safely when its new commits
  // do not touch the task's changes or selected tests; only an overlap consumes the one re-gate.
  const gatedFiles = new Set<string>();
  let regated = false;
  let unitFailure = await preMergeUnitGate(preparedMerge.worktree, root, preparedMerge.baseline, flags.has('--skip-unit-gate'), gatedFiles);
  for (;;) {
    const current: PreparedMerge = preparedMerge;
    const outcome = await withLedger((ledger): string | PreparedMerge | undefined => {
      const task = taskOf(ledger, id);
      assertOwner(task);
      reviewGuard?.(task);
      const sharers = Object.values(ledger.tasks).filter(other => other.worktree === task.worktree && HOLDING.includes(other.state));
      if (unitFailure) {
        task.state = 'conflict';
        return `${task.id} ${unitFailure}`;
      }
      if (task.worktree !== current.worktree || task.branch !== current.branch
        || git(root, ['symbolic-ref', '--short', 'HEAD']) !== 'main'
        || git(root, ['rev-parse', task.branch]) !== current.after
        || git(task.worktree, ['rev-parse', 'HEAD']) !== current.after
        || changedFiles(task).dirty.length
        || sharers.map(sharer => sharer.id).sort().join(',') !== current.sharers.join(',')
        || sharers.some(sharer => sharer.goal !== task.goal || sharer.branch !== task.branch || running(sharer))
        || !['exited', 'conflict', 'stopped', 'merged'].includes(task.state)) {
        task.state = 'conflict';
        return `${task.id} main, task branch or sharers changed during the unit gate; retry merge to rebase, normalize and test again`;
      }
      if (landPermittedFiles !== undefined) {
        const refusal = landScopeRefusal(ledger, task, sharers, changedFiles(task).committed, landPermittedFiles);
        if (refusal) {
          task.state = 'conflict';
          return refusal;
        }
      }
      const mainHead = git(root, ['rev-parse', 'HEAD']);
      let prepared = current;
      if (mainHead !== current.before) {
        if (spawnSync('git', ['merge-base', '--is-ancestor', current.before, mainHead], { cwd: root }).status !== 0) {
          task.state = 'conflict';
          return `${task.id} main history changed during the unit gate; retry merge to rebase, normalize and test again`;
        }
        // Inspect every intervening commit: a change reverted later still touched the gated set.
        const touched = git(root, ['log', '--format=', '--name-only', '--no-renames', '-m', `${current.before}..${mainHead}`]).split('\n').filter(Boolean);
        const changed = git(root, ['diff', '--name-only', '--no-renames', `${current.before}..${current.after}`]).split('\n').filter(Boolean);
        const protectedFiles = new Set([...changed, ...gatedFiles]);
        const overlap = touched.filter(file => protectedFiles.has(file));
        if (overlap.length && regated) {
          task.state = 'conflict';
          return `${task.id} main touched task or gated files again after the retry unit gate; retry merge:\n  ${[...new Set(overlap)].join('\n  ')}`;
        }
        const refreshed = prepareMerge(ledger);
        if (typeof refreshed === 'string' || !refreshed) return refreshed;
        prepared = refreshed;
        console.log(`Main advanced during the unit gate; rebased ${task.id}${overlap.length ? ', re-running the gate once' : ', existing gate remains valid'}`);
        if (overlap.length) return prepared;
      }
      const merge = retryGitIndexLock(() => spawnSync('git', ['merge', '--ff-only', prepared.after], { cwd: root, encoding: 'utf8' }));
      if (merge.status !== 0) throw new Error(`Fast-forward failed in the main checkout:\n${merge.stderr}`);
      const event: MergeEvent = { before: prepared.before, after: prepared.after, goal: task.goal ?? 'program',
        taskIds: prepared.sharers, at: new Date().toISOString() };
      appendFileSync(join(stateDir, 'merges.jsonl'), `${JSON.stringify(event)}\n`);
      for (const sharer of sharers) { sharer.state = 'merged'; sharer.mergedCommit = prepared.after; }
      console.log(`${sharers.map(sharer => sharer.id).join(', ')} merged at ${task.mergedCommit!.slice(0, 12)}; ${prepared.committed.length} file(s):`);
      console.log(`  ${prepared.committed.join('\n  ')}`);
      return undefined;
    });
    if (typeof outcome === 'string') throw new Error(outcome);
    if (!outcome) return;
    preparedMerge = outcome;
    regated = true;
    unitFailure = await preMergeUnitGate(outcome.worktree, root, outcome.baseline, flags.has('--skip-unit-gate'), gatedFiles);
  }
}

// Re-read an updated brief for an open task (for example a schema task continuing to its template) and
// replace its claims after the same conflict checks as dispatch. `--allow-area` skips another Goal's
// areas the same way; every other conflict still refuses. The new brief is copied into the worktree.
async function reclaimTask(id: string, briefPath: string, flags: Set<string>): Promise<void> {
  const absolute = resolve(briefPath);
  const brief = parseBrief(readFileSync(absolute, 'utf8'));
  const errors = validateBrief(brief);
  if (errors.length) throw new Error(`Invalid brief ${briefPath}:\n  ${errors.join('\n  ')}`);
  await withLedger(ledger => {
    const task = taskOf(ledger, id);
    assertOwner(task);
    if (brief.id !== task.id) throw new Error(`${briefPath} is for ${brief.id}, not ${task.id}`);
    if (running(task)) throw new Error(`${task.id} is still running`);
    if (['verified', 'cancelled'].includes(task.state)) throw new Error(`${task.id} is closed`);
    const conflicts = claimConflicts(brief, Object.values(ledger.tasks));
    if (!flags.has('--allow-area')) conflicts.push(...areaConflicts(brief.paths, task.goal, areasOf(activeGoals(ledger))));
    if (conflicts.length) throw new Error(`Claim conflict for ${brief.id}:\n  ${conflicts.join('\n  ')}`);
    Object.assign(task, { title: brief.title, effort: brief.effort, cases: brief.cases, paths: brief.paths,
      migrations: brief.migrations, shared: brief.shared, depends: brief.depends, brief: absolute, land: brief.land });
    if (existsSync(task.worktree)) copyFileSync(absolute, join(task.worktree, briefFile({ ...task, shared: !!task.worktreeName })));
    console.log(`${task.id} claims replaced from ${briefPath}`);
  });
}

/** Closes the tasks in order, stopping at the first that cannot close, then moves the briefs and handoffs of those
 * closed to archive/goals in one commit. */
async function closeTasks(ids: string[], outcome: string): Promise<void> {
  if (outcome !== 'verified' && outcome !== 'cancelled') throw new Error('close needs verified or cancelled');
  if (!ids.length) throw new Error('close needs a task ID');
  const ledger = readLedger();
  for (const id of ids) assertOwner(taskOf(ledger, id));
  try {
    for (const id of ids) await closeTask(id, outcome);
  } finally {
    await withLedger(current => {
      for (const note of archiveClosedBriefs(current, ids.map(id => taskOf(current, id)))) console.log(note);
    });
  }
}

async function closeTask(id: string, outcome: 'verified' | 'cancelled'): Promise<void> {
  await withLedger(ledger => {
    const task = taskOf(ledger, id);
    if (running(task)) throw new Error(`${task.id} is still running; stop it first`);
    // A read-only task (no path claims, nothing committed) is verified by its accepted handoff.
    const readOnly = !task.paths.length && task.state === 'exited' && !changedFiles(task).ahead;
    if (outcome === 'verified' && task.state !== 'merged' && !readOnly) {
      throw new Error(`${task.id} is ${task.state}, not merged`);
    }
    // A shared worktree stays while another open task still works in it.
    const sharers = Object.values(ledger.tasks).filter(other => other.id !== task.id
      && other.worktree === task.worktree && !['verified', 'cancelled'].includes(other.state));
    if (existsSync(task.worktree) && !sharers.length) {
      killWorktreeProcesses(task.worktree);
      removeWorktreeStack(task.worktree);
      // Tasks may leave intentionally read-only artifacts (for example immutable release trees).
      spawnSync('chmod', ['-R', 'u+w', task.worktree]);
      preserveWorktreeArtifacts(task.worktree, join(stateDir, 'runs', task.id));
      git(root, ['worktree', 'remove', '--force', task.worktree]);
    }
    if (task.state === 'merged' && !sharers.length) git(root, ['branch', '-d', task.branch], true);
    task.state = outcome;
    task.closedAt = new Date().toISOString();
    console.log(`${task.id} ${outcome}; claims released${outcome === 'cancelled' ? `, branch ${task.branch} kept` : ''}`);
  });
}

const valueOf = (args: readonly string[], flag: string): string | undefined => {
  const at = args.indexOf(flag);
  return at >= 0 ? args[at + 1] : undefined;
};

/** Registers a Goal whose file exists, or records its manager's new session after a restart. `--adopt` gives it the
 * open tasks that have no Goal: the tasks of the single manager that ran before Goals had names. */
async function startGoal(slug: string, args: string[]): Promise<void> {
  if (!validGoalSlug(slug)) throw new Error(`Goal slug must be lower-case words joined by hyphens: ${slug || '(missing)'}`);
  const manager = valueOf(args, '--manager');
  if (!manager) throw new Error('goal start needs --manager <session name>');
  if (!existsSync(join(root, goalFile(slug)))) throw new Error(`${goalFile(slug)} is missing; write the Goal first`);
  await withLedger(ledger => {
    const existing = ledger.goals?.[slug];
    if (existing?.closedAt) throw new Error(`Goal ${slug} closed at ${existing.closedAt}; choose another slug`);
    const own = areasOf([slug])[slug] ?? [];
    const overlaps = areaConflicts(own, slug, areasOf(activeGoals(ledger).filter(other => other !== slug)));
    if (overlaps.length && !args.includes('--allow-area')) {
      throw new Error(`Goal ${slug}'s areas overlap another Goal's:\n  ${overlaps.join('\n  ')}`);
    }
    ledger.goals = { ...ledger.goals, [slug]: { ...existing, manager, startedAt: existing?.startedAt ?? new Date().toISOString() } };
    const adopted = args.includes('--adopt')
      ? Object.values(ledger.tasks).filter(task => !task.goal && !['verified', 'cancelled'].includes(task.state)) : [];
    for (const task of adopted) task.goal = slug;
    console.log(`Goal ${slug} ${existing ? 'resumed' : 'started'}; manager ${manager}; ${own.length} area(s)`
      + (adopted.length ? `; adopted ${adopted.map(task => task.id).join(', ')}` : ''));
  });
}

/** Ends a Goal once nothing of it remains in the tree: no open task, no brief, no file or line naming its tasks and no
 * link into its directory. Then its directory and ledger entries move to archive/goals. */
async function closeGoal(slug: string, flags: Set<string>): Promise<number> {
  const caller = process.env.GOAL_ID;
  if (caller && caller !== slug) throw new Error(`Goal ${slug} is not this manager's (GOAL_ID is ${caller})`);
  return withLedger(ledger => {
    const goal = ledger.goals?.[slug];
    if (!goal || goal.closedAt) throw new Error(`Goal ${slug} is not active`);
    const tasks = Object.values(ledger.tasks).filter(task => task.goal === slug);
    const problems = tasks.filter(task => !['verified', 'cancelled'].includes(task.state))
      .map(task => `${task.id} is ${task.state}; merge and close or cancel it`);
    if (!problems.length && !flags.has('--dry-run')) for (const note of archiveClosedBriefs(ledger, tasks)) console.log(note);
    const dir = `${GOALS_DIR}/${slug}`;
    const tasksDir = join(root, dir, 'tasks');
    problems.push(...(existsSync(tasksDir) ? readdirSync(tasksDir) : []).map(name => `${dir}/tasks/${name} remains`));
    const ids = tasks.map(task => task.id);
    problems.push(...treeMentions(root, ids, { words: true }).map(line => `names a task: ${line}`));
    const numbers = new Set(ids.map(id => id.slice(2)));
    const exempt = HISTORY_EXEMPT.map(pattern => new Bun.Glob(pattern));
    problems.push(...git(root, ['ls-files']).split('\n').filter(path => !exempt.some(glob => glob.match(path)) && path.split('/')
      .some(segment => numbers.has(/^g-(\d{3,})(?!\d)/i.exec(segment)?.[1] ?? ''))).map(path => `named after a task: ${path}`));
    problems.push(...treeMentions(root, [`goals/${slug}/`], { exclude: [`${GOALS_DIR}/*/**`, 'scripts/goal/**'] })
      .map(line => `links into the Goal: ${line}`));
    if (problems.length) {
      console.log(`Goal ${slug} has not converged:\n  ${problems.join('\n  ')}`);
      return 1;
    }
    if (flags.has('--dry-run')) { console.log(`Goal ${slug} has converged; close would archive ${dir}`); return 0; }
    const archive = archiveDirOf(ledger, slug);
    const files = git(root, ['ls-files', '--', dir]).split('\n').filter(Boolean)
      .concat(git(root, ['ls-files', '--others', '--exclude-standard', '--', dir]).split('\n').filter(Boolean));
    archiveFiles(root, [...files.map(path => ({ path: `${archive}/${relative(dir, path)}`, content: readFileSync(join(root, path), 'utf8') })),
      { path: `${archive}/ledger.json`, content: `${JSON.stringify({ goal: { slug, ...goal }, tasks }, null, 2)}\n` }],
    `Archive Goal ${slug}\n\nGoal: ${slug}`);
    removeFromTree(root, files, `Close Goal ${slug}\n\nIts directory and ledger entries are on ${ARCHIVE_BRANCH} under ${archive}/.\n\nGoal: ${slug}`);
    ledger.lastId = Math.max(ledger.lastId ?? 0, ...ids.map(id => Number(id.slice(2))));
    for (const id of ids) delete ledger.tasks[id];
    Object.assign(goal, { closedAt: new Date().toISOString(), archive });
    console.log(`Goal ${slug} closed; ${ARCHIVE_BRANCH}:${archive}/ holds its directory, briefs, handoffs and ledger`);
    return 0;
  });
}

/** Reserves the next task ID for a Goal and writes its brief skeleton, so two managers never take the same number. */
async function newBrief(args: string[]): Promise<void> {
  const goalArg = valueOf(args, '--goal');
  const title = args.filter((arg, at) => arg !== '--goal' && args[at - 1] !== '--goal').join(' ').trim();
  if (!title) throw new Error('new needs a title');
  await withLedger(ledger => {
    const active = activeGoals(ledger);
    const goal = goalArg ?? process.env.GOAL_ID ?? (active.length === 1 ? active[0] : undefined);
    if (!goal || !active.includes(goal)) throw new Error(`new needs an active Goal (--goal <slug>): ${active.join(', ') || 'none started'}`);
    const goalsDir = join(root, GOALS_DIR);
    const onDisk = readdirSync(goalsDir).flatMap(entry => {
      const dir = entry === 'tasks' ? join(goalsDir, 'tasks') : join(goalsDir, entry, 'tasks');
      return existsSync(dir) ? readdirSync(dir).map(name => name.replace(/\.md$/, '')) : [];
    });
    const id = nextTaskId([...Object.keys(ledger.tasks), ...Object.keys(ledger.reserved ?? {}), ...onDisk], ledger.lastId);
    const path = join(root, goalBriefFile(goal, id));
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, ['---', `id: ${id}`, `title: ${title}`, `engine: ${DEFAULT_ENGINE}`, 'effort: high', 'cases: []',
      'paths: []                             # name new files by capability, never g-NNN', 'migrations: []', 'shared: []',
      'depends: []', '---', '', '## Outcome', '', '## Checks', ''].join('\n'));
    ledger.reserved = { ...ledger.reserved, [id]: goal };
    console.log(`${id} reserved for Goal ${goal}: ${relative(root, path)}`);
  });
}

/** Archives the briefs of closed tasks still in the tree: a close that stopped part-way, or pre-Goal briefs. */
async function tidy(args: string[]): Promise<void> {
  const caller = process.env.GOAL_ID;
  await withLedger(ledger => {
    const tasks = Object.values(ledger.tasks).filter(task => !caller || !task.goal || task.goal === caller);
    const notes = archiveClosedBriefs(ledger, tasks, valueOf(args, '--legacy'));
    console.log(notes.length ? notes.join('\n') : 'Nothing to tidy');
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
    console.log(`Claude 7d ${usage.weekUsed}%, projected ${usage.weekProjected}–${usage.weekProjectedHigh}% at reset in ${usage.weekResetInHours}h: `
      + `${usage.weekAdvice}`);
  }
  for (const account of codexAccounts()) console.log(describeAccount(account));
  console.log(`heavy QA: ${heavyQaStatus()}`);
  for (const waiting of heavyQaWaiters()) console.log(waiting);
  for (const waiting of qaWaitStatusLines()) console.log(waiting);
  const active = activeGoals(ledger);
  for (const slug of active) {
    const own = tasks.filter(task => task.goal === slug);
    console.log(`Goal ${slug}: manager ${managerOf(ledger, slug)}; ${own.filter(running).length} live, `
      + `${own.filter(task => !['verified', 'cancelled'].includes(task.state)).length} open; `
      + `${inboxEntries(stateDir, slug).filter(entry => !entry.acknowledged).length} unacknowledged regressions`);
  }
  const inboxDirectory = join(stateDir, 'inbox');
  for (const file of existsSync(inboxDirectory) ? readdirSync(inboxDirectory).sort() : []) {
    if (!file.endsWith('.jsonl')) continue;
    const slug = file.slice(0, -6);
    if (!validGoalSlug(slug) || active.includes(slug)) continue;
    const count = inboxEntries(stateDir, slug).filter(entry => !entry.acknowledged).length;
    if (count) console.log(`Goal ${slug}: inactive; ${count} unacknowledged regressions`);
  }
  for (const task of tasks.filter(t => !['verified', 'cancelled'].includes(t.state))) {
    const attempt = lastAttempt(task);
    console.log(`${task.id} ${task.state.padEnd(8)} ${task.goal ?? '-'} ${engineOf(attempt)}/${attempt.effort} #${attempt.n} `
      + `${elapsed(attempt.startedAt)} [${task.cases.join(' ')}] ${task.title}`);
  }
  const closed = tasks.length - tasks.filter(t => !['verified', 'cancelled'].includes(t.state)).length;
  if (closed) console.log(`${closed} closed task(s) omitted`);
}

/** QA stacks are named `rezics-qa-<UTC yyyymmddThhmmss>-<id>-<n>`. A run killed with SIGKILL never tears
 * its stack down, and leaked stacks filled the Docker VM (four left running for nine hours). No QA run
 * lasts three hours, so a stack started earlier is removed before the next run takes a slot. */
export function reapStaleQaStacks(now = Date.now(), maxAgeMs = 3 * 3_600_000): string[] {
  const listed = spawnSync('docker', ['ps', '-a', '--format', '{{.Label "com.docker.compose.project"}}'],
    { encoding: 'utf8', timeout: 30_000 });
  if (listed.status !== 0) return [];
  const stale = [...new Set(listed.stdout.split('\n'))].filter(project => {
    const match = /^rezics-qa-(\d{4})(\d{2})(\d{2})t(\d{2})(\d{2})(\d{2})-/.exec(project);
    if (!match) return false;
    const [, y, mo, d, h, mi, se] = match;
    return now - Date.UTC(+y!, +mo! - 1, +d!, +h!, +mi!, +se!) > maxAgeMs;
  });
  for (const project of stale) {
    spawnSync('docker', ['compose', '-p', project, 'down', '-v'], { encoding: 'utf8', timeout: 180_000 });
  }
  return stale;
}

const heavyLock = join(stateDir, 'qa-slots', 'heavy');
const HEAVY_POLL_MS = 10_000;
const HEAVY_DEADLINE_MS = 6 * 3_600_000;

interface HeavyTicket {
  pid: number;
  goal?: string;
  command?: string;
  arrivedAt: number;
  /** Zero-padded monotonic time. Wall-clock milliseconds collide; this keeps those tickets in arrival order. */
  seq?: string;
}

/** Beside the lock, not inside it: releasing the lock deletes the lock directory, and later waiters must keep their tickets. */
function heavyQueueDir(lockDir: string): string {
  return join(dirname(lockDir), `${basename(lockDir)}-queue`);
}

function heavyGoalTurns(queueDir: string): string[] {
  try {
    const turns: unknown = JSON.parse(readFileSync(join(queueDir, 'turns'), 'utf8'));
    return Array.isArray(turns) ? turns.filter((goal): goal is string => typeof goal === 'string') : [];
  } catch { return []; }
}

/** Live tickets: shared refresh first, then Goals in turn order, FIFO within a Goal. Dead or unordered tickets are removed. */
function heavyTickets(queueDir: string, alive: (pid: number) => boolean): { path: string; ticket: HeavyTicket }[] {
  let names: string[];
  try { names = readdirSync(queueDir); } catch { return []; }
  const live: { path: string; ticket: HeavyTicket }[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const path = join(queueDir, name);
    try {
      const ticket = JSON.parse(readFileSync(path, 'utf8')) as HeavyTicket;
      if (typeof ticket?.pid !== 'number' || typeof ticket.arrivedAt !== 'number' || !alive(ticket.pid)) {
        rmSync(path, { force: true });
        continue;
      }
      live.push({ path, ticket });
    } catch { rmSync(path, { force: true }); }
  }
  // Refresh repairs the shared stack for every Goal. It gets the next turn, never the holder’s turn.
  const priority = (ticket: HeavyTicket) => ticket.command === 'task dev:refresh' ? 0 : 1;
  const turns = heavyGoalTurns(queueDir);
  const turn = (ticket: HeavyTicket) => priority(ticket) === 0 ? -1 : turns.indexOf(ticket.goal ?? '?');
  live.sort((a, b) => priority(a.ticket) - priority(b.ticket) || turn(a.ticket) - turn(b.ticket)
    || a.ticket.arrivedAt - b.ticket.arrivedAt
    || (a.ticket.seq ?? '').localeCompare(b.ticket.seq ?? '')
    || a.ticket.pid - b.ticket.pid
    || (a.path < b.path ? -1 : 1));
  return live;
}

/** Who holds the heavy QA lock, or undefined when it is free (a dead holder's lock is free). */
function heavyHolder(lockDir = heavyLock, alive: (pid: number) => boolean = pidAlive): string | undefined {
  try {
    const info = JSON.parse(readFileSync(join(lockDir, 'info.json'), 'utf8')) as
      { pid: number; goal?: string; command: string; startedAt: string; commandStartedAt?: string | null };
    const commandState = typeof info.commandStartedAt === 'string' ? `command started ${info.commandStartedAt}`
      : info.commandStartedAt === null ? 'command not started' : 'command start unknown';
    return alive(info.pid) ? `Goal ${info.goal ?? '?'} since ${info.startedAt} (pid ${info.pid}): ${info.command} (${commandState})` : undefined;
  } catch { return undefined; }
}

/** Holder text as before, plus how many live tickets are waiting. Reading the queue drops tickets of dead pids. */
export function heavyQaStatus(lockDir = heavyLock, alive: (pid: number) => boolean = pidAlive): string {
  const waiting = heavyTickets(heavyQueueDir(lockDir), alive).length;
  return `${heavyHolder(lockDir, alive) ?? 'free'}; ${waiting} waiting`;
}

export function heavyQaWaiters(lockDir = heavyLock, alive: (pid: number) => boolean = pidAlive): string[] {
  return heavyTickets(heavyQueueDir(lockDir), alive).map(({ ticket }) =>
    `QA waiting for heavy turn: Goal ${ticket.goal ?? '?'} (pid ${ticket.pid}): ${ticket.command ?? 'QA command'}`);
}

export interface QaWaitStatus {
  pid: number; goal?: string; command: string; waitingFor: 'slot' | 'memory'; message?: string; since: string;
}

function atomicJson(path: string, value: unknown): void {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(value));
  renameSync(temporary, path);
}

export function qaWaitStatusLines(qaSlotsDir = join(stateDir, 'qa-slots'), alive: (pid: number) => boolean = pidAlive): string[] {
  const directory = join(qaSlotsDir, 'waiters');
  let names: string[];
  try { names = readdirSync(directory); } catch { return []; }
  const lines: string[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const path = join(directory, name);
    try {
      const wait = JSON.parse(readFileSync(path, 'utf8')) as QaWaitStatus;
      if (!Number.isSafeInteger(wait.pid) || typeof wait.command !== 'string'
        || !['slot', 'memory'].includes(wait.waitingFor) || !alive(wait.pid)) {
        rmSync(path, { force: true });
        continue;
      }
      lines.push(`QA waiting for ${wait.waitingFor}: Goal ${wait.goal ?? '?'} (pid ${wait.pid}): ${wait.command}`
        + (wait.message ? `; ${wait.message}` : ''));
    } catch { rmSync(path, { force: true }); }
  }
  return lines.sort();
}

/** `process.exit` from a signal still runs the exit hook, which is the one place a waiting ticket is removed without `finally`. */
function bindHeavyTicketCleanup(remove: () => void): () => void {
  const onExit = () => remove();
  const onSignal = (signal: NodeJS.Signals) => {
    process.off('SIGHUP', onSignal);
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    process.exit(signal === 'SIGINT' ? 130 : signal === 'SIGHUP' ? 129 : 143);
  };
  process.on('exit', onExit);
  process.on('SIGHUP', onSignal);
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  return () => {
    process.off('exit', onExit);
    process.off('SIGHUP', onSignal);
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  };
}

export interface HeavyWaitOptions {
  lockDir?: string;
  pid?: number;
  goal?: string;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  alive?: (pid: number) => boolean;
  pollMs?: number;
  /** Epoch milliseconds after which a waiter that still does not hold the lock gives up. */
  deadline?: number;
  /** Exit and signal hooks remove the ticket. In-process tests pass false so they do not exit the runner. */
  bindExit?: boolean;
  /** A waiting refresh already includes committed main when it starts. Return undefined instead of queuing another. */
  coalesceRefresh?: boolean;
  announce?: (message: string) => void;
}

/** Heavy runs (affected sets, whole tiers, wave and browser suites) are host-wide exclusive: two managers' waves
 * together would put four or more QA stacks beside the workers, past what a 62 GB host held on 2026-09-27/28. A heavy
 * run still takes an ordinary slot, so the host carries at most one heavy run and two light ones, as with one manager.
 * The lock belongs to the process and is freed when it exits, so no manager has to remember to release it.
 * Waiters poll, so a run that starts at the moment the lock frees would otherwise cut in front of one that has been
 * waiting. Tickets preserve FIFO within each Goal, with a shared rotation preventing one Goal's backlog from starving peers. */
export function acquireHeavy(command: readonly string[], options?: HeavyWaitOptions & { coalesceRefresh?: false }): Promise<() => void>;
export function acquireHeavy(command: readonly string[], options: HeavyWaitOptions & { coalesceRefresh: boolean }): Promise<(() => void) | undefined>;
export async function acquireHeavy(command: readonly string[], options: HeavyWaitOptions = {}): Promise<(() => void) | undefined> {
  const lockDir = options.lockDir ?? heavyLock;
  const queueDir = heavyQueueDir(lockDir);
  const pid = options.pid ?? process.pid;
  const goal = options.goal ?? process.env.GOAL_ID;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => Bun.sleep(ms));
  const alive = options.alive ?? pidAlive;
  const pollMs = options.pollMs ?? HEAVY_POLL_MS;
  const deadline = options.deadline ?? now() + HEAVY_DEADLINE_MS;
  const commandText = command.join(' ');
  const arrivedAt = now();
  const ticketPath = join(queueDir, `${String(arrivedAt).padStart(16, '0')}-${pid}-${randomUUID()}.json`);
  const removeTicket = () => {
    rmSync(ticketPath, { force: true });
    rmSync(`${ticketPath}.tmp`, { force: true });
  };
  let unbind = () => {};
  try {
    // Bound before the ticket exists, so a signal between the write and the first poll still removes it.
    if (options.bindExit !== false) unbind = bindHeavyTicketCleanup(removeTicket);
    mkdirSync(queueDir, { recursive: true });
    const ticket: HeavyTicket = {
      pid, goal, command: commandText, arrivedAt, seq: process.hrtime.bigint().toString().padStart(24, '0'),
    };
    writeFileSync(`${ticketPath}.tmp`, JSON.stringify(ticket));
    renameSync(`${ticketPath}.tmp`, ticketPath);
    let announced = false;
    for (;;) {
      const tickets = heavyTickets(queueDir, alive);
      const ahead = tickets.findIndex(entry => entry.path === ticketPath);
      if (options.coalesceRefresh && commandText === 'task dev:refresh') {
        const prior = tickets.find(entry => entry.path !== ticketPath && entry.ticket.command === commandText
          && tickets.indexOf(entry) < ahead);
        if (prior) {
          // A refresh that has already taken the lock must not absorb changes arriving after its snapshot.
          let started = false;
          try {
            const holder = JSON.parse(readFileSync(join(lockDir, 'info.json'), 'utf8')) as HeavyTicket;
            started = holder.command === commandText && holder.pid === prior.ticket.pid && alive(holder.pid);
          } catch { /* a queued refresh has no holder record */ }
          if (!started) return undefined;
        }
      }
      if (ahead === 0 && !dirLockHeld(lockDir, alive)) {
        try {
          // A negative timeout fails at once when the directory is held, so this loop's poll is the only wait.
          // The stale-owner reap inside acquireDir still runs before that failure.
          await acquireDir(lockDir, -1, 'heavy QA');
          writeFileSync(join(lockDir, 'info.json'), JSON.stringify({
            pid, goal, command: commandText, startedAt: new Date().toISOString(), commandStartedAt: null,
          }));
          if (commandText !== 'task dev:refresh') {
            const turns = heavyGoalTurns(queueDir).filter(turn => turn !== (goal ?? '?'));
            turns.push(goal ?? '?');
            writeFileSync(join(queueDir, 'turns'), JSON.stringify(turns));
          }
          return () => rmSync(lockDir, { recursive: true, force: true });
        } catch { /* the lock was taken between the check and the create */ }
      }
      if (now() > deadline) throw new Error('The heavy QA lock stayed held for six hours');
      if (!announced) {
        const holder = heavyHolder(lockDir, alive);
        (options.announce ?? console.error)(ahead > 0
          ? `waiting for heavy QA turn; ${ahead} waiter${ahead === 1 ? '' : 's'} in line${holder ? ` (${holder})` : ''}`
          : `waiting for heavy QA turn held by ${holder ?? 'a starting run'}`);
        announced = true;
      }
      await sleep(pollMs);
    }
  } finally {
    removeTicket();
    unbind();
  }
}

export interface SlotRunOptions {
  slotDirectory?: string;
  heavyLockDirectory?: string;
  slots?: number;
  timeoutMs?: number;
  pollMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  announce?: (message: string) => void;
  reap?: () => void;
  runCommand?: (command: readonly string[], env: NodeJS.ProcessEnv, onStart: () => void) => Promise<number>;
}

async function runQaCommand(command: readonly string[], env: NodeJS.ProcessEnv, onStart: () => void): Promise<number> {
  const child = spawn(command[0]!, command.slice(1), { cwd: process.cwd(), stdio: 'inherit', env });
  const forward = (signal: NodeJS.Signals) => child.kill(signal);
  process.on('SIGINT', forward);
  process.on('SIGTERM', forward);
  try {
    return await new Promise<number>((done, reject) => {
      child.once('error', reject);
      child.once('spawn', onStart);
      child.once('exit', exit => done(exit ?? 1));
    });
  } finally {
    process.off('SIGINT', forward);
    process.off('SIGTERM', forward);
  }
}

export function markHeavyCommandStarted(lockDirectory: string): void {
  const path = join(lockDirectory, 'info.json');
  try {
    const info = JSON.parse(readFileSync(path, 'utf8')) as { pid: number; [key: string]: unknown };
    if (info.pid === process.pid) atomicJson(path, { ...info, commandStartedAt: new Date().toISOString() });
  } catch { /* status may read the lock while it is being acquired */ }
}

function currentQaGoal(): string | undefined {
  if (process.env.GOAL_ID) return process.env.GOAL_ID;
  const taskId = process.env.GOAL_TASK_ID;
  if (!taskId) return undefined;
  try { return readLedger().tasks[taskId]?.goal; } catch { return undefined; }
}

export async function withSlot(command: string[], heavy = false, resultFile?: string, options: SlotRunOptions = {}): Promise<number> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? (ms => Bun.sleep(ms));
  const announce = options.announce ?? console.error;
  const queuedAt = now();
  let startedAt: number | undefined;
  let code: number | undefined;
  const artifactRoot = join(process.cwd(), '.artifacts', 'qa');
  const prior = new Set(existsSync(artifactRoot) ? readdirSync(artifactRoot) : []);
  const slots = heavy ? undefined : options.slots ?? Number(process.env.GOAL_QA_SLOTS ?? 3);
  if (!heavy && (!Number.isSafeInteger(slots) || slots! < 1)) throw new Error('GOAL_QA_SLOTS must be a positive integer');
  const dir = options.slotDirectory ?? join(stateDir, 'qa-slots');
  const heavyLockDirectory = options.heavyLockDirectory ?? (options.slotDirectory ? join(dir, 'heavy') : heavyLock);
  const waiterDirectory = join(dir, 'waiters');
  const goal = currentQaGoal();
  mkdirSync(dir, { recursive: true });
  let releaseHeavy: (() => void) | undefined;
  let heldSlot: string | undefined;
  let waitPath: string | undefined;
  try {
    releaseHeavy = heavy ? await acquireHeavy(command, { lockDir: heavyLockDirectory, goal, announce }) : undefined;
    if (!heavy) {
      const deadline = now() + (options.timeoutMs ?? 3_600_000);
      let announced = false;
      while (!heldSlot) {
        for (let k = 0; k < slots! && !heldSlot; k++) {
          const path = join(dir, String(k));
          try { await acquireDir(path, -1, 'slot'); heldSlot = path; } catch { /* busy */ }
        }
        if (!heldSlot) {
          const free = [...Array(slots!).keys()].filter(k => !dirLockHeld(join(dir, String(k)), pidAlive)).length;
          const record: QaWaitStatus = { pid: process.pid, goal, command: command.join(' '),
            waitingFor: 'slot', message: `${slots! - free}/${slots} ordinary slots busy`, since: new Date(now()).toISOString() };
          mkdirSync(waiterDirectory, { recursive: true });
          waitPath ??= join(waiterDirectory, `slot-${process.pid}-${randomUUID()}.json`);
          atomicJson(waitPath, record);
          if (!announced) { announce(`waiting for QA slot; ${record.message}`); announced = true; }
          if (now() > deadline) throw new Error('No QA slot became free within one hour; waiting for an ordinary slot');
          await sleep(options.pollMs ?? 3000);
        }
      }
      if (waitPath) rmSync(waitPath, { force: true });
    }
    (options.reap ?? reapStaleQaStacks)();
    const env: NodeJS.ProcessEnv = { ...process.env, GOAL_IN_SLOT: '1',
      GOAL_QA_WAIT_DIR: waiterDirectory, GOAL_QA_COMMAND: command.join(' ') };
    if (heavy || process.env.GOAL_QA_HEAVY_RUN === '1') env.GOAL_QA_HEAVY_RUN = '1';
    if (goal) env.GOAL_ID = goal;
    code = await (options.runCommand ?? runQaCommand)(command, env, () => {
      startedAt = now();
      if (heavy) markHeavyCommandStarted(heavyLockDirectory);
    });
    return code;
  } finally {
    if (waitPath) rmSync(waitPath, { force: true });
    if (heldSlot) rmSync(heldSlot, { recursive: true, force: true });
    releaseHeavy?.();
    if (resultFile) {
      const finishedAt = now();
      mkdirSync(dirname(resultFile), { recursive: true });
      writeFileSync(resultFile, JSON.stringify({ code, queuedAt, startedAt, finishedAt,
        queueMs: (startedAt ?? finishedAt) - queuedAt, testMs: startedAt ? finishedAt - startedAt : 0,
        totalMs: finishedAt - queuedAt,
        artifactPaths: (existsSync(artifactRoot) ? readdirSync(artifactRoot) : [])
          .filter(name => !prior.has(name)).map(name => join(artifactRoot, name)) }, null, 2));
    }
  }
}

/** The override confines disposable mail/pump trials to their own ledger and local state. */
function eventStateDirectory(): string {
  return process.env.GOAL_MAIL_STATE_DIR ? resolve(process.env.GOAL_MAIL_STATE_DIR) : stateDir;
}
function eventLedger(directory: string): Ledger {
  const path = join(directory, 'ledger.json');
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) as Ledger : { tasks: {} };
}
function namedOptions(args: string[], allowed: string[]): Record<string, string> {
  const options: Record<string, string> = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index]!;
    const value = args[index + 1];
    if (!allowed.includes(flag) || options[flag] !== undefined || !value || value.startsWith('--')) {
      throw new Error(`Invalid option: ${flag}; expected ${allowed.join(', ')}`);
    }
    options[flag] = value;
  }
  return options;
}
export function mailCommand(args: string[], options: {stateDir: string; goals: string[]; callerGoal?: string}): string[] {
  const [action, ...rest] = args;
  const store = new GoalMailStore(options);
  try {
    if (action === 'send') {
      const goal = rest[0] ?? '';
      const flags = namedOptions(rest.slice(1), ['--file', '--key']);
      if (!flags['--file'] || !flags['--key']) throw new Error('mail send <goal> needs --file <path> --key <retry-key>');
      return [JSON.stringify(store.send(goal, readFileSync(resolve(flags['--file']), 'utf8'), flags['--key']))];
    }
    if (action === 'inbox') {
      if (rest.length > 1) throw new Error('mail inbox accepts one Goal');
      const goal = rest[0] ?? options.callerGoal;
      if (!goal) throw new Error('mail inbox needs <goal> or GOAL_ID');
      return store.inbox(goal).map(entry => JSON.stringify(entry));
    }
    if (action === 'ack') {
      const flags = namedOptions(rest.slice(1), ['--goal']);
      const goal = flags['--goal'] ?? options.callerGoal;
      if (!goal || !rest[0]) throw new Error('mail ack <id> needs GOAL_ID or --goal <goal>');
      return [JSON.stringify(store.ack(goal, rest[0]))];
    }
    throw new Error('mail needs send <goal> --file <path> --key <retry-key> | inbox [goal] | ack <id> [--goal <goal>]');
  } finally { store.close(); }
}
function managerEvents(directory: string, goal: string, mail: GoalMailStore): WakeEvent[] {
  const events: WakeEvent[] = mail.pending(goal).map(message => ({key:message.id,body:message.body}));
  for (const task of Object.values(eventLedger(directory).tasks)) {
    if (task.goal !== goal || ['verified', 'cancelled', 'merged'].includes(task.state) || !task.attempts.length) continue;
    const attempt = lastAttempt(task);
    if (task.state === 'running' && running(task)) continue;
    events.push({key:`task:${task.id}:${attempt.n}`,body:`${task.id}: ${task.state}; attempt ${attempt.n} exited. Output: ${attempt.output}`});
  }
  return events;
}
export function coordinatorEnrollmentOptions(args: string[]): {
  goal: string; session: string; engine: LaunchDescriptor['engine']; effort: string; cwd: string;
  socket?: string; previousOwner: NonNullable<ReturnType<typeof processIdentity>>;
} {
  const goal = args[0] ?? '';
  const flags = namedOptions(args.slice(1), ['--session', '--engine', '--effort', '--cwd', '--tmux-socket', '--previous-owner-pid']);
  const engine = flags['--engine'] ?? 'codex';
  if (engine !== 'codex' && engine !== 'codex-1' && engine !== 'luna') throw new Error('This pilot enrolls Codex managers only');
  const effort = flags['--effort'];
  const session = flags['--session'];
  const cwd = flags['--cwd'];
  const pidText = flags['--previous-owner-pid'];
  if (!goal || !effort || !effortsOf(engine).includes(effort) || !session || !cwd || !pidText) {
    throw new Error('Enrollment requires <goal> --session <native UUID> --effort <effort> --cwd <directory> --previous-owner-pid <pid>');
  }
  const pid = Number(pidText);
  if (!/^[1-9]\d*$/.test(pidText) || !Number.isSafeInteger(pid)) throw new Error('--previous-owner-pid must be a positive integer PID');
  const previousOwner = processIdentity(pid);
  if (!previousOwner) throw new Error(`Cannot establish the live previous owner ${pid}; enroll while that process is still running`);
  return { goal, session, engine, effort, cwd, socket: flags['--tmux-socket'], previousOwner };
}
async function coordinatorCommand(args: string[]): Promise<void> {
  const directory = eventStateDirectory();
  const goals = Object.keys(eventLedger(directory).goals ?? {});
  const mail = new GoalMailStore({stateDir:directory,goals});
  const coordinator = new GoalCoordinator({stateDir:directory,
    events:goal => goals.includes(goal) ? managerEvents(directory,goal,mail) : [],
    admit:descriptor => {
      if (!activeGoals(eventLedger(directory)).includes(descriptor.goal)) throw new Error('Enrolled Goal is no longer active');
      const home = engineEnv(descriptor.engine).CODEX_HOME;
      if (!home || realpathSync(home) !== descriptor.home) throw new Error('Selected engine account home changed; handover required');
      launchGates(Object.values(readLedger().tasks),descriptor.engine,false);
    }});
  try {
    const [action, ...rest] = args;
    if (action === 'status') {
      if (rest.length) throw new Error('coordinator status takes no options');
      console.log(JSON.stringify(coordinator.status(),null,2)); return;
    }
    if (action === 'unenroll') {
      if (rest.length !== 1) throw new Error('coordinator unenroll needs <goal>');
      coordinator.acquire();
      try { coordinator.unenroll(rest[0]!); } finally { coordinator.release(); }
      return;
    }
    if (action === 'enroll') {
      const { goal, session, engine, effort, cwd: requestedCwd, socket: requestedSocket, previousOwner } = coordinatorEnrollmentOptions(rest);
      if (!activeGoals(eventLedger(directory)).includes(goal)) throw new Error(`Unknown active Goal: ${goal}`);
      if (coordinator.status().managers.length) throw new Error('This pilot enrolls one manager; unenroll before a new handover');
      const cwd = realpathSync(resolve(requestedCwd));
      const home = realpathSync(engineEnv(engine).CODEX_HOME!);
      nativeSession(home,session,cwd);
      const socket = requestedSocket ?? spawnSync('tmux',['display-message','-p','#{socket_path}'],{encoding:'utf8'}).stdout.trim();
      if (!socket) throw new Error('Enrollment needs an existing independent tmux server');
      const [program, launchArgs] = launchCommand({id:goal,engine,effort,session,worktree:cwd,resume:true,
        prompt:WAKE_PROMPT,lastMessage:WAKE_LAST_MESSAGE});
      const descriptor: LaunchDescriptor = {goal,generation:randomUUID(),session,engine,effort,cwd,home,previousOwner,
        program:Bun.which(program) ?? program,args:launchArgs,socket,server:tmuxServer(socket),
        env:{PATH:process.env.PATH ?? '',HOME:homedir(),CODEX_HOME:home,GOAL_ID:goal,
          GOAL_MANAGER:managerOf(eventLedger(directory),goal),
          ...(process.env.GOAL_MAIL_STATE_DIR ? {GOAL_MAIL_STATE_DIR:directory} : {}),
          ...Object.fromEntries(['GOAL_MAX_WORKERS','GOAL_MEMORY_FLOOR_GIB','STORYBOOK_MAX_WORKERS','GOAL_CODEX_HOME',
            'GOAL_CODEX_1_HOME','GOAL_CODEX_SERVICE_TIER'].filter(key => process.env[key] !== undefined).map(key=>[key,process.env[key]!]))}};
      coordinator.acquire();
      try { coordinator.enroll(descriptor); } finally { coordinator.release(); }
      console.log(JSON.stringify(descriptor,null,2)); return;
    }
    const once = args.includes('--once');
    const flags = namedOptions(args.filter(arg=>arg !== '--once'),['--interval-ms']);
    const interval = Number(flags['--interval-ms'] ?? 5000);
    if (!Number.isSafeInteger(interval) || interval < 100 || interval > 60_000) throw new Error('interval must be 100..60000 ms');
    coordinator.acquire();
    let stopped = false;
    const stop = () => { stopped = true; };
    process.on('SIGTERM',stop); process.on('SIGINT',stop);
    try {
      do { coordinator.step(); if (!once && !stopped) await Bun.sleep(interval); } while (!once && !stopped);
    } finally { process.off('SIGTERM',stop); process.off('SIGINT',stop); coordinator.release(); }
  } finally { mail.close(); coordinator.close(); }
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  const flags = new Set(rest.filter(arg => arg.startsWith('--')));
  const positional = rest.filter(arg => !arg.startsWith('--'));
  switch (command) {
    case 'init':
      throw new Error('init is replaced by `goal start <slug> --manager <session>`; see docs/goals/README.md');
    case 'goal': {
      const [action, slug = ''] = positional;
      if (action === 'start') { await startGoal(slug, rest.slice(2)); return 0; }
      if (action === 'close') return closeGoal(slug, flags);
      throw new Error('goal needs start <slug> --manager <session> [--adopt] [--allow-area] | close <slug> [--dry-run]');
    }
    case 'new': await newBrief(rest); return 0;
    case 'tidy': await tidy(rest); return 0;
    case 'dispatch': await dispatch(positional[0] ?? '', flags); return 0;
    case 'wait': await waitFor(positional[0] ?? ''); return 0;
    case 'resume': await resumeTask(rest[0] ?? '', rest.slice(1)); return 0;
    case 'stop': await stopTask(positional[0] ?? ''); return 0;
    case 'scope': console.log(describe(taskOf(readLedger(), positional[0] ?? ''))); return 0;
    case 'merge': await mergeTask(positional[0] ?? '', flags); return 0;
    case 'land': await landTask(positional[0] ?? ''); return 0;
    case 'close': await closeTasks(positional.slice(0, -1), positional.at(-1) ?? ''); return 0;
    case 'reclaim': await reclaimTask(positional[0] ?? '', positional[1] ?? '', flags); return 0;
    case 'owner': {
      // Read-only: which open task claims a repository path (workers check before editing outside their claim).
      const path = positional[0] ?? '';
      const ledger = readLedger();
      const holders = Object.values(ledger.tasks).filter(task => HOLDING.includes(task.state)
        && task.paths.some(pattern => new Bun.Glob(pattern).match(path) || pathsOverlap(pattern, path)));
      const areas = Object.entries(areasOf(activeGoals(ledger)))
        .filter(([, globs]) => globs.some(glob => pathsOverlap(glob, path))).map(([slug]) => slug);
      console.log((holders.length ? `${path}: claimed by ${holders.map(task => `${task.id} (${task.state})`).join(', ')}`
        : `${path}: unclaimed`) + (areas.length ? `; in Goal ${areas.join(', ')}'s area` : ''));
      return holders.length ? 1 : 0;
    }
    case 'status': await status(); return 0;
    case 'mail': {
      const directory = eventStateDirectory();
      for (const line of mailCommand(rest,{stateDir:directory,goals:Object.keys(eventLedger(directory).goals ?? {}),callerGoal:process.env.GOAL_ID})) console.log(line);
      return 0;
    }
    case 'coordinator': await coordinatorCommand(rest); return 0;
    case 'regress': {
      // Worktree smoke runs can keep reports/inboxes in their writable checkout; QA still uses the shared host lock.
      const regressionState = process.env.GOAL_REGRESS_STATE_DIR ? resolve(process.env.GOAL_REGRESS_STATE_DIR) : stateDir;
      const manifest = await runRegression({ ...parseRegressArgs(rest), repo: process.cwd(), stateDir: regressionState,
        route: entry => regressionState === stateDir ? withLedger(() => appendInbox(stateDir, entry))
          : Promise.resolve(appendInbox(regressionState, entry)) });
      console.log(`Regression ${manifest.runId}: ${manifest.status} at ${manifest.atCommit}`);
      console.log(`Manifest: ${join(regressionState, 'regress', manifest.runId, 'manifest.json')}`);
      return manifest.status === 'passed' ? 0 : 1;
    }
    case 'inbox': {
      const goal = process.env.GOAL_ID ?? 'program';
      if (!validGoalSlug(goal)) throw new Error('Invalid inbox Goal');
      if (rest.length && (rest.length !== 2 || rest[0] !== '--ack' || !/^\d+$/.test(rest[1]!))) {
        throw new Error('inbox accepts --ack <number> (the displayed line number)');
      }
      await withLedger(() => {
        const entries = inboxEntries(stateDir, goal, rest.length ? Number(rest[1]) : undefined);
        for (const entry of entries) console.log(JSON.stringify(entry));
        if (!entries.length) console.log(`Goal ${goal}: inbox empty`);
      });
      return 0;
    }
    case 'usage':
      console.log(JSON.stringify(await usageReport(), null, 2));
      return 0;
    case 'test': {
      const at = rest.indexOf('--result-file');
      const resultFile = at < 0 ? undefined : rest[at + 1];
      if (at >= 0 && (!resultFile || resultFile.startsWith('--'))) throw new Error('--result-file needs a path');
      const args = rest.filter((arg, index) => arg !== '--heavy' && (at < 0 || (index !== at && index !== at + 1)));
      return withSlot(['bun', 'scripts/qa/test.ts', ...args], isHeavyTest(rest), resultFile);
    }
    case 'slot': {
      const heavy = rest[0] === '--heavy';
      const command = heavy ? rest.slice(1) : rest;
      return withSlot(command[0] === '--' ? command.slice(1) : command, heavy);
    }
    default:
      console.error('Usage: goalctl goal start <slug> --manager <session> [--adopt] [--allow-area] | goal close <slug> [--dry-run]'
        + ' | new [--goal <slug>] <title> | dispatch <brief.md> [--dry-run] [--force-usage] [--allow-area]'
        + ' | wait <id> | owner <path> | reclaim <id> <brief> [--allow-area] | resume <id> (-m <text> | --file <path>) [--effort e]'
        + ` [--engine ${ENGINES.join('|')}] [--fresh] [--force-usage]`
        + ' | stop <id> | scope <id> | land <id> | merge <id> [--allow-scope] [--allow-ids] [--landed] [--skip-unit-gate]'
        + ' | close <id>... verified|cancelled | tidy [--legacy <archive directory>]'
        + ' | status | usage | regress [--at <rev>] [--resume <run-id>] [--only <tiers>] [--integration-batches <n>]'
        + ' | mail send <goal> --file <path> --key <key> | mail inbox [goal] | mail ack <id> [--goal <goal>]'
        + ' | coordinator [enroll <goal> --session <UUID> --engine <engine> --effort <effort> --cwd <dir> --previous-owner-pid <pid> [--tmux-socket <path>]|status|unenroll <goal>]'
        + ' | inbox [--ack <n>] | test [--heavy] <task test args> | slot [--heavy] -- <command>');
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
