import type { Database } from 'bun:sqlite';
import { basename } from 'node:path';
import { SqliteManagerInbox } from './inbox.ts';
import { acquireDirectoryLeaseWaiting } from './lease.ts';
import { defaultPolicy, type ControlPolicy } from './policy.ts';
import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AttemptRef } from './contracts.ts';
import {
  BRIEF_KINDS,
  devProductBrief,
  parseBrief,
  pathsOverlap,
  readRiskOwnership,
  type RiskOwnership,
} from './briefs.ts';
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
  proposed: { file: string; reason: string }[];
  dropped: { file: string; reason: string }[];
  /** Source kept because every distinct backlog name already held a different brief. */
  retained: { file: string; reason: string }[];
};

/** Read scope without imposing another Goal's ownership/parser configuration. */
function scope(markdown: string): { paths: string[]; title: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(markdown);
  const raw = match ? Bun.YAML.parse(match[1]!) : {};
  const front = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  const body = match ? markdown.slice(match[0].length) : markdown;
  const title = front?.title ?? /^#+\s+(.+)$/m.exec(body)?.[1] ?? body.trim().split('\n')[0] ?? '';
  return {
    paths: Array.isArray(front?.paths) ? front.paths.filter((path: unknown) => typeof path === 'string') : [],
    title: String(title).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim(),
  };
}

function markdownFiles(directory: string): string[] {
  try {
    return readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
      .map((entry) => join(directory, entry.name)).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

/** The source task is already a dependency; only other unfinished work conflicts with its remainder. */
export function continuationOverlap(
  db: Database, stateDirectory: string, goal: string, markdown: string,
  sourceTask: string | undefined, ignoredFiles: string[] = [],
  policy: ControlPolicy['brief'] = defaultPolicy.brief,
): string | undefined {
  const candidate = scope(markdown);
  const overlaps = (other: ReturnType<typeof scope>) =>
    (candidate.title && candidate.title === other.title) ||
    candidate.paths.some((path) => other.paths.some((pattern) => pathsOverlap(path, pattern, policy)));
  const rows = db.query(`SELECT id, body FROM worker_tasks
    WHERE json_extract(body, '$.brief.goal') = ?
      AND json_extract(body, '$.state') IN ('ready', 'running', 'held', 'landing', 'stopped')
    ORDER BY sequence`).all(goal) as { id: string; body: string }[];
  for (const row of rows) {
    if (row.id === sourceTask) continue;
    const brief = (JSON.parse(row.body) as Task).brief;
    if (overlaps({ paths: brief.paths ?? [], title: scope(brief.markdown ?? '').title }))
      return `overlaps task ${row.id}; merge the remainder into that task's scope`;
  }
  const root = backlogDirectory(stateDirectory, goal);
  for (const directory of [root, join(root, 'held'), join(root, '.dispatching'), join(root, 'proposed')]) {
    for (const file of markdownFiles(directory)) {
      try {
        const other = readFileSync(file, 'utf8');
        if (ignoredFiles.includes(file) && other === markdown) continue;
        if (overlaps(scope(other))) return `overlaps brief ${file}; merge the remainder into that scope`;
      } catch {
        // An incomplete manager draft has no usable scope yet; ordinary dispatch will validate it.
      }
    }
  }
  return undefined;
}

/** Explicit per-Goal values override the default derived from the Goal's durable brief history. */
export function continuationReview(
  stateDirectory: string, goal: string, policy: ControlPolicy = defaultPolicy, additional = 0,
): boolean {
  const configured = policy.backlog.continuationReview[goal];
  if (configured !== undefined) return configured;
  const root = backlogDirectory(stateDirectory, goal);
  const files = ['', 'proposed', 'dispatched', 'continued', 'failed', 'retired', '.dispatching']
    .flatMap((directory) => markdownFiles(join(root, directory)));
  const continuations = files.filter((file) => /(?:^|-)continuation-/.test(basename(file))).length;
  return continuations + additional > files.length - continuations;
}

/** A retained reason and a moved brief are the manager's explicit release; overlaps are still checked. */
export function continuationReleased(stateDirectory: string, goal: string, name: string, markdown: string): boolean {
  const root = backlogDirectory(stateDirectory, goal);
  const reason = join(root, 'proposed', `${name}.reason`);
  return Boolean(lstatSync(reason, { throwIfNoEntry: false })) &&
    readFileSync(reason, 'utf8').includes(`<!-- continuation-review:${createHash('sha256').update(markdown).digest('hex')} -->`) &&
    !lstatSync(join(root, 'proposed', name), { throwIfNoEntry: false }) &&
    !lstatSync(join(root, 'retired', name), { throwIfNoEntry: false });
}

export function proposeContinuation(file: string, stateDirectory: string, goal: string, reason: string): string {
  const directory = join(backlogDirectory(stateDirectory, goal), 'proposed');
  mkdirSync(directory, { recursive: true });
  const destination = join(directory, basename(file));
  if (file !== destination && publicationState(destination, readFileSync(file, 'utf8')) === 'other')
    throw new Error(`cannot propose ${file}: ${destination} already holds a different brief`);
  const fingerprint = createHash('sha256').update(readFileSync(file, 'utf8')).digest('hex');
  writeFileSync(`${destination}.reason`, `${reason}\n\n<!-- continuation-review:${fingerprint} -->\n`);
  if (file !== destination) renameSync(file, destination);
  return destination;
}

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
 * risk areas the declared paths touch are added, and the ordinary parser still judges the result. A continuation is
 * the rest of its task, so it waits for the task: started earlier, it rebuilt the unlanded slice beside the task.
 */
export function completeContinuation(
  markdown: string,
  task: Pick<Task, 'brief' | 'id'>,
  ownership: RiskOwnership,
  policy: ControlPolicy['brief'] = defaultPolicy.brief,
): string {
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
  front.after = list(front.after, []);
  if (Array.isArray(front.after) && !front.after.includes(task.id)) front.after = [...front.after, task.id];
  const areas = list(front.riskAreas, []);
  const paths = front.paths;
  if (Array.isArray(areas) && Array.isArray(paths) && paths.every((path) => typeof path === 'string'))
    for (const [area, patterns] of Object.entries(ownership.areas))
      if (
        !areas.includes(area) &&
        paths.some((path) => patterns.some((pattern) => pathsOverlap(path, pattern, policy)))
      )
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
  settings: Pick<Settings, 'riskAreasFile' | 'policy'>,
  known: Set<string>,
): string | undefined {
  try {
    const brief = parseBrief(
      markdown,
      readRiskOwnership(settings.riskAreasFile, settings.policy?.brief),
      settings.policy?.brief,
    );
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
  settings: Pick<Settings, 'stateDirectory' | 'riskAreasFile' | 'policy'>,
  task: Task,
  ref: AttemptRef,
): ContinuationHarvest {
  const result: ContinuationHarvest = { queued: [], proposed: [], dropped: [], retained: [] };
  // The goal names a directory under the state directory; one that is not a plain name has no backlog.
  if (!continuesItself(task) || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(task.brief.goal)) return result;
  // No attempt record means there is no trustworthy creation boundary.
  const startedAt = Date.parse(store.attempt(ref).startedAt);
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
    ownership = readRiskOwnership(settings.riskAreasFile, settings.policy?.brief);
  } catch {
    // Without the table nothing is completed; the parser reports the same failure for each brief.
  }
  // A retried attempt restates the remainder its predecessor already queued: on 2026-11-02 one task's attempts queued
  // eight copies, and the copies' own retries fanned one outcome out to 28 workers. The first queued remainder stands.
  const queuedBy = store
    .events(task.id)
    .find((event) => ['continuation-queued', 'continuation-proposed'].includes(event.kind) && event.attempt < ref.attempt)?.attempt;
  const target = backlogDirectory(settings.stateDirectory, task.brief.goal);
  const lease = acquireDirectoryLeaseWaiting(join(settings.stateDirectory, 'leases', 'backlog'),
    (settings.policy ?? defaultPolicy).leases.dispatchWaitMs, settings.policy?.leases);
  try {
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
      // Creation time, rather than mtime, prevents a touched inherited file being attributed to this attempt.
      if (!Number.isFinite(startedAt) || stat.birthtimeMs < startedAt) {
        drop('file was not created during this attempt');
        continue;
      }
      if (queuedBy !== undefined) {
        drop(`attempt ${queuedBy} of this task already queued its continuation`);
        continue;
      }
      const written = readFileSync(path, 'utf8');
      const markdown = ownership ? completeContinuation(written, task, ownership, settings.policy?.brief) : written;
      const reason = invalidReason(markdown, task, settings, known);
      if (reason) {
        drop(reason);
        continue;
      }
      const basenames = continuationBacklogNames(task.id, ref.attempt, name);
      const readyCandidates = basenames.map((basename) => join(target, basename));
      const proposedCandidates = basenames.map((basename) => join(target, 'proposed', basename));
      const overlap = continuationOverlap(store.db, settings.stateDirectory, task.brief.goal, markdown,
        task.id, [...readyCandidates, ...proposedCandidates], settings.policy?.brief);
      const proposalReason = overlap ?? (continuationReview(settings.stateDirectory, task.brief.goal, settings.policy,
        [...readyCandidates, ...proposedCandidates].some((file) => publicationState(file, markdown) === 'match') ? 0 : 1)
        ? 'Goal continuation review is enabled; release or retire this proposal' : undefined);
      const directory = proposalReason ? join(target, 'proposed') : target;
      const candidates = basenames.map((basename) => join(directory, basename));
      let destination = candidates.find((candidate) => publicationState(candidate, markdown) === 'match');
      if (!destination) {
        for (const candidate of candidates) {
          if (publicationState(candidate, markdown) !== 'absent') continue;
          mkdirSync(directory, { recursive: true });
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
      if (proposalReason) {
        proposeContinuation(destination, settings.stateDirectory, task.brief.goal, proposalReason);
        rmSync(path, { force: true });
        result.proposed.push({ file: destination, reason: proposalReason });
        store.event(ref, 'continuation-proposed', { file: name, path: destination, reason: proposalReason });
        new SqliteManagerInbox(store.db, settings.stateDirectory).deliver({
          managerId: task.brief.manager, goalId: task.brief.goal, kind: 'instruction',
          summary: `Continuation proposed at ${destination}: ${proposalReason}`,
        });
        continue;
      }
      rmSync(path, { force: true });
      result.queued.push(destination);
      store.event(ref, 'continuation-queued', { file: name, path: destination });
    }
  } finally {
    lease.release();
  }
  return result;
}
