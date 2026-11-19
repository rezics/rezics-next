import { expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { git } from './merge.ts';
import { integrationHarness } from './test-support.ts';

const acceptance = ['feature-acceptance'];
const failure = 'AssertionError: required behavior failed';

// Direct dev defers acceptance to the verifier. Stabilize still gates publication on declared acceptance.
test('stabilize runs acceptance on the rebased candidate and retains failure evidence', async () => {
  const h = integrationHarness();
  try {
    h.ensureDev();
    git(h.root, 'branch', 'stabilize', 'dev');
    const task = h.dispatch('feature', [], acceptance, 'fixture', 'stabilize');
    await h.start(task);
    const base = h.advanceBranch('stabilize', 'base-change');
    const checks: { head: string; hasFeature: boolean; hasBaseChange: boolean }[] = [];

    await h.train(async (command, cwd) => {
      if (command[0] !== acceptance[0]) return { passed: true, output: '', timedOut: false };
      const hasFeature = existsSync(join(cwd, 'feature'));
      checks.push({
        head: git(cwd, 'rev-parse', 'HEAD'),
        hasFeature,
        hasBaseChange: existsSync(join(cwd, 'base-change')),
      });
      return { passed: !hasFeature, output: hasFeature ? failure : '', timedOut: false };
    });

    expect(checks).toEqual([
      { head: expect.any(String), hasFeature: true, hasBaseChange: true },
      { head: base, hasFeature: false, hasBaseChange: true },
    ]);
    expect(checks[0]!.head).not.toBe(base);
    expect(h.head('stabilize')).toBe(base);
    expect(h.outcomes).toMatchObject([
      {
        taskId: task.id,
        passed: false,
        stage: 'gate',
        failedCommand: acceptance,
        failsOnMain: false,
        firstFailure: { assertion: expect.stringContaining(failure) },
      },
    ]);
    const log = readFileSync(h.outcomes[0]!.logPath, 'utf8');
    expect(log).toContain(`Acceptance on ${checks[0]!.head}`);
    expect(log).toContain(acceptance.join(' '));
  } finally {
    h.dispose();
  }
});

test('stabilize marks a matching baseline failure as pre-existing', async () => {
  const h = integrationHarness();
  try {
    h.ensureDev();
    git(h.root, 'branch', 'stabilize', 'dev');
    const base = h.advanceBranch('stabilize', 'base-change');
    const task = h.dispatch('feature', [], acceptance, 'fixture', 'stabilize');
    await h.start(task);
    const checked: string[] = [];

    await h.train(async (command, cwd) => {
      if (command[0] !== acceptance[0]) return { passed: true, output: '', timedOut: false };
      checked.push(git(cwd, 'rev-parse', 'HEAD'));
      return { passed: false, output: failure, timedOut: false };
    });

    expect(checked).toEqual([expect.any(String), base]);
    expect(checked[0]).not.toBe(base);
    expect(h.head('stabilize')).toBe(base);
    expect(h.outcomes).toMatchObject([{ taskId: task.id, passed: false, failsOnMain: true, stage: 'gate' }]);
    expect(readFileSync(h.outcomes[0]!.logPath, 'utf8')).toContain('Acceptance failure is pre-existing');
  } finally {
    h.dispose();
  }
});
