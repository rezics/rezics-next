import { expect, test } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { siblingTestCommand, siblingTestFiles } from './affected-tests.ts';
import { integrationHarness } from './test-support.ts';

test('selects same-directory sibling tests and falls back to workspace tests', () => {
  const h = integrationHarness();
  try {
    mkdirSync(join(h.root, 'scripts'), { recursive: true });
    mkdirSync(join(h.root, 'tests'), { recursive: true });
    writeFileSync(join(h.root, 'scripts/remote-check.test.ts'), '');
    writeFileSync(join(h.root, 'tests/catalogue.test.ts'), '');
    expect(
      siblingTestFiles(
        ['scripts/remote-check.ts', 'packages/catalogue.ts', 'services/kernel/kernel.ts', 'readme.md'],
        h.root,
      ),
    ).toEqual(['scripts/remote-check.test.ts', 'tests/catalogue.test.ts']);
    expect(siblingTestCommand(['scripts/remote-check.test.ts'])).toEqual([
      'bun',
      'test',
      'scripts/remote-check.test.ts',
    ]);
    expect(siblingTestCommand([])).toBeUndefined();
  } finally {
    h.dispose();
  }
});

test('a landing refuses a changed source whose sibling test fails only on the candidate', async () => {
  const h = integrationHarness();
  try {
    h.ensureDev();
    h.advanceDev('scripts/remote-check.ts', 'good');
    h.advanceDev(
      'scripts/remote-check.test.ts',
      `import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
test('remote check contract', () => expect(readFileSync('scripts/remote-check.ts', 'utf8')).toBe('good'));\n`,
    );
    h.settings.affectedTests = [];
    const task = h.dispatch('scripts/remote-check.ts');
    writeFileSync(
      join(task.worktree, '.temp/worker-plan.json'),
      JSON.stringify({
        file: 'scripts/remote-check.ts',
        content: 'broken',
      }),
    );
    await h.start(task);
    await h.train(undefined, false);
    expect(h.outcomes[0]!.passed).toBe(false);
    expect(h.outcomes[0]!.stage).toBe('gate');
    expect(h.outcomes[0]!.firstFailure!.assertion).toContain('scripts/remote-check.test.ts');
  } finally {
    h.dispose();
  }
}, 60_000);

test('a sibling failure also present on the base is reported as pre-existing', async () => {
  const h = integrationHarness();
  try {
    h.ensureDev();
    h.advanceDev('scripts/remote-check.ts', 'base-broken');
    h.advanceDev(
      'scripts/remote-check.test.ts',
      `import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
test('remote check contract', () => expect(readFileSync('scripts/remote-check.ts', 'utf8')).toBe('good'));\n`,
    );
    h.settings.affectedTests = [];
    const task = h.dispatch('scripts/remote-check.ts');
    writeFileSync(
      join(task.worktree, '.temp/worker-plan.json'),
      JSON.stringify({
        file: 'scripts/remote-check.ts',
        content: 'branch-broken',
      }),
    );
    await h.start(task);
    await h.train(undefined, false);
    expect(h.outcomes[0]!.passed).toBe(true);
    expect(readFileSync(h.outcomes[0]!.logPath, 'utf8')).toContain('Base already shares the affected-test failures');
  } finally {
    h.dispose();
  }
}, 60_000);
