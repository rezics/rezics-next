import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gateRunner, git, type GateRunner } from './merge.ts';
import type { CompletionEvidence } from './managers.ts';
import { parseCapabilityManifest, validateGoalCapabilitiesText, validateScenarioReport } from './capabilities.ts';

export type GoalCondition = { taskIds: readonly string[]; gate: readonly string[] };
export type CompletionOptions = {
  mainCheckout: string;
  stateDirectory: string;
  worktreeRoot: string;
  mainBranch?: string;
  condition(goal: string): GoalCondition;
  /** Worker-owned state is read only through this adapter. Missing tasks are unmet. */
  mergedTasks(goal: string): Promise<ReadonlySet<string>>;
  runGate?: GateRunner;
};

export function completionChecker(options: CompletionOptions): (goal: string) => Promise<CompletionEvidence> {
  return async (goal) => {
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
      const initial = options.condition(goal);
      const condition = { taskIds: [...initial.taskIds], gate: [...initial.gate] };
      const missing = async () => {
        const merged = await options.mergedTasks(goal);
        return condition.taskIds.filter((id) => !merged.has(id));
      };
      const unmet = await missing();
      if (unmet.length) return fail(`Unmerged tasks: ${unmet.join(', ')}`);
      const base = git(options.mainCheckout, 'rev-parse', `refs/heads/${options.mainBranch ?? 'main'}`);
      let scope = '';
      try {
        scope = git(options.mainCheckout, 'show', `${base}:docs/scope.md`);
      } catch {
        // Isolated control-plane repositories may not contain product scope.
      }
      const manifestPath = `docs/goals/${goal}.capabilities.md`;
      let manifestText: string | null = null;
      try {
        manifestText = git(options.mainCheckout, 'show', `${base}:${manifestPath}`);
      } catch {
        // Goals without owned In rows do not need a capability manifest.
      }
      const manifestErrors = validateGoalCapabilitiesText(goal, scope, manifestText);
      if (manifestErrors.length) return fail(`Capability manifest incomplete: ${manifestErrors.join('; ')}`);
      mkdirSync(options.worktreeRoot, { recursive: true });
      git(options.mainCheckout, 'worktree', 'add', '--detach', tree, base);
      added = true;
      const gated = await (options.runGate ?? gateRunner())(condition.gate, tree, evidencePath);
      if (!gated.passed)
        return fail(
          `Main gate failed${gated.timedOut ? ' (timed out)' : ''}: ${gated.output.slice(0, 1000).replace(/[\r\n]+/g, ' ')}`,
        );
      if (manifestText !== null) {
        const manifest = parseCapabilityManifest(manifestText, goal);
        const commands = new Map<string, string[]>();
        for (const capability of manifest.capabilities) {
          const key = JSON.stringify(capability.command);
          commands.set(key, [...(commands.get(key) ?? []), ...capability.scenarios]);
        }
        mkdirSync(join(tree, '.temp'), { recursive: true });
        for (const [serialized, scenarios] of commands) {
          const command = JSON.parse(serialized) as string[];
          if (command[0] !== 'bun' || command[1] !== 'test')
            return fail(`Capability acceptance command must be a native bun test command: ${command.join(' ')}`);
          const registered = [...command, '--reporter=junit', '--reporter-outfile=.temp/goal-capability-results.xml'];
          const outcome = await (options.runGate ?? gateRunner())(registered, tree, evidencePath);
          if (!outcome.passed)
            return fail(`Capability acceptance failed: ${outcome.output.slice(0, 1000).replace(/[\r\n]+/g, ' ')}`);
          let report: string;
          try {
            report = readFileSync(join(tree, '.temp/goal-capability-results.xml'), 'utf8');
          } catch (error) {
            return fail(`Capability JUnit report unavailable: ${String(error)}`);
          }
          const scenarioErrors = validateScenarioReport(report, scenarios);
          if (scenarioErrors.length) return fail(`Capability acceptance incomplete: ${scenarioErrors.join('; ')}`);
        }
      }
      if (git(tree, 'rev-parse', 'HEAD') !== base) return fail('Main gate changed the commit being checked');
      const mainRef = `refs/heads/${options.mainBranch ?? 'main'}`;
      const currentMain = git(options.mainCheckout, 'rev-parse', mainRef);
      if (git(options.mainCheckout, 'merge-base', base, currentMain) !== base)
        return fail('The checked main commit is no longer an ancestor of main');
      const remaining = await missing();
      if (remaining.length) return fail(`Unmerged tasks: ${remaining.join(', ')}`);
      const latest = options.condition(goal);
      if (
        JSON.stringify([...latest.taskIds].sort()) !== JSON.stringify([...condition.taskIds].sort()) ||
        JSON.stringify(latest.gate) !== JSON.stringify(condition.gate)
      )
        return fail('Goal condition changed during the completion gate');
      const summary = `All scoped tasks are merged and the gate passes on main ${base}.`;
      writeFileSync(evidencePath, `${summary}\n`, { flag: 'a' });
      return { passed: true, summary, evidencePath };
    } catch (error) {
      return fail(`Completion check failed: ${error}`);
    } finally {
      if (added) git(options.mainCheckout, 'worktree', 'remove', '--force', tree);
    }
  };
}
