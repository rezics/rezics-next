import { expect, test } from 'bun:test';
import { git } from './merge.ts';
import { integrationHarness } from './test-support.ts';

const headFailure = { passed: false, output: 'AssertionError: expected fixture to pass', timedOut: false };
const probeFailure = { passed: false, output: 'Error: EADDRINUSE fixture port', timedOut: false };
const success = { passed: true, output: '', timedOut: false };

test('a failing stabilize candidate does not run or retry a prefix probe', async () => {
  const h = integrationHarness();
  try {
    const first = await h.seed('alpha');
    const culprit = await h.seed('bad');
    const dev = h.head();
    let probeRuns = 0;

    await h.promote(async (command, cwd, logPath) => {
      const commit = git(cwd, 'rev-parse', 'HEAD');
      if (commit === dev && command[0] === 'true') return headFailure;
      if (command[0] === 'true' && logPath.includes('-prefix-0-')) {
        probeRuns++;
        return probeRuns === 1 ? probeFailure : success;
      }
      return success;
    });

    expect(probeRuns).toBe(0);
    expect(h.head()).toBe(dev);
    expect(h.store.promotion()?.phase).toBe('stabilize-blocked');
    for (const task of [first, culprit]) {
      expect(h.store.task(task.id).state).toBe('integrated');
      expect(h.store.task(task.id).currentAttempt).toBe(1);
    }
  } finally { h.dispose(); }
});

test('a failing stabilize candidate is recorded once without confirmation', async () => {
  const h = integrationHarness();
  try {
    const first = await h.seed('alpha');
    const culprit = await h.seed('bad');
    const dev = h.head();
    let probeRuns = 0, confirmationRuns = 0;

    await h.promote(async (command, cwd, logPath) => {
      const commit = git(cwd, 'rev-parse', 'HEAD');
      if (commit === dev && command[0] === 'true') return headFailure;
      if (command[0] === 'true' && logPath.includes('-prefix-0-')) {
        probeRuns++;
        return headFailure;
      }
      if (command[0] === 'true' && logPath.includes('-confirm-culprit-')) {
        confirmationRuns++;
        return headFailure;
      }
      return success;
    });

    expect(probeRuns).toBe(0);
    expect(confirmationRuns).toBe(0);
    expect(h.head()).toBe(dev);
    expect(h.store.promotion()?.phase).toBe('stabilize-blocked');
    for (const task of [first, culprit]) {
      expect(h.store.task(task.id).state).toBe('integrated');
      expect(h.store.task(task.id).currentAttempt).toBe(1);
    }
  } finally { h.dispose(); }
});
