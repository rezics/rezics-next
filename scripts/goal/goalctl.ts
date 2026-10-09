// Goal worker-process control: exclusive claims, dispatch, waits, QA slots, scope and merge.
// The manager is the only caller of the state-changing commands; see docs/goals/README.md.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, closeSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, readSync,
  renameSync, readlinkSync, realpathSync, rmSync, statSync, lstatSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { decodeXml, ownerGateFiles, parseJUnit, testArgs, unitHarnessFiles, type TestResult } from '../qa/acceptance.ts';
import { affectedPlanForChanges, affectedUnitTierEntries, type AffectedPlan } from '../qa/affected.ts';
import { newReapScope, reapScopeChain, reapSettleMs, removeScopedContainers, sweepOrphanContainers } from '../qa/container-reaper.ts';
import { processAlive } from '../qa/process/identity.ts';
import { directoryLeaseHeld, readDirectoryLease, transferDirectoryLease, tryAcquireDirectoryLease,
  updateDirectoryLeaseNote, type AcquiredDirectoryLease, type DirectoryLeaseRecord } from '../qa/process/lease.ts';
import { terminateProcessGroup } from '../qa/process/terminate.ts';
import { repositoryGuards } from '../qa/repository-guards.ts';
import { parseAffectedArgs, selectTestCommand } from '../qa/test.ts';
import { appendInbox, inboxEntries, parseRegressArgs, runRegression, type MergeEvent } from './regress.ts';
import { physicalPath, postgresSocketRefusal } from './postgres-socket.ts';
import { COMPOSITION_ROOTS } from './composition-roots.ts';
import { land, type LandScope } from './land.ts';
import { mechanisms } from '../static/mechanisms.ts';
import { GoalMailStore } from './mail.ts';
import { GoalCoordinator, claudeConfigHome, claudeNativeSession, claudeWakeArgs, nativeSession, processIdentity, tmuxServer,
  WAKE_LAST_MESSAGE, WAKE_PROMPT, type LaunchDescriptor, type WakeEvent } from './coordinator.ts';

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
  /** First line of the message that put the task in `conflict`. Absent in every other state. */
  refusal?: string;
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
// Landed (`merged`) and closed tasks no longer have to land. Every other holding state
// still does, including files it committed outside its claim.
const UNLANDED: State[] = ['running', 'exited', 'conflict', 'stopped'];

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

/** A brief selects each mapped concept it touches, or `none`. `new` names an unmapped one and needs the reason no owner fits. */
export function mechanismSectionErrors(markdown: string, ids: readonly string[] = mechanisms.map(item => item.id)): string[] {
  const heading = /^## Mechanisms[ \t]*$/m.exec(markdown);
  if (!heading) return ['brief needs a ## Mechanisms section'];
  const rest = markdown.slice(heading.index + heading[0].length);
  const next = /\n## (?!#)/.exec(rest);
  const body = next ? rest.slice(0, next.index) : rest;
  const lines = body.split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith('#'));
  if (!lines.length) return ['brief needs a ## Mechanisms section'];
  if (lines.length === 1 && lines[0] === 'none') return [];
  if (lines.includes('none')) return ['mechanism section is none or a list, not both'];
  const errors: string[] = [];
  const seen = new Set<string>();
  const known = new Set(ids);
  for (const line of lines) {
    const match = /^(?:-\s+)?([a-z0-9-]+):\s*(consume|configure|extend|new)(?:\s+(?:—|–|-)\s+(\S.*))?\s*$/.exec(line);
    if (!match) {
      errors.push(`bad mechanism line: ${line}`);
      continue;
    }
    const id = match[1]!;
    const relation = match[2]!;
    const reason = match[3];
    // A new mechanism is not in the map yet; the task that builds it registers it.
    if (relation === 'new' && known.has(id)) errors.push(`mechanism ${id} is mapped: consume, configure or extend it`);
    if (relation !== 'new' && !known.has(id)) errors.push(`unknown mechanism: ${id}`);
    if (seen.has(id)) errors.push(`duplicate mechanism: ${id}`);
    seen.add(id);
    if (relation === 'new' && !reason?.trim()) errors.push(`mechanism ${id}: new needs the reason no owner fits`);
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

/** Generator output under `generated/`. It is rewritten on every merge, so it is not a claim.
 * A regeneration commit can also write paths outside that prefix. Those are exempt one file at a time,
 * from the commit that wrote them, not by widening this prefix. */
export function isGeneratedOutput(path: string): boolean {
  return path === 'generated' || path.startsWith('generated/');
}

export function claimConflicts(brief: Brief, tasks: Task[]): string[] {
  const conflicts: string[] = [];
  for (const task of tasks) {
    if (task.id === brief.id || !HOLDING.includes(task.state)) continue;
    for (const id of brief.cases) if (task.cases.includes(id)) conflicts.push(`case ${id} is held by ${task.id}`);
    for (const path of brief.paths) {
      if (isGeneratedOutput(path)) continue;
      for (const held of task.paths) {
        if (isGeneratedOutput(held)) continue;
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
  // A prompt may start with `---` (brief frontmatter) or `-`, so no engine may parse it as an option:
  // Grok's parser takes a dash-leading value only in `--single=<prompt>` form; the others take the prompt after `--`.
  if (engine === 'grok') {
    return ['grok', ['-m', GROK_MODEL, '--reasoning-effort', effort,
      '--permission-mode', 'bypassPermissions', '--no-subagents', '--output-format', 'json',
      '--cwd', options.worktree ?? '.', ...(resume ? ['-r', session] : []), `--single=${prompt}`]];
  }
  if (engine === 'cursor') {
    return ['cursor-agent', ['-p', '--model', `${GROK_MODEL}-${effort}`, '--force', '--trust',
      '--sandbox', 'disabled', '--output-format', 'json', '--workspace', options.worktree ?? '.',
      ...(resume ? ['--resume', session] : []), '--', prompt]];
  }
  if (isCodex(engine)) {
    // Maintainer, 2026-10-03: Codex workers run on the fast service tier unless GOAL_CODEX_SERVICE_TIER says otherwise.
    const tier = process.env.GOAL_CODEX_SERVICE_TIER ?? codexServiceTier();
    const common = ['-m', MODELS[engine], '-c', `model_reasoning_effort=${effort}`,
      ...(tier ? ['-c', `service_tier="${tier}"`] : []),
      '--dangerously-bypass-approvals-and-sandbox', '--json', '-o', options.lastMessage ?? '/dev/null'];
    return ['codex', resume ? ['exec', 'resume', session, ...common, '--', prompt]
      : ['exec', ...common, '-C', options.worktree ?? '.', '--', prompt]];
  }
  return ['claude', ['-p', '--model', MODELS[engine], '--effort', effort, '--dangerously-skip-permissions',
    ...(resume ? ['--resume', session] : ['--session-id', session]), '-n', id.toLowerCase(),
    '--output-format', 'json', '--', prompt]];
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

// The common git directory is the main checkout even when this process started inside a linked worktree.
// `--show-toplevel` would be that worktree and would nest `.temp/worktrees` and unit-gate trees past the socket limit.
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

function outOfClaimFiles(committed: string[], sharers: Task[], regenerated: readonly string[] = []): string[] {
  const exempt = new Set(regenerated);
  const migrationOrigins = Object.assign({}, ...sharers.map(sharer => sharer.migrationOrigins ?? {})) as Record<string, string>;
  const files = committed.flatMap(file => {
    const name = migrationOrigins[file] ?? file;
    if (isGeneratedOutput(file) || isGeneratedOutput(name) || exempt.has(file) || exempt.has(name)) return [];
    return [name];
  });
  return outOfScope(files, sharers.flatMap(sharer => sharer.paths));
}

/** Files outside the claim, and which of those another open task claims.
 * `generated/` is never either. `regenerated` is the exact paths a regeneration commit wrote. */
export function landClaimScope(committed: readonly string[], claims: readonly string[],
  otherClaims: readonly { id: string; paths: readonly string[] }[], regenerated: readonly string[] = []): LandScope {
  const exempt = new Set(regenerated);
  const outOfClaim = outOfScope(committed.filter(file => !isGeneratedOutput(file) && !exempt.has(file)), [...claims]);
  const claimedByOthers = [...new Set(outOfClaim.filter(file => otherClaims.some(other => other.paths.some(pattern =>
    !isGeneratedOutput(pattern) && (new Bun.Glob(pattern).match(file) || pathsOverlap(pattern, file))))))];
  return { outOfClaim, claimedByOthers };
}

function scopeViolations(committed: string[], task: Task, sharers: Task[], regenerated: readonly string[] = []): string[] {
  const union = new Set(committed.filter(file =>
    git(root, ['check-attr', 'merge', '--', file], true).endsWith(': merge: union')));
  const sharedTree = !!task.worktreeName || sharers.length > 1;
  return outOfClaimFiles(committed.filter(file => sharedTree || !union.has(file)), sharers, regenerated);
}

/** `git check-attr -z` records `path NUL attr NUL value NUL` for each path. */
function unionMerged(files: readonly string[]): Set<string> {
  const union = new Set<string>();
  for (let start = 0; start < files.length; start += 200) {
    const output = git(root, ['check-attr', '-z', 'merge', '--', ...files.slice(start, start + 200)], true);
    const parts = output ? output.split('\0') : [];
    for (let index = 0; index + 2 < parts.length; index += 3) {
      if (parts[index + 1] === 'merge' && parts[index + 2] === 'union') union.add(parts[index]!);
    }
  }
  return union;
}

/** Commits on `main..branch` whose every change to a path is a regeneration commit. */
function regeneratedOnBranch(branch: string): string[] {
  const log = git(root, ['log', '--name-only', '--pretty=format:%H%x09%s', `main..${branch}`], true);
  return log ? filesOnlyRegenerated(log) : [];
}

/** Files this branch committed outside the claim that land would still refuse if another task claimed them.
 * A solo task may edit union-merge files and regeneration output; a shared branch may not. */
function unlandedOutOfClaim(task: Task, sharers: readonly Task[]): string[] {
  const committed = git(root, ['diff', '--name-only', `main...${task.branch}`], true).split('\n').filter(Boolean);
  if (!committed.length) return [];
  const sharedTree = sharers.some(sharer => sharer.worktreeName) || sharers.length > 1;
  const union = sharedTree ? new Set<string>() : unionMerged(committed);
  const watched = committed.filter(file => !union.has(file));
  return outOfClaimFiles(watched, [...sharers], regeneratedOnBranch(task.branch));
}

/** Out-of-claim commits of a task that has not landed or closed, matched the way a path claim is. */
function unlandedChangeConflicts(brief: Brief, tasks: readonly Task[]): string[] {
  if (!brief.paths.some(path => !isGeneratedOutput(path))) return [];
  const conflicts: string[] = [];
  const seen = new Set<string>();
  for (const task of tasks) {
    if (!UNLANDED.includes(task.state) || !task.branch) continue;
    const key = `${task.worktree}\0${task.branch}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const sharers = tasks.filter(other => other.worktree === task.worktree && other.branch === task.branch
      && HOLDING.includes(other.state));
    // A sharer may adopt the file into its own claim. Another task may not take it.
    if (sharers.some(sharer => sharer.id === brief.id)) continue;
    const files = unlandedOutOfClaim(task, sharers);
    if (!files.length) continue;
    const names = sharers.filter(sharer => UNLANDED.includes(sharer.state)).map(sharer => sharer.id).sort().join(', ');
    for (const path of brief.paths) {
      if (isGeneratedOutput(path)) continue;
      const held = files.some(file => new Bun.Glob(path).match(file) || pathsOverlap(path, file));
      if (held) conflicts.push(`path ${path} changed by ${names} (unlanded)`);
    }
  }
  return conflicts;
}

/** Unlanded tasks that committed this exact path outside their claim. */
function unlandedChangers(tasks: readonly Task[], path: string): Task[] {
  if (!path || isGeneratedOutput(path)) return [];
  const found: Task[] = [];
  const seen = new Set<string>();
  for (const task of tasks) {
    if (!UNLANDED.includes(task.state) || !task.branch) continue;
    const key = `${task.worktree}\0${task.branch}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const sharers = tasks.filter(other => other.worktree === task.worktree && other.branch === task.branch
      && HOLDING.includes(other.state));
    if (!unlandedOutOfClaim(task, sharers).includes(path)) continue;
    found.push(...sharers.filter(sharer => UNLANDED.includes(sharer.state)));
  }
  return found.sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
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
    const migrationOrigins = Object.assign({}, ...sharers.map(sharer => sharer.migrationOrigins ?? {})) as Record<string, string>;
    const committed = changedFiles(task).committed.map(file => migrationOrigins[file] ?? file);
    const others = Object.values(ledger.tasks)
      .filter(other => other.id !== task.id && HOLDING.includes(other.state))
      .map(other => ({ id: other.id, paths: other.paths }));
    const regenerated = regenerationOnlyFiles(task.worktree).map(file => migrationOrigins[file] ?? file);
    return landClaimScope(committed, sharers.flatMap(sharer => sharer.paths), others, regenerated);
  });
}

function landScopeRefusal(ledger: Ledger, task: Task, sharers: Task[], committed: string[], permittedFiles: readonly string[],
  regenerated: readonly string[] = []): string | undefined {
  const violations = outOfClaimFiles(committed, sharers, regenerated);
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
  if (!processAlive({ pid })) return false;
  if (!program) return true;
  try { return readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes(program); } catch { return false; }
}

/** A directory lock is still taken when its owner is alive, or it is new enough that the owner may not have written that record yet. */
function dirLockHeld(path: string, alive: (pid: number) => boolean): boolean {
  return directoryLeaseHeld(path, { alive });
}

async function acquireDir(path: string, timeoutMs: number, label: string): Promise<AcquiredDirectoryLease> {
  const deadline = Date.now() + timeoutMs;
  let announced = false;
  for (;;) {
    const acquired = tryAcquireDirectoryLease(path, { alive: candidate => pidAlive(candidate) });
    if (acquired !== 'held') return acquired;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    if (!announced && timeoutMs > 60_000) { console.error(`waiting for ${label}`); announced = true; }
    await Bun.sleep(label === 'ledger lock' ? 100 : 3000);
  }
}

async function withLedger<T>(change: (ledger: Ledger) => T | Promise<T>): Promise<T> {
  mkdirSync(stateDir, { recursive: true });
  const lock = join(stateDir, 'ledger.lock');
  const lease = await acquireDir(lock, 120_000, 'ledger lock');
  try {
    const ledger = readLedger();
    const result = await change(ledger);
    writeLedger(ledger);
    return result;
  } finally {
    lease.release();
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

/** A manager wake is one turn, and a Goal only advances through its manager.
 * Claude usage and the live-worker cap slow workers; they stay visible here and do not refuse the wake.
 * The memory floor and a reached Codex account for this engine still do. */
export function managerWakeGates(engine: Engine): { live: number; limit: number; claude: UsageLevel } {
  const live = Object.values(readLedger().tasks).filter(running).length;
  const limit = Number(process.env.GOAL_MAX_WORKERS ?? 25);
  const memory = memoryFloorRefusal(readFileSync('/proc/meminfo', 'utf8'), Number(process.env.GOAL_MEMORY_FLOOR_GIB ?? 12));
  if (memory) throw new Error(memory);
  const claude = currentUsage().level;
  const account = codexAccounts().find(candidate => candidate.engines.includes(engine));
  if (account?.reached) throw new Error(`${describeAccount(account)}; use another engine or pass --force-usage`);
  return { live, limit, claude };
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
  const exempt = new Set(existsSync(task.worktree) ? regenerationOnlyFiles(task.worktree) : []);
  const watched = [...new Set([...committed.filter(file => !exempt.has(file)), ...dirty])].filter(file => !isGeneratedOutput(file));
  const violations = outOfScope(watched, task.paths);
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
  const text = readFileSync(absolute, 'utf8');
  const brief = parseBrief(text);
  const errors = [...validateBrief(brief), ...mechanismSectionErrors(text)];
  if (errors.length) throw new Error(`Invalid brief ${briefPath}:\n  ${errors.join('\n  ')}`);
  await withLedger(ledger => {
    if (ledger.tasks[brief.id]) throw new Error(`${brief.id} already exists (${ledger.tasks[brief.id]!.state}); use resume`);
    const goal = briefGoal(ledger, absolute);
    const reservedBy = ledger.reserved?.[brief.id];
    if (reservedBy && reservedBy !== goal) throw new Error(`${brief.id} is reserved for Goal ${reservedBy}; take an ID with \`new\``);
    const tasks = Object.values(ledger.tasks);
    // Commits outside the claim are held until that task lands or closes, or land would refuse it.
    const conflicts = [...claimConflicts(brief, tasks), ...unlandedChangeConflicts(brief, tasks)];
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
    const socket = postgresSocketRefusal(physicalPath(worktree));
    if (socket) throw new Error(socket);
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
      if (current.state === 'running') { current.state = 'exited'; clearRefusal(current); }
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
  const landingLease = await acquireDir(lock, 120_000, `${initial.id} landing lock`);
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
    landingLease.release();
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
    clearRefusal(task);
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
    if (task.state === 'running') { task.state = 'stopped'; clearRefusal(task); }
  });
  console.log(`${id.toUpperCase()} stopped; its worktree and claims remain until close`);
}

export { COMPOSITION_ROOTS };

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

/** Longest declared per-test timeout. `unparseable` means a timeout argument was not a numeric literal. */
export interface DeclaredTestTimeout {
  ms?: number;
  unparseable: boolean;
}

const NUMERIC_LITERAL = /^(?:0|[1-9]\d*(?:_\d+)*)(?:\.\d+(?:_\d+)*)?(?:[eE][+-]?\d+)?$/;

function numericLiteral(text: string): number | undefined {
  const raw = text.trim();
  if (!NUMERIC_LITERAL.test(raw)) return undefined;
  const value = Number(raw.replaceAll('_', ''));
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/** `/` after an operator or bracket starts a regex; after a value it is division. */
function skipRegexLiteral(source: string, index: number): number {
  let i = index + 1;
  let inClass = false;
  while (i < source.length) {
    const char = source[i]!;
    if (char === '\\') { i += 2; continue; }
    if (char === '\n') return index + 1;
    if (inClass) {
      if (char === ']') inClass = false;
      i++;
      continue;
    }
    if (char === '[') { inClass = true; i++; continue; }
    if (char === '/') {
      i++;
      while (i < source.length && /[a-z]/i.test(source[i]!)) i++;
      return i;
    }
    i++;
  }
  return i;
}

function skipQuoted(source: string, index: number, canRegex: boolean): number {
  const quote = source[index]!;
  if (quote === '/' && canRegex) return skipRegexLiteral(source, index);
  if (quote !== '"' && quote !== "'" && quote !== '`') return index + 1;
  let i = index + 1;
  while (i < source.length) {
    const char = source[i]!;
    if (char === '\\') { i += 2; continue; }
    if (quote === '`' && char === '$' && source[i + 1] === '{') {
      i = skipBracket(source, i + 1);
      continue;
    }
    if (char === quote) return i + 1;
    if (char === '\n' && quote !== '`') return i;
    i++;
  }
  return i;
}

/** Index just past the bracket at `open`, which is `(`, `[` or `{`. Strings, comments and regexes stay opaque. */
function skipBracket(source: string, open: number): number {
  const closing: Record<string, string> = { '(': ')', '[': ']', '{': '}' };
  const stack = [closing[source[open]!]!];
  let i = open + 1;
  let value = false;
  while (i < source.length && stack.length) {
    const char = source[i]!;
    const next = source[i + 1];
    if (char === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') i++;
      continue;
    }
    if (char === '/' && next === '*') {
      i += 2;
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) i++;
      i = Math.min(source.length, i + 2);
      continue;
    }
    if (char === '"' || char === "'" || char === '`' || (char === '/' && !value)) {
      const skipped = skipQuoted(source, i, char === '/' && !value);
      value = skipped > i + 1 || char !== '/';
      i = skipped;
      continue;
    }
    if (char === '(' || char === '[' || char === '{') {
      stack.push(closing[char]!);
      value = false;
      i++;
      continue;
    }
    if (char === stack.at(-1)) {
      stack.pop();
      value = true;
      i++;
      continue;
    }
    if (/[A-Za-z0-9_$]/.test(char) || char === ')' || char === ']' || char === '}') value = true;
    else if (!/\s/.test(char)) value = false;
    i++;
  }
  return i;
}

function callArguments(source: string, open: number): { args: string[]; end: number } | undefined {
  if (source[open] !== '(') return undefined;
  const end = skipBracket(source, open);
  if (source[end - 1] !== ')') return undefined;
  const body = source.slice(open + 1, end - 1);
  const args: string[] = [];
  let start = 0;
  let i = 0;
  let value = false;
  while (i < body.length) {
    const char = body[i]!;
    const next = body[i + 1];
    if (char === '/' && next === '/') {
      while (i < body.length && body[i] !== '\n') i++;
      continue;
    }
    if (char === '/' && next === '*') {
      i += 2;
      while (i < body.length && !(body[i] === '*' && body[i + 1] === '/')) i++;
      i = Math.min(body.length, i + 2);
      continue;
    }
    if (char === '"' || char === "'" || char === '`' || (char === '/' && !value)) {
      const skipped = skipQuoted(body, i, char === '/' && !value);
      value = true;
      i = skipped;
      continue;
    }
    if (char === '(' || char === '[' || char === '{') {
      i = skipBracket(body, i);
      value = true;
      continue;
    }
    if (char === ',') {
      args.push(body.slice(start, i));
      start = i + 1;
      value = false;
      i++;
      continue;
    }
    if (/[A-Za-z0-9_$]/.test(char)) value = true;
    else if (!/\s/.test(char)) value = false;
    i++;
  }
  args.push(body.slice(start));
  return { args: args.filter(arg => arg.trim()), end };
}

function isCallback(argument: string): boolean {
  const text = argument.trim();
  return /^(?:async\b|function\b|\()/.test(text) || /=>/.test(text);
}

/** Numeric last argument of `test(...)` / `it(...)`, and `setDefaultTimeout(...)`. The longest one wins. */
export function declaredTestTimeout(source: string): DeclaredTestTimeout {
  let max: number | undefined;
  let unparseable = false;
  const note = (value: number | undefined) => {
    if (value === undefined) { unparseable = true; return; }
    max = max === undefined ? value : Math.max(max, value);
  };
  let i = 0;
  let value = false;
  while (i < source.length) {
    const char = source[i]!;
    const next = source[i + 1];
    if (char === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') i++;
      continue;
    }
    if (char === '/' && next === '*') {
      i += 2;
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) i++;
      i = Math.min(source.length, i + 2);
      continue;
    }
    if (char === '"' || char === "'" || char === '`' || (char === '/' && !value)) {
      i = skipQuoted(source, i, char === '/' && !value);
      value = true;
      continue;
    }
    if (!/[A-Za-z_$]/.test(char) || (i > 0 && /[A-Za-z0-9_$]/.test(source[i - 1]!))) {
      // Parens stay visible so a timeout on a nested `test` call is still read.
      if (/[A-Za-z0-9_$]/.test(char) || char === ')' || char === ']' || char === '}') value = true;
      else if (!/\s/.test(char)) value = false;
      i++;
      continue;
    }
    const name = /^[A-Za-z_$][\w$]*/.exec(source.slice(i))![0]!;
    let cursor = i + name.length;
    const callee = name === 'test' || name === 'it' || name === 'setDefaultTimeout';
    if (!callee || (i > 0 && source[i - 1] === '.')) {
      value = true;
      i = cursor;
      continue;
    }
    const dotted = /^\s*(?:\.\s*[A-Za-z_$][\w$]*\s*)*/.exec(source.slice(cursor));
    cursor += dotted?.[0].length ?? 0;
    while (source[cursor] !== undefined && /\s/.test(source[cursor]!)) cursor++;
    if (source[cursor] !== '(') {
      value = true;
      i = cursor;
      continue;
    }
    let call = callArguments(source, cursor);
    if (!call) { value = true; i = cursor + 1; continue; }
    // `test.if(condition)(name, fn, timeout)` keeps the timeout on the following call.
    while (name !== 'setDefaultTimeout') {
      let after = call.end;
      while (source[after] !== undefined && /\s/.test(source[after]!)) after++;
      if (source[after] !== '(') break;
      const nextCall = callArguments(source, after);
      if (!nextCall) break;
      call = nextCall;
    }
    if (name === 'setDefaultTimeout') note(call.args.length === 1 ? numericLiteral(call.args[0]!) : undefined);
    else if (call.args.length >= 3) {
      const last = call.args.at(-1)!;
      const parsed = numericLiteral(last);
      if (parsed !== undefined) note(parsed);
      else if (!isCallback(last) && !last.trim().startsWith('{')) note(undefined);
    }
    value = true;
    i = call.end;
  }
  return unparseable ? { unparseable: true } : { unparseable: false, ...(max !== undefined ? { ms: max } : {}) };
}

/** Added to a declared timeout when that file needs its own shard. One minute covers process startup under contention. */
export const UNIT_GATE_TIMEOUT_MARGIN_MS = 60_000;

export interface PlannedUnitShard { files: string[]; budgetMs: number }

/** Files with no measured duration share a shard only up to this count.
 * A twelve-minute budget on a host already running other gates does not finish a hundred-file shard. */
export const UNIT_GATE_FILE_CAP = 8;

/** A file whose declared timeout plus the margin exceeds the default budget runs alone at that longer budget.
 * Measured durations pack every other file so the shard fits the budget: a known-slow file runs alone, and
 * files with no measurement share a shard only up to the file cap. A wide plan is more shards, not larger
 * ones. `shardCount` is how many of those shards run at once, not how many the plan is cut into. */
export function planUnitGateShards(entries: readonly { file: string; timeout: DeclaredTestTimeout; durationMs?: number }[],
  shardCount: number, defaultBudgetMs: number): { shards: PlannedUnitShard[]; unparseable: string[] } {
  const unparseable: string[] = [];
  const long: PlannedUnitShard[] = [];
  const rest: { file: string; durationMs?: number }[] = [];
  let measured = false;
  for (const entry of entries) {
    const duration = measuredDuration(entry.durationMs);
    if (entry.timeout.unparseable) {
      unparseable.push(entry.file);
      rest.push({ file: entry.file, ...(duration === undefined ? {} : { durationMs: duration }) });
      if (duration !== undefined) measured = true;
      continue;
    }
    const timeout = entry.timeout.ms;
    if (timeout !== undefined && timeout + UNIT_GATE_TIMEOUT_MARGIN_MS > defaultBudgetMs) {
      long.push({ files: [entry.file], budgetMs: timeout + UNIT_GATE_TIMEOUT_MARGIN_MS });
    } else {
      rest.push({ file: entry.file, ...(duration === undefined ? {} : { durationMs: duration }) });
      if (duration !== undefined) measured = true;
    }
  }
  const packed = measured
    ? packMeasuredUnitShards(rest, defaultBudgetMs)
    : packCountedUnitShards(rest.map(entry => entry.file), shardCount, defaultBudgetMs);
  return { shards: [...long, ...packed], unparseable };
}

function measuredDuration(durationMs: number | undefined): number | undefined {
  return durationMs !== undefined && Number.isFinite(durationMs) && durationMs >= 0 ? durationMs : undefined;
}

function chunkFiles(files: readonly string[], size: number): string[][] {
  const groups: string[][] = [];
  for (let index = 0; index < files.length; index += size) groups.push(files.slice(index, index + size));
  return groups;
}

/** Round-robin when that already fits the cap, so a small plan keeps today's shard shape.
 * A plan that would put more than the cap in one shard is cut into cap-sized shards instead. */
function packCountedUnitShards(files: readonly string[], shardCount: number, budgetMs: number): PlannedUnitShard[] {
  if (!files.length) return [];
  const balanced = balanceUnitShards(files, shardCount);
  const groups = balanced.every(group => group.length <= UNIT_GATE_FILE_CAP) ? balanced : chunkFiles(files, UNIT_GATE_FILE_CAP);
  return groups.map(group => ({ files: group, budgetMs }));
}

/** Known-slow files take a shard of their own. The rest are packed longest-first into the budget and the cap.
 * A file with no measurement costs one cap slot, so it cannot crowd out a measured file. */
function packMeasuredUnitShards(entries: readonly { file: string; durationMs?: number }[], budgetMs: number): PlannedUnitShard[] {
  const room = Math.max(1, budgetMs - UNIT_GATE_TIMEOUT_MARGIN_MS);
  const slot = Math.max(1, Math.floor(room / UNIT_GATE_FILE_CAP));
  const solo: PlannedUnitShard[] = [];
  const packed: { file: string; cost: number }[] = [];
  for (const entry of entries) {
    const duration = entry.durationMs;
    if (duration !== undefined && (duration >= budgetMs / 2 || duration + UNIT_GATE_TIMEOUT_MARGIN_MS > budgetMs)) {
      solo.push({ files: [entry.file], budgetMs: Math.max(budgetMs, duration + UNIT_GATE_TIMEOUT_MARGIN_MS) });
    } else packed.push({ file: entry.file, cost: duration ?? slot });
  }
  packed.sort((left, right) => right.cost - left.cost || left.file.localeCompare(right.file));
  const bins: { files: string[]; cost: number }[] = [];
  for (const item of packed) {
    const bin = bins.find(candidate => candidate.files.length < UNIT_GATE_FILE_CAP && candidate.cost + item.cost <= room);
    if (bin) {
      bin.files.push(item.file);
      bin.cost += item.cost;
    } else bins.push({ files: [item.file], cost: item.cost });
  }
  return [...solo, ...bins.map(bin => ({ files: bin.files, budgetMs }))];
}

const UNIT_DURATION_FILE = 'unit-file-durations.json';
const UNIT_DURATION_SCAN_BYTES = 256 * 1024;

function absorbDurationRecord(into: Map<string, number>, value: unknown): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  for (const [file, ms] of Object.entries(value as Record<string, unknown>)) {
    const duration = measuredDuration(typeof ms === 'number' ? ms : undefined);
    if (duration === undefined || !file || file.startsWith('..')) continue;
    into.set(file, Math.max(into.get(file) ?? 0, duration));
  }
}

function readDurationJson(path: string, into: Map<string, number>): void {
  try {
    if (!existsSync(path) || statSync(path).size > UNIT_DURATION_SCAN_BYTES) return;
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && 'durations' in parsed) {
      absorbDurationRecord(into, (parsed as { durations?: unknown }).durations);
    } else absorbDurationRecord(into, parsed);
  } catch { /* an unreadable history file is not a duration */ }
}

function recentQaDurationFiles(qaRoot: string): string[] {
  if (!existsSync(qaRoot)) return [];
  let runs: string[];
  try {
    runs = readdirSync(qaRoot, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name)
      .sort((left, right) => right.localeCompare(left)).slice(0, 15);
  } catch { return []; }
  const files: string[] = [];
  for (const run of runs) {
    const logs = join(qaRoot, run, 'logs');
    if (!existsSync(logs)) continue;
    try {
      for (const name of readdirSync(logs)) if (name.endsWith('-durations.json')) files.push(join(logs, name));
    } catch { /* a run directory that cannot be read has no durations */ }
  }
  return files;
}

/** Measured per-file time from this gate's own memory, earlier gate evidence, and QA `*-durations.json`.
 * The longest observation wins, so a quiet run does not shrink a shard that previously needed the room. */
export function readMeasuredUnitDurations(cwd: string): Map<string, number> {
  const durations = new Map<string, number>();
  const orchestration = [join(cwd, '.temp', 'goal-orchestration'), stateDir];
  for (const directory of orchestration) readDurationJson(join(directory, UNIT_DURATION_FILE), durations);
  for (const directory of orchestration) {
    const merges = join(directory, 'merges');
    if (!existsSync(merges)) continue;
    // The checkout's merge evidence can be large. Read duration sidecars there, and small evidence
    // files only from the tree under test, which is where a fixture records a measured file.
    const treeLocal = directory === join(cwd, '.temp', 'goal-orchestration');
    try {
      for (const name of readdirSync(merges)) {
        if (!name.endsWith('.json')) continue;
        if (!treeLocal && !name.endsWith('-durations.json')) continue;
        readDurationJson(join(merges, name), durations);
      }
    } catch { /* evidence that cannot be read is skipped */ }
  }
  const qaRoots = new Set([join(cwd, '.artifacts', 'qa'), join(root, '.artifacts', 'qa')]);
  for (const qaRoot of qaRoots) for (const path of recentQaDurationFiles(qaRoot)) readDurationJson(path, durations);
  return durations;
}

function durationsFromOutput(output: string, files: readonly string[], skip: ReadonlySet<string>): Map<string, number> {
  const known = new Set(files);
  const totals = new Map<string, number>();
  let current: string | undefined;
  for (const line of output.split('\n')) {
    const header = /^(\S+\.(?:test|spec)\.[cm]?[jt]sx?):$/.exec(line);
    if (header) {
      const file = header[1]!.replace(/^\.\//, '');
      current = known.has(file) ? file : undefined;
      continue;
    }
    const timed = /^\((?:pass|fail|skip|todo)\)\s+.*\[(\d+(?:\.\d+)?)(ms|s)\]\s*$/.exec(line);
    if (!current || skip.has(current) || !timed) continue;
    const ms = Number(timed[1]) * (timed[2] === 's' ? 1000 : 1);
    if (Number.isFinite(ms) && ms >= 0) totals.set(current, (totals.get(current) ?? 0) + ms);
  }
  return totals;
}

/** Keep the longest observed time for repo files. Fixture names without a directory are not history. */
function rememberUnitDurations(found: ReadonlyMap<string, number>): void {
  const usable = [...found].filter(([file]) => file.includes('/') && !file.startsWith('..'));
  if (!usable.length) return;
  const path = join(stateDir, UNIT_DURATION_FILE);
  try {
    mkdirSync(stateDir, { recursive: true });
    const current = new Map<string, number>();
    readDurationJson(path, current);
    for (const [file, ms] of usable) current.set(file, Math.max(current.get(file) ?? 0, ms));
    const record = Object.fromEntries([...current].sort(([left], [right]) => left.localeCompare(right)));
    writeFileSync(path, `${JSON.stringify(record)}\n`);
  } catch { /* a duration memory that cannot be written does not change this gate's verdict */ }
}

function existingTestFiles(worktree: string, entries: readonly string[], wholeTier: readonly string[]): string[] {
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
      for (const file of wholeTier) collect(file);
    } else collect(entry);
  }
  return [...selected];
}

/** Unit files named by an affected-plan transcript. Fixtures and a checkout without the typed planner still use this; the merge gate reads the plan object. */
export function mergeUnitFiles(worktree: string, plan: string): string[] {
  if (!/^Affected since /m.test(plan)) throw new Error('Affected unit plan was not produced');
  const entries = [...plan.matchAll(/^  unit: (.+)$/gm)].map(match => match[1]!);
  const selected = new Set(existingTestFiles(worktree, entries, [...testArgs('unit'), ...unitHarnessFiles]));
  for (const file of existingTestFiles(worktree, repositoryGuards.map(guard => guard.file), [])) selected.add(file);
  return [...selected].sort();
}

/** Owner-tier files from the same transcript. Whole-tier widening uses the worktree's owner registry. */
export function mergeOwnerFiles(worktree: string, plan: string): string[] {
  if (!/^Affected since /m.test(plan)) throw new Error('Affected unit plan was not produced');
  const entries = [...plan.matchAll(/^  owner: (.+)$/gm)].map(match => match[1]!);
  const whole = entries.some(entry => entry.startsWith('whole tier (')) ? ownerGateFiles(worktree) : [];
  return existingTestFiles(worktree, entries, whole).sort();
}

/** Unit files from the typed plan. Widening lists the registered unit entries and omits input-selected native files unless the plan names them. */
export function unitFilesFromPlan(worktree: string, plan: AffectedPlan): string[] {
  const widened = plan.widened.some(item => item.tier === 'unit');
  const entries = [...(widened ? affectedUnitTierEntries() : []), ...plan.tests.unit];
  const selected = new Set(existingTestFiles(worktree, entries, []));
  for (const file of existingTestFiles(worktree, repositoryGuards.map(guard => guard.file), [])) selected.add(file);
  return [...selected].sort();
}

/** Owner files from the typed plan. Whole-tier widening uses the worktree's owner registry. */
export function ownerFilesFromPlan(worktree: string, plan: AffectedPlan): string[] {
  const widened = plan.widened.some(item => item.tier === 'owner');
  const entries = [...(widened ? ['whole tier (owner)'] : []), ...plan.tests.owner];
  return existingTestFiles(worktree, entries, widened ? ownerGateFiles(worktree) : []).sort();
}

/** Separates the console transcript from the JUnit report appended for attribution. */
export const UNIT_JUNIT_MARKER = '<!-- goal-unit-junit -->';

const UNIT_SUMMARY_LINE = /^(?:\d+ tests? failed:|\s*\d+\s+pass\b)/;

interface GateJunitBlock { xml: string; before: string; after: string }

/** The report the gate appended: the last marker at column 0 whose next element is `<testsuites>`.
 * A test can print the marker indented, or an earlier copy, including one cut off mid-element.
 * Those copies are transcripts. Only this block names failures. */
function gateJunitBlock(output: string): GateJunitBlock | undefined {
  let from = output.length;
  while (from > 0) {
    const at = output.lastIndexOf(UNIT_JUNIT_MARKER, from - 1);
    if (at < 0) return undefined;
    from = at;
    if (at !== 0 && output[at - 1] !== '\n') continue;
    const rest = output.slice(at + UNIT_JUNIT_MARKER.length);
    const start = rest.search(/<testsuites\b/);
    if (start < 0) continue;
    if (!/^(?:\s*<\?xml\b[^>]*\?>)?\s*$/.test(rest.slice(0, start))) continue;
    const end = rest.indexOf('</testsuites>', start);
    if (end < 0) continue;
    const close = end + '</testsuites>'.length;
    return { xml: rest.slice(start, close), before: output.slice(0, at), after: rest.slice(close) };
  }
  return undefined;
}

function junitXml(output: string): string | undefined {
  return gateJunitBlock(output)?.xml;
}

/** Text outside every JUnit block. An owner transcript joined after a block stays. */
function stripJunitBlocks(text: string): string {
  return text.split(UNIT_JUNIT_MARKER).map((part, index) => {
    if (index === 0) return part;
    const end = part.lastIndexOf('</testsuites>');
    return end < 0 ? '' : part.slice(end + '</testsuites>'.length);
  }).join('\n');
}

/** Drop the bun summary at the end of one segment. Its `(fail)` lines have no file header, so they belong to no file.
 * A test can print the same words in the middle; that copy is followed by a later `(pass)` or file header and stays. */
function dropRunSummary(text: string): string {
  const lines = text.split('\n');
  const fileHeader = /^(\S+\.(?:test|spec)\.[cm]?[jt]sx?):$/;
  for (let index = 0; index < lines.length; index++) {
    if (!UNIT_SUMMARY_LINE.test(lines[index]!)) continue;
    const continued = lines.slice(index + 1).some(line => fileHeader.test(line) || /^\((?:pass|skip|todo)\) /.test(line));
    if (!continued) return lines.slice(0, index).join('\n');
  }
  return text;
}

/** `(fail)` lines printed before the gate's report belong to whatever file was logging, not to the header they name. */
function stripPreReportFailures(text: string): string {
  return text.split('\n').filter(line => !/^\(fail\) /.test(line)).join('\n');
}

/** Bun's end-of-run summary has `(fail)` lines and no file header. Those lines belong to no file.
 * A unit JUnit block is removed per segment, so an owner transcript joined after it stays readable.
 * `(fail)` lines before the gate's report are transcripts and are not file results. */
function beforeUnitSummary(output: string): string {
  const block = gateJunitBlock(output);
  if (!block) return dropRunSummary(stripJunitBlocks(output));
  const before = stripPreReportFailures(dropRunSummary(stripJunitBlocks(block.before)));
  const after = dropRunSummary(stripJunitBlocks(block.after));
  return `${before}\n${after}`;
}

/** Console text joined after the gate's report. Owner cases live here. Empty when the shard has no report. */
function consoleAfterReport(output: string): string {
  const block = gateJunitBlock(output);
  if (!block) return '';
  return dropRunSummary(stripJunitBlocks(block.after));
}

/** Testcases in the gate's appended report. Undefined when that report is absent.
 * A leading `./` is the same file the console header names without it. */
function reportCases(output: string, root?: string): TestResult[] | undefined {
  const xml = junitXml(output);
  if (xml === undefined) return undefined;
  return parseJUnit(xml, 'unit', root === undefined ? undefined : { root }).map(test => ({
    ...test,
    file: test.file.replace(/^\.\//, ''),
  }));
}

/** Files the appended JUnit report names, including ones whose cases passed.
 * A file that is absent was not in that report, so its console cases still count. */
function junitReportedFiles(output: string, candidates: readonly string[], root?: string): Set<string> {
  const cases = reportCases(output, root);
  if (!cases) return new Set();
  const known = new Set(candidates);
  const files = new Set<string>();
  for (const test of cases) if (known.has(test.file)) files.add(test.file);
  return files;
}

interface JunitFailure extends UnitFailureDetail { timeout: boolean }

/** Named failures from the gate's JUnit report. Undefined when that report is absent.
 * A present report with no failures is an empty list, so the console summary cannot supply names. */
function junitFailures(output: string, candidates: readonly string[], root?: string): JunitFailure[] | undefined {
  const cases = reportCases(output, root);
  if (!cases) return undefined;
  const known = new Set(candidates);
  const found: JunitFailure[] = [];
  const seen = new Set<string>();
  for (const test of cases) {
    if (!test.failed || !known.has(test.file)) continue;
    const key = `${test.file}\0${test.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const detail = test.detail ? normalizeUnitFileError(test.detail, root) : undefined;
    found.push({ file: test.file, test: test.name, timeout: test.timeout === true, ...(detail ? { detail } : {}) });
  }
  return found;
}

function junitFailureDetails(output: string, candidates: readonly string[], root?: string): UnitFailureDetail[] | undefined {
  const found = junitFailures(output, candidates, root);
  if (!found) return undefined;
  return found.map(({ file, test, detail }) => ({ file, test, ...(detail ? { detail } : {}) }));
}

function junitTimeoutFiles(output: string, candidates: readonly string[], root?: string): string[] {
  return [...new Set((junitFailures(output, candidates, root) ?? []).filter(item => item.timeout).map(item => item.file))].sort();
}

function consoleFailureKinds(output: string, candidates: readonly string[], root?: string): { fail: Set<string>; unhandled: Set<string> } {
  const known = new Set(candidates);
  const fail = new Set<string>();
  const unhandled = new Set<string>();
  let current: string | undefined;
  for (const line of beforeUnitSummary(output).split('\n')) {
    const header = /^(\S+\.(?:test|spec)\.[cm]?[jt]sx?):$/.exec(line);
    if (header) {
      let file = header[1]!.replace(/^\.\//, '');
      if (root && isAbsolute(file)) file = relative(root, file);
      current = known.has(file) ? file : undefined;
    } else if (current && /^\(fail\) /.test(line)) fail.add(current);
    else if (current && /^# Unhandled error/.test(line)) unhandled.add(current);
  }
  return { fail, unhandled };
}

/** Files a failing bun run names. The gate's report is the last column-0 `<testsuites>` block.
 * A file that report names contributes only that report's failures. Console `(fail)` lines before
 * the report, including ones another file printed, are not failures. A file the report omits still
 * counts a `# Unhandled error`, and a `(fail)` line after the report, because an owner transcript
 * is joined there and bun leaves a load failure out of the report. With no report, the console is
 * the only source. */
export function failingTestFiles(output: string, candidates: readonly string[], root?: string): string[] {
  const kinds = consoleFailureKinds(output, candidates, root);
  const junit = junitFailureDetails(output, candidates, root);
  if (!junit) return [...new Set([...kinds.fail, ...kinds.unhandled])].sort();
  const covered = junitReportedFiles(output, candidates, root);
  const omitted = [...kinds.fail, ...kinds.unhandled].filter(file => !covered.has(file));
  return [...new Set([...junit.map(item => item.file), ...omitted])].sort();
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

/** `task` is not the test process. A new session lets the budget signal reach bun underneath it. */
async function stopProcessGroup(child: ChildProcess): Promise<void> {
  if (!child.pid) return;
  await terminateProcessGroup(child.pid, { graceMs: 2_000, killWaitMs: 5_000 });
}

/** The preload names the bun process that is about to die, so the sweep can remove only that shard's containers. */
async function stopGateShard(child: ChildProcess): Promise<void> {
  try { await stopProcessGroup(child); }
  finally {
    sweepOrphanContainers();
    await Bun.sleep(reapSettleMs);
    sweepOrphanContainers();
  }
}

export interface UnitShardResult {
  done: boolean; failing: string[]; timedOut: string[]; failures: UnitFailureDetail[]; fileErrors: UnitFileErrorDetail[];
  runnerErrors: UnitRunnerError[]; files: string[]; output: string; ms: number;
  /** The shard stopped at the wall-clock budget, so files it never reached have no verdict yet. */
  budgetExpired?: boolean;
}

export type UnitShardRunner = (cwd: string, files: readonly string[], deadline: number) => Promise<UnitShardResult>;

function unitFileFromHeader(output: string, files: readonly string[], cwd: string): string | undefined {
  const known = new Set(files);
  const headers = [...beforeUnitSummary(output).matchAll(/^(\S+\.(?:test|spec)\.[cm]?[jt]sx?):$/gm)];
  for (let index = headers.length - 1; index >= 0; index--) {
    let file = headers[index]![1]!.replace(/^\.\//, '');
    if (isAbsolute(file)) file = relative(cwd, file);
    if (known.has(file)) return file;
  }
  return files.length === 1 ? files[0] : undefined;
}

/** Bun prints its test timeout as a failed test, so it needs a retry before it can decide a side.
 * A JUnit `TimeoutError` names the file even when a printed header owns the console timeout line.
 * A console timeout before the report counts only for a file that report names; a line under a
 * header the report does not name was printed by another file. */
export function timedOutTestFiles(output: string, candidates: readonly string[], root?: string): string[] {
  const known = new Set(candidates);
  const found = new Set<string>();
  const timeoutLine = /(?:timed out after\s+\d+(?:\.\d+)?\s*(?:ms|s)\b|timed out\s*\([^)]*\bagainst\b[^)]*\)|timeout of\s+\d+(?:\.\d+)?\s*(?:ms|s)\s+(?:was\s+)?exceeded)/i;
  const scan = (text: string, onlyCovered: ReadonlySet<string> | undefined) => {
    let current: string | undefined;
    for (const line of text.split('\n')) {
      const header = /^(\S+\.(?:test|spec)\.[cm]?[jt]sx?):$/.exec(line);
      if (header) {
        current = header[1]!.replace(/^\.\//, '');
        if (root && isAbsolute(current)) current = relative(root, current);
        if (!known.has(current)) current = undefined;
      } else if (current && timeoutLine.test(line) && (!onlyCovered || onlyCovered.has(current))) found.add(current);
    }
  };
  const block = gateJunitBlock(output);
  if (!block) scan(beforeUnitSummary(output), undefined);
  else {
    scan(dropRunSummary(stripJunitBlocks(block.before)), junitReportedFiles(output, candidates, root));
    scan(dropRunSummary(stripJunitBlocks(block.after)), undefined);
  }
  for (const file of junitTimeoutFiles(output, candidates, root)) found.add(file);
  return [...found].sort();
}

export function shardTimeoutFiles(output: string, candidates: readonly string[], root: string): string[] {
  return [...new Set([...timedOutTestFiles(output, candidates, root), ...[unitFileFromHeader(output, candidates, root)].filter(
    (file): file is string => file !== undefined)])].sort();
}

export interface UnitFailureDetail { file: string; test: string; detail?: string }
export interface UnitFileErrorDetail { file: string; detail: string }
export interface UnitRunnerError { files: string[]; diagnostic: string }

/** Bun prints a load or assertion diagnostic at column 0. A passing test indents the same words
 * when it logs a gate transcript (`      error: id 111`); that copy is not this file's error. */
function isUnitErrorLine(line: string): boolean {
  return /^(?:error|Error|[A-Z][\w$]*(?:Error|Exception)):\s*/i.test(line);
}

/** Capture each failed test's assertion detail without file-specific stack locations.
 * A JUnit report names the file; the console summary after the last file does not. */
export function unitFailureDetails(output: string, candidates: readonly string[], root?: string): UnitFailureDetail[] {
  const reported = junitFailureDetails(output, candidates, root);
  if (reported) return reported;
  const known = new Set(candidates);
  const found: UnitFailureDetail[] = [];
  const plain = beforeUnitSummary(output).replace(/\u001b\[[\d;]*m/g, '');
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

/** Retain file-scoped unhandled errors, separate from named assertion failures.
 * A file the report names already ran; its `error:` lines are transcript. A bare `error:` line
 * before the report, under a file the report does not name, was printed by another file.
 * `# Unhandled error` still counts for an omitted file. A bare `error:` after the report is the
 * owner transcript joined there. */
export function unitFileErrorDetails(output: string, candidates: readonly string[], root?: string,
  failingFiles: readonly string[] = []): UnitFileErrorDetail[] {
  const known = new Set(candidates);
  const reportedByJunit = junitReportedFiles(output, candidates, root);
  const errors = new Map<string, string[][]>();
  const sections = new Map<string, string[]>();
  const namedFailures = new Set(unitFailureDetails(output, candidates, root).map(failure => failure.file));
  const collect = (plain: string, bareErrors: boolean) => {
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
        if (!collecting && !bareErrors) continue;
        if (reportedByJunit.has(current) && !collecting) continue;
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
  };
  const plain = (text: string) => dropRunSummary(stripJunitBlocks(text)).replace(/\u001b\[[\d;]*m/g, '');
  const block = gateJunitBlock(output);
  if (!block) collect(plain(output), true);
  else {
    collect(plain(block.before), false);
    collect(plain(block.after), true);
  }
  for (const file of failingFiles) {
    if (reportedByJunit.has(file) || errors.has(file) || namedFailures.has(file)) continue;
    const diagnostic = (sections.get(file) ?? []).filter(line => !bunRunSummaryLine(line)
      && !/^\((?:pass|fail|skip|todo)\)/.test(line)).join('\n').trim();
    if (diagnostic) errors.set(file, [[diagnostic]]);
  }
  return [...errors].flatMap(([file, blocks]) => blocks.map(lines => ({ file,
    detail: normalizeUnitFileError(lines.join('\n'), root) })));
}

/** Kept per failing file so a later retry can name the case after the raw shard log is gone. */
const UNIT_GATE_FILE_OUTPUT_CAP = 20 * 1024;
const UNIT_GATE_FAILURE_ERROR_LINES = 40;
const UNIT_TIMEOUT_LINE = /(?:timed out after\s+\d+(?:\.\d+)?\s*(?:ms|s)\b|timed out\s*\([^)]*\bagainst\b[^)]*\)|timeout of\s+\d+(?:\.\d+)?\s*(?:ms|s)\s+(?:was\s+)?exceeded)/i;
const UNIT_RESULT_LINE = /^\((?:pass|fail|skip|todo)\)\s+/;
const UNIT_FAIL_LINE = /^\(fail\)\s+(.+?)(?:\s+\[[^\]]+\])?\s*$/;
const UNIT_FILE_HEADER = /^(\S+\.(?:test|spec)\.[cm]?[jt]sx?):$/;

export type UnitGateRunKind = 'first' | 'isolated-retry' | 'never-started-rerun' | 'confirm' | 'alone';
export interface UnitFailureCase { test: string; error: string }
export interface UnitFileEvidence {
  file: string;
  /** This file's own transcript, capped at 20KB. */
  output: string;
  cases: UnitFailureCase[];
  /** Set when a timeout's transcript or owner progress names the test that was running. */
  runningTest?: string;
  /** A file-level diagnostic, kept beside any `(fail)` cases. An import error between tests is one. */
  fileError?: string;
}
export interface UnitRunEvidence {
  side: 'affected' | 'main';
  kind: UnitGateRunKind;
  files: UnitFileEvidence[];
}
export interface UnitGatePass {
  kind: 'first' | 'never-started-rerun';
  output: string;
  files: string[];
  failing: string[];
  timedOut: string[];
}

function unitHeaderFile(header: string, root?: string): string {
  let file = header.replace(/^\.\//, '');
  if (root && isAbsolute(file)) file = relative(root, file);
  return file;
}

/** A file can appear twice: bun's transcript, then the owner progress file appended after a kill. */
function fileSection(output: string, file: string, root?: string): string {
  const chunks: string[] = [];
  let current: string | undefined;
  let bucket: string[] = [];
  const flush = () => { if (current === file && bucket.length) chunks.push(bucket.join('\n')); };
  for (const line of beforeUnitSummary(output).split('\n')) {
    const header = UNIT_FILE_HEADER.exec(line);
    if (header) {
      flush();
      current = unitHeaderFile(header[1]!, root);
      bucket = [];
      continue;
    }
    if (current === file) bucket.push(line);
  }
  flush();
  return chunks.join('\n');
}

function utf8Bytes(text: string): number {
  return Buffer.byteLength(text);
}

/** Longest prefix of `text` whose UTF-8 encoding fits in `maxBytes`, ending on a character boundary. */
function truncateUtf8(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return '';
  if (utf8Bytes(text) <= maxBytes) return text;
  const chars = [...text];
  let bytes = 0;
  let count = 0;
  for (const char of chars) {
    const size = utf8Bytes(char);
    if (bytes + size > maxBytes) break;
    bytes += size;
    count++;
  }
  return chars.slice(0, count).join('');
}

/** A window of at most `room` UTF-8 bytes that keeps the failure when the transcript names one. */
function utf8Window(text: string, focus: number, room: number): { start: number; text: string } {
  const chars = [...text];
  const prefix = [0];
  for (const char of chars) prefix.push(prefix.at(-1)! + utf8Bytes(char));
  const total = prefix.at(-1)!;
  let unit = 0;
  let focusBytes = total;
  if (focus >= 0) {
    for (let index = 0; index < chars.length; index++) {
      if (unit >= focus) { focusBytes = prefix[index]!; break; }
      unit += chars[index]!.length;
    }
  }
  const startByte = focus < 0 ? Math.max(0, total - room) : Math.max(0, Math.min(focusBytes, Math.max(0, total - room)));
  let start = 0;
  while (start < chars.length && prefix[start + 1]! <= startByte) start++;
  if (prefix[start]! < startByte) start++;
  let end = start;
  while (end < chars.length && prefix[end + 1]! - prefix[start]! <= room) end++;
  return { start, text: chars.slice(start, end).join('') };
}

function capFileOutput(text: string): string {
  if (utf8Bytes(text) <= UNIT_GATE_FILE_OUTPUT_CAP) return text;
  const marker = '[truncated to 20KB]\n';
  const room = UNIT_GATE_FILE_OUTPUT_CAP - utf8Bytes(marker);
  const focus = Math.max(text.lastIndexOf('(fail) '), text.search(UNIT_TIMEOUT_LINE));
  const window = utf8Window(text, focus, room);
  return `${window.start > 0 ? marker : ''}${window.text}`;
}

function errorBeforeFailure(pending: readonly string[]): string[] {
  const start = pending.findIndex(line => isUnitErrorLine(line) || UNIT_TIMEOUT_LINE.test(line) || /^Timeout:/i.test(line));
  if (start < 0) return [];
  const collected: string[] = [];
  for (const line of pending.slice(start)) {
    collected.push(line.trimEnd());
    if (collected.length >= UNIT_GATE_FAILURE_ERROR_LINES) break;
  }
  return collected;
}

function trailingTimeout(lines: readonly string[], from: number): { lines: string[]; consumed: number } {
  const collected: string[] = [];
  let consumed = from;
  for (let cursor = from + 1; cursor < lines.length && collected.length < UNIT_GATE_FAILURE_ERROR_LINES; cursor++) {
    const next = lines[cursor]!;
    if (UNIT_RESULT_LINE.test(next) || bunRunSummaryLine(next) || UNIT_FILE_HEADER.test(next)) break;
    if (!next.trim()) {
      if (collected.length) break;
      continue;
    }
    // Only the timeout annotation belongs to the `(fail)` it follows. The next test's error stays pending.
    if (!(UNIT_TIMEOUT_LINE.test(next) || /^Timeout:/i.test(next))) break;
    collected.push(next.trimEnd());
    consumed = cursor;
  }
  return { lines: collected, consumed };
}

/** `(fail)` names plus the error bun printed before that line, or the timeout detail bun prints after the name.
 * That trailing timeout is consumed here so the next case cannot record it as its own error. */
function failureCases(section: string): UnitFailureCase[] {
  const lines = section.split('\n');
  const cases: UnitFailureCase[] = [];
  let pending: string[] = [];
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    const fail = UNIT_FAIL_LINE.exec(line);
    if (!fail) {
      if (UNIT_RESULT_LINE.test(line) || bunRunSummaryLine(line) || UNIT_FILE_HEADER.test(line)) pending = [];
      else pending.push(line);
      continue;
    }
    const before = errorBeforeFailure(pending);
    const after = trailingTimeout(lines, index);
    const error = (before.length ? before : after.lines).slice(0, UNIT_GATE_FAILURE_ERROR_LINES).join('\n').trim();
    cases.push({ test: fail[1]!.trim(), error });
    pending = [];
    if (after.lines.length) index = after.consumed;
  }
  return cases;
}

/** The test a timeout stopped, when the transcript or the owner progress file names it. */
function runningTestName(section: string): string | undefined {
  let lastFail: string | undefined;
  let marked: string | undefined;
  for (const line of section.split('\n')) {
    const running = /^(?:running test|running):\s+(.+?)\s*$/.exec(line.trim());
    if (running) marked = running[1];
    const fail = UNIT_FAIL_LINE.exec(line);
    if (fail) lastFail = fail[1]!.trim();
    if (lastFail && (UNIT_TIMEOUT_LINE.test(line) || /^Timeout:/i.test(line))) return lastFail;
  }
  return marked;
}

/** Every case name is kept. Error text shares one 20KB UTF-8 budget per file and is cut on a character boundary. */
function capCaseErrors(cases: readonly UnitFailureCase[]): UnitFailureCase[] {
  const marker = '\n[truncated to 20KB]';
  const markerBytes = utf8Bytes(marker);
  let room = UNIT_GATE_FILE_OUTPUT_CAP;
  return cases.map(item => {
    const size = utf8Bytes(item.error);
    if (size <= room) {
      room -= size;
      return item;
    }
    const note = markerBytes < room ? marker : '';
    const error = `${truncateUtf8(item.error, room - utf8Bytes(note))}${note}`;
    room = 0;
    return { test: item.test, error };
  });
}

/** Named cases and a file-level error share one 20KB budget. The file-level text is not a case name. */
function capCasesAndFileError(cases: readonly UnitFailureCase[], diagnostic: string): { cases: UnitFailureCase[]; fileError?: string } {
  if (!diagnostic) return { cases: capCaseErrors(cases) };
  const lined = diagnostic.split('\n').slice(0, UNIT_GATE_FAILURE_ERROR_LINES).join('\n');
  const capped = capCaseErrors([...cases, { test: '', error: lined }]);
  const fileError = capped.at(-1)!.error;
  return { cases: capped.slice(0, -1), ...(fileError ? { fileError } : {}) };
}

/** An import failure is `# Unhandled error between tests` and stays even when the file also names a `(fail)` case.
 * A failing file with neither keeps the other diagnostic lines in its section. */
function fileLevelError(section: string, failing: boolean): string {
  const lines = section.split('\n');
  const blocks: string[][] = [];
  let current: string[] | undefined;
  for (const line of lines) {
    if (/^# Unhandled error/i.test(line)) {
      current = [line.trimEnd()];
      blocks.push(current);
      continue;
    }
    if (!current) continue;
    if (bunRunSummaryLine(line) || UNIT_RESULT_LINE.test(line) || UNIT_FILE_HEADER.test(line)) {
      current = undefined;
      continue;
    }
    current.push(line.trimEnd());
    if (/^-{3,}$/.test(line.trim()) && current.filter(item => /^-{3,}$/.test(item.trim())).length >= 2) current = undefined;
  }
  const unhandled = blocks.map(block => block.join('\n').trim()).filter(Boolean).join('\n');
  if (unhandled) return unhandled;
  if (!failing) return '';
  return lines.filter(line => line.trim() && !bunRunSummaryLine(line) && !UNIT_RESULT_LINE.test(line)
    && !UNIT_FILE_HEADER.test(line)).join('\n').trim();
}

export function unitFileEvidence(output: string, scope: readonly string[], failing: readonly string[],
  timedOut: readonly string[], root?: string): UnitFileEvidence[] {
  // Classification omits a failure inside a shard the budget stopped. The transcript still names it.
  const classified = new Set([...failing, ...timedOut]);
  const reported = junitFailureDetails(output, scope, root);
  const covered = reported ? junitReportedFiles(output, scope, root) : undefined;
  return scope.flatMap(file => {
    const section = fileSection(output, file, root);
    const fromReport = reported !== undefined && covered!.has(file);
    const parsed = fromReport
      ? reported.filter(item => item.file === file).map(item => ({ test: item.test, error: item.detail ?? '' }))
      : failureCases(section);
    // The fallback diagnostic repeats assertion text that already belongs to a named case.
    // A file the report names does not take a file error from console `error:` lines.
    const kept = capCasesAndFileError(parsed, fromReport ? '' : fileLevelError(section, failing.includes(file) && parsed.length === 0));
    const { cases } = kept;
    if (!classified.has(file) && cases.length === 0 && !kept.fileError) return [];
    const evidence: UnitFileEvidence = { file, output: capFileOutput(section), cases, ...(kept.fileError ? { fileError: kept.fileError } : {}) };
    if (timedOut.includes(file)) {
      const running = runningTestName(section);
      if (running) evidence.runningTest = running;
    }
    return [evidence];
  });
}

function formatErrorLines(error: string, indent: string): string[] {
  const lines: string[] = [];
  for (const errorLine of error.split('\n').slice(0, UNIT_GATE_FAILURE_ERROR_LINES)) {
    if (errorLine.trim()) lines.push(`${indent}${errorLine}`);
  }
  return lines;
}

function formatFileEvidence(file: UnitFileEvidence): string {
  const lines = [`  ${file.file}`];
  if (file.runningTest && !file.cases.some(item => item.test === file.runningTest)) {
    lines.push(`    timed out while running: ${file.runningTest}`);
  }
  for (const item of file.cases) {
    lines.push(`    (fail) ${item.test}`);
    lines.push(...formatErrorLines(item.error, '      '));
  }
  if (file.fileError) lines.push(...formatErrorLines(file.fileError, '    '));
  return lines.join('\n');
}

function formatUnitEvidence(run: UnitRunEvidence): string {
  if (!run.files.length) return '';
  return `Unit gate evidence (${run.side}, ${run.kind}):\n${run.files.map(formatFileEvidence).join('\n')}`;
}

function noteUnitRun(evidence: UnitRunEvidence[], side: 'affected' | 'main', kind: UnitGateRunKind,
  output: string, scope: readonly string[], failing: readonly string[], timedOut: readonly string[], root?: string): void {
  const files = unitFileEvidence(output, scope, failing, timedOut, root);
  if (!files.length) return;
  const run = { side, kind, files };
  evidence.push(run);
  const text = formatUnitEvidence(run);
  if (text) console.log(text);
}

function notePasses(evidence: UnitRunEvidence[], side: 'affected' | 'main', passes: readonly UnitGatePass[],
  kindOf: (pass: UnitGatePass) => UnitGateRunKind, root?: string): void {
  for (const pass of passes) noteUnitRun(evidence, side, kindOf(pass), pass.output, pass.files, pass.failing, pass.timedOut, root);
}

/** A later run replaces an earlier one when it names cases. A timeout that names only the running test does not drop cases already kept.
 * A file-level error stays when the later run does not replace it with its own. */
function preferFileEvidence(previous: UnitFileEvidence | undefined, next: UnitFileEvidence): UnitFileEvidence {
  if (!previous) return next;
  const runningTest = next.runningTest ?? previous.runningTest;
  const fileError = next.fileError ?? previous.fileError;
  const attach = (chosen: UnitFileEvidence): UnitFileEvidence =>
    ({ ...chosen, runningTest, ...(fileError ? { fileError } : {}) });
  if (next.cases.length) return attach(next);
  if (previous.cases.length) return attach(previous);
  if (next.fileError || next.runningTest || next.output) return attach(next);
  return attach(previous);
}

/** Later runs replace earlier ones only within one side, so main cannot overwrite the branch's cases. */
function evidenceForSide(runs: readonly UnitRunEvidence[], side: 'affected' | 'main',
  files: readonly string[]): Map<string, UnitFileEvidence> {
  const chosen = new Map<string, UnitFileEvidence>();
  for (const run of runs) {
    if (run.side !== side) continue;
    for (const file of run.files) {
      if (!files.includes(file.file)) continue;
      chosen.set(file.file, preferFileEvidence(chosen.get(file.file), file));
    }
  }
  return chosen;
}

/** A refusal names the cases from the side that decided it. File names alone are not evidence.
 * When `introduced` is set, the deciding section names only the new cases and a new file-level error.
 * Cases the main run already has stay under `inherited on main:`. */
export function unitGateRefusal(message: string, files: readonly string[], runs: readonly UnitRunEvidence[],
  side: 'affected' | 'main' = 'affected', introduced?: readonly IntroducedUnitFailure[]): string {
  const chosen = evidenceForSide(runs, side, files);
  const introducedByFile = new Map((introduced ?? []).map(item => [item.file, item]));
  const lines = [message, ...files.map(file => {
    const found = chosen.get(file);
    if (!found) return `  ${file}`;
    const item = side === 'affected' && introduced ? introducedByFile.get(file) : undefined;
    if (!item) return formatFileEvidence(found);
    const wanted = new Set(item.cases);
    const present = found.cases.filter(entry => wanted.has(entry.test));
    const missing = item.cases.filter(name => !present.some(entry => entry.test === name)).map(test => ({ test, error: '' }));
    const filtered: UnitFileEvidence = {
      file: found.file, output: found.output, cases: [...present, ...missing],
      ...(found.runningTest && wanted.has(found.runningTest) ? { runningTest: found.runningTest } : {}),
      ...(item.fileError && found.fileError ? { fileError: found.fileError } : {}),
    };
    return formatFileEvidence(filtered);
  })];
  // Main's cases stay visible under their own label when the branch case is what the refusal names.
  if (side === 'affected') {
    const inherited = evidenceForSide(runs, 'main', files);
    const shown = files.filter(file => {
      const found = inherited.get(file);
      return found && (found.cases.length > 0 || found.runningTest || found.fileError);
    });
    if (shown.length) lines.push('inherited on main:', ...shown.map(file => formatFileEvidence(inherited.get(file)!)));
  }
  return lines.join('\n');
}

function mergeLogPath(): string | undefined {
  const fromEnv = process.env.GOAL_MERGE_LOG;
  if (fromEnv) return resolve(fromEnv);
  try {
    const target = readlinkSync('/proc/self/fd/1');
    // A manager redirect (`> merge.log`) is a file. A pipe or a terminal is not a place to put a sibling.
    if (target.startsWith('/') && !target.startsWith('/dev/')) return target;
  } catch { /* stdout is not a regular file */ }
  return undefined;
}

interface UnitEvidenceFile {
  invocations: { invocation: number; runs: UnitRunEvidence[] }[];
}

function readUnitEvidence(path: string): UnitEvidenceFile {
  if (!existsSync(path)) return { invocations: [] };
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<UnitEvidenceFile>;
    return { invocations: Array.isArray(parsed.invocations) ? parsed.invocations : [] };
  } catch {
    return { invocations: [] };
  }
}

/** Writes the kept cases beside the merge log when stdout is that log, otherwise under the orchestration merges directory.
 * A gate that runs again after main moves appends its own invocation instead of replacing the first. */
export function writeUnitEvidence(runs: readonly UnitRunEvidence[]): string | undefined {
  if (!runs.some(run => run.files.length)) return;
  const log = mergeLogPath();
  const path = log
    ? `${log.endsWith('.log') ? log.slice(0, -4) : log}.json`
    : join(stateDir, 'merges', `${process.env.GOAL_ID ?? 'merge'}-${process.pid}-${Date.now()}.json`);
  try {
    mkdirSync(dirname(path), { recursive: true });
    const stored = readUnitEvidence(path);
    const invocation = stored.invocations.reduce((max, item) => Math.max(max, item.invocation), 0) + 1;
    stored.invocations.push({ invocation, runs: [...runs] });
    writeFileSync(path, `${JSON.stringify(stored, null, 2)}\n`);
    console.log(`Unit gate evidence file: ${path}`);
    return path;
  } catch (error) {
    console.log(`Unit gate evidence file was not written: ${error instanceof Error ? error.message : error}`);
    return undefined;
  }
}

export interface IntroducedUnitFailure { file: string; cases: string[]; fileError: boolean }

/** The first meaningful line of a file-level error. Ports, ids and durations are not part of the key. */
function fileErrorKey(detail: string): string {
  const lines = normalizeUnitFileError(detail).split('\n').map(line => line.trim()).filter(Boolean);
  return lines.find(line => !/^# Unhandled error\b/i.test(line) && !/^-{3,}$/.test(line)) ?? '';
}

function failingCaseNames(file: string, failures: readonly UnitFailureDetail[]): Set<string> {
  return new Set(failures.filter(item => item.file === file).map(item => item.test));
}

function fileErrorKeys(file: string, errors: readonly UnitFileErrorDetail[]): Set<string> {
  return new Set(errors.filter(item => item.file === file).map(error => fileErrorKey(error.detail)));
}

/** A file is introduced when it has a failing case name main does not, or a file-level error whose first line main does not.
 * Differing error text for the same case is evidence, not a new failure. Duplicate case names count once. */
export function introducedUnitFailures(branchFiles: readonly string[], branch: readonly UnitFailureDetail[],
  main: readonly UnitFailureDetail[], branchErrors: readonly UnitFileErrorDetail[] = [],
  mainErrors: readonly UnitFileErrorDetail[] = []): IntroducedUnitFailure[] {
  const found: IntroducedUnitFailure[] = [];
  for (const file of [...new Set(branchFiles)].sort()) {
    const cases = [...failingCaseNames(file, branch)].filter(name => !failingCaseNames(file, main).has(name)).sort();
    const fileError = [...fileErrorKeys(file, branchErrors)].some(key => !fileErrorKeys(file, mainErrors).has(key));
    if (cases.length || fileError) found.push({ file, cases, fileError });
  }
  return found;
}

export function introducedUnitFailureFiles(branchFiles: readonly string[], branch: readonly UnitFailureDetail[],
  main: readonly UnitFailureDetail[], branchErrors: readonly UnitFileErrorDetail[] = [],
  mainErrors: readonly UnitFileErrorDetail[] = []): string[] {
  return introducedUnitFailures(branchFiles, branch, main, branchErrors, mainErrors).map(item => item.file);
}

interface ShardInvocation { args: string[]; label: string; env: NodeJS.ProcessEnv; progressFile?: string }

/** The QA CLI prints this when its own budget stops the tier. An ordinary test failure does not. */
function harnessBudgetExpired(output: string): boolean {
  return /QA tier budget exceeded: \S+ \d+ms/.test(output);
}

function outputTail(text: string, lines = 40): string {
  return text.trimEnd().split('\n').slice(-lines).join('\n').trim();
}

function relativizeJunitFiles(xml: string, cwd: string): string {
  return xml.replace(/\bfile="([^"]*)"/g, (match, value: string) => {
    const file = decodeXml(value);
    return isAbsolute(file) ? `file="${relative(cwd, file)}"` : match;
  });
}

/** A test may print a gate transcript on stdout. Indenting it stops a column-0 header or `(fail)` line
 * from naming a file this shard did not fail. */
function indentPrintedStdout(text: string): string {
  if (!text) return '';
  return text.split('\n').map(line => line.length === 0 ? line : `  ${line}`).join('\n');
}

/** The merge log keeps the last 20KB of a shard. Indent each kept line, and start at a line boundary
 * so a cut cannot leave a `(fail)` or a file header at column 0. */
function indentedTranscriptTail(text: string, maxChars = 20_000): string {
  const indented = indentPrintedStdout(text);
  if (indented.length <= maxChars) return indented;
  let start = indented.length - maxChars;
  if (indented[start - 1] !== '\n') {
    const next = indented.indexOf('\n', start);
    if (next < 0) return '';
    start = next + 1;
  }
  return indented.slice(start);
}

async function runUnitShard(cwd: string, files: readonly string[], deadline: number, invocation?: ShardInvocation): Promise<UnitShardResult> {
  const startedAt = Date.now();
  const unfinished = (output: string, timedOut: string[] = timedOutTestFiles(output, files, cwd)): UnitShardResult =>
    ({ done: false, failing: [], timedOut, failures: unitFailureDetails(output, files, cwd),
      fileErrors: unitFileErrorDetails(output, files, cwd),
      runnerErrors: [], files: [...files], output, ms: Date.now() - startedAt });
  // Inventory guards include owner files. Run the selected Bun files directly
  // through Task so the public selector's tier-mixing refusal cannot mask them.
  // The gate's cwd is the tree under test, which may not contain this checkout's reaper.
  // Each shard has its own scope, so a timed-out shard cannot remove a sibling's containers.
  const scope = newReapScope();
  const label = invocation?.label ?? 'goal:unit-files';
  // The owner tier strips agent variables so bun lists every test. The gate still owns a reap scope
  // so a shard stopped at its budget cannot leave containers behind.
  const env: NodeJS.ProcessEnv = { ...(invocation?.env ?? { ...process.env, AGENT: '1', REZICS_REAP_PRELOAD: '1' }),
    REZICS_REAP_SCOPE: scope, REZICS_REAP_SCOPES: reapScopeChain(process.env.REZICS_REAP_SCOPES, scope) };
  // A colored parent makes Bun print "✗ name" instead of "(fail) name". Named cases and file
  // errors for a file the JUnit report names come from that report. The console still supplies
  // timeouts, a harness-budget stop, and file errors when the report is missing or omits the file.
  delete env.FORCE_COLOR;
  // Tests that mkdtemp under `.temp` need the directory. A git worktree does not check it out.
  mkdirSync(join(cwd, '.temp'), { recursive: true });
  const junitFile = invocation ? undefined : join(cwd, '.temp', 'unit-gate-junit', `${process.pid}-${randomUUID()}.xml`);
  if (junitFile) mkdirSync(dirname(junitFile), { recursive: true });
  const child = spawn('task', invocation?.args ?? ['goal:unit-files', '--', `--preload=${join(import.meta.dir, '../qa/container-reaper.ts')}`,
    ...junitFile ? ['--reporter=junit', `--reporter-outfile=${junitFile}`] : [],
    ...files.map(file => `./${file}`)], {
    cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true,
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
  const output = () => {
    const stdoutText = stdout.join('');
    const stderrText = stderr.join('');
    // Bun writes its report on stderr. A test's stdout can print another file's header and `(fail)` line.
    // Indenting stdout keeps that transcript from being read as this shard's console result. The owner
    // tier's transcript is the result, so it stays at column 0.
    const streamed = invocation ? `${stdoutText}\n${stderrText}` : `${indentPrintedStdout(stdoutText)}\n${stderrText}`;
    const parts = [streamed];
    // Written as each file starts, so an outer kill still names the file that was running.
    if (invocation?.progressFile && existsSync(invocation.progressFile))
      parts.push(readFileSync(invocation.progressFile, 'utf8'));
    const text = parts.join('\n');
    // The owner tier keeps bun's transcript in its artifact log. Failure comparison needs that transcript.
    const artifacts = /QA artifacts: (\S+)/.exec(text);
    if (!artifacts || /\.(?:test|spec)\.[cm]?[jt]sx?:$/m.test(text)) return text;
    const log = join(artifacts[1]!, 'logs/owner.log');
    return existsSync(log) ? `${text}\n${readFileSync(log, 'utf8')}` : text;
  };
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
      await stopGateShard(child);
      const text = output();
      if (outcome !== 'timeout' && !truncated && outcome.code === null) {
        return { ...unfinished(text), runnerErrors: [{ files: [...files], diagnostic: launchError ?? (text.trim() || 'Unit runner could not be started') }] };
      }
      const timedOut = outcome === 'timeout'
        ? shardTimeoutFiles(text, files, cwd)
        : timedOutTestFiles(text, files, cwd);
      rememberUnitDurations(durationsFromOutput(text, files, new Set(timedOut)));
      return { ...unfinished(text, timedOut), ...outcome === 'timeout' ? { budgetExpired: true } : {} };
    }
    const text = output();
    const reported = junitFile && existsSync(junitFile)
      ? `${text}\n${UNIT_JUNIT_MARKER}\n${relativizeJunitFiles(readFileSync(junitFile, 'utf8'), cwd)}` : text;
    // The CLI stopped at its own budget and exited. That is an unfinished shard:
    // the file that was running is retried alone, and files with no header run again.
    if (harnessBudgetExpired(text)) {
      const timedOut = shardTimeoutFiles(text, files, cwd);
      rememberUnitDurations(durationsFromOutput(text, files, new Set(timedOut)));
      return { ...unfinished(text, timedOut), budgetExpired: true };
    }
    const timedOut = timedOutTestFiles(reported, files, cwd);
    const failures = unitFailureDetails(reported, files, cwd);
    const namedFailing = outcome.code === 0 ? [] : failingTestFiles(reported, files, cwd);
    const fileErrors = unitFileErrorDetails(reported, files, cwd, [...namedFailing, ...failures.map(failure => failure.file)]);
    const failing = [...new Set([...namedFailing, ...timedOut,
      ...failures.map(failure => failure.file), ...fileErrors.map(error => error.file)])];
    // A non-zero exit with no case and no file error is the runner, not every file in the shard.
    const runnerErrors = outcome.code !== 0 && !failing.length
      ? [{ files: ['runner'], diagnostic: outputTail(text) || `task ${label} exited with status ${outcome.code}` }]
      : [];
    rememberUnitDurations(durationsFromOutput(reported, files, new Set(timedOut)));
    return { done: true, failing, timedOut, failures, fileErrors,
      runnerErrors, files: [...files], output: reported,
      ms: Date.now() - startedAt };
  } catch {
    // A shard that cannot be reaped is unfinished, not a merge-blocking failure.
    try { await stopGateShard(child); } catch { /* already unfinished */ }
    return unfinished(output());
  } finally {
    if (timer) clearTimeout(timer);
    if (junitFile) rmSync(junitFile, { force: true });
    if (invocation?.progressFile) rmSync(invocation.progressFile, { force: true });
    try { removeScopedContainers(scope); } catch { /* the shard's status still stands */ }
  }
}

/** Owner files go through `task test`, the same command as the owner tier, so their environment matches.
 * The CLI's budget is this shard's remaining deadline; without it the tier stops at its own 600s ceiling. */
export function runOwnerShard(cwd: string, files: readonly string[], deadline: number): Promise<UnitShardResult> {
  const budgetMs = Math.max(1, deadline - Date.now());
  const progressFile = join(cwd, '.temp', 'owner-shard-progress', `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(dirname(progressFile), { recursive: true });
  const env: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !['AGENT', 'CLAUDECODE', 'REPL_ID'].includes(key)));
  env.REZICS_QA_OWNER_BUDGET_MS = String(budgetMs);
  env.REZICS_QA_PROGRESS_FILE = progressFile;
  return runUnitShard(cwd, files, deadline, { args: ['test', '--', ...files], label: 'test', env, progressFile });
}

function gateShardRunner(owner: ReadonlySet<string>): UnitShardRunner {
  return (cwd, group, deadline) => {
    const owners = group.filter(file => owner.has(file));
    const units = group.filter(file => !owner.has(file));
    if (owners.length && units.length) return Promise.all([
      runUnitShard(cwd, units, deadline), runOwnerShard(cwd, owners, deadline),
    ]).then(mergeShardResults);
    return owners.length ? runOwnerShard(cwd, owners, deadline) : runUnitShard(cwd, units, deadline);
  };
}

function mergeShardResults(parts: readonly UnitShardResult[]): UnitShardResult {
  return {
    done: parts.every(part => part.done),
    failing: [...new Set(parts.flatMap(part => part.failing))].sort(),
    timedOut: [...new Set(parts.flatMap(part => part.timedOut))].sort(),
    failures: parts.flatMap(part => part.failures),
    fileErrors: parts.flatMap(part => part.fileErrors),
    runnerErrors: parts.flatMap(part => part.runnerErrors),
    files: [...new Set(parts.flatMap(part => part.files))].sort(),
    output: parts.map(part => part.output).join('\n'),
    ms: Math.max(...parts.map(part => part.ms)),
    ...(parts.some(part => part.budgetExpired) ? { budgetExpired: true } : {}),
  };
}

interface UnitGateResult {
  done: boolean; failing: string[]; timedOut: string[]; failures: UnitFailureDetail[];
  fileErrors: UnitFileErrorDetail[]; runnerErrors: UnitRunnerError[]; unfinished: string[]; output: string;
  /** First pass, then one pass per continuation of files a budget never reached. */
  passes: UnitGatePass[];
}

function gatePass(kind: UnitGatePass['kind'], files: readonly string[], result: UnitGateResult): UnitGatePass {
  return { kind, output: result.output, files: [...files], failing: result.failing, timedOut: result.timedOut };
}

/** Whole-side wall clock. The default covers two schedules of a cap-sized plan at the current concurrency.
 * Past this, files that still have no verdict are named and the gate stops. */
function unitGateCeilingMs(fileCount: number, budgetMs: number, concurrency: number): number {
  const raw = process.env.GOAL_UNIT_GATE_CEILING_MS;
  if (raw !== undefined && raw !== '') return positiveInteger('GOAL_UNIT_GATE_CEILING_MS', budgetMs);
  const waves = Math.ceil(Math.max(1, Math.ceil(fileCount / UNIT_GATE_FILE_CAP)) / Math.max(1, concurrency));
  return Math.max(budgetMs, waves * 2 * budgetMs);
}

function gateStop(reason: string, files: readonly string[]): void {
  const count = `${files.length} file${files.length === 1 ? '' : 's'}`;
  console.log(`Unit gate inconclusive: ${reason} (${count})\n  ${files.join('\n  ')}`);
}

/** A file a budget-expired shard actually finished: it printed a pass, fail, skip, or todo line.
 * The file that was running is in `timedOut` and is not finished. A header with no result was not reached. */
function filesCompletedInOutput(output: string, files: readonly string[], timedOut: ReadonlySet<string>): Set<string> {
  const known = new Set(files);
  const completed = new Set<string>();
  let current: string | undefined;
  for (const line of output.split('\n')) {
    const header = /^(\S+\.(?:test|spec)\.[cm]?[jt]sx?):$/.exec(line);
    if (header) {
      const file = header[1]!.replace(/^\.\//, '');
      current = known.has(file) ? file : undefined;
      continue;
    }
    if (current && !timedOut.has(current) && /^\((?:pass|fail|skip|todo)\)\s+/.test(line)) completed.add(current);
  }
  return completed;
}

interface ShardSettlement {
  passed: string[]; failing: string[]; failures: UnitFailureDetail[]; fileErrors: UnitFileErrorDetail[];
  timedOut: string[]; pending: string[]; blocked: string[];
}

/** Completed files keep the verdict in this shard's transcript. Files with no result go back to the queue.
 * A file that started and timed out stays with the isolated retry. A shard that stopped for any other reason
 * is not split and is not run again. */
function settleUnitShard(result: UnitShardResult): ShardSettlement {
  const assigned = result.files;
  const blank = (): ShardSettlement => ({
    passed: [], failing: [], failures: [], fileErrors: [], timedOut: [], pending: [], blocked: [],
  });
  if (result.runnerErrors.length || (!result.done && !result.budgetExpired)) {
    return { ...blank(), blocked: [...assigned] };
  }
  if (!result.budgetExpired) {
    const timedOut = result.timedOut.filter(file => assigned.includes(file));
    return {
      passed: assigned.filter(file => !result.failing.includes(file) && !timedOut.includes(file)),
      failing: [...result.failing],
      failures: result.failures,
      fileErrors: result.fileErrors,
      timedOut, pending: [], blocked: [],
    };
  }
  const timedOut = result.timedOut.filter(file => assigned.includes(file));
  const completed = filesCompletedInOutput(result.output, assigned, new Set(timedOut));
  const failures = unitFailureDetails(result.output, [...completed]).filter(item => completed.has(item.file));
  const fileErrors = unitFileErrorDetails(result.output, [...completed]).filter(item => completed.has(item.file));
  const failing = [...new Set([...failures.map(item => item.file), ...fileErrors.map(item => item.file)])];
  return {
    passed: [...completed].filter(file => !failing.includes(file)),
    failing, failures, fileErrors, timedOut,
    pending: assigned.filter(file => !completed.has(file) && !timedOut.includes(file)),
    blocked: [],
  };
}

/** Shards run at most `concurrency` at a time. Each shard's budget starts when that shard starts,
 * so a shard waiting in the queue still receives a full budget. */
async function mapPool<T, R>(items: readonly T[], concurrency: number, run: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(Math.max(1, concurrency), Math.max(1, items.length)) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await run(items[index]!);
    }
  });
  await Promise.all(workers);
  return results;
}

/** One schedule of the files still without a verdict. A wide plan is many shards; only `shards` run at once. */
export async function runUnitGate(cwd: string, files: readonly string[], shards?: number,
  runShard: UnitShardRunner = runUnitShard): Promise<UnitGateResult> {
  const concurrency = shards ?? unitGateShards();
  const ceiling = unitGateCeilingMs(files.length, unitGateBudgetMs(), concurrency);
  const startedAt = Date.now();
  const durations = readMeasuredUnitDurations(cwd);
  let pending = [...files];
  const passes: UnitGatePass[] = [];
  const failing = new Set<string>();
  const failures: UnitFailureDetail[] = [];
  const fileErrors: UnitFileErrorDetail[] = [];
  const timedOut = new Set<string>();
  /** A file that was running when the budget stopped the shard. A timeout inside a shard that exited stays on `timedOut` only. */
  const runningAtBudget = new Set<string>();
  const outputs: string[] = [];
  let wave = 0;
  const snapshot = (unfinished: readonly string[], done: boolean, runnerErrors: UnitRunnerError[] = []): UnitGateResult => ({
    done, failing: [...failing].sort(), timedOut: [...timedOut].sort(), failures, fileErrors, runnerErrors,
    unfinished: [...unfinished].sort(), output: outputs.join('\n'), passes,
  });
  while (pending.length) {
    if (wave > 0 && Date.now() - startedAt >= ceiling) {
      const left = [...new Set([...pending, ...runningAtBudget])].sort();
      gateStop('the gate ceiling was reached with files still unfinished', left);
      return snapshot(left, false);
    }
    const scheduled = pending;
    const pass = await runUnitGatePass(cwd, scheduled, concurrency, runShard, durations);
    wave++;
    outputs.push(pass.result.output);
    if (pass.result.runnerErrors.length) {
      for (const file of pass.result.failing) failing.add(file);
      failures.push(...pass.result.failures);
      fileErrors.push(...pass.result.fileErrors);
      for (const file of pass.result.timedOut) timedOut.add(file);
      const unfinished = [...new Set([...pass.result.unfinished, ...runningAtBudget])].sort();
      const result = snapshot(unfinished, unfinished.length === 0 && pass.result.done, pass.result.runnerErrors);
      passes.push(gatePass(wave === 1 ? 'first' : 'never-started-rerun', scheduled, result));
      return result;
    }
    const next = new Set<string>();
    const blocked: string[] = [];
    const waveFailing: string[] = [];
    const waveTimed: string[] = [];
    for (const shard of pass.shards) {
      const settled = settleUnitShard(shard);
      for (const file of settled.failing) {
        failing.add(file);
        waveFailing.push(file);
      }
      failures.push(...settled.failures);
      fileErrors.push(...settled.fileErrors);
      for (const file of settled.timedOut) {
        timedOut.add(file);
        waveTimed.push(file);
        if (!shard.done || shard.budgetExpired) runningAtBudget.add(file);
      }
      for (const file of settled.pending) next.add(file);
      blocked.push(...settled.blocked);
    }
    passes.push(gatePass(wave === 1 ? 'first' : 'never-started-rerun', scheduled, {
      done: next.size === 0 && blocked.length === 0,
      failing: [...new Set(waveFailing)].sort(),
      timedOut: [...new Set(waveTimed)].sort(),
      failures: [], fileErrors: [], runnerErrors: [],
      unfinished: [...next, ...blocked].sort(),
      output: pass.result.output, passes: [],
    }));
    if (blocked.length) {
      const left = [...new Set([...blocked, ...next, ...runningAtBudget])].sort();
      gateStop('a shard stopped without finishing and without reaching its budget', left);
      return snapshot(left, false);
    }
    const nextFiles = [...next].sort();
    if (!nextFiles.length) break;
    // The first pass may be killed before any file prints a header. One continuation of that same set
    // can still finish. A later wave that classifies nothing is no progress, and the gate stops.
    if (nextFiles.length >= scheduled.length && wave > 1) {
      const left = [...new Set([...nextFiles, ...runningAtBudget])].sort();
      gateStop('continuation made no progress', left);
      return snapshot(left, false);
    }
    console.log(`Unit gate: ${nextFiles.length} file(s) were not reached; continuing`);
    pending = nextFiles;
  }
  const unfinished = [...runningAtBudget].sort();
  return snapshot(unfinished, unfinished.length === 0);
}

function fileDeclaredTimeout(cwd: string, file: string): DeclaredTestTimeout {
  const path = join(cwd, file);
  if (!existsSync(path)) return { unparseable: false };
  try {
    if (!statSync(path).isFile()) return { unparseable: false };
    return declaredTestTimeout(readFileSync(path, 'utf8'));
  } catch {
    return { unparseable: true };
  }
}

/** A stub can return the last file's cases while the JUnit report in its output names each file.
 * A unit report joined to an owner transcript covers only the files it names. The owner's cases stay.
 * Cases a runner already listed are not kept: a printed transcript can name them. Owner cases are the
 * `(fail)` lines after the report. A done shard that reported no file is read again, so a timeout in
 * the gate's report is that file's result and not an unattributed runner failure. */
function attributeShard(result: UnitShardResult): UnitShardResult {
  if (!result.done) return result;
  const parsed = junitFailureDetails(result.output, result.files);
  if (!parsed) return result;
  const covered = junitReportedFiles(result.output, result.files);
  const seen = new Set(parsed.map(item => `${item.file}\0${item.test}`));
  const retained = unitFailureDetails(consoleAfterReport(result.output), result.files).filter(item => {
    if (covered.has(item.file)) return false;
    const key = `${item.file}\0${item.test}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const failures = [...parsed, ...retained];
  const timedOut = [...new Set([...result.timedOut, ...timedOutTestFiles(result.output, result.files)])].sort();
  const unhandled = [...consoleFailureKinds(result.output, result.files).unhandled].filter(file => !covered.has(file));
  const fileErrors = unitFileErrorDetails(result.output, result.files, undefined, [
    ...failures.map(item => item.file), ...timedOut, ...unhandled,
  ]).filter(error => !covered.has(error.file));
  const failing = [...new Set([
    ...failures.map(item => item.file),
    ...fileErrors.map(error => error.file),
    ...timedOut,
    ...unhandled,
  ])].sort();
  return { ...result, failing, timedOut, failures, fileErrors, runnerErrors: failing.length ? [] : result.runnerErrors };
}

async function runUnitGatePass(cwd: string, files: readonly string[], shards: number | undefined,
  runShard: UnitShardRunner, durations: ReadonlyMap<string, number>): Promise<{ result: UnitGateResult; shards: UnitShardResult[] }> {
  const empty: UnitGateResult = { done: true, failing: [], timedOut: [], failures: [], fileErrors: [], runnerErrors: [], unfinished: [], output: '', passes: [] };
  if (!files.length) return { result: empty, shards: [] };
  const budget = unitGateBudgetMs();
  const concurrency = shards ?? unitGateShards();
  const planned = planUnitGateShards(files.map(file => ({
    file, timeout: fileDeclaredTimeout(cwd, file),
    ...(durations.has(file) ? { durationMs: durations.get(file) } : {}),
  })), concurrency, budget);
  for (const file of planned.unparseable) {
    console.log(`Unit gate: ${file} declared a timeout that could not be parsed; using the default shard budget`);
  }
  // At most `concurrency` shards run at once. Each budget starts when that shard starts.
  const slowest = Math.max(budget, ...planned.shards.map(shard => shard.budgetMs));
  console.log(`Unit gate: ${files.length} file(s) in ${planned.shards.length} shard(s), slowest budget ${slowest}ms`);
  const results = (await mapPool(planned.shards, concurrency, shard => runShard(cwd, shard.files, Date.now() + shard.budgetMs))).map(attributeShard);
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
  return { result: { done: !unfinished.length, failing, timedOut, failures, fileErrors, runnerErrors, unfinished, output, passes: [] }, shards: results };
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

async function retryTimedOutFiles(cwd: string, files: readonly string[], side: 'affected' | 'main',
  runShard?: UnitShardRunner, onRun?: (result: UnitGateResult) => void): Promise<TimeoutRetryResult> {
  const result: TimeoutRetryResult = { failing: [], passing: [], unfinished: [], inconclusive: [], failures: [], fileErrors: [], runnerErrors: [] };
  for (const file of [...new Set(files)].sort()) {
    console.log(`Unit gate: ${file} timed out on ${side}; rerunning alone`);
    const retry = await runUnitGate(cwd, [file], 1, runShard);
    // Keep the case before the timeout classification discards the transcript.
    onRun?.(retry);
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

/** Inherited failures are classified against the main commit the merge targets, including after earlier merges of the same stream.
 * Selection still widens to files those earlier merges changed. */
export function streamUnitBaseline(events: readonly MergeEvent[], taskIds: readonly string[], current: string): string {
  void events;
  void taskIds;
  return current;
}

type RecordedMerge = MergeEvent & { files?: readonly string[] };

/** The candidate's own changes plus files this stream changed in earlier recorded merges.
 * A record written before `files` existed is read back from the two commits. */
export function streamSelectionFiles(own: readonly string[], events: readonly RecordedMerge[], taskIds: readonly string[],
  root?: string): string[] {
  const earlier = events.filter(event => event.before !== event.after && event.taskIds.some(id => taskIds.includes(id)))
    .flatMap(event => event.files ?? (root ? git(root, ['diff', '--name-only', '--no-renames', event.before, event.after]).split('\n').filter(Boolean) : []));
  return [...new Set([...own, ...earlier])].sort();
}

function readMergeEvents(): RecordedMerge[] {
  const eventPath = join(stateDir, 'merges.jsonl');
  if (!existsSync(eventPath)) return [];
  return readFileSync(eventPath, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as RecordedMerge);
}

function writeMergeEvent(event: MergeEvent, files: readonly string[]): void {
  appendFileSync(join(stateDir, 'merges.jsonl'), `${JSON.stringify({ ...event, files: [...new Set(files)].sort() })}\n`);
}

type AffectedSelection = { plan: AffectedPlan } | { text: string };

/** The worktree's planner when it can be imported, otherwise this checkout's. A missing module or a fixture plan stays text. */
async function affectedSelection(worktree: string, base: string, changed: readonly string[]): Promise<AffectedSelection> {
  if (process.env.GOAL_TEST_PLAN !== undefined) {
    return { text: `Affected since HEAD: fixture\n${readFileSync(process.env.GOAL_TEST_PLAN, 'utf8')}` };
  }
  const modulePath = join(worktree, 'scripts/qa/affected.ts');
  if (!existsSync(modulePath)) {
    const plan = spawnSync('task', ['test', '--', '--affected', base, '--list'],
      { cwd: worktree, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    if (plan.status !== 0) throw new Error(`Affected unit selection failed:\n${plan.stderr || plan.error?.message}`);
    return { text: plan.stdout };
  }
  try {
    const planner = await import(pathToFileURL(modulePath).href) as {
      affectedPlanForChanges?: typeof affectedPlanForChanges;
    };
    if (typeof planner.affectedPlanForChanges !== 'function') throw new Error('affected planner does not export a typed plan');
    return { plan: planner.affectedPlanForChanges(worktree, base, changed) };
  } catch (error) {
    console.log(`Pre-merge selection: affected planner import failed (${error instanceof Error ? error.message : error}); using this checkout's planner`);
    return { plan: affectedPlanForChanges(worktree, base, changed) };
  }
}

function selectedUnitFiles(worktree: string, selection: AffectedSelection): string[] {
  return 'plan' in selection ? unitFilesFromPlan(worktree, selection.plan) : mergeUnitFiles(worktree, selection.text);
}

function selectedOwnerFiles(worktree: string, selection: AffectedSelection): string[] {
  return 'plan' in selection ? ownerFilesFromPlan(worktree, selection.plan) : mergeOwnerFiles(worktree, selection.text);
}

function generatorOutput(run: ReturnType<typeof spawnSync>): string {
  return `${run.stdout ?? ''}\n${run.stderr ?? ''}${run.error ? `\n${run.error.message}` : ''}`.trim();
}

function resetGeneratedWorktree(worktree: string): void {
  git(worktree, ['reset', '--hard', 'HEAD']);
  git(worktree, ['clean', '-fd', '-e', '.temp'], true);
}

/** Subject of the commit that records generator output. Scope checks recognise it by this text. */
export const REGENERATION_COMMIT_SUBJECT = 'Regenerate generated outputs (goalctl)';

/** Paths whose every change in this `git log --name-only` output is from a regeneration commit.
 * A path the task's own commit also changed stays in the claim check. */
function filesOnlyRegenerated(log: string): string[] {
  const regen = new Set<string>();
  const own = new Set<string>();
  let bucket: Set<string> | undefined;
  for (const line of log.split('\n')) {
    const header = /^[0-9a-f]{40}\t(.*)$/.exec(line);
    if (header) {
      bucket = header[1] === REGENERATION_COMMIT_SUBJECT ? regen : own;
      continue;
    }
    if (!line) { bucket = undefined; continue; }
    bucket?.add(line);
  }
  return [...regen].filter(file => !own.has(file)).sort();
}

/** Paths whose every change on the branch since `main` is from a regeneration commit.
 * A path the task's own commit also changed stays in the claim check. */
export function regenerationOnlyFiles(repo: string): string[] {
  if (!existsSync(repo)) return [];
  return filesOnlyRegenerated(git(repo, ['log', '--name-only', '--pretty=format:%H%x09%s', 'main..HEAD']));
}

/** Regenerates outputs, commits whatever the generator changed, then verifies with `--check`.
 * A fixture without `scripts/generate.ts` skips. Land, merge and refresh exempt exactly the files
 * this commit wrote, including after main advances and prepareMerge runs again. */
function regenerateGeneratedOutputs(merge: PreparedMerge): string | undefined {
  if (!existsSync(join(merge.worktree, 'scripts/generate.ts'))) return undefined;
  const generated = spawnSync('bun', ['scripts/generate.ts'], { cwd: merge.worktree, encoding: 'utf8', timeout: 180_000 });
  if (generated.status !== 0) {
    resetGeneratedWorktree(merge.worktree);
    return `generated artifacts could not be regenerated; run task gen\n${generatorOutput(generated).slice(-4_000)}`;
  }
  if (git(merge.worktree, ['status', '--porcelain'], true)) {
    git(merge.worktree, ['add', '-A']);
    const commit = spawnSync('git', ['commit', '-q', '-m', REGENERATION_COMMIT_SUBJECT],
      { cwd: merge.worktree, encoding: 'utf8' });
    if (commit.status !== 0) {
      resetGeneratedWorktree(merge.worktree);
      return `generated artifacts could not be committed; run task gen\n${generatorOutput(commit).slice(-4_000)}`;
    }
  }
  const check = spawnSync('bun', ['scripts/generate.ts', '--check'], { cwd: merge.worktree, encoding: 'utf8', timeout: 180_000 });
  if (check.status !== 0) return `generated artifacts are stale after regeneration; run task gen\n${generatorOutput(check).slice(-4_000)}`;
  merge.after = git(merge.worktree, ['rev-parse', 'HEAD']);
  merge.committed = git(merge.worktree, ['diff', '--name-only', 'main...HEAD'], true).split('\n').filter(Boolean);
  return undefined;
}

/** Workspaces with a `<workspace>:typecheck` task, by the directories whose sources they check. Each task checks one
 * TypeScript project: Task stops at the first failing command, so a second project would hide its errors. */
export const TYPECHECK_WORKSPACES: ReadonlyArray<readonly [workspace: string, roots: readonly string[]]> = [
  ['main', ['services/main/']],
  ['account', ['services/account/']],
  ['content', ['services/content/']],
  ['web', ['apps/web/']],
  ['accounts', ['apps/accounts/']],
  ['model', ['packages/model/']],
  ['ui', ['packages/ui/']],
  ['document', ['packages/document/']],
  ['observability', ['packages/observability/']],
  ['observability-scripts', ['scripts/observability/']],
  ['dataset', ['scripts/datasets/']],
  ['dev', ['scripts/dev/']],
  ['goal', ['scripts/goal/']],
  ['apphost', ['apphost/']],
];

const TYPECHECK_SOURCE = /\.[cm]?tsx?$|(?:^|\/)(?:tsconfig[^/]*|package)\.json$/;

/** Each workspace a changed TypeScript source or its config belongs to, once. */
export function typecheckWorkspaces(files: readonly string[]): string[] {
  return TYPECHECK_WORKSPACES
    .filter(([, roots]) => files.some(file => TYPECHECK_SOURCE.test(file) && roots.some(root => file.startsWith(root))))
    .map(([workspace]) => workspace);
}

/** `tsc` diagnostics keyed without line and column, so an edit above an old error does not make it new.
 * A diagnostic with no location (`error TS6053: File not found`) is keyed by its code and message. */
export function typecheckDiagnostics(output: string): string[] {
  const diagnostics: string[] = [];
  for (const line of output.split('\n')) {
    const located = /^(\S.*?)\(\d+,\d+\): (error TS\d+: .*)$/.exec(line.trimEnd());
    const bare = /^(error TS\d+: .*)$/.exec(line.trimEnd());
    if (located) diagnostics.push(`${located[1]}: ${located[2]}`);
    else if (bare) diagnostics.push(bare[1]!);
    else if (/^\s+\S/.test(line) && diagnostics.length) diagnostics[diagnostics.length - 1] += ` ${line.trim()}`;
  }
  return diagnostics.sort();
}

/** Lines that name a TypeScript error in a shape the parser does not know (for example `tsc --pretty`).
 * Comparing around them would let a branch-only error pass, so the run is inconclusive instead. */
export function unclassifiedTypecheckLines(output: string): string[] {
  const known = (line: string) => /^(\S.*?)\(\d+,\d+\): error TS\d+: /.test(line) || /^error TS\d+: /.test(line);
  return output.split('\n').filter(line => /error TS\d+/.test(line) && !/^\s/.test(line) && !known(line.trimEnd()));
}

/** Branch diagnostics beyond those `main` already has, counting repeats. */
export function introducedTypecheckDiagnostics(branch: readonly string[], main: readonly string[]): string[] {
  const inherited = new Map<string, number>();
  for (const diagnostic of main) inherited.set(diagnostic, (inherited.get(diagnostic) ?? 0) + 1);
  return branch.filter(diagnostic => {
    const left = inherited.get(diagnostic) ?? 0;
    if (left) inherited.set(diagnostic, left - 1);
    return !left;
  });
}

export interface TypecheckRun { done: boolean; status: number | null; output: string }
export type TypecheckSide = 'branch' | 'main';

/** Branch type checks run together under one deadline; main is checked only for workspaces whose branch run has
 * diagnostics, under a second deadline shared by every comparison so that side stays within the budget in total.
 * An unfinished run, a failure with no parsed diagnostic, or an unrecognised error line is inconclusive and refuses the merge. */
export async function typecheckGate(workspaces: readonly string[],
  run: (workspace: string, side: TypecheckSide, deadline: number) => Promise<TypecheckRun>,
  budgetMs: number, now: () => number = Date.now): Promise<string | undefined> {
  if (!workspaces.length) return;
  const branchDeadline = now() + budgetMs;
  const branch = await Promise.all(workspaces.map(async workspace => ({ workspace, result: await run(workspace, 'branch', branchDeadline) })));
  const inconclusive: string[] = [];
  const failing: { workspace: string; diagnostics: string[] }[] = [];
  for (const { workspace, result } of branch) {
    const diagnostics = typecheckDiagnostics(result.output);
    const unknown = unclassifiedTypecheckLines(result.output);
    if (!result.done) inconclusive.push(`${workspace}: the branch type check did not finish`);
    else if (unknown.length) inconclusive.push(`${workspace}: unrecognised type error output:\n    ${unknown.join('\n    ')}`);
    else if (result.status === 0) console.log(`Type check ${workspace}: passes`);
    else if (!diagnostics.length) inconclusive.push(`${workspace}: the type check failed without diagnostics:\n${result.output.slice(-2000)}`);
    else failing.push({ workspace, diagnostics });
  }
  const introduced: string[] = [];
  let mainDeadline: number | undefined;
  for (const { workspace, diagnostics } of failing) {
    mainDeadline ??= now() + budgetMs;
    const main = await run(workspace, 'main', mainDeadline);
    const inherited = typecheckDiagnostics(main.output);
    if (!main.done || unclassifiedTypecheckLines(main.output).length || (main.status !== 0 && !inherited.length)) {
      inconclusive.push(`${workspace}: the type check on main is inconclusive`);
      continue;
    }
    const added = introducedTypecheckDiagnostics(diagnostics, inherited);
    console.log(`Type check ${workspace}: ${diagnostics.length} diagnostic(s) on the branch, ${diagnostics.length - added.length} already on main, ${added.length} introduced`);
    for (const diagnostic of diagnostics.filter(diagnostic => !added.includes(diagnostic))) console.log(`  on main, not blocking: ${diagnostic}`);
    introduced.push(...added.map(diagnostic => `${workspace}: ${diagnostic}`));
  }
  if (introduced.length) return `introduced type errors; not merging:\n  ${introduced.join('\n  ')}`;
  if (inconclusive.length) return `type check inconclusive; not merging:\n  ${inconclusive.join('\n  ')}`;
}

async function runTypecheck(cwd: string, workspace: string, deadline: number): Promise<TypecheckRun> {
  const child = spawn('task', [`${workspace}:typecheck`], {
    cwd, env: { ...process.env, AGENT: '1' }, stdio: ['ignore', 'pipe', 'pipe'], detached: true,
  });
  const chunks: string[] = [];
  let bytes = 0;
  for (const stream of [child.stdout, child.stderr]) {
    stream?.setEncoding('utf8');
    stream?.on('data', (chunk: string) => { bytes += chunk.length; if (bytes <= UNIT_GATE_OUTPUT_CAP) chunks.push(chunk); });
  }
  const closed = new Promise<number | null>(resolve => {
    child.once('error', error => { chunks.push(`Unable to start the type check: ${error.message}`); resolve(null); });
    child.once('close', code => resolve(code));
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'timeout'>(resolve => {
    timer = setTimeout(() => resolve('timeout'), Math.min(Math.max(0, deadline - Date.now()), 2_147_483_647));
  });
  try {
    const outcome = await Promise.race([closed, timeout]);
    if (outcome === 'timeout') await stopProcessGroup(child);
    return { done: outcome !== 'timeout' && outcome !== null, status: outcome === 'timeout' ? null : outcome, output: chunks.join('') };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** A classification checkout is a detached worktree, so git does not materialize the ignored `.temp` directory. */
export function addGateWorktree(mainRoot: string, directory: string, commit: string): void {
  git(mainRoot, ['worktree', 'add', '--detach', directory, commit]);
  mkdirSync(join(directory, '.temp'), { recursive: true });
}

/** Type-checks the workspaces the branch touched before the unit gate, within the unit gate's per-side budget.
 * `only` narrows a rerun to workspaces whose `main` sources changed under the branch. */
async function preMergeTypecheckGate(worktree: string, mainRoot: string, before: string, files: readonly string[],
  skip: boolean, only?: readonly string[]): Promise<string | undefined> {
  if (skip) {
    console.log('Type check skipped: --skip-type-gate explicitly requested by the manager');
    return;
  }
  const workspaces = typecheckWorkspaces(files).filter(workspace => !only || only.includes(workspace));
  console.log(`Pre-merge type check: ${workspaces.length ? workspaces.join(', ') : 'no TypeScript workspace touched'} against main ${before.slice(0, 12)}`);
  let baseline: string | undefined;
  try {
    return await typecheckGate(workspaces, async (workspace, side, deadline) => {
      if (side === 'branch') return runTypecheck(worktree, workspace, deadline);
      if (!baseline) {
        mkdirSync(join(mainRoot, '.temp'), { recursive: true });
        baseline = mkdtempSync(join(mainRoot, '.temp/type-gate-'));
        addGateWorktree(mainRoot, baseline, before);
        const install = spawnSync('task', ['install'], { cwd: baseline, encoding: 'utf8', timeout: 120_000 });
        if (install.status !== 0) throw new Error(`Type check baseline dependency install failed:\n${install.stdout}\n${install.stderr}`);
      }
      return runTypecheck(baseline, workspace, deadline);
    }, unitGateBudgetMs());
  } finally {
    if (baseline) {
      git(mainRoot, ['worktree', 'remove', '--force', baseline], true);
      rmSync(baseline, { recursive: true, force: true });
    }
  }
}

interface UnitSideResult {
  failing: string[];
  failures: UnitFailureDetail[];
  fileErrors: UnitFileErrorDetail[];
  runnerErrors: UnitRunnerError[];
  inconclusive: string[];
  orderDependent: string[];
  initialDone: boolean;
}

function emptyGate(): UnitGateResult {
  return { done: true, failing: [], timedOut: [], failures: [], fileErrors: [], runnerErrors: [], unfinished: [], output: '', passes: [] };
}

/** One side of the unit gate: first run, never-started rerun, isolated timeout retry, and confirm.
 * Every classified run keeps its failing cases. The caller decides whether they block the merge. */
export async function runUnitSide(cwd: string, files: readonly string[], side: 'affected' | 'main',
  evidence: UnitRunEvidence[], runShard?: UnitShardRunner): Promise<UnitSideResult> {
  const none = (extra: Partial<UnitSideResult> = {}): UnitSideResult => ({
    failing: [], failures: [], fileErrors: [], runnerErrors: [], inconclusive: [], orderDependent: [], initialDone: true, ...extra,
  });
  const isolatedKind = (pass: UnitGatePass): UnitGateRunKind => pass.kind === 'never-started-rerun' ? 'never-started-rerun' : 'isolated-retry';
  const confirmKind = (pass: UnitGatePass): UnitGateRunKind => pass.kind === 'never-started-rerun' ? 'never-started-rerun' : 'confirm';
  const branch = await runUnitGate(cwd, files, undefined, runShard);
  notePasses(evidence, side, branch.passes, pass => pass.kind, cwd);
  if (branch.runnerErrors.length) return none({ runnerErrors: branch.runnerErrors, initialDone: branch.done });
  let failureFiles = branch.failing;
  let timedOut = branch.timedOut;
  let timeoutRetry: TimeoutRetryResult = { failing: [], passing: [], unfinished: [], inconclusive: [], failures: [], fileErrors: [], runnerErrors: [] };
  if (!branch.done) {
    timeoutRetry = await retryTimedOutFiles(cwd, branch.timedOut, side, runShard, retry => {
      notePasses(evidence, side, retry.passes, isolatedKind, cwd);
    });
    if (timeoutRetry.runnerErrors.length) return none({ runnerErrors: timeoutRetry.runnerErrors, initialDone: false });
    failureFiles = [...new Set([...branch.failing, ...timeoutRetry.failing])].sort();
    const unresolved = [...new Set([
      ...branch.unfinished.filter(file => !branch.timedOut.includes(file)),
      ...timeoutRetry.inconclusive,
    ])].sort();
    if (unresolved.length) {
      reportUnfinished(side, unresolved);
      return none({ failing: failureFiles, failures: timeoutRetry.failures, fileErrors: timeoutRetry.fileErrors,
        inconclusive: unresolved, initialDone: false });
    }
    timedOut = branch.timedOut;
  }
  if (!failureFiles.length) return none({ initialDone: branch.done });
  // Case evidence does not replace the raw transcript the merge log kept before that channel existed.
  // Indent it: this line is printed while a test file is itself under the gate, and a column-0 header
  // or `(fail)` in the excerpt would be read as another file's result.
  if (side === 'affected') {
    console.log(`Unit gate: ${failureFiles.length} file(s) fail on the branch:\n${indentedTranscriptTail(branch.output)}`);
  }
  // A file can fail beside its shard-mates and pass when those failures run together. Confirm those together,
  // then retry every timeout alone so the side's decision comes from its isolated run.
  const together = failureFiles.filter(file => !timedOut.includes(file));
  const confirmed = together.length ? await runUnitGate(cwd, together, 1, runShard) : emptyGate();
  notePasses(evidence, side, confirmed.passes, confirmKind, cwd);
  if (confirmed.runnerErrors.length) return none({ runnerErrors: confirmed.runnerErrors, initialDone: branch.done });
  const alreadyRetried = new Set(branch.done ? [] : branch.timedOut);
  const retry = await retryTimedOutFiles(cwd, [...new Set([...timedOut, ...confirmed.timedOut])].filter(file => !alreadyRetried.has(file)),
    side, runShard, result => { notePasses(evidence, side, result.passes, isolatedKind, cwd); });
  const confirmedFailures = [...new Set([
    ...(!branch.done ? timeoutRetry.failing : []),
    ...confirmed.failing.filter(file => !confirmed.timedOut.includes(file)),
    ...retry.failing,
  ])].sort();
  const unresolved = [...new Set([
    ...(!confirmed.done ? confirmed.unfinished.filter(file => !confirmed.timedOut.includes(file)) : []),
    ...retry.inconclusive,
  ])].sort();
  if (retry.runnerErrors.length) return none({ runnerErrors: retry.runnerErrors, initialDone: branch.done });
  if (unresolved.length) {
    reportUnfinished(side, unresolved);
    return none({ failing: confirmedFailures, inconclusive: unresolved, initialDone: branch.done });
  }
  const acrossShards = branch.done && confirmed.done ? together.filter(file => !confirmed.failing.includes(file)) : [];
  // A JUnit timeout is excluded from the together-confirm. Its alone pass is the same class as a
  // failure that disappears when the file runs by itself.
  const passedAlone = [...retry.passing].sort();
  if (acrossShards.length) {
    console.log(`Unit gate: ${acrossShards.length} file(s) failed only across shards; order-dependent, reported, not blocking\n  ${acrossShards.join('\n  ')}`);
  }
  if (passedAlone.length) {
    console.log(`Unit gate: ${passedAlone.length} file(s) pass when run alone; order or load dependent, reported, not blocking\n  ${passedAlone.join('\n  ')}`);
  }
  return {
    failing: confirmedFailures,
    failures: [
      ...(!branch.done ? timeoutRetry.failures : []),
      ...confirmed.failures.filter(failure => !confirmed.timedOut.includes(failure.file)),
      ...retry.failures,
    ],
    fileErrors: [
      ...(!branch.done ? timeoutRetry.fileErrors : []),
      ...confirmed.fileErrors.filter(error => !confirmed.timedOut.includes(error.file)),
      ...retry.fileErrors,
    ],
    runnerErrors: [], inconclusive: [], initialDone: branch.done,
    orderDependent: [...new Set([...acrossShards, ...passedAlone])].sort(),
  };
}

/** A recognised infrastructure start failure. The step is what the report names. */
export type InfrastructureStep = 'pg_ctl start' | 'embedded PostgreSQL' | 'port bind';

/** The step a pg_ctl start, embedded PostgreSQL, or port bind names. The argument is the error itself. */
export function infrastructureStep(text: string): InfrastructureStep | undefined {
  if (/\bpg_ctl\b/.test(text) && (/could not start server|stopped waiting|Is server running\?|\bPID file\b/i.test(text)
    || /Command failed: pg_ctl\b[\s\S]{0,800}?\bstart\b/.test(text))) return 'pg_ctl start';
  if (/embedded[ -]?postgres/i.test(text)) return 'embedded PostgreSQL';
  if (/\bEADDRINUSE\b|address already in use|port is already allocated/i.test(text)) return 'port bind';
  return undefined;
}

interface AloneFileResult {
  passed: boolean;
  failures: UnitFailureDetail[];
  fileErrors: UnitFileErrorDetail[];
  /** Set when the file's own errors are only a recognised start failure. */
  step?: InfrastructureStep;
  /** A non-zero exit with no case and no file error, other than a recognised start failure. */
  runnerErrors?: UnitRunnerError[];
  unfinished: boolean;
}

/** Fallout of a recognised start failure in this same detail, such as `pool.end` on a pool that never connected.
 * A TypeError or "is not a function" is not fallout unless this detail is that `pool.end` crash and the file's
 * own errors already name a start failure. The rest of the transcript is not consulted. */
function startFallout(detail: string, startInFile: boolean): boolean {
  if (infrastructureStep(detail)) return true;
  if (/\b(?:expect\(|Expected\b|Received\b|AssertionError)\b/.test(detail)) return false;
  return startInFile && /pool\.end/.test(detail);
}

function fileStartStep(failures: readonly UnitFailureDetail[], fileErrors: readonly UnitFileErrorDetail[],
  runnerErrors: readonly UnitRunnerError[]): InfrastructureStep | undefined {
  for (const text of [...failures.map(item => item.detail ?? ''), ...fileErrors.map(item => item.detail),
    ...runnerErrors.map(item => item.diagnostic)]) {
    const step = infrastructureStep(text);
    if (step) return step;
  }
  return undefined;
}

/** Drops a recognised start failure out of the case list. `pool.end` after that failure is the same report.
 * Any other non-zero exit with no case and no file error stays a runner error. */
function aloneFileResult(result: UnitGateResult, file: string): AloneFileResult {
  if (!result.done || result.timedOut.includes(file) || result.unfinished.includes(file)) {
    return { passed: false, failures: [], fileErrors: [], unfinished: true };
  }
  const failures = result.failures.filter(item => item.file === file);
  const fileErrors = result.fileErrors.filter(item => item.file === file);
  const failing = result.failing.includes(file) || failures.length > 0 || fileErrors.length > 0 || result.runnerErrors.length > 0;
  if (!failing) return { passed: true, failures: [], fileErrors: [], unfinished: false };
  const crashes = result.runnerErrors.filter(error => !infrastructureStep(error.diagnostic));
  if (crashes.length && !failures.length && !fileErrors.length) {
    return { passed: false, failures: [], fileErrors: [], unfinished: false, runnerErrors: crashes };
  }
  const step = fileStartStep(failures, fileErrors, result.runnerErrors);
  if (step) {
    const productFailures = failures.filter(item => !startFallout(item.detail ?? '', true));
    const productErrors = fileErrors.filter(item => !startFallout(item.detail, true));
    if (!productFailures.length && !productErrors.length && !crashes.length) {
      return { passed: false, failures: [], fileErrors: [], unfinished: false, step };
    }
    if (crashes.length) return { passed: false, failures: [], fileErrors: [], unfinished: false, runnerErrors: crashes };
    return { passed: false, failures: productFailures, fileErrors: productErrors, unfinished: false };
  }
  if (crashes.length) return { passed: false, failures: [], fileErrors: [], unfinished: false, runnerErrors: crashes };
  if (failures.length || fileErrors.length) return { passed: false, failures, fileErrors, unfinished: false };
  return { passed: false, failures: [], fileErrors: [{ file, detail: '' }], unfinished: false };
}

export interface BranchOnlyClassification {
  introduced: IntroducedUnitFailure[];
  orderDependent: string[];
  /** Still fail alone on the branch, and alone on main with the same cases and file-level errors. */
  matched: string[];
  inconclusive: { file: string; side: 'affected' | 'main'; step: string }[];
  /** Non-zero exits with no case and no file error. These refuse, including when both sides crash. */
  runnerErrors: { side: 'affected' | 'main'; errors: UnitRunnerError[] }[];
}

async function runFileAlone(cwd: string, file: string, side: 'affected' | 'main', runShard: UnitShardRunner | undefined,
  onRun?: (side: 'affected' | 'main', result: UnitGateResult) => void): Promise<AloneFileResult> {
  console.log(`Unit gate: ${file} rerun alone on ${side}`);
  let result = await runUnitGate(cwd, [file], 1, runShard);
  onRun?.(side, result);
  let judged = aloneFileResult(result, file);
  if (!judged.step || judged.runnerErrors?.length) return judged;
  // One retry. A second recognised start failure is inconclusive and is not an introduced case.
  console.log(`Unit gate: ${file} failed to start ${judged.step} on ${side}; retrying alone`);
  result = await runUnitGate(cwd, [file], 1, runShard);
  onRun?.(side, result);
  judged = aloneFileResult(result, file);
  return judged;
}

/** Files that failed only on the branch, compared by running each one alone on both sides.
 * A pass on the branch is order or load dependent, so main is not run again for that file. */
export async function classifyBranchOnlyFailures(files: readonly string[], absent: ReadonlySet<string>,
  branchCwd: string, mainCwd: string | undefined, runShard?: UnitShardRunner,
  onRun?: (side: 'affected' | 'main', result: UnitGateResult) => void): Promise<BranchOnlyClassification> {
  const introduced: IntroducedUnitFailure[] = [];
  const orderDependent: string[] = [];
  const matched: string[] = [];
  const inconclusive: BranchOnlyClassification['inconclusive'] = [];
  const runnerErrors: BranchOnlyClassification['runnerErrors'] = [];
  const noteRunner = (side: 'affected' | 'main', errors: readonly UnitRunnerError[] | undefined) => {
    if (errors?.length) runnerErrors.push({ side, errors: [...errors] });
  };
  for (const file of [...new Set(files)].sort()) {
    const branch = await runFileAlone(branchCwd, file, 'affected', runShard, onRun);
    if (branch.unfinished) {
      inconclusive.push({ file, side: 'affected', step: 'unfinished run' });
      continue;
    }
    if (branch.runnerErrors?.length) {
      noteRunner('affected', branch.runnerErrors);
      if (!absent.has(file) && mainCwd) {
        const main = await runFileAlone(mainCwd, file, 'main', runShard, onRun);
        if (main.unfinished) inconclusive.push({ file, side: 'main', step: 'unfinished run' });
        else noteRunner('main', main.runnerErrors);
      }
      continue;
    }
    if (branch.step) {
      inconclusive.push({ file, side: 'affected', step: branch.step });
      continue;
    }
    if (branch.passed) {
      orderDependent.push(file);
      continue;
    }
    if (absent.has(file) || !mainCwd) {
      introduced.push(...introducedUnitFailures([file], branch.failures, [], branch.fileErrors, []));
      continue;
    }
    const main = await runFileAlone(mainCwd, file, 'main', runShard, onRun);
    if (main.unfinished) {
      inconclusive.push({ file, side: 'main', step: 'unfinished run' });
      continue;
    }
    if (main.runnerErrors?.length) {
      noteRunner('main', main.runnerErrors);
      continue;
    }
    if (main.step) {
      inconclusive.push({ file, side: 'main', step: main.step });
      continue;
    }
    const compared = introducedUnitFailures([file], branch.failures, main.failures, branch.fileErrors, main.fileErrors);
    if (compared.length) introduced.push(...compared);
    else matched.push(file);
  }
  return { introduced, orderDependent, matched, inconclusive, runnerErrors };
}

/** A repeated recognised start failure is reported by the caller and does not refuse the merge.
 * An unfinished alone run still does. A runner crash still does. A new case found in the same pass still does. */
export function branchOnlyRefusal(classified: BranchOnlyClassification, evidence: readonly UnitRunEvidence[]): string | undefined {
  const unfinished = classified.inconclusive.filter(item => item.step === 'unfinished run');
  const parts: string[] = [];
  for (const item of classified.runnerErrors ?? []) parts.push(runnerErrorRefusal(item.side, item.errors));
  if (unfinished.length) {
    const named = unfinished.map(item => `${item.file} (${item.step})`).join('; ');
    parts.push(unitGateRefusal(`unit gate remains inconclusive after an isolated rerun: ${named}:`,
      unfinished.map(item => item.file), evidence));
  }
  if (classified.introduced.length) {
    parts.push(unitGateRefusal('introduced unit failures; not merging:',
      classified.introduced.map(item => item.file), evidence, 'affected', classified.introduced));
  }
  return parts.length ? parts.join('\n') : undefined;
}

/** Refuses a task worktree or unit-gate baseline whose PostgreSQL socket path exceeds the Linux limit.
 * The baseline name matches `mkdtemp`'s six-character suffix. The result names the path and its byte length. */
export function gateTreeRefusal(worktree: string, mainRoot: string): string | undefined {
  const baseline = join(mainRoot, '.temp', 'unit-gate-xxxxxx');
  return postgresSocketRefusal(physicalPath(worktree)) ?? postgresSocketRefusal(physicalPath(baseline));
}

/** A branch failure is inherited when current main already fails the same case, or the same file-level error's first line.
 * Selection uses the candidate's own changes plus files from the stream's earlier merges. */
async function preMergeUnitGate(worktree: string, mainRoot: string, currentMain: string,
  taskIds: readonly string[], skip: boolean, gatedFiles: Set<string>): Promise<string | undefined> {
  if (skip) {
    console.log('Unit gate skipped: --skip-unit-gate explicitly requested by the manager');
    return;
  }
  const own = git(worktree, ['diff', '--name-only', '--no-renames', `${currentMain}...HEAD`]).split('\n').filter(Boolean);
  const changed = streamSelectionFiles(own, readMergeEvents(), taskIds, mainRoot);
  console.log(`Pre-merge selection since ${currentMain.slice(0, 12)} (${changed.length} path(s))\n  ${changed.join('\n  ')}`);
  const selection = await affectedSelection(worktree, currentMain, changed);
  const unit = selectedUnitFiles(worktree, selection);
  const owner = new Set(selectedOwnerFiles(worktree, selection).filter(file => !unit.includes(file)));
  const files = [...unit, ...owner].sort();
  for (const file of files) gatedFiles.add(file);
  console.log(`Pre-merge unit gate: ${files.length} affected/guard file(s) against main ${currentMain.slice(0, 12)}`);
  if (!files.length) return;
  const configured = gateTreeRefusal(worktree, mainRoot);
  if (configured) return configured;
  const runShard = gateShardRunner(owner);
  const evidence: UnitRunEvidence[] = [];
  try {
    // Run the branch first. A timeout is retried alone; any still-unresolved file keeps this merge inconclusive.
    const side = await runUnitSide(worktree, files, 'affected', evidence, runShard);
    if (side.runnerErrors.length) return runnerErrorRefusal('affected', side.runnerErrors);
    if (side.inconclusive.length) {
      return unitGateRefusal('unit gate remains inconclusive after isolated timeout retry:', side.inconclusive, evidence);
    }
    if (!side.failing.length && !side.orderDependent.length) {
      console.log(`Pre-merge unit gate: every affected unit file and repository guard ${side.initialDone ? 'passes' : 'passes after isolated retry'}`);
      return;
    }
    // `runUnitSide` already reported order-dependent and alone-pass files.
    if (!side.failing.length) return;
    // A file main does not have is entirely new. A file both sides have is introduced only for case names or
    // file-level first lines the main run lacks; the refusal names those and leaves the shared cases below.
    const absent = side.failing.filter(file =>
      spawnSync('git', ['cat-file', '-e', `${currentMain}:${file}`], { cwd: mainRoot }).status !== 0);
    const introduced: IntroducedUnitFailure[] = [];
    const refusing: string[] = [];
    const existing = side.failing.filter(file => !absent.includes(file));
    let directory: string | undefined;
    try {
      const candidates: string[] = [];
      if (existing.length) {
        // Keep the checkout shallow: owner unit gates bind PostgreSQL sockets below it.
        mkdirSync(join(mainRoot, '.temp'), { recursive: true });
        const created = mkdtempSync(join(mainRoot, '.temp/unit-gate-'));
        const deep = postgresSocketRefusal(physicalPath(created));
        if (deep) {
          rmSync(created, { recursive: true, force: true });
          return deep;
        }
        directory = created;
        addGateWorktree(mainRoot, directory, currentMain);
        // Own workspace links keep the baseline on HEAD even when main has local source edits.
        const install = spawnSync('task', ['install'], { cwd: directory, encoding: 'utf8', timeout: 120_000 });
        if (install.status !== 0) throw new Error(`Unit baseline dependency install failed:\n${install.stdout}\n${install.stderr}`);
        const main = await runUnitGate(directory, existing, undefined, runShard);
        notePasses(evidence, 'main', main.passes, pass => pass.kind, directory);
        if (main.runnerErrors.length) return runnerErrorRefusal('main', main.runnerErrors);
        const mainRetry = await retryTimedOutFiles(directory, main.timedOut, 'main', runShard, retry => {
          notePasses(evidence, 'main', retry.passes, pass => pass.kind === 'never-started-rerun' ? 'never-started-rerun' : 'isolated-retry', directory);
        });
        if (mainRetry.runnerErrors.length) return runnerErrorRefusal('main', mainRetry.runnerErrors);
        const mainUnresolved = [...new Set([
          ...main.unfinished.filter(file => !main.timedOut.includes(file)),
          ...mainRetry.inconclusive,
        ])].sort();
        const affecting = existing.filter(file => mainUnresolved.includes(file));
        if (affecting.length) {
          reportUnfinished('main', affecting);
          return unitGateRefusal('unit gate remains inconclusive on main after isolated timeout retry:', affecting, evidence, 'main');
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
          const compared = introducedUnitFailures([file], side.failures.filter(failure => failure.file === file),
            mainDetails, side.fileErrors.filter(error => error.file === file), mainFileErrors);
          if (compared.length) candidates.push(file);
          else console.log(`Unit gate: ${file} also fails on main ${currentMain.slice(0, 12)}; reported, not blocking`);
        }
      }
      // The branch confirm runs every failing file in one process and main splits them into shards.
      // A file counts as introduced only after both sides run that file alone.
      const branchOnly = [...new Set([...absent, ...candidates])].sort();
      if (branchOnly.length) {
        console.log(`Unit gate: ${branchOnly.length} file(s) fail only on the branch; rerunning each alone`);
        const classified = await classifyBranchOnlyFailures(branchOnly, new Set(absent), worktree, directory, runShard,
          (aloneSide, result) => {
            notePasses(evidence, aloneSide, result.passes, () => 'alone', aloneSide === 'main' ? directory : worktree);
          });
        if (classified.orderDependent.length) {
          console.log(`Unit gate: ${classified.orderDependent.length} file(s) pass when run alone; order or load dependent, reported, not blocking\n  ${classified.orderDependent.join('\n  ')}`);
        }
        for (const file of classified.matched) {
          console.log(`Unit gate: ${file} also fails on main ${currentMain.slice(0, 12)} when run alone; reported, not blocking`);
        }
        const reported = classified.inconclusive.filter(item => item.step !== 'unfinished run');
        if (reported.length) {
          console.log(`Unit gate: ${reported.length} file(s) failed to start when run alone; inconclusive, reported, not blocking`);
          for (const item of reported) {
            console.log(`Unit gate inconclusive: ${item.file} failed ${item.step} when run alone on ${item.side}; reported, not blocking`);
          }
        }
        const blocking = classified.runnerErrors.length > 0
          || classified.inconclusive.some(item => item.step === 'unfinished run');
        if (blocking) {
          for (const item of classified.inconclusive.filter(entry => entry.step === 'unfinished run')) {
            console.log(`Unit gate inconclusive: ${item.file} failed ${item.step} when run alone on ${item.side}`);
          }
          const refusal = branchOnlyRefusal(classified, evidence);
          if (refusal) return refusal;
        }
        introduced.push(...classified.introduced);
        refusing.push(...classified.introduced.map(item => item.file));
      }
    } finally {
      if (directory) {
        git(mainRoot, ['worktree', 'remove', '--force', directory]);
        rmSync(directory, { recursive: true, force: true });
      }
    }
    return refusing.length
      ? unitGateRefusal('introduced unit failures; not merging:', refusing.sort(), evidence, 'affected', introduced) : undefined;
  } finally {
    writeUnitEvidence(evidence);
  }
}

export interface PreparedMerge {
  before: string; baseline: string; after: string; worktree: string; branch: string; sharers: string[]; committed: string[];
  /** Files checked against claims. The regeneration commit is not one of them. */
  scopeFiles?: string[];
}

/** The git operations a fast-forward needs, so a moving `main` can be played back without a repository. */
export interface MainSync {
  head(): string;
  isAncestor(ancestor: string, descendant: string): boolean;
  mergeBase(a: string, b: string): string;
  /** Files touched by any commit in `from..to`, including ones reverted later. */
  touched(from: string, to: string): string[];
  /** Files the task changes between `from` and `to`. */
  changed(from: string, to: string): string[];
  /** Rebases the task onto the current `main` and normalizes it again; throws on a conflict. */
  refresh(): string | PreparedMerge | undefined;
  fastForward(after: string): { status: number | null; stderr: string };
}

export type FastForward =
  | { kind: 'merged'; prepared: PreparedMerge }
  /** The pre-merge gate passed and main was not fast-forwarded. */
  | { kind: 'passed'; prepared: PreparedMerge }
  /** The unit gate and the type check both rerun on the rebased branch. */
  | { kind: 'regate'; prepared: PreparedMerge }
  /** Only the type check of these workspaces reruns: main changed their sources but none the unit gate selected. */
  | { kind: 'retypecheck'; prepared: PreparedMerge; workspaces: string[] }
  | { kind: 'stopped'; message?: string; conflict: boolean };

/** What the gates already covered, and how often each may rerun. `typechecked` is empty when the type check was skipped. */
export interface FastForwardGates { gatedFiles: ReadonlySet<string>; regated: boolean; typechecked: readonly string[]; retyped: boolean }

/** Fast-forwards `main` to the task. A `main` that moved past the gated rebase is rebased onto again and, if that
 * second rebase conflicts, the merge stops with the conflict. The unit gate reruns once, and only when the new commits
 * touch the task's files or the files the gate selected. The type check reruns once, separately, when they touch any
 * source of a workspace it checked: a widened exported type breaks callers in files the branch never changed. */
export function fastForwardMain(sync: MainSync, current: PreparedMerge, gates: FastForwardGates,
  note: (text: string) => void = console.log, gateOnly = false): FastForward {
  let prepared = current;
  // The first rebase answers a moved main; the second answers one that moves again before the fast-forward lands.
  for (let rebases = 0; ; ) {
    const head = sync.head();
    if (!sync.isAncestor(head, prepared.after)) {
      if (!sync.isAncestor(prepared.before, head)) {
        return { kind: 'stopped', conflict: true,
          message: 'main history changed during the unit gate; retry merge to rebase, normalize and test again' };
      }
      if (rebases === 2) throw new Error(`Fast-forward failed in the main checkout: main moved again after ${rebases} rebases`);
      // Inspect every intervening commit: a change reverted later still touched the gated set.
      const base = sync.mergeBase(head, prepared.after);
      const touched = sync.touched(base, head);
      const protectedFiles = new Set([...sync.changed(base, prepared.after), ...gates.gatedFiles]);
      const overlap = [...new Set(touched.filter(file => protectedFiles.has(file)))];
      if (overlap.length && gates.regated) {
        return { kind: 'stopped', conflict: true,
          message: `main touched task or gated files again after the retry unit gate; retry merge:\n  ${overlap.join('\n  ')}` };
      }
      const retype = typecheckWorkspaces(touched).filter(workspace => gates.typechecked.includes(workspace));
      if (!overlap.length && retype.length && gates.retyped) {
        return { kind: 'stopped', conflict: true,
          message: `main changed type-checked workspaces again after the retry type check; retry merge:\n  ${retype.join('\n  ')}` };
      }
      const refreshed = sync.refresh();
      rebases++;
      if (typeof refreshed === 'string' || !refreshed) return { kind: 'stopped', message: refreshed, conflict: false };
      prepared = refreshed;
      note(`Main advanced during the unit gate; rebased onto it${overlap.length ? ', re-running the gate once' : retype.length ? `, re-running the type check of ${retype.join(', ')} once` : ', existing gate remains valid'}`);
      if (overlap.length) return { kind: 'regate', prepared };
      if (retype.length) return { kind: 'retypecheck', prepared, workspaces: retype };
      continue;
    }
    if (gateOnly) return { kind: 'passed', prepared };
    const merge = sync.fastForward(prepared.after);
    if (merge.status === 0) return { kind: 'merged', prepared };
    // A main that moved after the check above is the same case, once more.
    if (rebases < 2 && !sync.isAncestor(sync.head(), prepared.after)) continue;
    throw new Error(`Fast-forward failed in the main checkout:\n${merge.stderr}`);
  }
}

function refusalLine(message: string): string {
  return message.split('\n').map(line => line.trim()).find(Boolean) ?? message.trim();
}

function markConflict(task: Task, message: string): void {
  task.state = 'conflict';
  task.refusal = refusalLine(message);
}

/** Merge records a refusal on the task. A gate only prints it. */
function recordRefusal(task: Task, message: string, gateOnly: boolean): string {
  if (!gateOnly) markConflict(task, message);
  return message;
}

function clearRefusal(task: Task): void {
  delete task.refusal;
}

async function mergeTask(id: string, flags: Set<string>, expectedHead?: string,
  reviewGuard?: (task: Task) => void, landPermittedFiles?: readonly string[], gateOnly = false): Promise<void> {
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
      // Rebase, renumber and regeneration write this worktree. A live worker still owns it.
      if (running(sharer)) throw new Error(`${sharer.id} is still running; stop it first`);
    }
    if (!gateOnly && !['exited', 'conflict', 'stopped', 'merged'].includes(task.state)) throw new Error(`${task.id} is ${task.state}`);
    const recordMerged = (commit: string, before?: string, files: readonly string[] = []) => {
      if (before !== undefined) {
        writeMergeEvent({ before, after: commit, goal: task.goal ?? 'program',
          taskIds: sharers.map(sharer => sharer.id).sort(), at: new Date().toISOString() }, files);
      }
      for (const sharer of sharers) { sharer.state = 'merged'; sharer.mergedCommit = commit; clearRefusal(sharer); }
    };
    if (git(root, ['symbolic-ref', '--short', 'HEAD']) !== 'main') throw new Error('Main checkout is not on main');
    const { committed, dirty, ahead } = changedFiles(task);
    if (dirty.length) throw new Error(`${task.id} worktree has uncommitted files:\n  ${dirty.join('\n  ')}`);
    if (flags.has('--landed')) {
      // The manager already landed this work on main by hand (a cherry-pick, often with a conflict resolved).
      const commit = git(root, ['rev-parse', 'HEAD']);
      if (!sharers.every(sharer => sharer.mergedCommit === commit)) {
        const boundary = landedBoundary(root, task, commit);
        const landedFiles = git(root, ['diff', '--name-only', '--no-renames', `${boundary}..${commit}`], true).split('\n').filter(Boolean);
        recordMerged(commit, boundary, landedFiles);
      } else recordMerged(commit);
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
    const regenerated = regenerationOnlyFiles(task.worktree);
    const violations = scopeViolations(committed, task, sharers, regenerated);
    if (landPermittedFiles !== undefined) {
      const refusal = landScopeRefusal(ledger, task, sharers, committed, landPermittedFiles, regenerated);
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
      const message = `${task.id} does not rebase onto main; conflicts:\n  ${conflicted.split('\n').filter(Boolean).join('\n  ')}`;
      return recordRefusal(task, message, gateOnly);
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
      const message = `${task.id} composition root does not parse; not merging:\n  ${prepared.error}`;
      return recordRefusal(task, message, gateOnly);
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
      const message = `${task.id} composition root does not parse; not merging:\n  ${failures.join('\n  ')}`;
      return recordRefusal(task, message, gateOnly);
    }
    if (git(task.worktree, ['status', '--porcelain', '--', 'services/main/src'], true)) {
      git(task.worktree, ['commit', '-q', '-am', 'Normalize Main composition roots after rebase (goalctl)']);
    }
    let normalization: string | MigrationRename[];
    try { normalization = normalizeMigrations(task.worktree, task.branch); }
    catch (error) { normalization = error instanceof Error ? error.message : String(error); }
    if (typeof normalization === 'string') {
      const message = `${task.id} migration normalization refused; not merging:\n  ${normalization}`;
      return recordRefusal(task, message, gateOnly);
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
    const committedNow = changedFiles(task).committed;
    const exempt = new Set(regenerationOnlyFiles(task.worktree));
    const scopeFiles = committedNow.filter(file => !exempt.has(file));
    return { before, baseline, after, worktree: task.worktree, branch: task.branch,
      sharers: sharers.map(sharer => sharer.id).sort(), committed: committedNow, scopeFiles };
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
  let retyped = false;
  const skipTypes = flags.has('--skip-type-gate');
  const typecheck = (merge: PreparedMerge, only?: readonly string[]) =>
    preMergeTypecheckGate(merge.worktree, root, merge.before, merge.committed, skipTypes, only);
  const gate = async (merge: PreparedMerge): Promise<string | undefined> => {
    const generated = regenerateGeneratedOutputs(merge);
    if (generated) return generated;
    return typecheck(merge).then(refusal => refusal ?? preMergeUnitGate(merge.worktree, root, merge.before, merge.sharers,
      flags.has('--skip-unit-gate'), gatedFiles));
  };
  let gateFailure = await gate(preparedMerge);
  for (;;) {
    const current: PreparedMerge = preparedMerge;
    const outcome = await withLedger((ledger): string | { rerun: PreparedMerge; workspaces?: string[] } | undefined => {
      const task = taskOf(ledger, id);
      assertOwner(task);
      reviewGuard?.(task);
      const sharers = Object.values(ledger.tasks).filter(other => other.worktree === task.worktree && HOLDING.includes(other.state));
      if (gateFailure) return recordRefusal(task, `${task.id} ${gateFailure}`, gateOnly);
      const drifted = task.worktree !== current.worktree || task.branch !== current.branch
        || git(root, ['symbolic-ref', '--short', 'HEAD']) !== 'main'
        || git(root, ['rev-parse', task.branch]) !== current.after
        || git(task.worktree, ['rev-parse', 'HEAD']) !== current.after
        || changedFiles(task).dirty.length
        || sharers.map(sharer => sharer.id).sort().join(',') !== current.sharers.join(',')
        || sharers.some(sharer => sharer.goal !== task.goal || sharer.branch !== task.branch || (!gateOnly && running(sharer)))
        || (!gateOnly && !['exited', 'conflict', 'stopped', 'merged'].includes(task.state));
      if (drifted) {
        return recordRefusal(task, `${task.id} main, task branch or sharers changed during the unit gate; retry merge to rebase, normalize and test again`, gateOnly);
      }
      if (landPermittedFiles !== undefined) {
        const refusal = landScopeRefusal(ledger, task, sharers, current.scopeFiles ?? changedFiles(task).committed,
          landPermittedFiles, regenerationOnlyFiles(task.worktree));
        if (refusal) return recordRefusal(task, refusal, gateOnly);
      }
      const advance = fastForwardMain({
        head: () => git(root, ['rev-parse', 'HEAD']),
        isAncestor: (ancestor, descendant) => spawnSync('git', ['merge-base', '--is-ancestor', ancestor, descendant], { cwd: root }).status === 0,
        mergeBase: (a, b) => git(root, ['merge-base', a, b]),
        touched: (from, to) => git(root, ['log', '--format=', '--name-only', '--no-renames', '-m', `${from}..${to}`]).split('\n').filter(Boolean),
        changed: (from, to) => git(root, ['diff', '--name-only', '--no-renames', `${from}..${to}`]).split('\n').filter(Boolean),
        refresh: () => prepareMerge(ledger),
        fastForward: after => retryGitIndexLock(() => spawnSync('git', ['merge', '--ff-only', after], { cwd: root, encoding: 'utf8' })),
      }, current, { gatedFiles, regated, retyped, typechecked: skipTypes ? [] : typecheckWorkspaces(current.committed) }, console.log, gateOnly);
      if (advance.kind === 'stopped') {
        if (advance.conflict && advance.message) {
          return recordRefusal(task, `${task.id} ${advance.message}`, gateOnly);
        }
        if (advance.conflict && !gateOnly) task.state = 'conflict';
        return advance.message;
      }
      const prepared = advance.prepared;
      if (advance.kind === 'regate') return { rerun: prepared };
      if (advance.kind === 'retypecheck') return { rerun: prepared, workspaces: advance.workspaces };
      if (advance.kind === 'passed') {
        // A gate leaves state and the refusal field untouched. Merge still clears a refusal when it lands.
        if (!gateOnly) {
          clearRefusal(task);
          if (task.state !== 'merged') task.state = 'exited';
        }
        console.log(`${task.id} pre-merge gate passed at ${prepared.after.slice(0, 12)}; not merged`);
        return undefined;
      }
      writeMergeEvent({ before: prepared.before, after: prepared.after, goal: task.goal ?? 'program',
        taskIds: prepared.sharers, at: new Date().toISOString() }, prepared.committed);
      for (const sharer of sharers) { sharer.state = 'merged'; sharer.mergedCommit = prepared.after; clearRefusal(sharer); }
      console.log(`${sharers.map(sharer => sharer.id).join(', ')} merged at ${task.mergedCommit!.slice(0, 12)}; ${prepared.committed.length} file(s):`);
      console.log(`  ${prepared.committed.join('\n  ')}`);
      return undefined;
    });
    if (typeof outcome === 'string') throw new Error(outcome);
    if (!outcome) return;
    preparedMerge = outcome.rerun;
    retyped = true;
    if (outcome.workspaces) gateFailure = await typecheck(outcome.rerun, outcome.workspaces);
    else {
      regated = true;
      gateFailure = await gate(outcome.rerun);
    }
  }
}

// Re-read an updated brief for an open task (for example a schema task continuing to its template) and
// replace its claims after the same conflict checks as dispatch. `--allow-area` skips another Goal's
// areas the same way; every other conflict still refuses. The new brief is copied into the worktree.
async function reclaimTask(id: string, briefPath: string, flags: Set<string>): Promise<void> {
  const absolute = resolve(briefPath);
  const text = readFileSync(absolute, 'utf8');
  const brief = parseBrief(text);
  const errors = [...validateBrief(brief), ...mechanismSectionErrors(text)];
  if (errors.length) throw new Error(`Invalid brief ${briefPath}:\n  ${errors.join('\n  ')}`);
  await withLedger(ledger => {
    const task = taskOf(ledger, id);
    assertOwner(task);
    if (brief.id !== task.id) throw new Error(`${briefPath} is for ${brief.id}, not ${task.id}`);
    if (running(task)) throw new Error(`${task.id} is still running`);
    if (['verified', 'cancelled'].includes(task.state)) throw new Error(`${task.id} is closed`);
    // A path this task already holds was claimed before any later change to it, so only added paths can
    // collide with another task's unlanded change.
    const added = { ...brief, paths: brief.paths.filter(path => !task.paths.includes(path)) };
    const conflicts = [...claimConflicts(brief, Object.values(ledger.tasks)),
      ...unlandedChangeConflicts(added, Object.values(ledger.tasks))];
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
    clearRefusal(task);
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
      'depends: []', '---', '', '## Outcome', '', '## Mechanisms', '', 'none',
      '# <id>: consume | configure | extend | new — <why no owner fits>', '', '## Checks', ''].join('\n'));
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
        clearRefusal(task);
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
  console.log(`shared lifecycle: ${sharedLifecycleStatus()}`);
  for (const waiting of sharedLifecycleWaiters()) console.log(waiting);
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
      + `${elapsed(attempt.startedAt)} [${task.cases.join(' ')}] ${task.title}`
      + (task.state === 'conflict' && task.refusal ? `\n  ${task.refusal}` : ''));
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
const sharedLifecycleLock = join(stateDir, 'shared-lifecycle');
const HEAVY_POLL_MS = 10_000;
const HEAVY_DEADLINE_MS = 6 * 3_600_000;

interface CommandTicket {
  pid: number;
  goal?: string;
  command?: string;
  arrivedAt: number;
  /** Zero-padded monotonic time. Wall-clock milliseconds collide; this keeps those tickets in arrival order. */
  seq?: string;
}

/** Beside the lock, not inside it: releasing the lock deletes the lock directory, and later waiters must keep their tickets. */
function commandQueueDir(lockDir: string): string {
  return join(dirname(lockDir), `${basename(lockDir)}-queue`);
}

function commandGoalTurns(queueDir: string): string[] {
  try {
    const turns: unknown = JSON.parse(readFileSync(join(queueDir, 'turns'), 'utf8'));
    return Array.isArray(turns) ? turns.filter((goal): goal is string => typeof goal === 'string') : [];
  } catch { return []; }
}

/** Live tickets: shared refresh first, then Goals in turn order, FIFO within a Goal. Dead or unordered tickets are removed. */
function commandTickets(queueDir: string, alive: (pid: number) => boolean): { path: string; ticket: CommandTicket }[] {
  let names: string[];
  try { names = readdirSync(queueDir); } catch { return []; }
  const live: { path: string; ticket: CommandTicket }[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const path = join(queueDir, name);
    try {
      const ticket = JSON.parse(readFileSync(path, 'utf8')) as CommandTicket;
      if (typeof ticket?.pid !== 'number' || typeof ticket.arrivedAt !== 'number' || !alive(ticket.pid)) {
        rmSync(path, { force: true });
        continue;
      }
      live.push({ path, ticket });
    } catch { rmSync(path, { force: true }); }
  }
  // Refresh repairs the shared stack for every Goal. It gets the next turn, never the holder’s turn.
  const priority = (ticket: CommandTicket) => ticket.command === 'task dev:refresh' ? 0 : 1;
  const turns = commandGoalTurns(queueDir);
  const turn = (ticket: CommandTicket) => priority(ticket) === 0 ? -1 : turns.indexOf(ticket.goal ?? '?');
  live.sort((a, b) => priority(a.ticket) - priority(b.ticket) || turn(a.ticket) - turn(b.ticket)
    || a.ticket.arrivedAt - b.ticket.arrivedAt
    || (a.ticket.seq ?? '').localeCompare(b.ticket.seq ?? '')
    || a.ticket.pid - b.ticket.pid
    || (a.path < b.path ? -1 : 1));
  return live;
}

/** Who holds the heavy QA lock, or undefined when it is free (a dead holder's lock is free). */
function commandHolder(lockDir = heavyLock, alive: (pid: number) => boolean = pidAlive): string | undefined {
  const info = readDirectoryLease(lockDir);
  if (!info?.command || info.invalid) return undefined;
  const commandState = typeof info.commandStartedAt === 'string' ? `command started ${info.commandStartedAt}`
    : info.commandStartedAt === null ? 'command not started' : 'command start unknown';
  const live = info.start && info.boot ? processAlive({ pid: info.pid, start: info.start, boot: info.boot }) : alive(info.pid);
  return live ? `Goal ${info.goal ?? '?'} since ${info.startedAt} (pid ${info.pid}): ${info.command} (${commandState})` : undefined;
}

/** Holder text as before, plus how many live tickets are waiting. Reading the queue drops tickets of dead pids. */
export function heavyQaStatus(lockDir = heavyLock, alive: (pid: number) => boolean = pidAlive): string {
  const waiting = commandTickets(commandQueueDir(lockDir), alive).length;
  return `${commandHolder(lockDir, alive) ?? 'free'}; ${waiting} waiting`;
}

export function heavyQaWaiters(lockDir = heavyLock, alive: (pid: number) => boolean = pidAlive): string[] {
  return commandTickets(commandQueueDir(lockDir), alive).map(({ ticket }) =>
    `QA waiting for heavy turn: Goal ${ticket.goal ?? '?'} (pid ${ticket.pid}): ${ticket.command ?? 'QA command'}`);
}

export function sharedLifecycleStatus(lockDir = sharedLifecycleLock, alive: (pid: number) => boolean = pidAlive): string {
  return `${commandHolder(lockDir, alive) ?? 'free'}; ${commandTickets(commandQueueDir(lockDir), alive).length} waiting`;
}

export function sharedLifecycleWaiters(lockDir = sharedLifecycleLock, alive: (pid: number) => boolean = pidAlive): string[] {
  return commandTickets(commandQueueDir(lockDir), alive).map(({ ticket }) =>
    `Shared lifecycle waiting: Goal ${ticket.goal ?? '?'} (pid ${ticket.pid}): ${ticket.command ?? 'lifecycle command'}`);
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
function bindCommandTicketCleanup(remove: () => void): () => void {
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
  /** Lifecycle takes the next admission turn while existing isolated QA is allowed to finish. */
  lifecycleLockDir?: string;
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
 * run owns only its heavy lease; bounded light runs use the ordinary slots independently.
 * The lock belongs to the process and is freed when it exits, so no manager has to remember to release it.
 * Waiters poll, so a run that starts at the moment the lock frees would otherwise cut in front of one that has been
 * waiting. Tickets preserve FIFO within each Goal, with a shared rotation preventing one Goal's backlog from starving peers. */
export function acquireHeavy(command: readonly string[], options?: HeavyWaitOptions & { coalesceRefresh?: false }): Promise<() => void>;
export function acquireHeavy(command: readonly string[], options: HeavyWaitOptions & { coalesceRefresh: boolean }): Promise<(() => void) | undefined>;
export async function acquireHeavy(command: readonly string[], options: HeavyWaitOptions = {}): Promise<(() => void) | undefined> {
  return acquireQueuedCommand(command, options, 'heavy QA');
}

export type SharedLifecycleWaitOptions = Omit<HeavyWaitOptions, 'lifecycleLockDir'>;

/** Shared-stack mutation has its own lease. Existing isolated QA can keep running while refresh or repair starts. */
export function acquireSharedLifecycle(command: readonly string[], options?: SharedLifecycleWaitOptions & { coalesceRefresh?: false }): Promise<() => void>;
export function acquireSharedLifecycle(command: readonly string[], options: SharedLifecycleWaitOptions & { coalesceRefresh: boolean }): Promise<(() => void) | undefined>;
export async function acquireSharedLifecycle(command: readonly string[], options: SharedLifecycleWaitOptions = {}): Promise<(() => void) | undefined> {
  return acquireQueuedCommand(command, options, 'shared lifecycle');
}

async function acquireQueuedCommand(command: readonly string[], options: HeavyWaitOptions,
  kind: 'heavy QA' | 'shared lifecycle'): Promise<(() => void) | undefined> {
  const lockDir = options.lockDir ?? (kind === 'heavy QA' ? heavyLock : sharedLifecycleLock);
  const lifecycleLockDir = options.lifecycleLockDir ?? (options.lockDir ? join(dirname(lockDir), 'shared-lifecycle') : sharedLifecycleLock);
  const queueDir = commandQueueDir(lockDir);
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
    if (options.bindExit !== false) unbind = bindCommandTicketCleanup(removeTicket);
    mkdirSync(queueDir, { recursive: true });
    const ticket: CommandTicket = {
      pid, goal, command: commandText, arrivedAt, seq: process.hrtime.bigint().toString().padStart(24, '0'),
    };
    writeFileSync(`${ticketPath}.tmp`, JSON.stringify(ticket));
    renameSync(`${ticketPath}.tmp`, ticketPath);
    let announced = false;
    for (;;) {
      const tickets = commandTickets(queueDir, alive);
      const ahead = tickets.findIndex(entry => entry.path === ticketPath);
      if (options.coalesceRefresh && commandText === 'task dev:refresh') {
        const prior = tickets.find(entry => entry.path !== ticketPath && entry.ticket.command === commandText
          && tickets.indexOf(entry) < ahead);
        if (prior) {
          // A refresh that has already taken the lock must not absorb changes arriving after its snapshot.
          let started = false;
          try {
            const holder = readDirectoryLease(lockDir);
            started = holder?.command === commandText && holder.pid === prior.ticket.pid && alive(holder.pid);
          } catch { /* a queued refresh has no holder record */ }
          if (!started) return undefined;
        }
      }
      const lifecyclePending = kind === 'heavy QA' && (dirLockHeld(lifecycleLockDir, alive)
        || commandTickets(commandQueueDir(lifecycleLockDir), alive).length > 0);
      if (ahead === 0 && !lifecyclePending && !dirLockHeld(lockDir, alive)) {
        try {
          // Fail at once when the directory is held, so this loop's poll is the only wait.
          // Stale-owner reclaim still runs before that failure.
          const acquired = tryAcquireDirectoryLease(lockDir, {
            pid, alive: candidate => alive(candidate),
            note: { goal, command: commandText, startedAt: new Date().toISOString(), commandStartedAt: null },
          });
          if (acquired === 'held') throw new Error(`The ${kind} lock is held`);
          if (commandText !== 'task dev:refresh') {
            const turns = commandGoalTurns(queueDir).filter(turn => turn !== (goal ?? '?'));
            turns.push(goal ?? '?');
            writeFileSync(join(queueDir, 'turns'), JSON.stringify(turns));
          }
          return () => acquired.release();
        } catch { /* the lock was taken between the check and the create */ }
      }
      if (now() > deadline) throw new Error(`The ${kind} lock stayed held for six hours`);
      if (!announced) {
        const holder = commandHolder(lockDir, alive);
        (options.announce ?? console.error)(lifecyclePending ? 'waiting for shared lifecycle before heavy QA admission' : ahead > 0
          ? `waiting for ${kind} turn; ${ahead} waiter${ahead === 1 ? '' : 's'} in line${holder ? ` (${holder})` : ''}`
          : `waiting for ${kind} turn held by ${holder ?? 'a starting run'}`);
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
  lifecycleLockDirectory?: string;
  slots?: number;
  timeoutMs?: number;
  pollMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  announce?: (message: string) => void;
  reap?: () => void;
  runCommand?: (command: readonly string[], env: NodeJS.ProcessEnv, onStart: () => void) => Promise<number>;
}

async function runQaCommand(command: readonly string[], env: NodeJS.ProcessEnv, onStart: () => void,
  lifecycleLockDirectory?: string): Promise<number> {
  const owner = lifecycleLockDirectory ? commandLease(lifecycleLockDirectory) : undefined;
  const child = spawn(command[0]!, command.slice(1), { cwd: process.cwd(), stdio: 'inherit', env, detached: true });
  let restoreOwner: (() => void) | undefined;
  if (lifecycleLockDirectory && child.pid && owner) {
    onStart();
    // Transfer synchronously before yielding: a killed launcher must not make its still-running repair look stale.
    restoreOwner = transferSharedLifecycleOwnership(lifecycleLockDirectory, child.pid, owner.pid);
  }
  const exited = new Promise<number>((done, reject) => {
    child.once('error', reject);
    if (!restoreOwner) child.once('spawn', onStart);
    child.once('exit', exit => done(exit ?? 1));
  });
  let stopping: Promise<void> | undefined;
  const forward = () => {
    if (!child.pid) return;
    stopping ??= terminateProcessGroup(child.pid, { graceMs: 1_000 });
  };
  process.on('SIGINT', forward);
  process.on('SIGTERM', forward);
  try {
    const code = await exited;
    if (stopping) await stopping;
    return code;
  } finally {
    process.off('SIGINT', forward);
    process.off('SIGTERM', forward);
    restoreOwner?.();
    // The child's exit hook can run before dockerd finishes creating its container.
    try { sweepOrphanContainers(); } catch { /* the command's exit status still stands */ }
    await Bun.sleep(reapSettleMs);
    try { sweepOrphanContainers(); } catch { /* the command's exit status still stands */ }
  }
}

export function markHeavyCommandStarted(lockDirectory: string): void {
  updateDirectoryLeaseNote(lockDirectory, process.pid, { commandStartedAt: new Date().toISOString() });
}

export function markSharedLifecycleCommandStarted(lockDirectory = sharedLifecycleLock): void {
  markHeavyCommandStarted(lockDirectory);
}

function commandOwnerAlive(info: DirectoryLeaseRecord): boolean {
  return info.start && info.boot ? processAlive({ pid: info.pid, start: info.start, boot: info.boot }) : pidAlive(info.pid);
}

function commandLease(lockDirectory: string): DirectoryLeaseRecord | undefined {
  const info = readDirectoryLease(lockDirectory);
  return info?.token && !info.invalid ? info : undefined;
}

export function sharedLifecycleEnvironment(lockDirectory = sharedLifecycleLock): NodeJS.ProcessEnv {
  const info = commandLease(lockDirectory);
  if (!info?.token || !commandOwnerAlive(info)) throw new Error('Shared lifecycle lease is absent or stale');
  return { GOAL_SHARED_LIFECYCLE_LOCK: resolve(lockDirectory), GOAL_SHARED_LIFECYCLE_PID: String(info.pid),
    GOAL_SHARED_LIFECYCLE_LEASE: info.token };
}

/** Nested maintenance uses the caller's validated lease, so a repair may invoke refresh without queuing behind itself. */
export function inheritedSharedLifecycleOwnership(lockDirectory = sharedLifecycleLock, env = process.env):
  { lockDirectory: string; pid: number; leaseId: string } | undefined {
  if (!env.GOAL_SHARED_LIFECYCLE_LOCK) return undefined;
  const info = commandLease(lockDirectory);
  if (resolve(env.GOAL_SHARED_LIFECYCLE_LOCK) !== resolve(lockDirectory) || !info?.token || !commandOwnerAlive(info)
    || ![String(info.pid), String(info.delegatedFromPid)].includes(env.GOAL_SHARED_LIFECYCLE_PID ?? '')
    || info.token !== env.GOAL_SHARED_LIFECYCLE_LEASE) {
    throw new Error('Inherited shared lifecycle lease is absent, stale or belongs to another lock');
  }
  return { lockDirectory, pid: info.pid, leaseId: info.token };
}

/** The staged child owns the lease while running. Restore a live caller for the rest of its repair command;
 * if that caller was killed, the child releases it. */
export function transferSharedLifecycleOwnership(lockDirectory: string, pid: number,
  expectedOwnerPid = process.ppid): () => void {
  const info = commandLease(lockDirectory);
  if (!Number.isSafeInteger(pid) || pid < 1 || !info?.token)
    throw new Error('Shared lifecycle ownership changed before transfer');
  return transferDirectoryLease(lockDirectory, info.token, pid, expectedOwnerPid, { alive: candidate => pidAlive(candidate) });
}

/** Repairs mutate the shared stack, not a QA stack: no QA lease, stack reap or QA admission environment. */
export async function withRecovery(command: string[], options: SlotRunOptions = {}): Promise<number> {
  if (!command.length) throw new Error('slot --recovery needs a command after --');
  const lockDirectory = options.lifecycleLockDirectory ?? sharedLifecycleLock;
  const inherited = inheritedSharedLifecycleOwnership(lockDirectory);
  const release = inherited ? () => {} : await acquireSharedLifecycle(command, { lockDir: lockDirectory, goal: currentQaGoal(),
    now: options.now, sleep: options.sleep, pollMs: options.pollMs,
    deadline: options.timeoutMs === undefined ? undefined : (options.now ?? Date.now)() + options.timeoutMs,
    announce: options.announce });
  try {
    const env: NodeJS.ProcessEnv = { ...process.env, GOAL_SHARED_LIFECYCLE: '1', ...sharedLifecycleEnvironment(lockDirectory) };
    delete env.GOAL_IN_SLOT;
    delete env.GOAL_QA_HEAVY_RUN;
    delete env.GOAL_QA_SLOT_DIRECTORY;
    delete env.GOAL_QA_WAIT_DIR;
    delete env.GOAL_QA_COMMAND;
    const onStart = () => markSharedLifecycleCommandStarted(lockDirectory);
    return await (options.runCommand ? options.runCommand(command, env, onStart)
      : runQaCommand(command, env, onStart, lockDirectory));
  } finally { release(); }
}

function currentQaGoal(): string | undefined {
  if (process.env.GOAL_ID) return process.env.GOAL_ID;
  const taskId = process.env.GOAL_TASK_ID;
  if (!taskId) return undefined;
  try { return readLedger().tasks[taskId]?.goal; } catch { return undefined; }
}

/** The harness admits its own lifetime lease after memory and the startup turn. */
function harnessOwnsSlot(command: readonly string[]): boolean {
  if (basename(command[0] ?? '') !== 'bun') return false;
  const script = resolve(command[1] ?? '');
  if (script === resolve(import.meta.dir, '../qa/cli.ts')) return true;
  if (script !== resolve(import.meta.dir, '../qa/test.ts')) return false;
  const args = command.slice(2);
  if (parseAffectedArgs(args)) return false;
  const [program, selected] = selectTestCommand(args);
  return program === 'bun' && selected[0] === 'scripts/qa/cli.ts';
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
  const deferred = !heavy && harnessOwnsSlot(command);
  const slots = heavy ? undefined : options.slots ?? Number(process.env.GOAL_QA_SLOTS ?? 3);
  if (!heavy && (!Number.isSafeInteger(slots) || slots! < 1)) throw new Error('GOAL_QA_SLOTS must be a positive integer');
  const dir = options.slotDirectory ?? (deferred ? process.env.GOAL_QA_SLOT_DIRECTORY : undefined) ?? join(stateDir, 'qa-slots');
  const heavyLockDirectory = options.heavyLockDirectory ?? (options.slotDirectory ? join(dir, 'heavy') : heavyLock);
  const waiterDirectory = join(dir, 'waiters');
  const goal = currentQaGoal();
  mkdirSync(dir, { recursive: true });
  let releaseHeavy: (() => void) | undefined;
  let heldSlot: AcquiredDirectoryLease | undefined;
  let waitPath: string | undefined;
  try {
    releaseHeavy = heavy ? await acquireHeavy(command, { lockDir: heavyLockDirectory,
      lifecycleLockDir: options.lifecycleLockDirectory ?? (options.slotDirectory ? join(dir, 'shared-lifecycle') : sharedLifecycleLock),
      goal, announce }) : undefined;
    if (!heavy && !deferred) {
      const deadline = now() + (options.timeoutMs ?? 3_600_000);
      let announced = false;
      while (!heldSlot) {
        for (let k = 0; k < slots! && !heldSlot; k++) {
          const path = join(dir, String(k));
          try { heldSlot = await acquireDir(path, -1, 'slot'); } catch { /* busy */ }
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
    const env: NodeJS.ProcessEnv = { ...process.env, GOAL_IN_SLOT: deferred ? '0' : '1',
      ...(deferred ? { GOAL_QA_SLOT_DIRECTORY: dir, GOAL_QA_SLOTS: String(slots) } : {}),
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
    heldSlot?.release();
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
  goal: string; session: string; engine: LaunchDescriptor['engine']; effort: string; cwd: string; model?: string;
  socket?: string; previousOwner: NonNullable<ReturnType<typeof processIdentity>>;
} {
  const goal = args[0] ?? '';
  const flags = namedOptions(args.slice(1), ['--session', '--engine', '--effort', '--cwd', '--model', '--tmux-socket', '--previous-owner-pid']);
  const engine = flags['--engine'] ?? 'codex';
  if (engine !== 'codex' && engine !== 'codex-1' && engine !== 'luna' && engine !== 'claude') {
    throw new Error('The coordinator enrolls Codex and Claude managers only');
  }
  const effort = flags['--effort'];
  const session = flags['--session'];
  const cwd = flags['--cwd'];
  const model = flags['--model'];
  const pidText = flags['--previous-owner-pid'];
  if (!goal || !effort || !effortsOf(engine).includes(effort) || !session || !cwd || !pidText) {
    throw new Error('Enrollment requires <goal> --session <native UUID> --effort <effort> --cwd <directory> --previous-owner-pid <pid>');
  }
  if (engine === 'claude' && !model) throw new Error('Claude enrollment requires --model <id>');
  if (engine !== 'claude' && model) throw new Error('--model is only for --engine claude');
  const pid = Number(pidText);
  if (!/^[1-9]\d*$/.test(pidText) || !Number.isSafeInteger(pid)) throw new Error('--previous-owner-pid must be a positive integer PID');
  const previousOwner = processIdentity(pid);
  if (!previousOwner) throw new Error(`Cannot establish the live previous owner ${pid}; enroll while that process is still running`);
  return { goal, session, engine, effort, cwd, model, socket: flags['--tmux-socket'], previousOwner };
}
async function coordinatorCommand(args: string[]): Promise<void> {
  const directory = eventStateDirectory();
  const goals = Object.keys(eventLedger(directory).goals ?? {});
  const mail = new GoalMailStore({stateDir:directory,goals});
  const coordinator = new GoalCoordinator({stateDir:directory,
    events:goal => goals.includes(goal) ? managerEvents(directory,goal,mail) : [],
    admit:descriptor => {
      if (!activeGoals(eventLedger(directory)).includes(descriptor.goal)) throw new Error('Enrolled Goal is no longer active');
      const home = descriptor.engine === 'claude' ? realpathSync(claudeConfigHome()) : engineEnv(descriptor.engine).CODEX_HOME;
      if (!home || realpathSync(home) !== descriptor.home) throw new Error('Selected engine account home changed; handover required');
      managerWakeGates(descriptor.engine);
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
      const { goal, session, engine, effort, model, cwd: requestedCwd, socket: requestedSocket, previousOwner } = coordinatorEnrollmentOptions(rest);
      if (!activeGoals(eventLedger(directory)).includes(goal)) throw new Error(`Unknown active Goal: ${goal}`);
      const cwd = realpathSync(resolve(requestedCwd));
      if (engine === 'claude') {
        const home = realpathSync(claudeConfigHome());
        claudeNativeSession(home, session, cwd);
        const socket = requestedSocket ?? spawnSync('tmux',['display-message','-p','#{socket_path}'],{encoding:'utf8'}).stdout.trim();
        if (!socket) throw new Error('Enrollment needs an existing independent tmux server');
        const descriptor: LaunchDescriptor = {goal,generation:randomUUID(),session,engine,effort,cwd,home,previousOwner,
          program:Bun.which('claude') ?? 'claude',args:claudeWakeArgs(session,model!,effort),socket,server:tmuxServer(socket),
          env:{PATH:process.env.PATH ?? '',HOME:homedir(),GOAL_ID:goal,
            GOAL_MANAGER:managerOf(eventLedger(directory),goal),
            ...(process.env.CLAUDE_CONFIG_DIR ? {CLAUDE_CONFIG_DIR:process.env.CLAUDE_CONFIG_DIR} : {}),
            ...(process.env.GOAL_MAIL_STATE_DIR ? {GOAL_MAIL_STATE_DIR:directory} : {}),
            ...Object.fromEntries(['GOAL_MAX_WORKERS','GOAL_MEMORY_FLOOR_GIB','STORYBOOK_MAX_WORKERS'].filter(key => process.env[key] !== undefined).map(key=>[key,process.env[key]!]))}};
        coordinator.acquire();
        try { coordinator.enroll(descriptor); } finally { coordinator.release(); }
        console.log(JSON.stringify(descriptor,null,2)); return;
      }
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
    case 'gate': await mergeTask(positional[0] ?? '', flags, undefined, undefined, undefined, true); return 0;
    case 'land': await landTask(positional[0] ?? ''); return 0;
    case 'close': await closeTasks(positional.slice(0, -1), positional.at(-1) ?? ''); return 0;
    case 'reclaim': await reclaimTask(positional[0] ?? '', positional[1] ?? '', flags); return 0;
    case 'owner': {
      // Read-only: which open task claims a path, or committed it outside its claim and has not landed.
      const path = positional[0] ?? '';
      const ledger = readLedger();
      const areas = Object.entries(areasOf(activeGoals(ledger)))
        .filter(([, globs]) => globs.some(glob => pathsOverlap(glob, path))).map(([slug]) => slug);
      const areaNote = areas.length ? `; in Goal ${areas.join(', ')}'s area` : '';
      if (isGeneratedOutput(path)) {
        console.log(`${path}: unclaimed${areaNote}`);
        return 0;
      }
      const tasks = Object.values(ledger.tasks);
      const holders = tasks.filter(task => HOLDING.includes(task.state)
        && task.paths.some(pattern => !isGeneratedOutput(pattern)
          && (new Bun.Glob(pattern).match(path) || pathsOverlap(pattern, path))));
      const changed = unlandedChangers(tasks, path);
      const claimText = holders.length
        ? `claimed by ${holders.map(task => `${task.id} (${task.state})`).join(', ')}` : '';
      const changeText = changed.length ? `changed by ${changed.map(task => task.id).join(', ')} (unlanded)` : '';
      const body = [claimText, changeText].filter(Boolean).join('; ') || 'unclaimed';
      console.log(`${path}: ${body}${areaNote}`);
      return claimText || changeText ? 1 : 0;
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
      if (rest[0] === '--recovery') {
        const command = rest.slice(1);
        return withRecovery(command[0] === '--' ? command.slice(1) : command);
      }
      const heavy = rest[0] === '--heavy';
      const command = heavy ? rest.slice(1) : rest;
      return withSlot(command[0] === '--' ? command.slice(1) : command, heavy);
    }
    default:
      console.error('Usage: goalctl goal start <slug> --manager <session> [--adopt] [--allow-area] | goal close <slug> [--dry-run]'
        + ' | new [--goal <slug>] <title> | dispatch <brief.md> [--dry-run] [--force-usage] [--allow-area]'
        + ' | wait <id> | owner <path> | reclaim <id> <brief> [--allow-area] | resume <id> (-m <text> | --file <path>) [--effort e]'
        + ` [--engine ${ENGINES.join('|')}] [--fresh] [--force-usage]`
        + ' | stop <id> | scope <id> | land <id> | merge <id> [--allow-scope] [--allow-ids] [--landed] [--skip-unit-gate] [--skip-type-gate]'
        + ' | gate <id> [--skip-unit-gate] [--skip-type-gate]'
        + ' | close <id>... verified|cancelled | tidy [--legacy <archive directory>]'
        + ' | status | usage | regress [--at <rev>] [--resume <run-id>] [--only <tiers>] [--integration-batches <n>]'
        + ' | mail send <goal> --file <path> --key <key> | mail inbox [goal] | mail ack <id> [--goal <goal>]'
        + ' | coordinator [enroll <goal> --session <UUID> --engine <engine> --effort <effort> --cwd <dir> --previous-owner-pid <pid> [--model <id>] [--tmux-socket <path>]|status|unenroll <goal>]'
        + ' | inbox [--ack <n>] | test [--heavy] <task test args> | slot [--heavy|--recovery] -- <command>');
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
