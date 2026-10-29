import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { integrationHarness } from './test-support.ts';

const fails = ['bun', '-e', "console.error('AssertionError: required behavior failed'); process.exit(1)"];

test('with dev landing checks off, a dev landing merges without running its acceptance', async () => {
  const h = integrationHarness();
  try {
    h.ensureDev();
    h.settings.integration.devLandingChecks = false;
    const task = h.dispatch('feature', [], fails);
    await h.start(task);
    const base = h.head();
    await h.train();

    expect(h.head()).not.toBe(base);
    expect(h.outcomes).toHaveLength(1);
    expect(h.outcomes[0]).toMatchObject({ passed: true });
    const log = readFileSync(h.outcomes[0]!.logPath, 'utf8');
    expect(log).toContain('Checks are not run at dev landing');
    expect(log).not.toContain('AssertionError: required behavior failed');
  } finally {
    h.dispose();
  }
});

test('with dev landing checks off, a dev batch lands every member without running acceptance', async () => {
  const h = integrationHarness();
  try {
    h.ensureDev();
    h.settings.integration.devLandingChecks = false;
    h.settings.integration.batchSize = 2;
    const first = h.dispatch('first', [], fails);
    const second = h.dispatch('second', [], fails);
    await h.start(first);
    await h.start(second);
    const base = h.head();
    await h.train();

    expect(h.head()).not.toBe(base);
    expect(h.outcomes.filter((outcome) => outcome.passed)).toHaveLength(2);
  } finally {
    h.dispose();
  }
});

test('dev landing checks stay on by default', async () => {
  const h = integrationHarness();
  try {
    h.ensureDev();
    const task = h.dispatch('feature', [], fails);
    await h.start(task);
    const base = h.head();
    await h.train();

    expect(h.head()).toBe(base);
    expect(h.outcomes[0]).toMatchObject({ passed: false, stage: 'gate' });
  } finally {
    h.dispose();
  }
});
