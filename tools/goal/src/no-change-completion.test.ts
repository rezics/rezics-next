import { expect, test } from 'bun:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { git } from './tasks.ts';
import { integrationHarness } from './test-support.ts';
import { frozenFile } from './frozen.ts';

async function unchangedClaim(h: ReturnType<typeof integrationHarness>, command: string[]) {
  h.ensureDev();
  const source = h.advanceDev('retained.txt');
  const task = h.dispatch('retained.txt', [], command);
  await h.start(task);
  return { source, task };
}

test('an unchanged claim runs its original acceptance on the retained source without an artificial commit', async () => {
  const h = integrationHarness();
  const command = ['sh', '-c', 'test "$(cat retained.txt)" = retained.txt && git rev-parse HEAD'];
  try {
    const { source, task } = await unchangedClaim(h, command);
    const dev = h.head();

    await h.train();

    const outcome = h.outcomes[0]!;
    expect(outcome.passed).toBe(true);
    expect(outcome.mergedCommit).toBe(source);
    expect(outcome.retainedSourceAcceptance).toEqual({ sourceCommit: source, command, status: 'passed' });
    expect(h.store.task(task.id).state).toBe('integrated');
    expect(h.head()).toBe(dev);
    expect(h.head(task.branch)).toBe(source);
    const saved = h.store.events(task.id, 1).find((event) => event.kind === 'gate-outcome')!;
    expect(JSON.parse(saved.body).retainedSourceAcceptance).toEqual(outcome.retainedSourceAcceptance);
    expect(readFileSync(outcome.logPath, 'utf8')).toContain(`source=${source}: ${command.join(' ')}`);
  } finally {
    h.dispose();
  }
});

test('a failed retained-source acceptance stays non-green and records its exact result', async () => {
  const h = integrationHarness();
  const command = ['sh', '-c', 'echo retained-acceptance-failed; exit 1'];
  try {
    const { source, task } = await unchangedClaim(h, command);
    const dev = h.head();

    await h.train();

    const outcome = h.outcomes[0]!;
    expect(outcome.passed).toBe(false);
    expect(outcome.retainedSourceAcceptance).toEqual({ sourceCommit: source, command, status: 'failed' });
    expect(h.store.task(task.id).state).not.toBe('integrated');
    expect(h.head()).toBe(dev);
    expect(readFileSync(outcome.logPath, 'utf8')).toContain('retained-acceptance-failed');
  } finally {
    h.dispose();
  }
});

test('dirty or changed source and contract refuse an unchanged claim before acceptance', async () => {
  for (const change of ['dirty', 'source', 'contract'] as const) {
    const h = integrationHarness();
    try {
      const { task } = await unchangedClaim(h, ['true']);
      if (change === 'dirty') writeFileSync(join(task.worktree, 'retained.txt'), 'dirty');
      if (change === 'source') {
        writeFileSync(join(task.worktree, 'retained.txt'), 'changed');
        git(task.worktree, ['add', 'retained.txt']);
        git(task.worktree, ['commit', '-m', 'Change retained source']);
      }
      if (change === 'contract') writeFileSync(task.briefPath, `${task.brief.markdown}\nchanged\n`);

      await h.train();

      expect(h.outcomes[0]?.passed).toBe(false);
      expect(readFileSync(h.outcomes[0]!.logPath, 'utf8')).not.toContain('Retained-source acceptance task=');
    } finally {
      h.dispose();
    }
  }
});

test('historical empty commits and frozen acceptance alone complete without advancing dev', async () => {
  for (const frozen of [false, true]) {
    const h = integrationHarness();
    try {
      h.ensureDev();
      const ancestor = h.advanceDev('retained.txt');
      const task = h.dispatch('retained.txt', [], ['sh', '-c', 'cat retained.txt; git rev-parse HEAD']);
      if (frozen) {
        writeFileSync(join(task.worktree, 'retained.txt'), 'frozen acceptance\n');
        git(task.worktree, ['add', 'retained.txt']);
        h.store.updateTask({ taskId: task.id, attempt: 0 }, (current) => {
          Object.assign(current, { frozenFiles: [frozenFile('retained.txt', 'frozen acceptance\n')] });
        });
        writeFileSync(
          join(task.worktree, '.temp/worker-plan.json'),
          JSON.stringify({ file: 'retained.txt', content: 'frozen acceptance\n' }),
        );
      }
      git(task.worktree, ['commit', '--allow-empty', '-m', 'Retained historical controller commit']);
      const source = h.head(task.branch);
      await h.start(task);
      await h.train();

      expect(h.outcomes[0]?.retainedSourceAcceptance).toEqual({
        sourceCommit: source,
        command: task.brief.acceptance.command,
        status: 'passed',
      });
      expect(h.outcomes[0]?.mergedCommit).toBe(ancestor);
      expect(h.store.task(task.id).state).toBe('integrated');
      expect(h.head()).toBe(ancestor);
      expect(h.head(task.branch)).toBe(source);
    } finally {
      h.dispose();
    }
  }
});

test('unavailable acceptance and invalidation during acceptance never complete an unchanged claim', async () => {
  for (const change of ['unavailable', 'dirty', 'source', 'contract', 'stale'] as const) {
    const h = integrationHarness();
    try {
      const { source, task } = await unchangedClaim(h, ['true']);
      await h.train(async () => {
        if (change === 'unavailable') throw new Error('Acceptance executable unavailable');
        if (change === 'dirty') writeFileSync(join(task.worktree, 'retained.txt'), 'dirty');
        if (change === 'source') git(task.worktree, ['commit', '--allow-empty', '-m', 'Moved source']);
        if (change === 'contract') writeFileSync(task.briefPath, `${task.brief.markdown}\nchanged\n`);
        if (change === 'stale')
          h.store.updateTask({ taskId: task.id, attempt: 1 }, (current) => {
            current.currentAttempt++;
          });
        return { passed: true, output: '', timedOut: false };
      });

      expect(h.outcomes.some((outcome) => outcome.passed)).toBe(false);
      expect(h.store.task(task.id).state).not.toBe('integrated');
      expect(h.head()).toBe(source);
      if (change === 'unavailable') {
        expect(h.outcomes[0]?.retainedSourceAcceptance?.status).toBe('unavailable');
        expect(h.outcomes[0]?.failedCommand).toEqual(['true']);
      }
    } finally {
      h.dispose();
    }
  }
});
