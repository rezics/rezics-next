import { existsSync, statSync, readFileSync, readdirSync, mkdirSync, writeFileSync, readlinkSync, rmSync, mkdtempSync } from 'node:fs';
import { join, resolve, relative, isAbsolute, dirname } from 'node:path';
import { stateDir, root, git } from './ledger.ts';
import { testArgs, unitHarnessFiles, type TestResult, parseJUnit, decodeXml } from '../qa/acceptance.ts';
import { repositoryGuards, selectRepositoryGuards, filterRepositoryGuardFiles, repositoryGuardSelectionLine } from '../qa/repository-guards.ts';
import { affectedOwnerTierEntries, type AffectedPlan, affectedUnitTierEntries } from '../qa/affected.ts';
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { terminateProcessGroup } from '../qa/process/terminate.ts';
import { sweepOrphanContainers, reapSettleMs, newReapScope, reapScopeChain, removeScopedContainers } from '../qa/container-reaper.ts';
import { randomUUID } from 'node:crypto';
import { loadavg } from 'node:os';
import { tierBunTestArgs, tierTestTimeoutMs, type TierTestTimeout } from '../qa/core.ts';
import { acquireDir } from './ledger.ts';
import { type MergeEvent } from './regress.ts';
import { postgresSocketRefusal, physicalPath } from './postgres-socket.ts';
import { readMergeEvents, affectedSelection, selectedOwnerFiles } from './merge.ts';
import { addGateWorktree } from './typecheck-gate.ts';
import { selectSurface, runSurfaceGate, type SurfaceRunOptions } from './surface-gate.ts';
import { type Brief } from './types.ts';

/** Surface landing consumes exactly the worker's selection and ordered gate on the rebased candidate. */
export async function preMergeSurfaceGate(worktree: string, main: string, brief: Brief,
  changed: readonly string[], gatedFiles: Set<string>, options: SurfaceRunOptions = {}): Promise<string | undefined> {
  const selected = await selectSurface(worktree, brief, changed, main);
  if (!selected?.selection) return selected?.refusals.join('\n') ?? 'surface selection unavailable';
  const selection = selected.selection;
  for (const file of [...changed, ...selection.units, ...selection.stories, ...selection.guards,
    ...selection.rows.map(row => `tests/qa/fixtures/outcomes/${row}.json`),
    ...selection.proofs]) gatedFiles.add(file);
  // A new API contract on main must rerun the record guards and stories together.
  for (const file of git(worktree, ['ls-files', 'generated/openapi/main']).split('\n').filter(Boolean)) gatedFiles.add(file);
  const result = await runSurfaceGate(worktree, selection, options);
  return result.code ? `surface gate failed; not merging (evidence: ${result.evidence})` : undefined;
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
export function mergeUnitFiles(worktree: string, plan: string, changed?: readonly string[]): string[] {
  if (!/^Affected since /m.test(plan)) throw new Error('Affected unit plan was not produced');
  const entries = [...plan.matchAll(/^  unit: (.+)$/gm)].map(match => match[1]!);
  const selected = new Set(filterRepositoryGuardFiles(existingTestFiles(worktree, entries, [...testArgs('unit'), ...unitHarnessFiles]), changed));
  for (const file of existingTestFiles(worktree, selectRepositoryGuards(changed).map(guard => guard.file), [])) selected.add(file);
  return [...selected].sort();
}

/** Owner-tier files from the same transcript. Whole-tier widening uses the worktree's owner registry. */
export function mergeOwnerFiles(worktree: string, plan: string): string[] {
  if (!/^Affected since /m.test(plan)) throw new Error('Affected unit plan was not produced');
  const listed = [...plan.matchAll(/^  owner: (.+)$/gm)].map(match => match[1]!);
  const hasWholeTier = listed.some(entry => entry.startsWith('whole tier ('));
  const widened = /^  owner tier \(/m.test(plan) || hasWholeTier;
  const whole = widened ? affectedOwnerTierEntries(worktree) : [];
  const entries = widened && !hasWholeTier ? ['whole tier (widened owner registry)', ...listed] : listed;
  return existingTestFiles(worktree, entries, whole).sort();
}

/** Unit files from the typed plan. Widening lists the registered unit entries and omits input-selected native files unless the plan names them. */
export function unitFilesFromPlan(worktree: string, plan: AffectedPlan, changed?: readonly string[]): string[] {
  const widened = plan.widened.some(item => item.tier === 'unit');
  const entries = [...(widened ? affectedUnitTierEntries() : []), ...plan.tests.unit];
  const selected = new Set(filterRepositoryGuardFiles(existingTestFiles(worktree, entries, []), changed));
  for (const file of existingTestFiles(worktree, selectRepositoryGuards(changed).map(guard => guard.file), [])) selected.add(file);
  return [...selected].sort();
}

/** Owner files from the typed plan. Whole-tier widening uses the worktree's owner registry. */
export function ownerFilesFromPlan(worktree: string, plan: AffectedPlan): string[] {
  const widened = plan.widened.some(item => item.tier === 'owner');
  const entries = [...(widened ? affectedOwnerTierEntries(worktree) : []), ...plan.tests.owner];
  return existingTestFiles(worktree, entries, []).sort();
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

export function positiveInteger(name: string, fallback: number): number {
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

/** Which affected files a merge runs itself. Program chooses `changed` in `unit-gate-scope` in the orchestration
 * state when landing is the limit and it runs the full affected set on main; `GOAL_UNIT_GATE_SCOPE` overrides it. */
function unitGateScope(): 'affected' | 'changed' {
  const file = join(stateDir, 'unit-gate-scope');
  const value = process.env.GOAL_UNIT_GATE_SCOPE ?? (existsSync(file) ? readFileSync(file, 'utf8').trim() : '');
  return value === 'changed' ? 'changed' : 'affected';
}

/** How many shards of one gate run at a time. Program sets it for every Goal in `unit-gate-shards` in the
 * orchestration state; `GOAL_UNIT_GATE_SHARDS` overrides it for one process. Each shard still passes memory admission. */
function unitGateShards(): number {
  if (process.env.GOAL_UNIT_GATE_SHARDS) return positiveInteger('GOAL_UNIT_GATE_SHARDS', 4);
  const file = join(stateDir, 'unit-gate-shards');
  const stored = existsSync(file) ? readFileSync(file, 'utf8').trim() : '';
  return /^[1-9]\d*$/.test(stored) && Number.isSafeInteger(Number(stored)) ? Number(stored) : 4;
}

/** Wall clock for every shard of one side. Twelve minutes: one Access-sized run previously waited past 25.
 * A merge gate starts this clock after it holds a gate lane, so time spent waiting for a lane is not included. */
export function unitGateBudgetMs(): number {
  return positiveInteger('GOAL_UNIT_GATE_BUDGET_MS', 12 * 60 * 1000);
}

export const UNIT_GATE_OUTPUT_CAP = 256 * 1024 * 1024;

/** `task` is not the test process. A new session lets the budget signal reach bun underneath it. */
export async function stopProcessGroup(child: ChildProcess): Promise<void> {
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
  /** A completed process has already attributed its own report. Its diagnostic text is not another result. */
  exitCode?: number;
}

export interface TimeoutRetryOptions { testTimeoutMultiplier?: number }
export type UnitShardRunner = (cwd: string, files: readonly string[], deadline: number, options?: TimeoutRetryOptions) => Promise<UnitShardResult>;

export const TIMEOUT_RETRY_MULTIPLIER = 6;
export function timeoutRetryArg(tier: TierTestTimeout): string {
  return `--timeout=${tierTestTimeoutMs[tier] * TIMEOUT_RETRY_MULTIPLIER}`;
}

export interface SlowTestRecord {
  file: string;
  test: string;
  seconds: number;
  loadAverage: number[];
}

export function slowTestLine(test: SlowTestRecord): string {
  return `Timeout retry passed: ${test.file} > ${test.test} (${test.seconds.toFixed(3)}s)`;
}

/** Only failures attributed to runner timeouts qualify. A mixed assertion/timeout file stays a failure. */
export function timeoutOnlyTestFiles(output: string, files: readonly string[], cwd?: string, attributed: readonly string[] = []): string[] {
  const timed = [...new Set([...timedOutTestFiles(output, files, cwd), ...attributed])];
  const failures = junitFailures(output, files, cwd);
  const covered = junitReportedFiles(output, files, cwd);
  const errors = unitFileErrorDetails(output, files, cwd);
  return timed.filter(file => !errors.some(error => error.file === file) && (covered.has(file)
    ? failures!.some(test => test.file === file && test.timeout) && !failures!.some(test => test.file === file && !test.timeout)
    : unitFileEvidence(output, [file], [file], [file], cwd).every(item =>
      item.cases.every(test => /timed out|timeout.*exceeded/i.test(test.error)))));
}

/** Use the report, including in agent sessions where passing console names are suppressed. */
export function recoveredSlowTests(before: string | readonly string[], after: string, file: string, cwd?: string): SlowTestRecord[] {
  const failed = (typeof before === 'string' ? [before] : before).flatMap(output =>
    reportCases(output, cwd)?.filter(test => test.file === file && test.failed && test.timeout).map(test => test.name)
      ?? unitFileEvidence(output, [file], [file], [file], cwd).flatMap(item => item.cases.map(test => test.test)));
  const names = new Set(failed);
  const reported = reportCases(after, cwd);
  const passed = reported ?? [...fileSection(after, file, cwd).matchAll(/^\(pass\) (.+?) \[(\d+(?:\.\d+)?)(ms|s)\]\s*$/gm)]
    .map(match => ({ file, name: match[1]!, failed: false, skipped: false,
      durationMs: Number(match[2]) * (match[3] === 's' ? 1000 : 1) }));
  return passed.filter(test => test.file === file && names.has(test.name)
    && !test.failed && !test.skipped && test.durationMs !== undefined).map(test => ({
      file, test: test.name, seconds: test.durationMs! / 1000, loadAverage: loadavg(),
    }));
}

/** Gate lanes and worker slots can finish together; serialize the bounded history append. */
export async function rememberSlowTests(records: readonly SlowTestRecord[], directory = stateDir): Promise<void> {
  if (!records.length) return;
  mkdirSync(directory, { recursive: true });
  const release = await acquireDir(join(directory, 'timeout-retry-history.lock'), 120_000, 'timeout retry history');
  try {
    const path = join(directory, 'timeout-retry-history.json');
    const previous = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) as SlowTestRecord[] : [];
    writeFileSync(path, `${JSON.stringify([...previous, ...records].slice(-200), null, 2)}\n`);
  } finally { release.release(); }
}

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

/** A reported file takes timeouts only from its own JUnit cases. Console text is a fallback
 * for an omitted file or an unfinished run, never an override of a passing report. */
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
    const covered = junitReportedFiles(output, candidates, root);
    const omitted = new Set(candidates.filter(file => !covered.has(file)));
    scan(dropRunSummary(stripJunitBlocks(block.after)), omitted);
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
  slowTests?: SlowTestRecord[];
}
export interface UnitGatePass {
  kind: 'first' | 'never-started-rerun';
  output: string;
  files: string[];
  failing: string[];
  timedOut: string[];
  slowTests?: SlowTestRecord[];
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
  for (const pass of passes) {
    noteUnitRun(evidence, side, kindOf(pass), pass.output, pass.files, pass.failing, pass.timedOut, root);
    if (pass.slowTests?.length) evidence.push({ side, kind: kindOf(pass), files: [], slowTests: pass.slowTests });
  }
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
  if (!runs.some(run => run.files.length || run.slowTests?.length)) return;
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

interface ShardInvocation { args: string[]; label: string; env: NodeJS.ProcessEnv; progressFile?: string; artifactDirectory?: string }

/** Paths supplied to this runner own its reports; a test printing another artifact URL grants no attribution. */
function ownerArtifactFiles(directory: string | undefined, patterns: readonly string[]): string[] {
  if (!directory || !existsSync(directory)) return [];
  return patterns.flatMap(pattern => [...new Bun.Glob(pattern).scanSync({ cwd: directory })].map(file => join(directory, file)));
}

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

async function runUnitShard(cwd: string, files: readonly string[], deadline: number, options: TimeoutRetryOptions = {}, invocation?: ShardInvocation): Promise<UnitShardResult> {
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
  const child = spawn('task', invocation?.args ?? ['goal:unit-files', '--',
    ...tierBunTestArgs('unit', [
      ...options.testTimeoutMultiplier ? [`--timeout=${tierTestTimeoutMs.unit * options.testTimeoutMultiplier}`] : [],
      `--preload=${join(import.meta.dir, '../qa/container-reaper.ts')}`,
      ...junitFile ? ['--reporter=junit', `--reporter-outfile=${junitFile}`] : [],
      ...files.map(file => `./${file}`),
    ]).slice(1)], {
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
    // Both tiers can print a nested run. Reports and progress are read from this invocation's own paths.
    const streamed = `${indentPrintedStdout(stdoutText)}\n${stderrText}`;
    const parts = [streamed];
    // Written as each file starts, so an outer kill still names the file that was running.
    if (invocation?.progressFile && existsSync(invocation.progressFile))
      parts.push(readFileSync(invocation.progressFile, 'utf8'));
    const text = parts.join('\n');
    // Owner progress already contains streamed case diagnostics. Otherwise its own log supplies them.
    if (/\.(?:test|spec)\.[cm]?[jt]sx?:$/m.test(text)) return text;
    return [text, ...ownerArtifactFiles(invocation?.artifactDirectory, ['*/logs/owner.log'])
      .map(log => readFileSync(log, 'utf8'))].join('\n');
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
    const reportFiles = junitFile && existsSync(junitFile) ? [junitFile]
      : ownerArtifactFiles(invocation?.artifactDirectory, ['owner.xml', '*/owner.xml']);
    const xml = reportFiles.map(path => relativizeJunitFiles(readFileSync(path, 'utf8'), cwd)
      .replace(/<\?xml[^>]*\?>|<\/?testsuites\b[^>]*>/g, '')).join('\n');
    const reported = reportFiles.length ? `${text}\n${UNIT_JUNIT_MARKER}\n<testsuites>${xml}</testsuites>` : text;
    // An exit-zero process passed. A transcript it printed must not trigger classification or a retry.
    if (outcome.code === 0) {
      rememberUnitDurations(durationsFromOutput(reported, files, new Set()));
      return { done: true, exitCode: 0, failing: [], timedOut: [], failures: [], fileErrors: [], runnerErrors: [],
        files: [...files], output: reportFiles.length ? reported : indentPrintedStdout(text), ms: Date.now() - startedAt };
    }
    // The CLI stopped at its own budget and exited. That is an unfinished shard:
    // the file that was running is retried alone, and files with no header run again.
    if (invocation && harnessBudgetExpired(stderr.join(''))) {
      const timedOut = shardTimeoutFiles(text, files, cwd);
      rememberUnitDurations(durationsFromOutput(text, files, new Set(timedOut)));
      return { ...unfinished(text, timedOut), budgetExpired: true };
    }
    const timedOut = timedOutTestFiles(reported, files, cwd);
    const failures = unitFailureDetails(reported, files, cwd);
    const namedFailing = outcome.code === 0 ? [] : failingTestFiles(reported, files, cwd);
    const covered = junitReportedFiles(reported, files, cwd);
    const fileErrors = unitFileErrorDetails(reported, files, cwd, [...namedFailing, ...failures.map(failure => failure.file)])
      .filter(error => !covered.has(error.file));
    const failing = [...new Set([...namedFailing, ...timedOut,
      ...failures.map(failure => failure.file), ...fileErrors.map(error => error.file)])];
    // A non-zero exit with no case and no file error is the runner, not every file in the shard.
    const runnerErrors = outcome.code !== 0 && !failing.length
      ? [{ files: ['runner'], diagnostic: outputTail(text) || `task ${label} exited with status ${outcome.code}` }]
      : [];
    rememberUnitDurations(durationsFromOutput(reported, files, new Set(timedOut)));
    return { done: true, exitCode: outcome.code, failing, timedOut, failures, fileErrors,
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
export function runOwnerShard(cwd: string, files: readonly string[], deadline: number, now: () => number = Date.now, options: TimeoutRetryOptions = {}): Promise<UnitShardResult> {
  const budgetMs = Math.max(1, deadline - now());
  const progressFile = join(cwd, '.temp', 'owner-shard-progress', `${process.pid}-${now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(dirname(progressFile), { recursive: true });
  const env: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !['AGENT', 'CLAUDECODE', 'REPL_ID'].includes(key)));
  env.REZICS_QA_OWNER_BUDGET_MS = String(budgetMs);
  env.REZICS_QA_PROGRESS_FILE = progressFile;
  const artifactDirectory = join(cwd, '.temp', 'owner-shard-artifacts', randomUUID());
  mkdirSync(artifactDirectory, { recursive: true });
  env.REZICS_QA_ARTIFACT_ROOT = artifactDirectory;
  return runUnitShard(cwd, files, deadline, options, {
    args: ['test', '--', ...tierBunTestArgs('owner', [...files,
      ...options.testTimeoutMultiplier ? [`--timeout=${tierTestTimeoutMs.owner * options.testTimeoutMultiplier}`] : [],
    ]).slice(1)], label: 'test', env, progressFile, artifactDirectory,
  });
}

function gateShardRunner(owner: ReadonlySet<string>): UnitShardRunner {
  return (cwd, group, deadline, options) => {
    const owners = group.filter(file => owner.has(file));
    const units = group.filter(file => !owner.has(file));
    if (owners.length && units.length) return Promise.all([
      runUnitShard(cwd, units, deadline, options), runOwnerShard(cwd, owners, deadline, Date.now, options),
    ]).then(mergeShardResults);
    return owners.length ? runOwnerShard(cwd, owners, deadline, Date.now, options) : runUnitShard(cwd, units, deadline, options);
  };
}

function mergeShardResults(parts: readonly UnitShardResult[]): UnitShardResult {
  const reports = parts.flatMap(part => {
    const xml = junitXml(part.output);
    return xml ? [xml.replace(/<\?xml[^>]*\?>|<\/?testsuites\b[^>]*>/g, '')] : [];
  });
  const output = parts.map(part => part.output).join('\n');
  return {
    done: parts.every(part => part.done),
    failing: [...new Set(parts.flatMap(part => part.failing))].sort(),
    timedOut: [...new Set(parts.flatMap(part => part.timedOut))].sort(),
    failures: parts.flatMap(part => part.failures),
    fileErrors: parts.flatMap(part => part.fileErrors),
    runnerErrors: parts.flatMap(part => part.runnerErrors),
    files: [...new Set(parts.flatMap(part => part.files))].sort(),
    output: reports.length ? `${output}\n${UNIT_JUNIT_MARKER}\n<testsuites>${reports.join('\n')}</testsuites>` : output,
    ms: Math.max(...parts.map(part => part.ms)),
    ...(parts.every(part => part.exitCode !== undefined)
      ? { exitCode: parts.find(part => part.exitCode !== 0)?.exitCode ?? 0 } : {}),
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

export interface UnitGateOptions extends TimeoutRetryOptions {
  now?: () => number;
  durations?: ReadonlyMap<string, number>;
  historyDirectory?: string;
}

/** One schedule of the files still without a verdict. A wide plan is many shards; only `shards` run at once. */
export async function runUnitGate(cwd: string, files: readonly string[], shards?: number,
  runShard: UnitShardRunner = runUnitShard, options: UnitGateOptions = {}): Promise<UnitGateResult> {
  const now = options.now ?? Date.now;
  const concurrency = shards ?? unitGateShards();
  const ceiling = unitGateCeilingMs(files.length, unitGateBudgetMs(), concurrency);
  const startedAt = now();
  const durations = options.durations ?? readMeasuredUnitDurations(cwd);
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
    if (wave > 0 && now() - startedAt >= ceiling) {
      const left = [...new Set([...pending, ...runningAtBudget])].sort();
      gateStop('the gate ceiling was reached with files still unfinished', left);
      return snapshot(left, false);
    }
    const scheduled = pending;
    const pass = await runUnitGatePass(cwd, scheduled, concurrency, runShard, durations, now, options);
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
  if (!result.done || result.exitCode !== undefined) return result;
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
  const timedOut = [...new Set([...result.timedOut.filter(file => !covered.has(file)), ...timedOutTestFiles(result.output, result.files)])].sort();
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
  runShard: UnitShardRunner, durations: ReadonlyMap<string, number>, now: () => number, options: TimeoutRetryOptions): Promise<{ result: UnitGateResult; shards: UnitShardResult[] }> {
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
  const results = (await mapPool(planned.shards, concurrency, shard => runShard(cwd, shard.files, now() + shard.budgetMs, options))).map(attributeShard);
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
  runShard?: UnitShardRunner, onRun?: (result: UnitGateResult) => void, options: UnitGateOptions = {}, before: string | readonly string[] = ''): Promise<TimeoutRetryResult> {
  const result: TimeoutRetryResult = { failing: [], passing: [], unfinished: [], inconclusive: [], failures: [], fileErrors: [], runnerErrors: [] };
  for (const file of [...new Set(files)].sort()) {
    console.log(`Unit gate: ${file} timed out on ${side}; rerunning alone`);
    const retry = await runUnitGate(cwd, [file], 1, runShard, { ...options, testTimeoutMultiplier: TIMEOUT_RETRY_MULTIPLIER });
    if (retry.done) retry.timedOut = timeoutOnlyTestFiles(retry.output, retry.timedOut, cwd, retry.timedOut);
    if (retry.done && !retry.runnerErrors.length && !retry.failing.includes(file) && !retry.timedOut.includes(file)) {
      const slowTests = recoveredSlowTests(before, retry.output, file, cwd);
      if (retry.passes[0]) retry.passes[0].slowTests = slowTests;
      await rememberSlowTests(slowTests, options.historyDirectory);
      for (const test of slowTests) console.log(slowTestLine(test));
    }
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

export type RecordedMerge = MergeEvent & { files?: readonly string[] };

/** The candidate's own changes plus files this stream changed in earlier recorded merges.
 * A record written before `files` existed is read back from the two commits. */
export function streamSelectionFiles(own: readonly string[], events: readonly RecordedMerge[], taskIds: readonly string[],
  root?: string): string[] {
  const earlier = events.filter(event => event.before !== event.after && event.taskIds.some(id => taskIds.includes(id)))
    .flatMap(event => event.files ?? (root ? git(root, ['diff', '--name-only', '--no-renames', event.before, event.after]).split('\n').filter(Boolean) : []));
  return [...new Set([...own, ...earlier])].sort();
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
  evidence: UnitRunEvidence[], runShard?: UnitShardRunner, options: UnitGateOptions = {}): Promise<UnitSideResult> {
  const none = (extra: Partial<UnitSideResult> = {}): UnitSideResult => ({
    failing: [], failures: [], fileErrors: [], runnerErrors: [], inconclusive: [], orderDependent: [], initialDone: true, ...extra,
  });
  const isolatedKind = (pass: UnitGatePass): UnitGateRunKind => pass.kind === 'never-started-rerun' ? 'never-started-rerun' : 'isolated-retry';
  const confirmKind = (pass: UnitGatePass): UnitGateRunKind => pass.kind === 'never-started-rerun' ? 'never-started-rerun' : 'confirm';
  const branch = await runUnitGate(cwd, files, undefined, runShard, options);
  // Wall-clock kills have no complete report; completed files must fail only by test timeouts.
  if (branch.done) branch.timedOut = timeoutOnlyTestFiles(branch.output, branch.timedOut, cwd, branch.timedOut);
  notePasses(evidence, side, branch.passes, pass => pass.kind, cwd);
  if (branch.runnerErrors.length) return none({ runnerErrors: branch.runnerErrors, initialDone: branch.done });
  let failureFiles = branch.failing;
  let timedOut = branch.timedOut;
  let timeoutRetry: TimeoutRetryResult = { failing: [], passing: [], unfinished: [], inconclusive: [], failures: [], fileErrors: [], runnerErrors: [] };
  if (!branch.done) {
    timeoutRetry = await retryTimedOutFiles(cwd, branch.timedOut, side, runShard, retry => {
      notePasses(evidence, side, retry.passes, isolatedKind, cwd);
    }, options, branch.output);
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
  const confirmed = together.length ? await runUnitGate(cwd, together, 1, runShard, options) : emptyGate();
  if (confirmed.done) confirmed.timedOut = timeoutOnlyTestFiles(confirmed.output, confirmed.timedOut, cwd, confirmed.timedOut);
  notePasses(evidence, side, confirmed.passes, confirmKind, cwd);
  if (confirmed.runnerErrors.length) return none({ runnerErrors: confirmed.runnerErrors, initialDone: branch.done });
  const alreadyRetried = new Set(branch.done ? [] : branch.timedOut);
  const retry = await retryTimedOutFiles(cwd, [...new Set([...timedOut, ...confirmed.timedOut])].filter(file => !alreadyRetried.has(file)),
    side, runShard, result => { notePasses(evidence, side, result.passes, isolatedKind, cwd); }, options, [branch.output, confirmed.output]);
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
export async function preMergeUnitGate(worktree: string, mainRoot: string, currentMain: string,
  taskIds: readonly string[], skip: boolean, gatedFiles: Set<string>): Promise<string | undefined> {
  if (skip) {
    console.log('Unit gate skipped: --skip-unit-gate explicitly requested by the manager');
    return;
  }
  const own = git(worktree, ['diff', '--name-only', '--no-renames', `${currentMain}...HEAD`]).split('\n').filter(Boolean);
  const changed = streamSelectionFiles(own, readMergeEvents(), taskIds, mainRoot);
  console.log(`Pre-merge selection since ${currentMain.slice(0, 12)} (${changed.length} path(s))\n  ${changed.join('\n  ')}`);
  const selection = await affectedSelection(worktree, currentMain, changed);
  console.log(repositoryGuardSelectionLine(own, worktree));
  const unit = 'plan' in selection ? unitFilesFromPlan(worktree, selection.plan, own) : mergeUnitFiles(worktree, selection.text, own);
  const owner = new Set(filterRepositoryGuardFiles(selectedOwnerFiles(worktree, selection), own).filter(file => !unit.includes(file)));
  const affected = [...unit, ...owner].sort();
  // Scope `changed` runs the test files the branch itself touches and the repository guards; program runs the
  // rest of the affected set on main for every merge together.
  const ownFiles = new Set(changed);
  const guards = new Set<string>(repositoryGuards.map(guard => guard.file));
  const files = unitGateScope() === 'changed' ? affected.filter(file => ownFiles.has(file) || guards.has(file)) : affected;
  for (const file of files) gatedFiles.add(file);
  console.log(`Pre-merge unit gate: ${files.length} affected/guard file(s) against main ${currentMain.slice(0, 12)}`
    + (files.length === affected.length ? '' : `; ${affected.length - files.length} more affected file(s) are left to the main-wide run`));
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
        if (main.done) main.timedOut = timeoutOnlyTestFiles(main.output, main.timedOut, directory, main.timedOut);
        notePasses(evidence, 'main', main.passes, pass => pass.kind, directory);
        if (main.runnerErrors.length) return runnerErrorRefusal('main', main.runnerErrors);
        const mainRetry = await retryTimedOutFiles(directory, main.timedOut, 'main', runShard, retry => {
          notePasses(evidence, 'main', retry.passes, pass => pass.kind === 'never-started-rerun' ? 'never-started-rerun' : 'isolated-retry', directory);
        }, {}, main.output);
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
