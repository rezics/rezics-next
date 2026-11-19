import { expect, test } from 'bun:test';
import { integrationHarness } from './test-support.ts';

const acceptance = ['fixture-acceptance'];

test('an ordinary dev landing reaches dev without running its acceptance', async () => {
  const h = integrationHarness();
  try {
    h.ensureDev();
    const task = h.dispatch('feature', [], acceptance);
    await h.start(task);
    const base = h.head();
    const checked: string[][] = [];
    await h.train(async (command) => {
      checked.push([...command]);
      return { passed: false, output: 'AssertionError: required behavior failed', timedOut: false };
    });

    expect(checked).not.toContainEqual(acceptance);
    expect(h.head()).not.toBe(base);
    expect(h.outcomes).toHaveLength(1);
    expect(h.outcomes[0]).toMatchObject({ passed: true });
    expect(h.store.task(task.id).state).toBe('integrated');
  } finally {
    h.dispose();
  }
});

test('an ordinary dev batch lands every member without running acceptance', async () => {
  const h = integrationHarness();
  try {
    h.ensureDev();
    h.settings.integration.batchSize = 2;
    const first = h.dispatch('first', [], acceptance);
    const second = h.dispatch('second', [], acceptance);
    await h.start(first);
    await h.start(second);
    const base = h.head();
    const checked: string[][] = [];
    await h.train(async (command) => {
      checked.push([...command]);
      return { passed: false, output: 'AssertionError: required behavior failed', timedOut: false };
    });

    expect(checked).not.toContainEqual(acceptance);
    expect(h.head()).not.toBe(base);
    expect(h.outcomes.filter((outcome) => outcome.passed)).toHaveLength(2);
  } finally {
    h.dispose();
  }
});
