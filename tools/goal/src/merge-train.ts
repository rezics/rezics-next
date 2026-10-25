import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import defaults from '../defaults.json';
import { StaleAttemptError } from './contracts.ts';
import type { AttemptFence, GateOutcome, GateOutcomeSink, GateStage } from './contracts.ts';
import { SqliteLandingQueue, type LandingEntry } from './land.ts';
import { acquireDirectoryLease, LeaseHeldError } from './lease.ts';
import { changedFiles, firstFailure, gateRunner, git, outsideScope, type GateRunner } from './merge.ts';

type DerivedFile = { path: string; command: string[] };
const derivedFiles = defaults.derivedFiles as DerivedFile[];

function unmergedFiles(cwd: string): string[] {
  return git(cwd, 'diff', '--name-only', '--diff-filter=U', '-z').split('\0').filter(Boolean);
}

export function rebaseOnto(cwd: string, base: string, originalBase: string, logPath: string): void {
  try {
    git(cwd, '-c', 'rebase.updateRefs=false', 'rebase', '--onto', base, originalBase);
    return;
  } catch (initialError) {
    let rebaseError: unknown = initialError;
    const derivedByPath = new Map(derivedFiles.map(file => [file.path, file]));
    for (;;) {
      const conflicts = unmergedFiles(cwd);
      if (!conflicts.length) throw rebaseError;
      const derivedConflicts = conflicts.filter(path => derivedByPath.has(path));
      if (!derivedConflicts.length) throw rebaseError;

      for (const path of derivedConflicts) git(cwd, 'checkout', '--ours', '--', path);
      for (const path of derivedConflicts) {
        const file = derivedByPath.get(path)!;
        if (!file.command.length) throw new Error(`No regeneration command configured for ${path}`);
        const commandCwd = dirname(join(cwd, file.path));
        const result = spawnSync(file.command[0]!, file.command.slice(1), { cwd: commandCwd, encoding: 'utf8' });
        const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
        appendFileSync(logPath, `$ ${file.command.join(' ')} (cwd: ${commandCwd})\n${output}`);
        if (result.status !== 0) throw new Error(`Failed to regenerate ${path}: ${output || result.error?.message || 'command failed'}`);
      }
      git(cwd, 'add', '--', ...derivedConflicts);
      if (derivedConflicts.length !== conflicts.length) throw rebaseError;
      try {
        git(cwd, '-c', 'core.editor=true', 'rebase', '--continue');
        return;
      } catch (continueError) {
        const nextConflicts = unmergedFiles(cwd);
        if (!nextConflicts.length || nextConflicts.some(path => !derivedByPath.has(path))) throw continueError;
        rebaseError = continueError;
      }
    }
  }
}

export type TrainOptions = {
  mainCheckout: string; stateDirectory: string; worktreeRoot: string;
  queue: SqliteLandingQueue; fence: AttemptFence; sink: GateOutcomeSink;
  runGate?: GateRunner; gateIdentity?: string; mainBranch?: string;
  codeIsCurrent?: () => boolean; handOff?: () => void | Promise<void>;
  /** Test seams around the final synchronous Git operation and train shutdown. */
  merge?: (cwd: string, candidate: string) => void; beforeRelease?: () => Promise<void>;
};

export class MergeTrain {
  constructor(private readonly options: TrainOptions) {}

  async run(): Promise<void> { await this.drain(true); }

  /** Background pumps are best-effort: a current lease owner will see any request queued during shutdown. */
  async pump(): Promise<void> { await this.drain(false); }

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
      try { lease = acquireDirectoryLease(leasePath); }
      catch (error) {
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
            const outcome = entry.outcome ?? await this.integrate(entry);
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
      } finally { lease.release(); }

      if (o.codeIsCurrent && !o.codeIsCurrent()) {
        await o.handOff?.();
        return;
      }
      // The empty check is outside the lease: enqueueing while we drained can wake no owner, so retry if needed.
      if (!o.queue.next()) return;
    }
  }

  private async integrate(entry: LandingEntry): Promise<GateOutcome> {
    const o = this.options;
    const request = entry.request;
    const mainBranch = o.mainBranch ?? 'main';
    const started = Date.now();
    const logPath = join(o.stateDirectory, `landing-${entry.id}.log`);
    writeFileSync(logPath, '');
    const result: GateOutcome = { taskId: request.taskId, attempt: request.attempt, passed: false,
      stage: 'setup', logPath, hostMs: 0, changedFiles: [], diffLines: 0 };
    let stage: GateStage = 'setup';
    const trainTree = resolve(o.worktreeRoot, `train-${randomUUID()}`);
    let added = false;
    const runGate = o.runGate ?? gateRunner();
    try {
      o.fence.assertCurrent(request);
      if (git(o.mainCheckout, 'symbolic-ref', 'HEAD') !== `refs/heads/${mainBranch}`)
        throw new Error('The main checkout must already have main checked out');
      const main = () => git(o.mainCheckout, 'rev-parse', `refs/heads/${mainBranch}`);
      // Recover an advance that committed before its outcome was saved.
      let alreadyMerged = false;
      if (entry.candidate) {
        try { git(o.mainCheckout, 'merge-base', '--is-ancestor', entry.candidate, mainBranch); alreadyMerged = true; } catch {}
      }
      if (alreadyMerged && entry.candidate) {
        result.passed = true; result.stage = 'merge'; result.mergedCommit = entry.candidate;
        return result;
      }
      const tip = git(o.mainCheckout, 'rev-parse', '--verify', `${request.branch}^{commit}`);
      const originalBase = git(o.mainCheckout, 'merge-base', tip, main());
      mkdirSync(resolve(o.worktreeRoot), { recursive: true });
      git(o.mainCheckout, 'worktree', 'add', '--detach', trainTree, tip);
      added = true;
      for (;;) {
        o.fence.assertCurrent(request);
        delete result.firstFailure; delete result.failsOnMain; delete result.timedOut;
        const base = main();
        stage = 'rebase';
        git(trainTree, 'reset', '--hard', tip);
        git(trainTree, 'clean', '-fdx');
        rebaseOnto(trainTree, base, originalBase, logPath);
        stage = 'scope';
        result.changedFiles = changedFiles(trainTree, base);
        result.diffLines = git(trainTree, 'diff', '--numstat', base, 'HEAD').split('\n').reduce((sum, line) => {
          const [a, b] = line.split('\t'); return sum + (Number(a) || 0) + (Number(b) || 0);
        }, 0);
        const outside = outsideScope(result.changedFiles, request.declaredPaths);
        if (outside.length) throw new Error(`Changes outside declared paths: ${outside.join(', ')}`);
        stage = 'gate';
        const candidate = git(trainTree, 'rev-parse', 'HEAD');
        appendFileSync(logPath, `\nGate on ${candidate}, main ${base}\n`);
        const gated = await runGate(request.gate, trainTree, logPath);
        // A gate on an old main is never authoritative, including a red gate.
        o.fence.assertCurrent(request);
        if (main() !== base) continue;
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
          if (main() !== base) continue;
          result.failsOnMain = !baseline.passed && firstFailure(baseline.output).fingerprint === result.firstFailure.fingerprint;
          result.stage = stage;
          return result;
        }
        // Gates may write files but may not replace the commit that was validated.
        if (git(trainTree, 'rev-parse', 'HEAD') !== candidate) throw new Error('Gate changed the candidate commit');
        git(trainTree, 'diff', '--quiet', 'HEAD', '--');
        stage = 'merge';
        o.queue.candidate(entry.id, candidate);
        if (main() !== base) continue;
        if (git(o.mainCheckout, 'symbolic-ref', 'HEAD') !== `refs/heads/${mainBranch}`)
          throw new Error('Main checkout HEAD changed while the gate ran');
        const advanced = o.fence.commitMerge(request, () => {
          // Retry uses the same BEGIN IMMEDIATE lock through this check, Git and merged-state publication.
          if (main() !== base) return '';
          if (git(o.mainCheckout, 'symbolic-ref', 'HEAD') !== `refs/heads/${mainBranch}`) throw new Error('Main checkout HEAD changed');
          if (o.merge) o.merge(o.mainCheckout, candidate);
          else git(o.mainCheckout, 'merge', '--ff-only', '--no-edit', candidate);
          return candidate;
        });
        if (!advanced) continue;
        result.passed = true; result.stage = 'merge'; result.mergedCommit = candidate;
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
        try { git(trainTree, 'rebase', '--abort'); } catch {}
        git(o.mainCheckout, 'worktree', 'remove', '--force', trainTree);
      }
    }
  }
}
