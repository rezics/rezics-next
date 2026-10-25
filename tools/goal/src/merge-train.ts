import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Database } from 'bun:sqlite';
import defaults from '../defaults.json';
import { matchesPath } from './briefs.ts';
import { StaleAttemptError } from './contracts.ts';
import type { AttemptFence, AttemptRef, GateOutcome, GateOutcomeSink, GateStage } from './contracts.ts';
import { SqliteLandingQueue, type LandingEntry } from './land.ts';
import { acquireDirectoryLease, LeaseHeldError } from './lease.ts';
import {
  changedFiles,
  diffLineCount,
  firstFailure,
  gateRunner,
  git,
  nonGeneratedFiles,
  outsideScope,
  type GateResult,
  type GateRunner,
} from './merge.ts';

export type DerivedFile = { path: string; stage: 'integration' | 'promotion'; command: string[] };
export type IntegrationCheck = { paths: string[]; command: string[] };
const defaultDerivedFiles = defaults.derivedFiles as DerivedFile[];

async function runIntegrationChecks(
  commands: readonly (readonly string[])[],
  cwd: string,
  logPath: string,
): Promise<GateResult> {
  const execute = gateRunner(180_000);
  let output = '';
  for (const command of commands) {
    appendFileSync(logPath, `$ ${command.join(' ')} (cwd: ${cwd})\n`);
    const result = await execute(command, cwd, logPath);
    output += result.output;
    if (!result.passed) return { ...result, output: result.output };
  }
  return { passed: true, output, timedOut: false };
}

// While dev already fails a check, a branch is still refused for error lines that dev does not have. Source
// positions and durations are dropped so that a moved line or a slower run compares equal; repeats count.
export function newErrorLines(output: string, baseline: string): string[] {
  const errors = (text: string) =>
    text
      .replace(/\x1b\[[0-9;]*m/g, '')
      .split(/\r?\n/)
      .filter((line) => /\berror\b/i.test(line))
      .map((line) =>
        line
          .replace(/\(\d+,\s*\d+\)|:\d+:\d+\b/g, '')
          .replace(/\b\d+(?:\.\d+)?\s*m?s\b/g, '')
          .trim(),
      );
  const remaining = new Map<string, number>();
  for (const line of errors(baseline)) remaining.set(line, (remaining.get(line) ?? 0) + 1);
  const added: string[] = [];
  for (const line of errors(output)) {
    const count = remaining.get(line) ?? 0;
    if (count) remaining.set(line, count - 1);
    else added.push(line);
  }
  return added;
}

function derivedForPath(path: string, files: readonly DerivedFile[]): DerivedFile[] {
  return files.filter((file) => matchesPath(path, [file.path]));
}

function changedWorkingFiles(cwd: string): string[] {
  const tracked = spawnSync('git', ['diff', '--name-only', '-z', 'HEAD', '--'], { cwd, encoding: 'utf8' });
  const untracked = spawnSync('git', ['ls-files', '--others', '--exclude-standard', '-z'], { cwd, encoding: 'utf8' });
  if (tracked.status !== 0 || untracked.status !== 0) throw new Error('Cannot read generated file changes');
  return [...new Set([...tracked.stdout.split('\0'), ...untracked.stdout.split('\0')].filter(Boolean))];
}

/** A path gone from both the index and the worktree is an already staged deletion, and naming it fails `git add`. */
export function stagePaths(cwd: string, paths: Iterable<string>): void {
  const all = [...paths];
  if (!all.length) return;
  const indexed = new Set(git(cwd, 'ls-files', '-z', '--', ...all).split('\0'));
  const present = all.filter((path) => indexed.has(path) || existsSync(join(cwd, path)));
  if (present.length) git(cwd, 'add', '-A', '--', ...present);
}

function unmergedFiles(cwd: string): string[] {
  return git(cwd, 'diff', '--name-only', '--diff-filter=U', '-z').split('\0').filter(Boolean);
}

type FrozenTaskRecord = { frozenFiles?: { path: string; hash: string }[] };
function frozenFilesForTask(stateDirectory: string, taskId: string): { path: string; hash: string }[] {
  const path = join(stateDirectory, 'goal.sqlite');
  if (!existsSync(path)) return [];
  const db = new Database(path, { readonly: true, strict: true });
  try {
    const row = db.query('SELECT body FROM worker_tasks WHERE id=?').get(taskId) as { body: string } | null;
    return row ? ((JSON.parse(row.body) as FrozenTaskRecord).frozenFiles ?? []) : [];
  } finally {
    db.close();
  }
}

function changedFrozenFiles(cwd: string, frozen: readonly { path: string; hash: string }[]): string[] {
  return frozen
    .filter((file) => {
      try {
        return (
          createHash('sha256')
            .update(readFileSync(join(cwd, file.path)))
            .digest('hex') !== file.hash
        );
      } catch {
        return true;
      }
    })
    .map((file) => file.path);
}

function rebaseWithDerivedFiles(
  cwd: string,
  base: string,
  originalBase: string,
  logPath: string,
  files: readonly DerivedFile[],
): unknown | undefined {
  try {
    git(cwd, '-c', 'rebase.updateRefs=false', 'rebase', '--onto', base, originalBase);
    return undefined;
  } catch (initialError) {
    let rebaseError: unknown = initialError;
    for (;;) {
      const conflicts = unmergedFiles(cwd);
      if (!conflicts.length) throw rebaseError;
      const derivedConflicts = conflicts.filter((path) => derivedForPath(path, files).length > 0);
      if (!derivedConflicts.length) return rebaseError;

      for (const path of derivedConflicts) git(cwd, 'checkout', '--ours', '--', path);
      const integrationCommands = new Map<string, string[]>();
      for (const path of derivedConflicts)
        for (const file of derivedForPath(path, files)) {
          if (file.stage === 'integration') integrationCommands.set(JSON.stringify(file.command), file.command);
        }
      for (const command of integrationCommands.values()) {
        const result = spawnSync(command[0]!, command.slice(1), { cwd, encoding: 'utf8' });
        const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
        appendFileSync(logPath, `$ ${command.join(' ')} (cwd: ${cwd})\n${output}`);
        if (result.status !== 0)
          throw new Error(`Failed to regenerate derived files: ${output || result.error?.message || 'command failed'}`);
      }
      const stageFiles = new Set(derivedConflicts);
      for (const path of changedWorkingFiles(cwd)) if (derivedForPath(path, files).length) stageFiles.add(path);
      stagePaths(cwd, stageFiles);
      if (derivedConflicts.length !== conflicts.length) return rebaseError;
      try {
        git(cwd, '-c', 'core.editor=true', 'rebase', '--continue');
        return undefined;
      } catch (continueError) {
        const nextConflicts = unmergedFiles(cwd);
        if (!nextConflicts.length) throw continueError;
        if (nextConflicts.some((path) => !derivedForPath(path, files).length)) return continueError;
        rebaseError = continueError;
      }
    }
  }
}

export function rebaseOnto(
  cwd: string,
  base: string,
  originalBase: string,
  logPath: string,
  files: readonly DerivedFile[] = defaultDerivedFiles,
): void {
  const originalSubjects = git(cwd, 'log', '--format=%s', '--reverse', `${originalBase}..HEAD`)
    .split('\n')
    .filter(Boolean);
  const initialConflict = rebaseWithDerivedFiles(cwd, base, originalBase, logPath, files);
  if (initialConflict === undefined) return;

  git(cwd, 'rebase', '--abort');
  git(cwd, 'reset', '--soft', originalBase);
  const message = [
    'Squash worker branch changes',
    '',
    'Original commits:',
    ...originalSubjects.map((subject) => `- ${subject}`),
  ].join('\n');
  git(cwd, 'commit', '--allow-empty', '-m', message);

  const squashedConflict = rebaseWithDerivedFiles(cwd, base, originalBase, logPath, files);
  if (squashedConflict !== undefined) throw squashedConflict;
}

export type TrainOptions = {
  mainCheckout: string;
  stateDirectory: string;
  worktreeRoot: string;
  formatCommand?: string[];
  integrationChecks?: IntegrationCheck[];
  queue: SqliteLandingQueue;
  fence: AttemptFence;
  sink: GateOutcomeSink;
  derivedFiles?: DerivedFile[];
  runGate?: GateRunner;
  gateIdentity?: string;
  mainBranch?: string;
  integrationBranch?: string;
  codeIsCurrent?: () => boolean;
  handOff?: () => void | Promise<void>;
  /** Runs after the landing lease is released, in the same process that drained the queue. */
  promote?: () => Promise<void>;
  /** Test seams around the final synchronous Git operation and train shutdown. */
  merge?: (cwd: string, candidate: string) => void;
  beforeRelease?: () => Promise<void>;
  beforeIntegrationAdvance?: () => void;
  beforePromotionAdvance?: () => void;
};

export class MergeTrain {
  constructor(private readonly options: TrainOptions) {}

  async run(): Promise<void> {
    await this.drain(true);
  }

  /** Background pumps are best-effort: a current lease owner will see any request queued during shutdown. */
  async pump(): Promise<void> {
    await this.drain(false);
  }

  private async drain(failWhenInitiallyHeld: boolean): Promise<void> {
    const o = this.options;
    if (o.codeIsCurrent && !o.codeIsCurrent()) {
      await o.handOff?.();
      return;
    }
    mkdirSync(o.stateDirectory, { recursive: true });
    const leasePath = join(o.stateDirectory, 'train.lease');
    let acquired = false;
    for (;;) {
      let lease: ReturnType<typeof acquireDirectoryLease>;
      try {
        lease = acquireDirectoryLease(leasePath);
      } catch (error) {
        if (error instanceof LeaseHeldError) {
          if (failWhenInitiallyHeld && !acquired) throw error;
          return;
        }
        throw error;
      }
      acquired = true;
      try {
        if (o.codeIsCurrent && !o.codeIsCurrent()) {
          await o.handOff?.();
          return;
        }
        for (;;) {
          if (o.codeIsCurrent && !o.codeIsCurrent()) {
            await o.handOff?.();
            return;
          }
          const entry = o.queue.next();
          if (!entry) break;
          try {
            const outcome = entry.outcome ?? (await this.integrate(entry));
            if (!entry.outcome) o.queue.finish(entry.id, outcome);
            // Sink delivery is at least once; obsolete entries must never block the current attempt.
            o.sink.onGateOutcome(outcome);
            o.queue.acknowledge(entry.id);
          } catch (error) {
            if (!(error instanceof StaleAttemptError)) throw error;
            o.queue.acknowledge(entry.id);
          }
        }
        await o.beforeRelease?.();
      } finally {
        lease.release();
      }

      if (o.codeIsCurrent && !o.codeIsCurrent()) {
        await o.handOff?.();
        return;
      }
      // The empty check is outside the lease: enqueueing while we drained can wake no owner, so retry if needed.
      if (o.queue.next()) continue;
      await o.promote?.();
      if (o.codeIsCurrent && !o.codeIsCurrent()) {
        await o.handOff?.();
        return;
      }
      if (!o.queue.next()) return;
    }
  }

  private async integrate(entry: LandingEntry): Promise<GateOutcome> {
    const o = this.options;
    const request = entry.request;
    const mainBranch = o.mainBranch ?? 'main';
    const targetBranch = o.integrationBranch ?? mainBranch;
    const integratesIntoDev = o.integrationBranch !== undefined;
    const targetRef = `refs/heads/${targetBranch}`;
    const started = Date.now();
    const logPath = join(o.stateDirectory, `landing-${entry.id}.log`);
    writeFileSync(logPath, '');
    const result: GateOutcome = {
      taskId: request.taskId,
      attempt: request.attempt,
      passed: false,
      stage: 'setup',
      logPath,
      hostMs: 0,
      changedFiles: [],
      diffLines: 0,
    };
    let stage: GateStage = 'setup';
    const trainTree = resolve(o.worktreeRoot, `train-${randomUUID()}`);
    let added = false;
    const runGate = o.runGate ?? gateRunner();
    try {
      o.fence.assertCurrent(request);
      if (git(o.mainCheckout, 'symbolic-ref', 'HEAD') !== `refs/heads/${mainBranch}`)
        throw new Error('The main checkout must already have main checked out');
      const target = () => git(o.mainCheckout, 'rev-parse', targetRef);
      // Recover an advance that committed before its outcome was saved.
      let alreadyIntegrated = false;
      if (entry.candidate) {
        try {
          git(o.mainCheckout, 'merge-base', '--is-ancestor', entry.candidate, targetBranch);
          alreadyIntegrated = true;
        } catch {}
      }
      if (alreadyIntegrated && entry.candidate) {
        result.passed = true;
        result.stage = 'merge';
        result.mergedCommit = entry.candidate;
        return result;
      }
      const tip = git(o.mainCheckout, 'rev-parse', '--verify', `${request.branch}^{commit}`);
      const originalBase = git(o.mainCheckout, 'merge-base', tip, target());
      mkdirSync(resolve(o.worktreeRoot), { recursive: true });
      git(o.mainCheckout, 'worktree', 'add', '--detach', trainTree, tip);
      added = true;
      for (;;) {
        o.fence.assertCurrent(request);
        delete result.firstFailure;
        delete result.failsOnMain;
        delete result.timedOut;
        const base = target();
        stage = 'rebase';
        git(trainTree, 'reset', '--hard', tip);
        git(trainTree, 'clean', '-fdx');
        const derivedFiles = o.derivedFiles ?? defaultDerivedFiles;
        // A worker that left its work uncommitted would otherwise integrate nothing and release its dependents.
        if (Number(git(trainTree, 'rev-list', '--count', `${originalBase}..HEAD`)) === 0)
          throw new Error('No committed changes beyond the base: commit the work before finishing');
        rebaseOnto(trainTree, base, originalBase, logPath, derivedFiles);
        const frozen = frozenFilesForTask(o.stateDirectory, request.taskId);
        const changedFrozen = changedFrozenFiles(trainTree, frozen);
        if (changedFrozen.length) {
          stage = 'rebase';
          result.stage = 'rebase';
          result.conflictedFiles = changedFrozen;
          result.firstFailure = firstFailure(`Frozen acceptance file changed: ${changedFrozen.join(', ')}`);
          appendFileSync(logPath, `Frozen acceptance files changed: ${changedFrozen.join(', ')}\n`);
          const mutable = o.fence as AttemptFence & {
            updateAttempt?: (ref: AttemptRef, update: (attempt: { escalation: string | null }) => void) => unknown;
          };
          mutable.updateAttempt?.(request, (attempt) => {
            attempt.escalation = 'rebase-conflict';
          });
          return result;
        }
        stage = 'scope';
        result.changedFiles = changedFiles(trainTree, base);
        result.diffLines = diffLineCount(trainTree, base);
        result.nonGeneratedChangedFiles = nonGeneratedFiles(trainTree, result.changedFiles);
        result.nonGeneratedDiffLines = diffLineCount(trainTree, base, result.nonGeneratedChangedFiles);
        const scopeCheckedFiles = result.changedFiles.filter((path) => !derivedForPath(path, derivedFiles).length);
        const outside = outsideScope(scopeCheckedFiles, request.declaredPaths);
        if (outside.length) throw new Error(`Changes outside declared paths: ${outside.join(', ')}`);
        if (integratesIntoDev) {
          const formatCommand = o.formatCommand ?? [resolve(o.mainCheckout, 'node_modules/.bin/oxfmt')];
          const formatFiles = result.changedFiles.filter((path) => existsSync(join(trainTree, path)));
          // Small isolated Git fixtures do not carry the repository's installed formatter.
          const formatterAvailable =
            !formatCommand[0]!.endsWith('/node_modules/.bin/oxfmt') || existsSync(formatCommand[0]!);
          if (formatFiles.length && formatterAvailable) {
            stage = 'setup';
            const formatted = spawnSync(formatCommand[0]!, [...formatCommand.slice(1), ...formatFiles], {
              cwd: trainTree,
              encoding: 'utf8',
            });
            const output = `${formatted.stdout ?? ''}${formatted.stderr ?? ''}`;
            appendFileSync(logPath, `$ ${[...formatCommand, ...formatFiles].join(' ')} (cwd: ${trainTree})\n${output}`);
            if (formatted.status !== 0)
              throw new Error(`Formatter failed: ${output || formatted.error?.message || 'command failed'}`);
            if (spawnSync('git', ['diff', '--quiet', 'HEAD', '--'], { cwd: trainTree }).status !== 0) {
              git(trainTree, 'add', '--', ...formatFiles);
              git(trainTree, 'commit', '-m', `style: format ${request.taskId}`);
            }
            stage = 'scope';
            result.changedFiles = changedFiles(trainTree, base);
            result.diffLines = diffLineCount(trainTree, base);
            result.nonGeneratedChangedFiles = nonGeneratedFiles(trainTree, result.changedFiles);
            result.nonGeneratedDiffLines = diffLineCount(trainTree, base, result.nonGeneratedChangedFiles);
            const formattedScopeCheckedFiles = result.changedFiles.filter(
              (path) => !derivedForPath(path, derivedFiles).length,
            );
            const formattedOutside = outsideScope(formattedScopeCheckedFiles, request.declaredPaths);
            if (formattedOutside.length)
              throw new Error(`Changes outside declared paths: ${formattedOutside.join(', ')}`);
          }
        }
        const candidate = git(trainTree, 'rev-parse', 'HEAD');
        const integrationChecks = (o.integrationChecks ?? []).filter((check) =>
          result.changedFiles.some((path) => matchesPath(path, check.paths)),
        );
        if (integratesIntoDev && integrationChecks.length) {
          stage = 'gate';
          appendFileSync(logPath, `\nIntegration check on ${candidate}, dev ${base}\n`);
          const commands = integrationChecks.map((check) => check.command);
          const checked = await runIntegrationChecks(commands, trainTree, logPath);
          o.fence.assertCurrent(request);
          if (target() !== base) continue;
          const key = `integration-check:${JSON.stringify(integrationChecks)}`;
          // An integrated candidate is dev's next head, so its result is that head's baseline.
          o.queue.saveBaseline(candidate, key, checked);
          if (!checked.passed) {
            result.timedOut = checked.timedOut;
            result.firstFailure = firstFailure(checked.output);
            let baseline = o.queue.baseline(base, key);
            if (!baseline) {
              git(trainTree, 'reset', '--hard', base);
              git(trainTree, 'clean', '-fdx');
              appendFileSync(logPath, `\nIntegration check baseline on dev ${base}\n`);
              baseline = await runIntegrationChecks(commands, trainTree, logPath);
              o.queue.saveBaseline(base, key, baseline);
            }
            o.fence.assertCurrent(request);
            if (target() !== base) continue;
            if (baseline.passed) {
              result.stage = stage;
              return result;
            }
            const added = newErrorLines(checked.output, baseline.output);
            if (added.length) {
              const report = `Errors that dev ${base} does not have:\n${added.join('\n')}`;
              appendFileSync(logPath, `${report}\n`);
              result.firstFailure = firstFailure(report);
              result.stage = stage;
              return result;
            }
            appendFileSync(logPath, 'dev already fails the integration check, with the same errors\n');
          }
        }
        if (!integratesIntoDev) {
          stage = 'gate';
          appendFileSync(logPath, `\nGate on ${candidate}, main ${base}\n`);
          const gated = await runGate(request.gate, trainTree, logPath);
          // A gate on an old main is never authoritative, including a red gate.
          o.fence.assertCurrent(request);
          if (target() !== base) continue;
          if (!gated.passed) {
            result.timedOut = gated.timedOut;
            result.firstFailure = firstFailure(gated.output);
            const key = JSON.stringify([o.gateIdentity ?? '', request.gate]);
            let baseline = o.queue.baseline(base, key);
            if (!baseline) {
              git(trainTree, 'reset', '--hard', base);
              git(trainTree, 'clean', '-fdx');
              baseline = await runGate(request.gate, trainTree, logPath);
              o.queue.saveBaseline(base, key, baseline);
            }
            o.fence.assertCurrent(request);
            if (target() !== base) continue;
            result.failsOnMain =
              !baseline.passed && firstFailure(baseline.output).fingerprint === result.firstFailure.fingerprint;
            result.stage = stage;
            return result;
          }
          // Gates may write files but may not replace the commit that was validated.
          if (git(trainTree, 'rev-parse', 'HEAD') !== candidate) throw new Error('Gate changed the candidate commit');
          git(trainTree, 'diff', '--quiet', 'HEAD', '--');
        }
        stage = 'merge';
        const integrationCommits = git(trainTree, 'rev-list', '--reverse', `${base}..${candidate}`)
          .split('\n')
          .filter(Boolean);
        const planner = o.fence as AttemptFence & {
          planIntegration?: (ref: AttemptRef, base: string, commit: string, commits: readonly string[]) => void;
        };
        planner.planIntegration?.(request, base, candidate, integrationCommits);
        o.queue.candidate(entry.id, candidate);
        if (target() !== base) continue;
        if (git(o.mainCheckout, 'symbolic-ref', 'HEAD') !== `refs/heads/${mainBranch}`)
          throw new Error('Main checkout HEAD changed while integrating');
        const advanced = o.fence.commitMerge(request, () => {
          // Retry uses the same BEGIN IMMEDIATE lock through this check, Git and task-state publication.
          if (target() !== base) return '';
          if (git(o.mainCheckout, 'symbolic-ref', 'HEAD') !== `refs/heads/${mainBranch}`)
            throw new Error('Main checkout HEAD changed');
          if (integratesIntoDev) {
            o.beforeIntegrationAdvance?.();
            try {
              git(o.mainCheckout, 'update-ref', targetRef, candidate, base);
            } catch (error) {
              if (target() !== base) return '';
              throw error;
            }
          } else if (o.merge) o.merge(o.mainCheckout, candidate);
          else git(o.mainCheckout, 'merge', '--ff-only', '--no-edit', candidate);
          return candidate;
        });
        if (!advanced) continue;
        result.passed = true;
        result.stage = 'merge';
        result.mergedCommit = candidate;
        return result;
      }
    } catch (error) {
      if (error instanceof StaleAttemptError) throw error;
      const message = String(error);
      appendFileSync(logPath, `${message}\n`);
      result.stage = stage;
      if (stage === 'rebase' && added) result.conflictedFiles = unmergedFiles(trainTree);
      result.firstFailure = firstFailure(message);
      return result;
    } finally {
      result.hostMs = Date.now() - started;
      if (added) {
        try {
          git(trainTree, 'rebase', '--abort');
        } catch {}
        git(o.mainCheckout, 'worktree', 'remove', '--force', trainTree);
      }
    }
  }
}
