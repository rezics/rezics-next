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
import { devProductBrief, parseBrief, readRiskOwnership } from './briefs.ts';
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
    const markdown = readFileSync(path, 'utf8');
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
