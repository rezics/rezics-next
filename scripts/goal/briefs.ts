import { type Brief, type BriefKind, type Engine, DEFAULT_ENGINE, BRIEF_KINDS, ENGINES, effortsOf, type Task, HOLDING } from './types.ts';
import { isAbsolute } from 'node:path';
import { mechanisms } from '../static/mechanisms.ts';

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
    kind: fields.kind as BriefKind | undefined, rows: list('rows'),
    id: fields.id ?? '', title: fields.title ?? '', effort: fields.effort ?? 'medium',
    engine: (fields.engine as Engine | undefined) ?? DEFAULT_ENGINE,
    cases: list('cases'), paths: list('paths'), migrations: list('migrations'), shared: list('shared'),
    tests: list('tests'), refs: list('refs'), operations: list('operations'),
    depends: list('depends'), ...fields.worktree ? { worktree: fields.worktree } : {},
    ...fields.land !== undefined ? { land: fields.land as Brief['land'] } : {},
  };
}

export function validateBrief(brief: Brief): string[] {
  const errors: string[] = [];
  if (!/^G-\d{3,}$/.test(brief.id)) errors.push(`id must look like G-038: ${brief.id || '(missing)'}`);
  if (!brief.title) errors.push('title is required');
  if (!brief.kind || !(BRIEF_KINDS as readonly string[]).includes(brief.kind)) {
    errors.push(`kind must be one of ${BRIEF_KINDS.join(', ')}: ${brief.kind ?? '(missing)'}`);
  }
  for (const row of brief.rows ?? []) if (!/^[a-z][a-z0-9-]*\/[a-z][a-z0-9-]*$/.test(row)) errors.push(`bad outcome row: ${row}`);
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
  const light = new Set(['unit', 'owner', 'model', 'integration', 'fault/recovery', 'load']);
  const tiers: string[] = [];
  const filesForTier: boolean[] = [];
  let current = -1;
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--tier') {
      current = tiers.length;
      tiers.push(args[index + 1] ?? '');
      filesForTier.push(false);
      index++;
    } else if (args[index] === '--file' && current >= 0) filesForTier[current] = true;
  }
  // Every named tier must be a bounded non-browser tier. One tier still accepts `--file` anywhere.
  if (tiers.length === 1) {
    if (!args.includes('--file') || !light.has(tiers[0]!)) return true;
  } else if (tiers.length > 1 && tiers.some((tier, index) => !light.has(tier) || !filesForTier[index])) return true;
  return args.some(arg => arg === '--affected' || arg.startsWith('--affected='));
}
