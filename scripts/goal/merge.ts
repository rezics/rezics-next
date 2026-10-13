import { type RecordedMerge, unitFilesFromPlan, mergeUnitFiles, ownerFilesFromPlan, mergeOwnerFiles, streamUnitBaseline, preMergeUnitGate, preMergeSurfaceGate } from './unit-gate.ts';
import { join } from 'node:path';
import { stateDir, git, REGENERATION_COMMIT_SUBJECT, assertOwner, root, regenerationOnlyFiles, scopeViolations, landScopeRefusal, withLedger, retryGitIndexLock } from './ledger.ts';
import { existsSync, readFileSync, appendFileSync, writeFileSync } from 'node:fs';
import { type MergeEvent } from './regress.ts';
import { type AffectedPlan, affectedPlanForChanges, typecheckWorkspaces } from '../qa/affected.ts';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { type Task, type Ledger, type Brief, HOLDING } from './types.ts';
import { taskOf, running, changedFiles, branchChanges } from './launch.ts';
import { landedBoundary, prepareCompositionMerge, compositionSyntaxFailure, type MigrationRename, normalizeMigrations } from './merge-normalise.ts';
import { historyIntroductions, parseBrief, parseFrontmatter } from './briefs.ts';
import { COMPOSITION_ROOTS } from './composition-roots.ts';
import { preMergeTypecheckGate, reinstallStaleDependencies, missingPinnedImage } from './typecheck-gate.ts';
import { withGateLane } from './qa-slots.ts';

export function readMergeEvents(): RecordedMerge[] {
  const eventPath = join(stateDir, 'merges.jsonl');
  if (!existsSync(eventPath)) return [];
  return readFileSync(eventPath, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as RecordedMerge);
}

function writeMergeEvent(event: MergeEvent, files: readonly string[]): void {
  appendFileSync(join(stateDir, 'merges.jsonl'), `${JSON.stringify({ ...event, files: [...new Set(files)].sort() })}\n`);
}

type AffectedSelection = { plan: AffectedPlan } | { text: string };

/** The worktree's planner when it can be imported, otherwise this checkout's. A missing module or a fixture plan stays text. */
export async function affectedSelection(worktree: string, base: string, changed: readonly string[]): Promise<AffectedSelection> {
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

export function selectedUnitFiles(worktree: string, selection: AffectedSelection): string[] {
  return 'plan' in selection ? unitFilesFromPlan(worktree, selection.plan) : mergeUnitFiles(worktree, selection.text);
}

export function selectedOwnerFiles(worktree: string, selection: AffectedSelection): string[] {
  return 'plan' in selection ? ownerFilesFromPlan(worktree, selection.plan) : mergeOwnerFiles(worktree, selection.text);
}

function generatorOutput(run: ReturnType<typeof spawnSync>): string {
  return `${run.stdout ?? ''}\n${run.stderr ?? ''}${run.error ? `\n${run.error.message}` : ''}`.trim();
}

function resetGeneratedWorktree(worktree: string): void {
  git(worktree, ['reset', '--hard', 'HEAD']);
  git(worktree, ['clean', '-fd', '-e', '.temp'], true);
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

export interface PreparedMerge {
  before: string; baseline: string; after: string; worktree: string; branch: string; sharers: string[]; committed: string[];
  /** Files checked against claims. The regeneration commit is not one of them. */
  scopeFiles?: string[];
  surface?: Brief;
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

/** How often one merge may recheck types because main changed a workspace it had checked. */
const MAX_TYPE_RECHECKS = 5;

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

export function clearRefusal(task: Task): void {
  delete task.refusal;
}

export async function mergeTask(id: string, flags: Set<string>, expectedHead?: string,
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
    const surfaceBriefs = sharers.flatMap(sharer => {
      const source = existsSync(sharer.brief) ? readFileSync(sharer.brief, 'utf8') : '';
      return parseFrontmatter(source)?.kind === 'surface' ? [parseBrief(source)] : [];
    });
    const surface = surfaceBriefs.length ? { ...surfaceBriefs[0]!,
      rows: [...new Set(surfaceBriefs.flatMap(brief => brief.rows ?? []))],
      tests: [...new Set(surfaceBriefs.flatMap(brief => brief.tests ?? []))] } : undefined;
    return { before, baseline, after, worktree: task.worktree, branch: task.branch,
      sharers: sharers.map(sharer => sharer.id).sort(), committed: committedNow, scopeFiles, surface };
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
  let typeRechecks = 0;
  const skipTypes = flags.has('--skip-type-gate');
  const skipUnits = flags.has('--skip-unit-gate');
  const laneCommand = `${landPermittedFiles !== undefined ? 'land' : gateOnly ? 'gate' : 'merge'} ${id}`;
  const typecheck = (merge: PreparedMerge, only?: readonly string[]) =>
    preMergeTypecheckGate(merge.worktree, root, merge.before, merge.committed, skipTypes, only);
  const unitGate = (merge: PreparedMerge) =>
    preMergeUnitGate(merge.worktree, root, merge.before, merge.sharers, skipUnits, gatedFiles);
  // Regeneration stays outside the lane. Type check and unit work share one lease, and each side's
  // budget starts inside that work, after the wait.
  const onLane = <T>(work: () => Promise<T>): Promise<T> => withGateLane(() => work(), { command: laneCommand });
  const gate = async (merge: PreparedMerge): Promise<string | undefined> => {
    const installed = reinstallStaleDependencies(merge.worktree);
    if (installed) return installed;
    const unbuilt = missingPinnedImage(merge.worktree, root);
    if (unbuilt) return unbuilt;
    if (merge.surface) return preMergeSurfaceGate(merge.worktree, merge.before, merge.surface, merge.committed, gatedFiles, {
      generate: async () => regenerateGeneratedOutputs(merge) ?? missingPinnedImage(merge.worktree, root),
      evidenceDirectory: join(stateDir, 'merges/surface-gate'),
    });
    const generated = regenerateGeneratedOutputs(merge);
    if (generated) return generated;
    // Again after the regeneration: the pin is derived from the generated model, so a shape change moves it
    // in that commit and not in the worker's. Checked only before it, a recipe shape change put a pin
    // without an image on main for fifty minutes on 2026-10-12.
    const unbuiltAfterRegeneration = missingPinnedImage(merge.worktree, root);
    if (unbuiltAfterRegeneration) return unbuiltAfterRegeneration;
    const run = () => typecheck(merge).then(refusal => refusal ?? unitGate(merge));
    return skipTypes && skipUnits ? run() : onLane(run);
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
      }, current, { gatedFiles, regated, retyped, typechecked: current.surface ? ['web'] : skipTypes ? [] : typecheckWorkspaces(current.committed) }, console.log, gateOnly);
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
    // A type check takes seconds. A busy workspace may be rechecked several times before the merge gives up;
    // a rerun of the unit gate is still allowed once.
    typeRechecks++;
    retyped = !outcome.workspaces || typeRechecks >= MAX_TYPE_RECHECKS;
    if (outcome.workspaces && !outcome.rerun.surface) {
      const workspaces = outcome.workspaces;
      const rerun = () => typecheck(outcome.rerun, workspaces);
      gateFailure = skipTypes ? await rerun() : await onLane(rerun);
    }
    else {
      regated = true;
      gateFailure = await gate(outcome.rerun);
    }
  }
}
