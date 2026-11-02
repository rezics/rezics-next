import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
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

export type ContinuationHarvest = { queued: string[]; dropped: { file: string; reason: string }[] };

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
 * manager; any other file is removed and its reason recorded on the attempt. Moving removes the source, so a resumed
 * attempt never queues the same brief twice.
 */
export function harvestContinuations(
  store: WorkerStore,
  settings: Pick<Settings, 'stateDirectory' | 'riskAreasFile'>,
  task: Task,
  ref: AttemptRef,
): ContinuationHarvest {
  const result: ContinuationHarvest = { queued: [], dropped: [] };
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
    const safe =
      name
        .replace(/\.md$/, '')
        .replace(/[^A-Za-z0-9._-]+/g, '-')
        .slice(0, 80) || 'continuation';
    const destination = join(target, `continuation-${task.id.slice(0, 8)}-${ref.attempt}-${safe}.md`);
    mkdirSync(target, { recursive: true });
    if (!existsSync(destination)) {
      // The dispatcher lists only *.md files, so it never reads a partly written brief.
      const temporary = `${destination}.${process.pid}.tmp`;
      writeFileSync(temporary, markdown, { flag: 'wx' });
      renameSync(temporary, destination);
    }
    rmSync(path, { force: true });
    result.queued.push(destination);
    store.event(ref, 'continuation-queued', { file: name, path: destination });
  }
  return result;
}
