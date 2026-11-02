import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AttemptRef } from './contracts.ts';
import { BRIEF_KINDS, devProductBrief, parseBrief, pathsOverlap, readRiskOwnership, type RiskOwnership } from './briefs.ts';
import { classifyTask } from './routing.ts';
import type { WorkerStore } from './store.ts';
import type { Settings, Task } from './types.ts';

/** Where a worker writes the rest of an outcome that does not fit its attempt, inside its own worktree. */
export const CONTINUATION_DIRECTORY = '.temp/continuation';

/** The Goal backlog the backlog dispatcher reads: `<state>/backlog/<goal>/`. */
export function backlogDirectory(stateDirectory: string, goal: string): string {
  return join(stateDirectory, 'backlog', goal);
}

export type ContinuationHarvest = {
  queued: string[];
  dropped: { file: string; reason: string }[];
  /** Source kept because every distinct backlog name already held a different brief. */
  retained: { file: string; reason: string }[];
};

/** How many stable backlog names one source may try before its brief is kept in the worktree. */
const CONTINUATION_NAME_ATTEMPTS = 8;

function continuationStem(name: string): string {
  return (
    name
      .replace(/\.md$/, '')
      .replace(/[^A-Za-z0-9._-]+/g, '-')
      .slice(0, 80) || 'continuation'
  );
}

/** Preferred backlog name, then names that stay distinct after normalization and truncation. */
function continuationBacklogNames(taskId: string, attempt: number, sourceName: string): string[] {
  const prefix = `continuation-${taskId.slice(0, 8)}-${attempt}-`;
  const normalized = continuationStem(sourceName);
  const digest = createHash('sha256').update(sourceName).digest('hex').slice(0, 8);
  const names: string[] = [];
  const seen = new Set<string>();
  const add = (stem: string) => {
    const filename = `${prefix}${stem}.md`;
    if (seen.has(filename)) return;
    seen.add(filename);
    names.push(filename);
  };
  add(normalized);
  for (let variant = 1; variant < CONTINUATION_NAME_ATTEMPTS; variant++) {
    const mark = variant === 1 ? digest : `${digest}-${variant - 1}`;
    const suffix = `-${mark}`;
    const head = normalized.slice(0, 80 - suffix.length).replace(/-+$/g, '') || 'c';
    add(`${head}${suffix}`);
  }
  return names;
}

function publicationState(destination: string, markdown: string): 'absent' | 'match' | 'other' {
  const stat = lstatSync(destination, { throwIfNoEntry: false });
  if (!stat) return 'absent';
  if (!stat.isFile()) return 'other';
  try {
    return readFileSync(destination, 'utf8') === markdown ? 'match' : 'other';
  } catch {
    return 'other';
  }
}

/** Publish a complete brief. A temporary name is not `*.md`, so the dispatcher never sees a partial file. */
function publishComplete(destination: string, markdown: string): boolean {
  const temporary = `${destination}.${process.pid}.tmp`;
  writeFileSync(temporary, markdown, { flag: 'wx' });
  const state = publicationState(destination, markdown);
  if (state !== 'absent') {
    rmSync(temporary, { force: true });
    return state === 'match';
  }
  renameSync(temporary, destination);
  return true;
}

/** Product work on dev in its own worktree may continue itself; shared workspaces and other lanes may not. */
export function continuesItself(task: Pick<Task, 'brief'> & Partial<Pick<Task, 'workspace'>>): boolean {
  return devProductBrief(task.brief) && !task.workspace;
}

/**
 * Fill the front matter a continuation leaves out from the brief it continues, and read a lone string as a one-item
 * list: on 2026-11-02, 36 of 55 continuations were dropped, most for a missing risk-area list. Declared values stay;
 * risk areas the declared paths touch are added, and the ordinary parser still judges the result.
 */
export function completeContinuation(markdown: string, task: Pick<Task, 'brief'>, ownership: RiskOwnership): string {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(markdown);
  if (!match) return markdown;
  let raw: unknown;
  try {
    raw = Bun.YAML.parse(match[1]!);
  } catch {
    return markdown;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return markdown;
  const front: Record<string, unknown> = { ...(raw as Record<string, unknown>) };
  const list = (value: unknown, fallback: string[]) =>
    value === undefined || value === null
      ? fallback
      : typeof value === 'string'
        ? value
            .split(',')
            .map((item) => item.trim())
            .filter(Boolean)
        : value;
  const flag = (value: unknown) => (value === 'true' ? true : value === 'false' ? false : (value ?? false));
  front.goal ??= task.brief.goal;
  if (!BRIEF_KINDS.includes(front.kind as Task['brief']['kind'])) front.kind = task.brief.kind;
  front.paths = list(front.paths, [...task.brief.paths]);
  front.estimate ??= task.brief.estimate;
  front.criticalPath = flag(front.criticalPath);
  front.waiting = list(front.waiting, []);
  if (front.after !== undefined) front.after = list(front.after, []);
  const areas = list(front.riskAreas, []);
  const paths = front.paths;
  if (Array.isArray(areas) && Array.isArray(paths) && paths.every((path) => typeof path === 'string'))
    for (const [area, patterns] of Object.entries(ownership.areas))
      if (!areas.includes(area) && paths.some((path) => patterns.some((pattern) => pathsOverlap(path, pattern))))
        areas.push(area);
  front.riskAreas = areas;
  if (JSON.stringify(front) === JSON.stringify(raw)) return markdown;
  const newline = match[0].includes('\r\n') ? '\r\n' : '\n';
  const yaml = Bun.YAML.stringify(front, null, 2).trimEnd().replaceAll('\n', newline);
  return `---${newline}${yaml}${newline}---${newline}${markdown.slice(match.index + match[0].length)}`;
}

function invalidReason(
  markdown: string,
  task: Task,
  settings: Pick<Settings, 'riskAreasFile'>,
  known: Set<string>,
): string | undefined {
  try {
    const brief = parseBrief(markdown, readRiskOwnership(settings.riskAreasFile));
    if (brief.goal !== task.brief.goal) return `goal ${brief.goal} is not the task's goal ${task.brief.goal}`;
    if (brief.manager !== task.brief.manager)
      return `manager ${brief.manager} is not the task's manager ${task.brief.manager}`;
    if (!devProductBrief(brief)) return 'a continuation must be product work on the integration branch';
    if (classifyTask(brief) === 'mechanical') return 'mechanical work is run directly, not dispatched';
    const unknown = brief.after.filter((dependency) => !known.has(dependency));
    if (unknown.length) return `unknown dependency task: ${unknown.join(', ')}`;
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/**
 * Move the continuation briefs an attempt left under `.temp/continuation/` into its Goal's backlog, where they are
 * dispatched like any other brief. A brief must parse with the ordinary brief parser and keep the task's goal and
 * manager; any other file is removed and its reason recorded on the attempt. A backlog name that already holds the
 * same brief is left untouched. A different brief is published under the next stable distinct name. The source is
 * removed only after that publication, so an interrupted harvest neither drops nor overwrites a wanted continuation.
 */
export function harvestContinuations(
  store: WorkerStore,
  settings: Pick<Settings, 'stateDirectory' | 'riskAreasFile'>,
  task: Task,
  ref: AttemptRef,
): ContinuationHarvest {
  const result: ContinuationHarvest = { queued: [], dropped: [], retained: [] };
  // The goal names a directory under the state directory; one that is not a plain name has no backlog.
  if (!continuesItself(task) || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(task.brief.goal)) return result;
  const source = join(task.worktree, CONTINUATION_DIRECTORY);
  let names: string[];
  try {
    names = readdirSync(source).sort();
  } catch {
    return result;
  }
  const known = new Set(store.taskIds());
  let ownership: RiskOwnership | undefined;
  try {
    ownership = readRiskOwnership(settings.riskAreasFile);
  } catch {
    // Without the table nothing is completed; the parser reports the same failure for each brief.
  }
  const target = backlogDirectory(settings.stateDirectory, task.brief.goal);
  for (const name of names) {
    const path = join(source, name);
    const drop = (reason: string) => {
      rmSync(path, { recursive: true, force: true });
      result.dropped.push({ file: name, reason });
      store.event(ref, 'continuation-dropped', { file: name, reason });
      console.error(`Continuation ${name} from task ${task.id} attempt ${ref.attempt} dropped: ${reason}`);
    };
    const stat = lstatSync(path, { throwIfNoEntry: false });
    if (!stat) continue;
    if (!stat.isFile() || !name.endsWith('.md')) {
      drop('a continuation must be a regular Markdown file');
      continue;
    }
    const written = readFileSync(path, 'utf8');
    const markdown = ownership ? completeContinuation(written, task, ownership) : written;
    const reason = invalidReason(markdown, task, settings, known);
    if (reason) {
      drop(reason);
      continue;
    }
    const basenames = continuationBacklogNames(task.id, ref.attempt, name);
    const candidates = basenames.map((basename) => join(target, basename));
    let destination = candidates.find((candidate) => publicationState(candidate, markdown) === 'match');
    if (!destination) {
      for (const candidate of candidates) {
        if (publicationState(candidate, markdown) !== 'absent') continue;
        mkdirSync(target, { recursive: true });
        if (publishComplete(candidate, markdown) || publicationState(candidate, markdown) === 'match') {
          destination = candidate;
          break;
        }
      }
    }
    if (!destination) {
      const reason = `kept at ${name}; ${basenames[0]} already holds a different brief and every distinct name is occupied`;
      result.retained.push({ file: name, reason });
      store.event(ref, 'continuation-retained', { file: name, reason });
      console.error(`Continuation ${name} from task ${task.id} attempt ${ref.attempt} kept: ${reason}`);
      continue;
    }
    rmSync(path, { force: true });
    result.queued.push(destination);
    store.event(ref, 'continuation-queued', { file: name, path: destination });
  }
  return result;
}
