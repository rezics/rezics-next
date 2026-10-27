import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { newErrorLines } from './merge-train.ts';
import { firstFailure } from './merge.ts';
import { integrationHarness } from './test-support.ts';

type IntegrationCheck = { paths: string[]; command: string[] };

function integrationChecks(h: ReturnType<typeof integrationHarness>, checks: IntegrationCheck[]): void {
  (h.settings as typeof h.settings & { integrationChecks?: IntegrationCheck[] }).integrationChecks = checks;
}

test("a branch that fails the integration check is not integrated and gets a gate failure carrying the check's first failure", async () => {
  const h = integrationHarness();
  try {
    h.ensureDev();
    integrationChecks(h, [
      {
        paths: ['**'],
        command: ['sh', '-c', "test ! -e broken || { echo 'AssertionError: broken integration'; exit 1; }"],
      },
    ]);
    const task = h.dispatch('broken');
    await h.start(task);
    const dev = h.head();

    await h.train(undefined, false);

    expect(h.head()).toBe(dev);
    expect(h.head(task.branch)).not.toBe(dev);
    expect(h.outcomes[0]?.passed).toBe(false);
    expect(h.outcomes[0]?.stage).toBe('gate');
    expect(h.outcomes[0]?.firstFailure?.assertion).toContain('AssertionError: broken integration');
    expect(readFileSync(h.outcomes[0]!.logPath, 'utf8')).toContain('AssertionError: broken integration');
  } finally {
    h.dispose();
  }
});

test('a branch integrates when dev already fails the integration check', async () => {
  const h = integrationHarness();
  try {
    h.ensureDev();
    h.advanceDev('broken');
    integrationChecks(h, [
      {
        paths: ['**'],
        command: ['sh', '-c', "test ! -e broken || { echo 'AssertionError: dev has broken integration'; exit 1; }"],
      },
    ]);
    const task = h.dispatch('feature');
    await h.start(task);
    const candidate = h.head(task.branch);

    await h.train(undefined, false);

    expect(h.head()).toBe(candidate);
    expect(h.outcomes[0]?.passed).toBe(true);
    expect(h.outcomes[0]?.stage).toBe('merge');
    expect(readFileSync(h.outcomes[0]!.logPath, 'utf8')).toContain('dev already fails the integration check');
  } finally {
    h.dispose();
  }
});

test('a branch is refused for an error that dev, already failing the check, does not have', async () => {
  const h = integrationHarness();
  try {
    h.ensureDev();
    h.advanceDev('broken');
    integrationChecks(h, [
      {
        paths: ['**'],
        command: [
          'sh',
          '-c',
          "test ! -e broken || echo 'src/a.ts(3,1): error TS2322: dev error'; test ! -e worse || echo 'src/b.ts(9,4): error TS2339: new error'; test ! -e broken",
        ],
      },
    ]);
    const task = h.dispatch('worse');
    await h.start(task);
    const dev = h.head();

    await h.train(undefined, false);

    expect(h.head()).toBe(dev);
    expect(h.outcomes[0]?.passed).toBe(false);
    expect(h.outcomes[0]?.stage).toBe('gate');
    expect(h.outcomes[0]?.firstFailure?.assertion).toContain('error TS2339: new error');
    expect(h.outcomes[0]?.firstFailure?.assertion).not.toContain('dev error');
  } finally {
    h.dispose();
  }
});

test('a branch on an integrated candidate reuses its check result as the dev baseline', async () => {
  const h = integrationHarness();
  try {
    h.ensureDev();
    h.advanceDev('broken');
    integrationChecks(h, [
      {
        paths: ['**'],
        command: ['sh', '-c', "test ! -e broken || { echo 'src/a.ts(3,1): error TS2322: dev error'; exit 1; }"],
      },
    ]);
    const first = h.dispatch('first');
    await h.start(first);
    await h.train(undefined, false);
    const second = h.dispatch('second');
    await h.start(second);
    await h.train(undefined, false);

    expect(h.outcomes.map((outcome) => [outcome.passed, outcome.stage])).toEqual([
      [true, 'merge'],
      [true, 'merge'],
    ]);
    expect(readFileSync(h.outcomes[0]!.logPath, 'utf8')).toContain('Integration check baseline on dev');
    expect(readFileSync(h.outcomes[1]!.logPath, 'utf8')).not.toContain('Integration check baseline on dev');
  } finally {
    h.dispose();
  }
});

test('newErrorLines ignores moved positions and timings and counts repeats', () => {
  const dev = 'src/a.ts(3,1): error TS2322: same\nerror: script "typecheck" exited with code 1 after 2.31s';
  expect(
    newErrorLines('src/a.ts(40,7): error TS2322: same\nerror: script "typecheck" exited with code 1 after 9.80s', dev),
  ).toEqual([]);
  expect(newErrorLines('src/a.ts(3,1): error TS2322: same\nsrc/a.ts(8,1): error TS2322: same', dev)).toEqual([
    'src/a.ts: error TS2322: same',
  ]);
});

test('a branch that passes the integration check integrates into dev as before', async () => {
  const h = integrationHarness();
  try {
    h.ensureDev();
    integrationChecks(h, [{ paths: ['**'], command: ['sh', '-c', "echo 'integration check passed'"] }]);
    const task = h.dispatch('feature');
    await h.start(task);
    const candidate = h.head(task.branch);

    await h.train(undefined, false);

    expect(h.head()).toBe(candidate);
    expect(h.outcomes[0]?.passed).toBe(true);
    expect(h.outcomes[0]?.stage).toBe('merge');
    expect(readFileSync(h.outcomes[0]!.logPath, 'utf8')).toContain('integration check passed');
  } finally {
    h.dispose();
  }
});

test("the dev head's check result is computed once per dev commit", async () => {
  const h = integrationHarness();
  try {
    h.ensureDev();
    const dev = h.head();
    integrationChecks(h, [
      {
        paths: ['**'],
        command: [
          'sh',
          '-c',
          `if [ "$(git rev-parse HEAD)" = "${dev}" ]; then echo dev-check-run; fi; test ! -e broken || { echo 'AssertionError: broken integration'; exit 1; }`,
        ],
      },
    ]);
    const first = h.dispatch('broken');
    const second = h.dispatch('broken');
    await h.start(first);
    await h.start(second);

    await h.train(undefined, false);

    const logs = h.outcomes.map((outcome) => readFileSync(outcome.logPath, 'utf8')).join('\n');
    expect(h.head()).toBe(dev);
    expect(h.outcomes.map((outcome) => [outcome.passed, outcome.stage])).toEqual([
      [false, 'gate'],
      [false, 'gate'],
    ]);
    expect(logs.match(/^dev-check-run$/gm) ?? []).toHaveLength(1);
  } finally {
    h.dispose();
  }
});

test("a branch whose changes match no check's paths integrates without running any check", async () => {
  const h = integrationHarness();
  try {
    h.ensureDev();
    integrationChecks(h, [
      { paths: ['services/kernel/**'], command: ['sh', '-c', "echo 'integration check ran'; exit 1"] },
    ]);
    const task = h.dispatch('feature');
    await h.start(task);
    const candidate = h.head(task.branch);

    await h.train(undefined, false);

    expect(h.head()).toBe(candidate);
    expect(h.outcomes[0]?.passed).toBe(true);
    expect(h.outcomes[0]?.stage).toBe('merge');
    const log = readFileSync(h.outcomes[0]!.logPath, 'utf8');
    expect(log).not.toContain('integration check ran');
    expect(log).not.toContain('Integration check on');
  } finally {
    h.dispose();
  }
});

test('a later check still runs when an earlier one fails as on dev, and its new errors refuse the branch', async () => {
  const h = integrationHarness();
  try {
    h.ensureDev();
    h.advanceDev('broken');
    integrationChecks(h, [
      { paths: ['**'], command: ['sh', '-c', "test ! -e broken || { echo 'src/a.ts(3,1): error TS2322: dev error'; exit 1; }"] },
      { paths: ['**'], command: ['sh', '-c', "test ! -e worse || { echo 'error: imports an undeclared package'; exit 1; }"] },
    ]);
    const task = h.dispatch('worse');
    await h.start(task);
    const dev = h.head();

    await h.train(undefined, false);

    expect(h.head()).toBe(dev);
    expect(h.outcomes[0]?.passed).toBe(false);
    expect(h.outcomes[0]?.firstFailure?.assertion).toContain('imports an undeclared package');
  } finally {
    h.dispose();
  }
});

test('a branch whose only change is its frozen acceptance files is refused as having no work', async () => {
  const h = integrationHarness();
  try {
    h.ensureDev();
    const task = h.dispatch('frozen.test.ts');
    await h.start(task);
    // The fixture worker's one file stands for the controller's frozen acceptance commit.
    h.store.updateTask({ taskId: task.id, attempt: h.store.task(task.id).currentAttempt }, (current) => {
      (current as typeof current & { frozenFiles?: { path: string; hash: string }[] }).frozenFiles = [
        { path: 'frozen.test.ts', hash: createHash('sha256').update(readFileSync(join(task.worktree, 'frozen.test.ts'))).digest('hex') },
      ];
    });
    const dev = h.head();

    await h.train(undefined, false);

    expect(h.head()).toBe(dev);
    expect(h.outcomes[0]?.passed).toBe(false);
    expect(readFileSync(h.outcomes[0]!.logPath, 'utf8')).toContain('No committed changes beyond');
  } finally {
    h.dispose();
  }
});

test("a failure's excerpt shows the failing line with its real file even after long install output", () => {
  const install = Array.from({ length: 400 }, (_, i) => `installed package-${i}@1.0.0 into node_modules/.store`).join('\n');
  const output = `${install}\n$ tsc --noEmit -p tsconfig.json\nsrc/community/publication.ts(74,11): error TS2554: Expected 2 arguments, but got 1.\nerror: script "check" exited with code 2\n`;
  const failure = firstFailure(output);
  expect(failure.assertion).toContain('<path>');
  expect(failure.excerpt.length).toBeLessThanOrEqual(8000);
  expect(failure.excerpt.startsWith('src/community/publication.ts(74,11): error TS2554')).toBe(true);
  expect(failure.excerpt.endsWith('exited with code 2\n')).toBe(true);
});

test("an error dev already has is not new when the branch only grows the type TypeScript elides in it", () => {
  const line = (more: number) =>
    `test/semantic/outcome-driver.ts(186,7): error TS2741: Property 'readAccount' is missing in type '{ registrationTarget(key: string): string; ... ${more} more ...; provisioningEvidence: () => Promise<...>; }' but required in type 'AccountWorkflowPorts<WorkflowContext>'.`;
  expect(newErrorLines(line(28), line(26))).toEqual([]);
  expect(newErrorLines(`${line(28)}\nsrc/other.ts(1,1): error TS2304: Cannot find name 'x'.`, line(26))).toHaveLength(1);
});

test('read-only integration checks run at once, and a check that writes the tree runs alone afterwards', async () => {
  const { runIntegrationChecks } = await import('./merge-train.ts');
  const { mkdtempSync, readFileSync: read, rmSync: remove } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const dir = mkdtempSync(join(tmpdir(), 'checks-'));
  try {
    const log = join(dir, 'landing.log');
    const started = Date.now();
    const result = await runIntegrationChecks(
      [['sh', '-c', 'sleep 1; echo first'], ['sh', '-c', 'sleep 1; echo second'], ['sh', '-c', 'echo generate step']],
      dir,
      log,
    );
    expect(result.passed).toBe(true);
    expect(Date.now() - started).toBeLessThan(1_900);
    const text = read(log, 'utf8');
    expect(text.indexOf('first')).toBeLessThan(text.indexOf('second'));
    expect(text.indexOf('second')).toBeLessThan(text.indexOf('generate step'));
  } finally { remove(dir, { recursive: true, force: true }); }
});

test("the workspace typecheck check receives the branch's changed files; other checks do not", async () => {
  const h = integrationHarness();
  try {
    h.ensureDev();
    const seen = join(h.root, '.temp', 'typecheck-changed.txt');
    const other = join(h.root, '.temp', 'other-changed.txt');
    integrationChecks(h, [
      { paths: ['**'], command: ['sh', '-c', `printf '%s' "$TYPECHECK_CHANGED" > ${seen} # scripts/typecheck.ts`] },
      { paths: ['**'], command: ['sh', '-c', `printf '%s' "\${TYPECHECK_CHANGED-unset}" > ${other}`] },
    ]);
    const task = h.dispatch('feature');
    await h.start(task);

    await h.train(undefined, false);

    expect(h.outcomes[0]?.passed).toBe(true);
    expect(readFileSync(seen, 'utf8').split('\n')).toContain('feature');
    expect(readFileSync(other, 'utf8')).toBe('unset');
  } finally {
    h.dispose();
  }
});
