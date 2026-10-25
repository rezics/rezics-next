import { expect, test } from 'bun:test';
import { git } from './merge.ts';
import { integrationHarness } from './test-support.ts';

const headFailure = { passed: false, output: 'AssertionError: expected fixture to pass', timedOut: false };
const probeFailure = { passed: false, output: 'Error: EADDRINUSE fixture port', timedOut: false };
const success = { passed: true, output: '', timedOut: false };

test('a prefix probe with a different failure is retried and the second result counts', async () => {
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

    expect(probeRuns).toBe(2);
    expect(h.store.task(first.id).state).toBe('merged');
    expect(h.store.task(culprit.id).currentAttempt).toBe(2);
  } finally { h.dispose(); }
});

test('a prefix probe with the head failure is not retried as a transient failure', async () => {
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

    expect(probeRuns).toBe(1);
    expect(confirmationRuns).toBe(1);
    expect(h.store.task(first.id).currentAttempt).toBe(2);
    expect(h.store.task(culprit.id).state).toBe('merged');
  } finally { h.dispose(); }
});
