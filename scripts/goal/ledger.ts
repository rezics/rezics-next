import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, rmSync, existsSync, readdirSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { join, dirname, relative, basename, resolve } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { HISTORY_EXEMPT, goalOfBriefPath, GOALS_DIR, goalFile, goalAreas, ownerRefusal, goalBriefFile, isGeneratedOutput, outOfScope, pathsOverlap } from './briefs.ts';
import { type Ledger, type Task, modelOf, engineOf, type Brief, UNLANDED, HOLDING } from './types.ts';
import { readResult, taskOf, changedFiles } from './launch.ts';
import { type LandScope } from './land.ts';
import { processAlive } from '../qa/process/identity.ts';
import { directoryLeaseHeld, type AcquiredDirectoryLease, tryAcquireDirectoryLease } from '../qa/process/lease.ts';
import { worktreeBase } from './tree-currency.ts';

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

export function git(cwd: string, args: string[], allowFail = false, options: { env?: Record<string, string>; input?: string } = {}): string {
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
    if (parent && tree === git(repo, ['rev-parse', `${parent}^{tree}`])) return parent;
    const commit = git(repo, ['commit-tree', tree, ...parent ? ['-p', parent] : [], '-m', message]);
    git(repo, ['update-ref', '-m', message, ref, commit, parent]);
    return commit;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Deletes files and commits their removal with any accompanying link edits, leaving whatever else peers have staged. */
export function removeFromTree(repo: string, paths: readonly string[], message: string,
  edited: readonly string[] = []): string | undefined {
  const tracked = paths.filter(path => git(repo, ['ls-files', '--', path], true) !== '');
  for (const path of paths) {
    rmSync(join(repo, path), { force: true });
    // A closed Goal leaves no empty directory behind.
    for (let dir = dirname(path); dir !== '.' && existsSync(join(repo, dir)) && !readdirSync(join(repo, dir)).length; dir = dirname(dir)) {
      rmSync(join(repo, dir), { recursive: true });
    }
  }
  if (!tracked.length) return undefined;
  git(repo, ['commit', '-q', '--only', '-m', message, '--', ...tracked, ...edited]);
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
export const root = dirname(git(process.cwd(), ['rev-parse', '--path-format=absolute', '--git-common-dir']));
export const stateDir = join(root, '.temp', 'goal-orchestration');
const ledgerPath = join(stateDir, 'ledger.json');
export const usagePath = process.env.GOAL_USAGE_FILE ?? join(homedir(), '.claude', 'usage', 'latest.json');
export const usageHistoryPath = join(stateDir, 'usage-history.json');
export const CODEX_RESET_URL = 'https://codex-resets.com/api/v1/status';
export const CODEX_RESET_CACHE_MS = 30 * 60 * 1000;
export const codexResetCachePath = join(stateDir, 'codex-resets-status.json');

export function readLedger(): Ledger {
  return existsSync(ledgerPath) ? JSON.parse(readFileSync(ledgerPath, 'utf8')) as Ledger : { tasks: {} };
}

function writeLedger(ledger: Ledger): void {
  writeFileSync(`${ledgerPath}.tmp`, `${JSON.stringify(ledger, null, 2)}\n`);
  renameSync(`${ledgerPath}.tmp`, ledgerPath);
}

export const activeGoals = (ledger: Ledger): string[] =>
  Object.entries(ledger.goals ?? {}).filter(([, goal]) => !goal.closedAt).map(([slug]) => slug);

export function managerOf(ledger: Ledger, goal: string | undefined): string {
  return (goal && ledger.goals?.[goal]?.manager) || ledger.manager || process.env.GOAL_MANAGER || 'goal-manager';
}

/** The Goal a brief belongs to: its directory, else the caller's GOAL_ID, else the only active Goal. Briefs in the
 * pre-Goal `docs/goals/tasks/` keep working while one Goal runs. */
export function briefGoal(ledger: Ledger, absolute: string): string | undefined {
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
export function areasOf(slugs: readonly string[]): Record<string, string[]> {
  return Object.fromEntries(slugs.map(slug => {
    const path = join(root, goalFile(slug));
    return [slug, existsSync(path) ? goalAreas(readFileSync(path, 'utf8')) : []];
  }));
}

export function assertOwner(task: Task): void {
  const refusal = ownerRefusal(task);
  if (refusal) throw new Error(refusal);
}

/** Where a task's brief is now: its recorded path, else its Goal directory, else the pre-Goal tasks directory. */
export function briefPathOf(task: Task): string | undefined {
  const candidates = [task.brief, ...task.goal ? [join(root, goalBriefFile(task.goal, task.id))] : [],
    join(root, GOALS_DIR, 'tasks', `${task.id}.md`)];
  return candidates.find(path => path && existsSync(path));
}

/** A Goal's directory on archive/goals, named like the earlier `frontend-goal-2026-09-27`. */
export function archiveDirOf(ledger: Ledger, goal: string): string {
  return ledger.goals?.[goal]?.archive ?? `${goal}-${(ledger.goals?.[goal]?.startedAt ?? new Date().toISOString()).slice(0, 10)}`;
}

function outputNames(directory: string): string[] {
  return existsSync(directory) ? readdirSync(directory, { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name !== 'brief.md' && /\.(md|json)$/.test(entry.name))
    .map(entry => entry.name).sort((a, b) => b.length - a.length || a.localeCompare(b)) : [];
}

/** Keep authored reports before the ignored worktree directory is moved or deleted. */
export function preserveTaskOutputs(task: Task): void {
  const source = join(task.worktree, '.temp/goal');
  const run = join(stateDir, 'runs', task.id);
  const outputs = join(run, 'outputs');
  for (const name of outputNames(source)) {
    mkdirSync(outputs, { recursive: true });
    copyFileSync(join(source, name), join(outputs, name));
  }
  if (outputNames(outputs).length) writeFileSync(join(run, 'handoff.md'), handoffText(task, 'outputs'));
}

function handoffText(task: Task, outputDirectory?: string): string {
  let text = [`# ${task.id} handoffs: ${task.title}`, '',
    ...task.attempts.flatMap(attempt => [`## Attempt ${attempt.n} (${modelOf(engineOf(attempt))}/${attempt.effort}, `
      + `${attempt.startedAt})`, '', readResult(attempt).text.trim(), ''])].join('\n');
  if (outputDirectory) for (const name of outputNames(join(stateDir, 'runs', task.id, 'outputs'))) {
    const target = `${outputDirectory}/${name}`;
    for (const source of [join(task.worktree, '.temp/goal', name), `./.temp/goal/${name}`, `.temp/goal/${name}`]) {
      text = text.replaceAll(source, target);
    }
  }
  return text;
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

export function scopeViolations(committed: string[], task: Task, sharers: Task[], regenerated: readonly string[] = []): string[] {
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

/** Commits above the task's base whose every change to a path is a regeneration commit. */
function regeneratedOnBranch(branch: string, base: string): string[] {
  const log = git(root, ['log', '--name-only', '--pretty=format:%H%x09%s', `${base}..${branch}`], true);
  return log ? filesOnlyRegenerated(log) : [];
}

/** Files this branch committed outside the claim that land would still refuse if another task claimed them.
 * A solo task may edit union-merge files and regeneration output; a shared branch may not. */
function unlandedOutOfClaim(task: Task, sharers: readonly Task[]): string[] {
  // Inherited wave work belongs to the wave merge, not to this task's claim.
  const base = existsSync(task.worktree) ? worktreeBase(task.worktree) : 'main';
  const committed = git(root, ['diff', '--name-only', `${base}...${task.branch}`], true).split('\n').filter(Boolean);
  if (!committed.length) return [];
  const sharedTree = sharers.some(sharer => sharer.worktreeName) || sharers.length > 1;
  const union = sharedTree ? new Set<string>() : unionMerged(committed);
  const watched = committed.filter(file => !union.has(file));
  return outOfClaimFiles(watched, [...sharers], regeneratedOnBranch(task.branch, base));
}

export interface UnlandedChanges { worktree: string; branch: string; files: string[] }

/** Read each unlanded branch once, outside a queue pass's ledger lock. */
export function unlandedChanges(tasks: readonly Task[], excludeId?: string): UnlandedChanges[] {
  const changes: UnlandedChanges[] = [];
  const seen = new Set<string>();
  for (const task of tasks) {
    if (!UNLANDED.includes(task.state) || !task.branch) continue;
    const key = `${task.worktree}\0${task.branch}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const sharers = tasks.filter(other => other.worktree === task.worktree && other.branch === task.branch
      && HOLDING.includes(other.state));
    if (sharers.some(sharer => sharer.id === excludeId)) continue;
    changes.push({ worktree: task.worktree, branch: task.branch, files: unlandedOutOfClaim(task, sharers) });
  }
  return changes;
}

/** Out-of-claim commits of a task that has not landed or closed, matched the way a path claim is. */
export function unlandedChangeConflicts(brief: Brief, tasks: readonly Task[], snapshot?: readonly UnlandedChanges[]): string[] {
  if (!brief.paths.some(path => !isGeneratedOutput(path))) return [];
  const conflicts: string[] = [];
  for (const change of snapshot ?? unlandedChanges(tasks, brief.id)) {
    const sharers = tasks.filter(task => task.worktree === change.worktree && task.branch === change.branch
      && HOLDING.includes(task.state));
    if (sharers.some(sharer => sharer.id === brief.id)) continue;
    const names = sharers.filter(sharer => UNLANDED.includes(sharer.state)).map(sharer => sharer.id).sort().join(', ');
    if (!names) continue;
    for (const path of brief.paths) {
      if (isGeneratedOutput(path)) continue;
      const held = change.files.some(file => new Bun.Glob(path).match(file) || pathsOverlap(path, file));
      if (held) conflicts.push(`path ${path} changed by ${names} (unlanded)`);
    }
  }
  return conflicts;
}

/** Unlanded tasks that committed this exact path outside their claim. */
export function unlandedChangers(tasks: readonly Task[], path: string): Task[] {
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

export function claimingTasks(ledger: Ledger, files: readonly string[], excludedIds: ReadonlySet<string>): { file: string; id: string }[] {
  return files.flatMap(file => Object.values(ledger.tasks)
    .filter(task => !excludedIds.has(task.id) && HOLDING.includes(task.state)
      && task.paths.some(pattern => new Bun.Glob(pattern).match(file) || pathsOverlap(pattern, file)))
    .map(task => ({ file, id: task.id })));
}

export async function landScope(id: string): Promise<LandScope> {
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
    const scope = landClaimScope(committed, sharers.flatMap(sharer => sharer.paths), others, regenerated);
    const lent = new Set(task.loans ?? []);
    return { ...scope, claimedByOthers: scope.claimedByOthers.filter(file => !lent.has(file)) };
  });
}

export function landScopeRefusal(ledger: Ledger, task: Task, sharers: Task[], committed: string[], permittedFiles: readonly string[],
  regenerated: readonly string[] = []): string | undefined {
  const violations = outOfClaimFiles(committed, sharers, regenerated);
  const permitted = new Set(permittedFiles);
  const noLongerUnclaimed = permittedFiles.filter(file => !violations.includes(file));
  const unreviewed = violations.filter(file => !permitted.has(file));
  const lent = new Set(task.loans ?? []);
  const claimed = claimingTasks(ledger, violations, new Set([task.id])).filter(item => !lent.has(item.file));
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

/** Flatten authored Markdown links to the selected briefs; examples and non-link mentions keep their source text. */
function withoutBriefLinks(repo: string, source: string, text: string, briefs: ReadonlySet<string>): string {
  const pointsAtBrief = (destination: string): boolean => {
    if (/^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i.test(destination)) return false;
    try {
      const path = decodeURIComponent(destination.split(/[?#]/, 1)[0]!.replace(/\\([()])/g, '$1'));
      return briefs.has(path.startsWith('/') ? resolve(repo, path.slice(1)) : resolve(repo, dirname(source), path));
    } catch { return false; } // A malformed escape cannot name a repository path.
  };
  // Fences are block syntax; keep whole prose runs so a link or code span can cross a line.
  const runs: { prose: boolean; text: string }[] = [];
  let fence: string | undefined;
  let indented = false;
  let previousBlank = true;
  for (const line of text.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
    const blank = /^\s*$/.test(line);
    const indentation = /^(?: {4}|\t)/.test(line);
    if (!fence) indented = indented ? indentation || blank : previousBlank && indentation;
    const marker = !indented ? /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1] : undefined;
    const prose = !fence && !marker && !indented;
    if (marker && !fence) fence = marker;
    else if (marker && fence && marker[0] === fence[0] && marker.length >= fence.length) fence = undefined;
    const last = runs.at(-1);
    if (last?.prose === prose) last.text += line;
    else runs.push({ prose, text: line });
    previousBlank = blank;
  }
  const references = new Set<string>();
  const referenceKey = (label: string) => label.trim().replace(/\s+/g, ' ').toLowerCase();
  const definition = /^ {0,3}\[([^\]\n]+)\]:[ \t]*(?:<([^>]+)>|(\S+))(?:[ \t]+(?:"[^"]*"|'[^']*'|\([^)]*\)))?[ \t]*\r?(?:\n|$)/gm;
  const code = /(?<!`)(`+)(?!`)[\s\S]*?(?<!`)\1(?!`)/g;
  const proseParts = (body: string, transform: (part: string) => string): string => {
    let end = 0;
    let result = '';
    for (const match of body.matchAll(code)) {
      result += transform(body.slice(end, match.index)) + match[0];
      end = match.index + match[0].length;
    }
    return result + transform(body.slice(end));
  };
  for (const run of runs.filter(run => run.prose)) proseParts(run.text, part => {
    for (const match of part.matchAll(definition)) {
      if (pointsAtBrief(match[2] ?? match[3]!)) references.add(referenceKey(match[1]!));
    }
    return part;
  });
  // Include nested label brackets, escaped punctuation, angle destinations and optional titles.
  const inline = /(?<![\\!])\[((?:\\.|[^\[\]\\]|\[[^\[\]]*\])*)\]\(\s*(?:<([^>]+)>|((?:\\.|[^\s()\\]|\([^()]*\))+))(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*\)/g;
  const reference = /(?<![\\!])\[((?:\\.|[^\[\]\\]|\[[^\[\]]*\])*)\](?:\[([^\]]*)\])?(?![\[(])/g;
  return runs.map(run => !run.prose ? run.text : proseParts(run.text, part => part
    .replace(definition, (whole: string, label: string) => references.has(referenceKey(label)) ? '' : whole)
    .replace(inline, (whole: string, label: string, angle: string | undefined, path: string | undefined) =>
      pointsAtBrief(angle ?? path!) ? label : whole)
    .replace(reference, (whole: string, label: string, id: string | undefined) =>
      references.has(referenceKey(id || label)) ? label : whole))).join('');
}

/** Moves the briefs and handoffs of closed tasks to archive/goals and removes the briefs from the tree in one commit.
 * Briefs that tracked files still cite are kept and reported: the citing file must point at an owner first.
 * Idempotent, so `tidy` repairs a close that stopped part-way. */
export function archiveClosedBriefs(ledger: Ledger, tasks: readonly Task[], legacyDir?: string): string[] {
  const notes: string[] = [];
  const files: { path: string; content: string }[] = [];
  const removed: string[] = [];
  const goals = new Set<string>();
  for (const task of tasks.filter(task => ['verified', 'cancelled'].includes(task.state))) {
    const dir = task.goal ? archiveDirOf(ledger, task.goal) : legacyDir;
    if (!dir) continue;
    const outputs = join(stateDir, 'runs', task.id, 'outputs');
    files.push(...outputNames(outputs).map(name => ({ path: `${dir}/outputs/${task.id}/${name}`,
      content: readFileSync(join(outputs, name), 'utf8') })),
    { path: `${dir}/handoffs/${task.id}.md`, content: handoffText(task, `../outputs/${task.id}`) });
  }
  const candidates = tasks.flatMap(task => {
    const path = ['verified', 'cancelled'].includes(task.state) ? briefPathOf(task) : undefined;
    return path?.startsWith(`${join(root, GOALS_DIR)}/`) ? [{ task, path, relativePath: relative(root, path) }] : [];
  });
  // One search for every candidate: the cost follows the tree once, not once per brief.
  const citations = treeMentions(root, candidates.map(item => item.relativePath), { exclude: [`${GOALS_DIR}/**`, 'scripts/goal/**'] });
  const documents = candidates.length ? git(root, ['ls-files', '-z', '--', '*.md']).split('\0').filter(Boolean)
    .filter(path => !path.startsWith('scripts/goal/') && existsSync(join(root, path)))
    .map(path => ({ path, text: readFileSync(join(root, path), 'utf8') })) : [];
  // Relative Markdown destinations outside the Goal tree can cite the same brief without spelling its root path.
  for (const document of documents.filter(document => !document.path.startsWith(`${GOALS_DIR}/`))) {
    for (const candidate of candidates) {
      if (withoutBriefLinks(root, document.path, document.text, new Set([candidate.path])) !== document.text) {
        citations.push(`${document.path}: links to ${candidate.relativePath}`);
      }
    }
  }
  for (const { task, path, relativePath } of candidates) {
    const dir = task.goal ? archiveDirOf(ledger, task.goal) : legacyDir;
    if (!dir) { notes.push(`${task.id}: no Goal; pass tidy --legacy <archive directory>`); continue; }
    const cited = citations.filter(line => line.includes(relativePath));
    if (cited.length) { notes.push(`${task.id}: kept; cited by\n    ${cited.join('\n    ')}`); continue; }
    files.push({ path: `${dir}/tasks/${task.id}.md`, content: readFileSync(path, 'utf8') });
    removed.push(relativePath);
    if (task.goal) goals.add(task.goal);
  }
  if (!removed.length) {
    if (files.length) archiveFiles(root, files, 'Archive closed task handoffs and outputs');
    return notes;
  }
  if (git(root, ['symbolic-ref', '--short', 'HEAD']) !== 'main') throw new Error('Main checkout is not on main');
  const subject = removed.length === 1 ? `Archive the closed brief ${basename(removed[0]!, '.md')}`
    : `Archive ${removed.length} closed briefs`;
  const trailer = goals.size ? `\n\n${[...goals].map(goal => `Goal: ${goal}`).join('\n')}` : '';
  archiveFiles(root, files, `${subject}${trailer}`);
  const removedTargets = new Set(removed.map(path => join(root, path)));
  const edited: string[] = [];
  for (const document of documents.filter(document => document.path.startsWith(`${GOALS_DIR}/`))) {
    if (removedTargets.has(join(root, document.path))) continue;
    const rewritten = withoutBriefLinks(root, document.path, document.text, removedTargets);
    if (rewritten === document.text) continue;
    writeFileSync(join(root, document.path), rewritten);
    edited.push(document.path);
  }
  removeFromTree(root, removed, `${subject}\n\nThey are on ${ARCHIVE_BRANCH}.${trailer}`, edited);
  notes.push(`${subject} (on ${ARCHIVE_BRANCH}, removed from the tree)`);
  return notes;
}

export function pidAlive(pid: number, program?: string): boolean {
  if (!processAlive({ pid })) return false;
  if (!program) return true;
  try { return readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes(program); } catch { return false; }
}

/** A directory lock is still taken when its owner is alive, or it is new enough that the owner may not have written that record yet. */
export function dirLockHeld(path: string, alive: (pid: number) => boolean): boolean {
  return directoryLeaseHeld(path, { alive });
}

export async function acquireDir(path: string, timeoutMs: number, label: string): Promise<AcquiredDirectoryLease> {
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

export async function withLedger<T>(change: (ledger: Ledger) => T | Promise<T>): Promise<T> {
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
