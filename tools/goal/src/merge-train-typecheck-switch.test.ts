import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { integrationHarness } from './test-support.ts';

const typecheckCommand = (command: readonly string[]) => command.some((part) => part.includes('scripts/typecheck.ts'));
const passed = { passed: true, output: '', timedOut: false };

test('the disabled prelanding typecheck skips first, retried, and batched dev landings', async () => {
  const h = integrationHarness();
  try {
    h.ensureDev();
    h.settings.integration.devPrelandingTypecheck = false;
    const first = h.dispatch('docs/first.md');
    await h.start(first);
    const firstCommands: string[][] = [];
    await h.train(async (command) => {
      firstCommands.push([...command]);
      return passed;
    });
    expect(firstCommands.some(typecheckCommand)).toBe(false);
    expect(readFileSync(h.outcomes.at(-1)!.logPath, 'utf8')).toContain('Prelanding typecheck skipped');

    Bun.spawnSync(['git', 'branch', 'stabilize', h.head('dev')], { cwd: h.root });
    h.settings.integrationChecks = [{ paths: ['docs/**'], command: ['bun', 'scripts/typecheck.ts'] }];
    h.settings.integration.devPrelandingTypecheck = true;
    const retried = h.dispatch('docs/retry.md', [], ['true'], 'fixture', 'stabilize');
    await h.start(retried);
    let typecheckRuns = 0;
    await h.train(async (command) => {
      if (!typecheckCommand(command)) return passed;
      typecheckRuns += 1;
      return typecheckRuns === 1
        ? { passed: false, output: 'root typecheck fixture failure', timedOut: false }
        : passed;
    });
    expect(h.outcomes.at(-1)).toMatchObject({ taskId: retried.id, passed: false });

    h.settings.integration.devPrelandingTypecheck = false;
    await h.start(retried);
    const retryCommands: string[][] = [];
    await h.train(async (command) => {
      retryCommands.push([...command]);
      return passed;
    });
    expect(retryCommands.some(typecheckCommand)).toBe(false);
    expect(h.outcomes.at(-1)).toMatchObject({ taskId: retried.id, passed: true });
    expect(readFileSync(h.outcomes.at(-1)!.logPath, 'utf8')).toContain('Prelanding typecheck skipped');

    h.settings.integration.batchSize = 2;
    const batch = [h.dispatch('docs/batch-a.md'), h.dispatch('docs/batch-b.md')];
    await h.start(batch[0]!);
    await h.start(batch[1]!);
    const previousOutcomes = h.outcomes.length;
    const batchCommands: string[][] = [];
    await h.train(async (command) => {
      batchCommands.push([...command]);
      return passed;
    });
    expect(batchCommands.some(typecheckCommand)).toBe(false);
    const batchOutcomes = h.outcomes.slice(previousOutcomes);
    expect(batchOutcomes.map(({ taskId, passed: ok }) => [taskId, ok])).toEqual([
      [batch[0]!.id, true],
      [batch[1]!.id, true],
    ]);
    for (const outcome of batchOutcomes)
      expect(readFileSync(outcome.logPath, 'utf8')).toContain('Prelanding typecheck skipped');
  } finally {
    h.dispose();
  }
}, 60_000);

test('a missing local SQL declaration with unchanged-file type cascades is infrastructure, not a task failure', async () => {
  const h = integrationHarness();
  try {
    h.ensureDev();
    const source = 'services/kernel/src/content/reaction-projection.ts';
    const cascade = 'services/kernel/src/content/other-projection.ts';
    h.advanceDev(source, 'export {};');
    h.advanceDev('services/kernel/src/content/reaction-projection-baseline.sql', 'SELECT 1;');
    h.settings.integration.devPrelandingTypecheck = true;
    const task = h.dispatch('docs/infra.md');
    await h.start(task);
    const before = h.head('dev');
    const output = [
      `${source}(11,26): error TS2307: Cannot find module './reaction-projection-baseline.sql' or its corresponding type declarations.`,
      `${source}(21,3): error TS18046: 'row' is of type 'unknown'.`,
      `${cascade}(6,7): error TS7006: Parameter 'value' implicitly has an 'any' type.`,
      `${cascade}(9,3): error TS18046: 'result' is of type 'unknown'.`,
    ].join('\n');
    const commands: string[][] = [];
    await h.train(async (command) => {
      commands.push([...command]);
      return typecheckCommand(command) ? { passed: false, output, timedOut: false } : passed;
    });
    expect(commands.filter(typecheckCommand)).toHaveLength(1);
    expect(h.head('dev')).not.toBe(before);
    expect(h.outcomes.at(-1)).toMatchObject({ taskId: task.id, passed: true });
    const log = readFileSync(h.outcomes.at(-1)!.logPath, 'utf8');
    expect(log).toContain('Root typecheck classified as infrastructure result');
    expect(log).not.toContain('Required root typecheck failed');
  } finally {
    h.dispose();
  }
}, 60_000);
