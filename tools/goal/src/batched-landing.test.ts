import { expect, test } from 'bun:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MergeTrain, type IntegrationCheck } from './merge-train.ts';
import { git } from './merge.ts';
import { integrationHarness } from './test-support.ts';

function setChecks(h: ReturnType<typeof integrationHarness>, checks: IntegrationCheck[]): void {
  (h.settings as typeof h.settings & { integrationChecks: IntegrationCheck[] }).integrationChecks = checks;
}

test('up to the batch size of queued landings rebase in order, check once, and fast-forward with one outcome each', async () => {
  const h = integrationHarness();
  try {
    h.ensureDev();
    const changed = join(h.settings.stateDirectory, 'batch-typecheck-files.txt');
    const runs = join(h.settings.stateDirectory, 'batch-typecheck-runs.txt');
    setChecks(h, [
      {
        paths: ['**'],
        command: [
          'sh',
          '-c',
          `printf '%s\\n' "$TYPECHECK_CHANGED" >> '${changed}'; printf 'run\\n' >> '${runs}' # scripts/typecheck.ts`,
        ],
      },
    ]);
    const first = h.dispatch('first.ts');
    const second = h.dispatch('second.ts');
    await h.start(first);
    await h.start(second);

    await h.train();

    expect(h.settings.integration.batchSize).toBe(4);
    expect(readFileSync(runs, 'utf8').trim().split('\n')).toHaveLength(1);
    expect(readFileSync(changed, 'utf8').split('\n')).toEqual(expect.arrayContaining(['first.ts', 'second.ts']));
    expect(h.outcomes.map(({ taskId, passed }) => [taskId, passed])).toEqual([
      [first.id, true],
      [second.id, true],
    ]);
    expect(h.outcomes[0]?.mergedCommit).not.toBe(h.outcomes[1]?.mergedCommit);
    expect(git(h.root, 'merge-base', '--is-ancestor', h.outcomes[0]!.mergedCommit!, h.head('dev'))).toBe('');
    expect(h.head('dev')).toBe(h.outcomes[1]!.mergedCommit!);
  } finally {
    h.dispose();
  }
});

test('a failing batch falls back to single landings and refuses only its failing member', async () => {
  const h = integrationHarness();
  try {
    h.ensureDev();
    const runs = join(h.settings.stateDirectory, 'batch-failure-runs.txt');
    setChecks(h, [
      {
        paths: ['**'],
        command: [
          'sh',
          '-c',
          `printf 'run\\n' >> '${runs}'; test ! -e broken.ts || { echo 'AssertionError: broken member'; exit 1; }`,
        ],
      },
    ]);
    const passing = h.dispatch('passing.ts');
    const failing = h.dispatch('broken.ts');
    await h.start(passing);
    await h.start(failing);
    const base = h.head('dev');

    await h.train();

    expect(readFileSync(runs, 'utf8').trim().split('\n').length).toBeGreaterThan(1);
    expect(h.outcomes.map(({ taskId, passed }) => [taskId, passed])).toEqual([
      [passing.id, true],
      [failing.id, false],
    ]);
    expect(h.outcomes[1]?.firstFailure?.assertion).toContain('AssertionError: broken member');
    expect(h.head('dev')).not.toBe(base);
    expect(git(h.root, 'show', 'dev:passing.ts')).toBe('passing.ts');
    expect(() => git(h.root, 'show', 'dev:broken.ts')).toThrow();
  } finally {
    h.dispose();
  }
});

test('a member that conflicts with earlier batch members stays queued while later members land', async () => {
  const h = integrationHarness();
  try {
    h.ensureDev();
    const runs = join(h.settings.stateDirectory, 'batch-rebase-runs.txt');
    setChecks(h, [{ paths: ['**'], command: ['sh', '-c', `printf 'run\\n' >> '${runs}'`] }]);
    const first = h.dispatch('shared.txt');
    const conflict = h.dispatch('shared.txt');
    writeFileSync(
      join(conflict.worktree, '.temp/worker-plan.json'),
      JSON.stringify({ file: 'shared.txt', content: 'conflicting change' }),
    );
    const later = h.dispatch('later.txt');
    await h.start(first);
    await h.start(conflict);
    await h.start(later);

    await h.train();

    expect(h.outcomes.map(({ taskId, passed }) => [taskId, passed])).toEqual([
      [first.id, true],
      [later.id, true],
    ]);
    expect(readFileSync(runs, 'utf8').trim().split('\n')).toHaveLength(1);
    expect(git(h.root, 'show', 'dev:shared.txt')).toBe('shared.txt');
    expect(git(h.root, 'show', 'dev:later.txt')).toBe('later.txt');
    expect(h.queue.next()?.request.taskId).toBe(conflict.id);
  } finally {
    h.dispose();
  }
});

test('a stale attempt discovered during the batch check is skipped and never lands', async () => {
  const h = integrationHarness();
  try {
    h.ensureDev();
    const runs = join(h.settings.stateDirectory, 'batch-stale-runs.txt');
    const stale = h.dispatch('stale.ts');
    const passing = h.dispatch('passing.ts');
    await h.start(stale);
    await h.start(passing);
    const source = `import { Database } from 'bun:sqlite';
import { appendFileSync } from 'node:fs';
const db = new Database(${JSON.stringify(join(h.settings.stateDirectory, 'goal.sqlite'))});
const taskId = ${JSON.stringify(stale.id)};
const row = db.query('SELECT body FROM worker_tasks WHERE id=?').get(taskId);
const task = JSON.parse(row.body);
if (task.currentAttempt === 1) {
  task.currentAttempt = 2;
  db.query('UPDATE worker_tasks SET current_attempt=?, body=? WHERE id=?').run(task.currentAttempt, JSON.stringify(task), taskId);
}
db.close();
appendFileSync(${JSON.stringify(runs)}, 'run\\n');
`;
    setChecks(h, [
      {
        paths: ['**'],
        command: ['bun', '-e', source],
      },
    ]);
    const base = h.head('dev');

    await new MergeTrain({
      ...h.settings,
      queue: h.queue,
      fence: h.store,
      sink: { onGateOutcome: (outcome) => h.outcomes.push(outcome) },
    }).run();

    expect(readFileSync(runs, 'utf8').trim().split('\n').length).toBeGreaterThanOrEqual(1);
    expect(h.outcomes.map(({ taskId, passed }) => [taskId, passed])).toEqual([[passing.id, true]]);
    expect(h.head('dev')).not.toBe(base);
    expect(git(h.root, 'show', 'dev:passing.ts')).toBe('passing.ts');
    expect(() => git(h.root, 'show', 'dev:stale.ts')).toThrow();
    expect(h.queue.next()).toBeUndefined();
    expect(h.store.task(stale.id).currentAttempt).toBe(2);
  } finally {
    h.dispose();
  }
});

test('batch checks compare against dev and accept errors already present there', async () => {
  const h = integrationHarness();
  try {
    h.ensureDev();
    h.advanceDev('existing-error.ts');
    const runs = join(h.settings.stateDirectory, 'batch-baseline-runs.txt');
    setChecks(h, [
      {
        paths: ['**'],
        command: [
          'sh',
          '-c',
          `printf 'run\\n' >> '${runs}'; test ! -e existing-error.ts || { echo 'AssertionError: existing dev error'; exit 1; }`,
        ],
      },
    ]);
    const first = h.dispatch('first.ts');
    const second = h.dispatch('second.ts');
    await h.start(first);
    await h.start(second);

    await h.train();

    expect(readFileSync(runs, 'utf8').trim().split('\n')).toHaveLength(2);
    expect(h.outcomes.map((outcome) => outcome.passed)).toEqual([true, true]);
    expect(h.outcomes[0]?.logPath && readFileSync(h.outcomes[0].logPath, 'utf8')).toContain(
      'dev already fails the integration check',
    );
    expect(h.head('dev')).toBe(h.outcomes[1]!.mergedCommit!);
  } finally {
    h.dispose();
  }
});

test('batch size one keeps one-at-a-time integration checks', async () => {
  const h = integrationHarness();
  try {
    h.ensureDev();
    h.settings.integration.batchSize = 1;
    const runs = join(h.settings.stateDirectory, 'batch-size-one-runs.txt');
    setChecks(h, [{ paths: ['**'], command: ['sh', '-c', `printf 'run\\n' >> '${runs}'`] }]);
    const first = h.dispatch('first.ts');
    const second = h.dispatch('second.ts');
    await h.start(first);
    await h.start(second);

    await h.train();

    expect(readFileSync(runs, 'utf8').trim().split('\n')).toHaveLength(2);
    expect(h.outcomes.map((outcome) => outcome.passed)).toEqual([true, true]);
  } finally {
    h.dispose();
  }
});
