import type { Database } from 'bun:sqlite';
import { basename } from 'node:path';
import { SqliteManagerInbox } from './inbox.ts';
import { acquireDirectoryLeaseWaiting } from './lease.ts';
import { defaultPolicy, type ControlPolicy } from './policy.ts';
import { createHash } from 'node:crypto';
import {
  type Dirent,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import type { AttemptRef } from './contracts.ts';
import {
  BRIEF_KINDS,
  classifyRiskAreas,
  devProductBrief,
  parseBrief,
  pathsOverlap,
  readRiskOwnership,
  riskAreaRulesFor,
  type RiskOwnership,
} from './briefs.ts';
import { classifyTask } from './routing.ts';
import type { WorkerStore } from './store.ts';
import type { Settings, Task } from './types.ts';
import { policyGit } from './merge.ts';

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
  const front = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const body = match ? markdown.slice(match[0].length) : markdown;
  const title = front?.title ?? /^#+\s+(.+)$/m.exec(body)?.[1] ?? body.trim().split('\n')[0] ?? '';
  return {
    paths: Array.isArray(front?.paths) ? front.paths.filter((path: unknown) => typeof path === 'string') : [],
    title: String(title)
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .trim(),
  };
}

function directoryEntries(directory: string, ignoreErrors = false): Dirent[] {
  try {
    return readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    if (ignoreErrors || (error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

type ContinuationInventoryEntry = {
  file: string;
  markdown: string;
  scope: ReturnType<typeof scope>;
};

/** A fresh, admission-local view of continuation overlap and review inputs. */
export type ContinuationAdmissionProjection = {
  root: string;
  overlapDirectories: Map<string, Map<string, ContinuationInventoryEntry>>;
  dispatchedNames: Set<string>;
  reviewFiles?: Set<string>;
  continuationCount: number;
};

const CONTINUATION_OVERLAP_DIRECTORIES = ['', 'held', '.dispatching'];
const CONTINUATION_REVIEW_DIRECTORIES = [
  '',
  'proposed',
  'dispatched',
  'continued',
  'failed',
  'retired',
  '.dispatching',
];

function isContinuationFile(file: string): boolean {
  return /(?:^|-)continuation-/.test(basename(file));
}

function readContinuationProjection(
  stateDirectory: string,
  goal: string,
  options: { overlap: boolean; review: boolean },
): ContinuationAdmissionProjection {
  const root = backlogDirectory(stateDirectory, goal);
  const overlapDirectories = new Map<string, Map<string, ContinuationInventoryEntry>>();
  const reviewFiles = options.review ? new Set<string>() : undefined;
  const dispatchedNames = new Set<string>();
  let continuationCount = 0;
  const reviewDirectories = new Set(CONTINUATION_REVIEW_DIRECTORIES);
  const overlapPaths = new Set(CONTINUATION_OVERLAP_DIRECTORIES.map((relative) => join(root, relative)));
  if (options.overlap) for (const directory of overlapPaths) overlapDirectories.set(directory, new Map());

  const directories = new Set<string>([
    ...(options.overlap ? CONTINUATION_OVERLAP_DIRECTORIES : []),
    ...(options.review ? CONTINUATION_REVIEW_DIRECTORIES : []),
    ...(options.overlap ? ['dispatched'] : []),
  ]);
  for (const relative of directories) {
    const directory = join(root, relative);
    // The original dispatched sibling check treated an unreadable directory as no matches. Review inventory keeps
    // its existing strict filesystem error behaviour.
    const entries = directoryEntries(directory, relative === 'dispatched' && !options.review);
    if (relative === 'dispatched') for (const entry of entries) dispatchedNames.add(entry.name);
    const files = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
      .map((entry) => join(directory, entry.name))
      .sort();
    if (reviewFiles && reviewDirectories.has(relative))
      for (const file of files) {
        reviewFiles.add(file);
        if (isContinuationFile(file)) continuationCount++;
      }
    const overlap = overlapDirectories.get(directory);
    if (overlap)
      for (const file of files) {
        try {
          const markdown = readFileSync(file, 'utf8');
          overlap.set(file, { file, markdown, scope: scope(markdown) });
        } catch {
          // An incomplete manager draft has no usable scope yet; ordinary dispatch will validate it.
        }
      }
  }
  return {
    root,
    overlapDirectories,
    dispatchedNames,
    ...(reviewFiles ? { reviewFiles } : {}),
    continuationCount,
  };
}

/** Build the single projection shared by one backlog admission or one source-task harvest. */
export function continuationAdmissionProjection(
  stateDirectory: string,
  goal: string,
  policy: ControlPolicy = defaultPolicy,
): ContinuationAdmissionProjection {
  return readContinuationProjection(stateDirectory, goal, {
    overlap: true,
    review: policy.backlog.continuationReview[goal] === undefined,
  });
}

function recordPublishedContinuation(
  projection: ContinuationAdmissionProjection,
  file: string,
  markdown: string,
): void {
  if (projection.reviewFiles && !projection.reviewFiles.has(file)) {
    projection.reviewFiles.add(file);
    if (isContinuationFile(file)) projection.continuationCount++;
  }
  const entries = projection.overlapDirectories.get(dirname(file));
  entries?.set(file, { file, markdown, scope: scope(markdown) });
}

function movePublishedContinuation(
  projection: ContinuationAdmissionProjection,
  source: string,
  destination: string,
): void {
  const sourceEntries = projection.overlapDirectories.get(dirname(source));
  const existing = sourceEntries?.get(source);
  if (existing) {
    sourceEntries!.delete(source);
    projection.overlapDirectories.get(dirname(destination))?.set(destination, { ...existing, file: destination });
  }
  if (projection.reviewFiles?.delete(source)) {
    projection.reviewFiles.add(destination);
    if (isContinuationFile(source)) projection.continuationCount--;
    if (isContinuationFile(destination)) projection.continuationCount++;
  }
}

function remainingPaths(paths: string[], policy: ControlPolicy['brief']): string[] {
  const shared = policy.sharedPaths ?? [];
  return paths.filter((path) => !shared.some((pattern) => pathsOverlap(path, pattern, policy)));
}

function coversAll(candidate: string[], other: string[], policy: ControlPolicy['brief']): boolean {
  return (
    candidate.length > 0 && candidate.every((path) => other.some((pattern) => pathsOverlap(path, pattern, policy)))
  );
}

function continuationBatchPrefix(taskId: string, attempt: number): string {
  return `continuation-${taskId.slice(0, 8)}-${attempt}-`;
}

function dispatchedFromBatch(projection: ContinuationAdmissionProjection, taskId: string, prefix: string): boolean {
  for (const name of projection.dispatchedNames) {
    const rest = name.startsWith(`${taskId}-`) ? name.slice(taskId.length + 1) : '';
    if (rest.startsWith(prefix)) return true;
  }
  return false;
}

/** Append dependency task IDs to a brief's `after` list; existing values stay first. */
export function withContinuationAfter(markdown: string, taskIds: string[]): string {
  if (!taskIds.length) return markdown;
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
  const existing = Array.isArray(front.after) ? front.after.filter((value) => typeof value === 'string') : [];
  const after = [...existing];
  for (const id of taskIds) if (!after.includes(id)) after.push(id);
  if (after.length === existing.length && after.every((id, index) => id === existing[index])) return markdown;
  front.after = after;
  const newline = match[0].includes('\r\n') ? '\r\n' : '\n';
  const yaml = Bun.YAML.stringify(front, null, 2).trimEnd().replaceAll('\n', newline);
  return `---${newline}${yaml}${newline}---${newline}${markdown.slice(match.index + match[0].length)}`;
}

export type ContinuationOverlap = { reason?: string; after: string[] };

/**
 * The source task is already a dependency. Same-attempt siblings never block each other. Shared paths do not count.
 * A duplicate is a matching title, or every remaining path covered by one active task or ready brief.
 */
export function continuationOverlap(
  db: Database,
  stateDirectory: string,
  goal: string,
  markdown: string,
  sourceTask: string | undefined,
  ignoredFiles: string[] = [],
  policy: ControlPolicy['brief'] = defaultPolicy.brief,
  sourceAttempt?: number,
  admission?: ContinuationAdmissionProjection,
): ContinuationOverlap {
  const projection = admission ?? readContinuationProjection(stateDirectory, goal, { overlap: true, review: false });
  const candidate = scope(markdown);
  const remaining = remainingPaths(candidate.paths, policy);
  const prefix =
    sourceTask !== undefined && sourceAttempt !== undefined
      ? continuationBatchPrefix(sourceTask, sourceAttempt)
      : undefined;
  const duplicate = (reason: string): ContinuationOverlap => ({ reason, after: [] });
  const rows = db
    .query(`SELECT id, body FROM worker_tasks
    WHERE json_extract(body, '$.brief.goal') = ?
      AND json_extract(body, '$.state') IN ('ready', 'running', 'held', 'landing')
    ORDER BY sequence`)
    .all(goal) as { id: string; body: string }[];
  for (const row of rows) {
    if (row.id === sourceTask) continue;
    if (prefix && dispatchedFromBatch(projection, row.id, prefix)) continue;
    const brief = (JSON.parse(row.body) as Task).brief;
    const other = { paths: remainingPaths(brief.paths ?? [], policy), title: scope(brief.markdown ?? '').title };
    if (candidate.title && candidate.title === other.title)
      return duplicate(`overlaps task ${row.id}; merge the remainder into that task's scope`);
    if (coversAll(remaining, other.paths, policy))
      return duplicate(`overlaps task ${row.id}; merge the remainder into that task's scope`);
  }
  for (const directory of CONTINUATION_OVERLAP_DIRECTORIES.map((relative) => join(projection.root, relative))) {
    const entries = projection.overlapDirectories.get(directory);
    if (!entries) continue;
    for (const { file, markdown: otherMarkdown, scope: other } of [...entries.values()].sort((a, b) =>
      a.file < b.file ? -1 : a.file > b.file ? 1 : 0,
    )) {
      if (ignoredFiles.includes(file) && otherMarkdown === markdown) continue;
      if (prefix && basename(file).startsWith(prefix)) continue;
      if (candidate.title && candidate.title === other.title)
        return duplicate(`overlaps brief ${file}; merge the remainder into that scope`);
      const otherRemaining = remainingPaths(other.paths, policy);
      if (coversAll(remaining, otherRemaining, policy))
        return duplicate(`overlaps brief ${file}; merge the remainder into that scope`);
    }
  }
  // Partial overlap orders nothing: concurrent edits to shared files are the train resolver's job.
  return { after: [] };
}

/** Explicit per-Goal values override the default derived from the Goal's durable brief history. */
export function continuationReview(
  stateDirectory: string,
  goal: string,
  policy: ControlPolicy = defaultPolicy,
  additional = 0,
  admission?: ContinuationAdmissionProjection,
): boolean {
  const configured = policy.backlog.continuationReview[goal];
  if (configured !== undefined) return configured;
  const projection = admission ?? readContinuationProjection(stateDirectory, goal, { overlap: false, review: true });
  const files = projection.reviewFiles!;
  return projection.continuationCount + additional > files.size - projection.continuationCount;
}

/** A retained reason and a moved brief are the manager's explicit release; overlaps are still checked. */
export function continuationReleased(stateDirectory: string, goal: string, name: string, markdown: string): boolean {
  const root = backlogDirectory(stateDirectory, goal);
  const reason = join(root, 'proposed', `${name}.reason`);
  return (
    Boolean(lstatSync(reason, { throwIfNoEntry: false })) &&
    readFileSync(reason, 'utf8').includes(
      `<!-- continuation-review:${createHash('sha256').update(markdown).digest('hex')} -->`,
    ) &&
    !lstatSync(join(root, 'proposed', name), { throwIfNoEntry: false }) &&
    !lstatSync(join(root, 'retired', name), { throwIfNoEntry: false })
  );
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
  ownership: RiskOwnership | undefined,
  policy: ControlPolicy['brief'] = defaultPolicy.brief,
): string {
  const frontMatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;
  const match = frontMatter.exec(markdown);
  let raw: unknown;
  if (match) {
    try {
      raw = Bun.YAML.parse(match[1]!);
    } catch {
      return markdown;
    }
  } else {
    // Workers often write the remainder as plain Markdown: on 2026-11-05, 34 of 43 dropped continuations had no front
    // matter. Its contract is the parent's, so it inherits the parent's front matter; ordering and critical-path flags
    // belong to the parent alone.
    const parent = frontMatter.exec(task.brief.markdown);
    let inherited: unknown;
    try {
      inherited = parent ? Bun.YAML.parse(parent[1]!) : {};
    } catch {
      inherited = {};
    }
    raw = inherited && typeof inherited === 'object' && !Array.isArray(inherited) ? { ...inherited } : {};
    for (const key of ['after', 'waiting', 'criticalPath']) delete (raw as Record<string, unknown>)[key];
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return markdown;
  const front: Record<string, unknown> = { ...(raw as Record<string, unknown>) };
  front.manager ??= task.brief.manager;
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
  if (ownership && Array.isArray(areas) && Array.isArray(paths) && paths.every((path) => typeof path === 'string')) {
    const rules = riskAreaRulesFor(ownership);
    for (const path of paths) {
      for (const area of classifyRiskAreas(path, rules, 'pattern', policy)) if (!areas.includes(area)) areas.push(area);
    }
  }
  front.riskAreas = areas;
  if (front.acceptance && typeof front.acceptance === 'object' && !Array.isArray(front.acceptance)) {
    const acceptance = { ...(front.acceptance as Record<string, unknown>) };
    if (Object.hasOwn(acceptance, 'placement') && !Object.hasOwn(acceptance, 'command')) {
      delete acceptance.placement;
      if (Object.keys(acceptance).length) front.acceptance = acceptance;
      else delete front.acceptance;
    }
  }
  if (match && JSON.stringify(front) === JSON.stringify(raw)) return markdown;
  const newline = (match?.[0] ?? markdown).includes('\r\n') ? '\r\n' : '\n';
  const yaml = Bun.YAML.stringify(front, null, 2).trimEnd().replaceAll('\n', newline);
  const body = match ? markdown.slice(match.index + match[0].length) : markdown;
  return `---${newline}${yaml}${newline}---${newline}${body}`;
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

function preserveFailedContinuation(
  source: string,
  target: string,
  task: Task,
  ref: AttemptRef,
  name: string,
  reason: string,
  keepSource = false,
): string {
  const failedDirectory = join(target, 'failed');
  mkdirSync(failedDirectory, { recursive: true });
  const candidates = continuationBacklogNames(task.id, ref.attempt, name);
  let destination: string;
  for (let variant = 0; ; variant++) {
    const candidate =
      variant < candidates.length
        ? join(failedDirectory, candidates[variant]!)
        : join(failedDirectory, `${candidates.at(-1)!.slice(0, -3)}-${variant}.md`);
    if (existsSync(candidate) || existsSync(`${candidate}.reason`)) continue;
    destination = candidate;
    break;
  }
  const reasonPath = `${destination}.reason`;
  writeFileSync(reasonPath, `${reason}\n`, { flag: 'wx' });
  try {
    if (keepSource) copyFileSync(source, destination);
    else renameSync(source, destination);
  } catch (error) {
    rmSync(reasonPath, { force: true });
    rmSync(destination, { force: true });
    throw error;
  }
  return destination;
}

const GIT_COMMIT_ID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i;

function continuationRootName(path: string): string | undefined {
  const prefix = `${CONTINUATION_DIRECTORY}/`;
  return path.startsWith(prefix) ? path.slice(prefix.length).split('/')[0] : undefined;
}

function continuationRootNames(paths: string): Set<string> {
  const names = new Set<string>();
  for (const path of paths.split('\0')) {
    const name = continuationRootName(path);
    if (name) names.add(name);
  }
  return names;
}

function attemptContinuationSources(store: WorkerStore, task: Task, ref: AttemptRef): Set<string> {
  const sources = new Set<string>();
  const add = (value: unknown) => {
    if (typeof value === 'string' && GIT_COMMIT_ID.test(value)) sources.add(value.toLowerCase());
  };
  add(task.base);
  for (const event of store.events(ref.taskId, ref.attempt)) {
    if (!['worker-run-started', 'worker-source-baseline'].includes(event.kind)) continue;
    try {
      const body = JSON.parse(event.body) as { branchHead?: unknown; workerCommit?: unknown; controllerHead?: unknown };
      if (event.kind === 'worker-run-started') add(body.branchHead);
      else {
        add(body.workerCommit);
        add(body.controllerHead);
      }
    } catch {
      // Older imported records may not contain a JSON object.
    }
  }
  return sources;
}

function directMergeParents(worktree: string, commit: string, policy: ControlPolicy['merge'] | undefined): string[] {
  const parents = policyGit(worktree, ['rev-list', '--parents', '-n', '1', commit], policy)
    .trim()
    .split(/\s+/)
    .slice(1);
  return parents.length > 1
    ? parents.filter((parent) => GIT_COMMIT_ID.test(parent)).map((parent) => parent.toLowerCase())
    : [];
}

function continuationNamesInTree(worktree: string, commit: string, policy: ControlPolicy['merge'] | undefined) {
  return continuationRootNames(
    policyGit(worktree, ['ls-tree', '-r', '--name-only', '-z', commit, '--', CONTINUATION_DIRECTORY], policy),
  );
}

/** Historical path-only evidence from the task base, recorded source trees, and direct merge parents. */
function inheritedContinuationNames(
  store: WorkerStore,
  task: Task,
  ref: AttemptRef,
  policy: ControlPolicy['merge'] | undefined,
): Set<string> {
  const names = new Set<string>();
  const sources = attemptContinuationSources(store, task, ref);
  const trees = new Set(sources);
  // Merge-conflict preparation records the exact worker and admitted controller source commits.
  for (const source of sources)
    for (const parent of directMergeParents(task.worktree, source, policy)) trees.add(parent);
  for (const tree of trees) for (const name of continuationNamesInTree(task.worktree, tree, policy)) names.add(name);
  return names;
}

/** Current index entries are candidates for this attempt; only captured source trees establish inheritance. */
function trackedContinuationNames(task: Task, policy: ControlPolicy['merge'] | undefined): Set<string> {
  return continuationRootNames(policyGit(task.worktree, ['ls-files', '-z', '--', CONTINUATION_DIRECTORY], policy));
}

/**
 * Move the continuation briefs an attempt left under `.temp/continuation/` into its Goal's backlog, where they are
 * dispatched like any other brief. A brief must parse with the ordinary brief parser and keep the task's goal and
 * manager. Rejected regular Markdown is copied or moved to the Goal's failed directory with a reason and a manager
 * notice; other untracked files are removed. Tracked sources remain untouched, including inherited briefs belonging
 * to other outcomes. A backlog name that already holds the same brief is left untouched. A different brief is
 * published under the next stable distinct name. An untracked source is removed only after publication, so an
 * interrupted harvest neither drops nor overwrites a wanted continuation.
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
  // Historical names stay in the source; newly tracked files still enter the existing backlog custody.
  const inheritedNames = inheritedContinuationNames(store, task, ref, settings.policy?.merge);
  const trackedNames = trackedContinuationNames(task, settings.policy?.merge);
  const known = new Set(store.taskIds());
  let ownership: RiskOwnership | undefined;
  try {
    ownership = readRiskOwnership(settings.riskAreasFile, settings.policy?.brief);
  } catch {
    // Without the table nothing is completed; the parser reports the same failure for each brief.
  }
  // A retried attempt restates the remainder its predecessor already queued: on 2026-11-02 one task's attempts queued
  // eight copies, and the copies' own retries fanned one outcome out to 28 workers. The first queued remainder stands.
  const taskEvents = store.events(task.id);
  const queuedBy = taskEvents.find(
    (event) => ['continuation-queued', 'continuation-proposed'].includes(event.kind) && event.attempt < ref.attempt,
  )?.attempt;
  const handledNames = new Set<string>();
  for (const event of taskEvents) {
    if (event.attempt !== ref.attempt || !event.kind.startsWith('continuation-')) continue;
    try {
      const body = JSON.parse(event.body) as { file?: unknown };
      if (typeof body.file === 'string') handledNames.add(body.file);
    } catch {
      // An older event without a file name cannot establish per-file custody.
    }
  }
  const target = backlogDirectory(settings.stateDirectory, task.brief.goal);
  const lease = acquireDirectoryLeaseWaiting(
    join(settings.stateDirectory, 'leases', 'backlog'),
    (settings.policy ?? defaultPolicy).leases.dispatchWaitMs,
    settings.policy?.leases,
  );
  try {
    // One task's output is one admission plan. A later harvest builds a fresh projection after this lease ends.
    const admission = continuationAdmissionProjection(settings.stateDirectory, task.brief.goal, settings.policy);
    for (const name of names) {
      if (inheritedNames.has(name)) continue;
      const keepSource = trackedNames.has(name);
      if (keepSource && handledNames.has(name)) continue;
      const path = join(source, name);
      const drop = (reason: string, keepMarkdown = false) => {
        const failedPath = keepMarkdown
          ? preserveFailedContinuation(path, target, task, ref, name, reason, keepSource)
          : undefined;
        if (!keepMarkdown && !keepSource) rmSync(path, { recursive: true, force: true });
        result.dropped.push({ file: name, reason });
        store.event(ref, 'continuation-dropped', { file: name, reason });
        handledNames.add(name);
        if (failedPath) {
          const summary = `Continuation ${name} kept at failed/${basename(failedPath)}: ${reason}`.replace(/\s+/g, ' ');
          new SqliteManagerInbox(store.db, settings.stateDirectory).deliver({
            managerId: task.brief.manager,
            goalId: task.brief.goal,
            kind: 'instruction',
            summary,
          });
          console.error(
            `Continuation ${name} from task ${task.id} attempt ${ref.attempt} kept at ${failedPath}: ${reason}`,
          );
        } else {
          console.error(`Continuation ${name} from task ${task.id} attempt ${ref.attempt} dropped: ${reason}`);
        }
      };
      const stat = lstatSync(path, { throwIfNoEntry: false });
      if (!stat) continue;
      // A tracked non-Markdown entry is source data, not disposable continuation output.
      if (keepSource && (!stat.isFile() || !name.endsWith('.md'))) continue;
      if (!stat.isFile() || !name.endsWith('.md')) {
        drop('a continuation must be a regular Markdown file');
        continue;
      }
      // Creation time, rather than mtime, prevents a touched inherited file being attributed to this attempt.
      if (!Number.isFinite(startedAt) || stat.birthtimeMs < startedAt) {
        if (keepSource) continue;
        drop('file was not created during this attempt', true);
        continue;
      }
      if (queuedBy !== undefined) {
        drop(`attempt ${queuedBy} of this task already queued its continuation`, true);
        continue;
      }
      const written = readFileSync(path, 'utf8');
      const markdown = completeContinuation(written, task, ownership, settings.policy?.brief);
      const reason = invalidReason(markdown, task, settings, known);
      if (reason) {
        drop(reason, true);
        continue;
      }
      const basenames = continuationBacklogNames(task.id, ref.attempt, name);
      const readyCandidates = basenames.map((basename) => join(target, basename));
      const proposedCandidates = basenames.map((basename) => join(target, 'proposed', basename));
      const overlap = continuationOverlap(
        store.db,
        settings.stateDirectory,
        task.brief.goal,
        markdown,
        task.id,
        [...readyCandidates, ...proposedCandidates],
        settings.policy?.brief,
        ref.attempt,
        admission,
      );
      const admitted = overlap.reason ? markdown : withContinuationAfter(markdown, overlap.after);
      const proposalReason =
        overlap.reason ??
        (continuationReview(
          settings.stateDirectory,
          task.brief.goal,
          settings.policy,
          [...readyCandidates, ...proposedCandidates].some((file) => publicationState(file, admitted) === 'match')
            ? 0
            : 1,
          admission,
        )
          ? 'Goal continuation review is enabled; release or retire this proposal'
          : undefined);
      const directory = proposalReason ? join(target, 'proposed') : target;
      const candidates = basenames.map((basename) => join(directory, basename));
      let destination = candidates.find((candidate) => publicationState(candidate, admitted) === 'match');
      if (!destination) {
        for (const candidate of candidates) {
          if (publicationState(candidate, admitted) !== 'absent') continue;
          mkdirSync(directory, { recursive: true });
          if (publishComplete(candidate, admitted) || publicationState(candidate, admitted) === 'match') {
            destination = candidate;
            break;
          }
        }
      }
      if (!destination) {
        const reason = `kept at ${name}; ${basenames[0]} already holds a different brief and every distinct name is occupied`;
        result.retained.push({ file: name, reason });
        store.event(ref, 'continuation-retained', { file: name, reason });
        handledNames.add(name);
        console.error(`Continuation ${name} from task ${task.id} attempt ${ref.attempt} kept: ${reason}`);
        continue;
      }
      if (proposalReason) {
        recordPublishedContinuation(admission, destination, admitted);
        proposeContinuation(destination, settings.stateDirectory, task.brief.goal, proposalReason);
        const proposed = join(target, 'proposed', basename(destination));
        if (proposed !== destination) movePublishedContinuation(admission, destination, proposed);
        if (!keepSource) rmSync(path, { force: true });
        result.proposed.push({ file: destination, reason: proposalReason });
        store.event(ref, 'continuation-proposed', { file: name, path: destination, reason: proposalReason });
        handledNames.add(name);
        new SqliteManagerInbox(store.db, settings.stateDirectory).deliver({
          managerId: task.brief.manager,
          goalId: task.brief.goal,
          kind: 'instruction',
          summary: `Continuation proposed at ${destination}: ${proposalReason}`,
        });
        continue;
      }
      recordPublishedContinuation(admission, destination, admitted);
      if (!keepSource) rmSync(path, { force: true });
      result.queued.push(destination);
      store.event(ref, 'continuation-queued', { file: name, path: destination });
      handledNames.add(name);
    }
  } finally {
    lease.release();
  }
  return result;
}
