import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gateRunner, git, type GateRunner } from './merge.ts';
import type { CompletionEvidence } from './managers.ts';
import { validateGoalCapabilities } from './capabilities.ts';

export type GoalCondition = { taskIds: readonly string[]; gate: readonly string[] };
export type CompletionOptions = {
  mainCheckout: string; stateDirectory: string; worktreeRoot: string; mainBranch?: string;
  condition(goal: string): GoalCondition;
  /** Worker-owned state is read only through this adapter. Missing tasks are unmet. */
  mergedTasks(goal: string): Promise<ReadonlySet<string>>;
  runGate?: GateRunner;
};

export function completionChecker(options: CompletionOptions): (goal: string) => Promise<CompletionEvidence> {
  return async goal => {
    const token = randomUUID();
    mkdirSync(options.stateDirectory, { recursive: true });
    const evidencePath = join(options.stateDirectory, `completion-${token}.log`);
    const tree = join(options.worktreeRoot, `completion-${token}`);
    let added = false;
    writeFileSync(evidencePath, '');
    const fail = (summary: string): CompletionEvidence => {
      writeFileSync(evidencePath, `${summary}\n`, { flag: 'a' });
      return { passed: false, summary, evidencePath };
    };
    try {
      const capabilityErrors = validateGoalCapabilities(options.mainCheckout, goal);
      if (capabilityErrors.length) return fail(`Capability manifest incomplete: ${capabilityErrors.join('; ')}`);
      const initial = options.condition(goal);
      const condition = { taskIds: [...initial.taskIds], gate: [...initial.gate] };
      const missing = async () => {
        const merged = await options.mergedTasks(goal);
        return condition.taskIds.filter(id => !merged.has(id));
      };
      const unmet = await missing();
      if (unmet.length) return fail(`Unmerged tasks: ${unmet.join(', ')}`);
      const base = git(options.mainCheckout, 'rev-parse', `refs/heads/${options.mainBranch ?? 'main'}`);
      mkdirSync(options.worktreeRoot, { recursive: true });
      git(options.mainCheckout, 'worktree', 'add', '--detach', tree, base); added = true;
      const gated = await (options.runGate ?? gateRunner())(condition.gate, tree, evidencePath);
      if (!gated.passed) return fail(`Main gate failed${gated.timedOut ? ' (timed out)' : ''}: ${gated.output.slice(0, 1000).replace(/[\r\n]+/g, ' ')}`);
      if (git(tree, 'rev-parse', 'HEAD') !== base) return fail('Main gate changed the commit being checked');
      const mainRef = `refs/heads/${options.mainBranch ?? 'main'}`;
      const currentMain = git(options.mainCheckout, 'rev-parse', mainRef);
      if (git(options.mainCheckout, 'merge-base', base, currentMain) !== base)
        return fail('The checked main commit is no longer an ancestor of main');
      const remaining = await missing();
      if (remaining.length) return fail(`Unmerged tasks: ${remaining.join(', ')}`);
      const latest = options.condition(goal);
      if (JSON.stringify([...latest.taskIds].sort()) !== JSON.stringify([...condition.taskIds].sort())
        || JSON.stringify(latest.gate) !== JSON.stringify(condition.gate)) return fail('Goal condition changed during the completion gate');
      const summary = `All scoped tasks are merged and the gate passes on main ${base}.`;
      writeFileSync(evidencePath, `${summary}\n`, { flag: 'a' });
      return { passed: true, summary, evidencePath };
    } catch (error) { return fail(`Completion check failed: ${error}`); }
    finally { if (added) git(options.mainCheckout, 'worktree', 'remove', '--force', tree); }
  };
}
