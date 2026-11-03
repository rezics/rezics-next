import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import type { Task } from './types.ts';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { git } from './tasks.ts';
import { integrationHarness } from './test-support.ts';

// A stabilize claim reruns its acceptance on the retained source; a direct dev landing does not.
async function unchangedClaim(
  h: ReturnType<typeof integrationHarness>,
  command: string[] | null,
  target?: 'stabilize',
) {
  h.ensureDev();
  const source = h.advanceDev('retained.txt');
  if (target) git(h.root, ['branch', target, source]);
  const task = h.dispatch('retained.txt', [], command, 'fixture', target);
  await h.start(task);
  return { source, task };
}

function reportAcceptance(
  h: ReturnType<typeof integrationHarness>,
  task: Task,
  command: string[],
  overrides: Record<string, unknown> = {},
) {
  h.store.updateAttempt({ taskId: task.id, attempt: 1 }, (attempt) => {
    attempt.result = JSON.stringify({
      status: 'success',
      checks: [],
      approaches: [
        {
          approach: 'unchanged-source-acceptance',
          result: JSON.stringify({
            command,
            sourceCommit: h.head(task.branch),
            contractHash: createHash('sha256').update(h.store.task(task.id).brief.markdown).digest('hex'),
            status: 'passed',
            ...overrides,
          }),
        },
      ],
    });
  });
}

test('an unchanged claim runs its original acceptance on the retained source without an artificial commit', async () => {
  const h = integrationHarness();
  const command = ['sh', '-c', 'test "$(cat retained.txt)" = retained.txt && git rev-parse HEAD'];
  try {
    const { source, task } = await unchangedClaim(h, command, 'stabilize');
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

test('an unchanged claim without an acceptance command or worker report stays non-green', async () => {
  const h = integrationHarness();
  try {
    const { source, task } = await unchangedClaim(h, null);
    const dev = h.head();

    await h.train();

    const outcome = h.outcomes[0]!;
    expect(outcome.passed).toBe(false);
    expect(outcome.retainedSourceAcceptance).toEqual({ sourceCommit: source, command: [], status: 'unavailable' });
    expect(outcome.firstFailure?.excerpt).toContain('Unmeasured clause:');
    expect(h.store.task(task.id).state).not.toBe('integrated');
    expect(h.head()).toBe(dev);
  } finally {
    h.dispose();
  }
});

test.each([false, true])(
  'an unchanged dev claim consumes passing worker acceptance without a train rerun (worker-owned: %s)',
  async (workerOwned) => {
    const h = integrationHarness();
    // Only a run prints 42-ran; the logged command line does not contain it.
    const command = ['sh', '-c', 'echo $((40 + 2))-ran; exit 1'];
    try {
      const { source, task } = await unchangedClaim(h, workerOwned ? null : command);
      reportAcceptance(h, task, command);
      let runs = 0;
      await h.train(async () => {
        runs++;
        return { passed: false, output: 'unexpected train rerun', timedOut: false };
      });
      expect(runs).toBe(0);

      const outcome = h.outcomes[0]!;
      expect(outcome.passed).toBe(true);
      expect(outcome.retainedSourceAcceptance).toEqual({ sourceCommit: source, command, status: 'passed' });
      expect(h.store.task(task.id).state).toBe('integrated');
      expect(readFileSync(outcome.logPath, 'utf8')).not.toContain('42-ran');
    } finally {
      h.dispose();
    }
  },
);

test.each(['missing', 'failed', 'unavailable', 'sourceCommit', 'contractHash', 'command', 'malformed'])(
  'an unchanged dev claim with a %s worker report names its unmeasured clause',
  async (change) => {
    const h = integrationHarness();
    try {
      const { task } = await unchangedClaim(h, ['true']);
      if (change !== 'missing')
        reportAcceptance(
          h,
          task,
          ['true'],
          change === 'failed' || change === 'unavailable'
            ? { status: change }
            : change === 'command'
              ? { command: ['false'] }
              : change === 'malformed'
                ? { command: [] }
                : { [change]: 'mismatched' },
        );
      await h.train();
      expect(h.outcomes[0]?.passed).toBe(false);
      expect(h.outcomes[0]?.firstFailure?.excerpt).toContain(
        `Unmeasured clause: ${task.brief.acceptance.tests.join('; ')}`,
      );
      expect(h.store.task(task.id).state).not.toBe('integrated');
      expect(h.head()).toBe(h.head(task.branch));
    } finally {
      h.dispose();
    }
  },
);

test('a failed retained-source acceptance stays non-green and records its exact result', async () => {
  const h = integrationHarness();
  const command = ['sh', '-c', 'echo retained-acceptance-failed; exit 1'];
  try {
    const { source, task } = await unchangedClaim(h, command, 'stabilize');
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

test.each([false, true])(
  'historical empty commits complete without advancing dev (frozen acceptance: %s)',
  async (frozen) => {
    const h = integrationHarness();
    try {
      h.ensureDev();
      const ancestor = h.advanceDev('retained.txt');
      const task = h.dispatch('retained.txt', [], ['sh', '-c', 'cat retained.txt; git rev-parse HEAD']);
      if (frozen) {
        const markdown = `${task.brief.markdown}\n\`\`\`text path=retained.txt\nfrozen acceptance\n\`\`\`\n`;
        writeFileSync(task.briefPath, markdown);
        h.store.updateTask({ taskId: task.id, attempt: 0 }, (current) => {
          current.brief.markdown = markdown;
        });
        writeFileSync(
          join(task.worktree, '.temp/worker-plan.json'),
          JSON.stringify({ file: 'retained.txt', content: 'frozen acceptance\n' }),
        );
      }
      git(task.worktree, ['commit', '--allow-empty', '-m', 'Retained historical controller commit']);
      await h.start(task);
      const source = h.head(task.branch);
      reportAcceptance(h, task, task.brief.acceptance.command);
      await h.train();

      expect(h.outcomes[0]?.firstFailure).toBeUndefined();
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
  },
);

test.each(['unavailable', 'dirty', 'source', 'contract', 'stale'] as const)(
  '%s during acceptance never completes an unchanged claim',
  async (change) => {
    const h = integrationHarness();
    try {
      const { source, task } = await unchangedClaim(h, ['true'], 'stabilize');
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
  },
);
