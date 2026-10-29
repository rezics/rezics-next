import { expect, test } from 'bun:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MergeTrain, type IntegrationCheck } from './merge-train.ts';
import { git } from './merge.ts';
import { integrationHarness } from './test-support.ts';

function setChecks(h: ReturnType<typeof integrationHarness>, checks: IntegrationCheck[]): void {
  (h.settings as typeof h.settings & { integrationChecks: IntegrationCheck[] }).integrationChecks = checks;
}

function markTask(
  h: ReturnType<typeof integrationHarness>,
  taskId: string,
  values: { target?: string },
): void {
  h.store.updateTask({ taskId, attempt: 0 }, (task) => {
    if (values.target === 'stabilize') task.brief.target = 'stabilize';
  });
}

function markAffectedFailure(h: ReturnType<typeof integrationHarness>, taskId: string): void {
  const row = h.store.db.query('SELECT id, request FROM landing_queue WHERE task=?').get(taskId) as {
    id: number;
    request: string;
  };
  const request = JSON.parse(row.request);
  request.affectedTests = [
    { command: ['false'], status: 'failed', failingFiles: [], durationMs: 1, output: 'failed affected check' },
  ];
  h.store.db.query('UPDATE landing_queue SET request=? WHERE id=?').run(JSON.stringify(request), row.id);
}

test('the dev lane batches eligible entries across control-plane, stabilize, and affected-failure entries', async () => {
  const h = integrationHarness();
  try {
    h.ensureDev();
    git(h.root, 'branch', 'stabilize', 'main');
    h.settings.integration.batchSize = 2;
    setChecks(h, [{ paths: ['**'], command: ['true'] }]);
    const first = h.dispatch('dev-a.ts');
    const affected = h.dispatch('affected.ts');
    const second = h.dispatch('dev-b.ts');
    const controlPlane = h.dispatch('tools/goal/cp.ts', [], ['true'], 'control-plane');
    const stabilize = h.dispatch('stabilize.ts');
    markTask(h, stabilize.id, { target: 'stabilize' });
    await h.start(first);
    await h.start(affected);
    markAffectedFailure(h, affected.id);
    await h.start(second);
    await h.start(controlPlane);
    await h.start(stabilize);
    await h.train(async () => ({ passed: true, output: '', timedOut: false }));

    expect(h.outcomes.find(({ taskId }) => taskId === affected.id)).toMatchObject({ passed: false, stage: 'gate' });
    expect(h.outcomes.find(({ taskId }) => taskId === controlPlane.id)?.passed).toBe(true);
    expect(h.outcomes.find(({ taskId }) => taskId === stabilize.id)?.passed).toBe(true);
    expect(
      h.outcomes.filter(({ taskId }) => [first.id, second.id].includes(taskId)).map(({ passed }) => passed),
    ).toEqual([true, true]);
    const controlPlaneLog = readFileSync(h.outcomes.find(({ taskId }) => taskId === controlPlane.id)!.logPath, 'utf8');
    const stabilizeLog = readFileSync(h.outcomes.find(({ taskId }) => taskId === stabilize.id)!.logPath, 'utf8');
    const affectedLog = readFileSync(h.outcomes.find(({ taskId }) => taskId === affected.id)!.logPath, 'utf8');
    const devLogs = h.outcomes
      .filter(({ taskId }) => [first.id, second.id].includes(taskId))
      .map(({ logPath }) => readFileSync(logPath, 'utf8'));
    expect(controlPlaneLog).toContain('Integration check on');
    expect(controlPlaneLog).not.toContain('Batch integration check on');
    expect(stabilizeLog).not.toContain('Batch integration check on');
    expect(affectedLog).not.toContain('Batch integration check on');
    expect(devLogs.every((log) => log.includes('Batch integration check on'))).toBe(true);
  } finally {
    h.dispose();
  }
}, 60_000);

test('the dev batch fills to its limit in eligible queue order when prioritized entries lead the queue', async () => {
  const h = integrationHarness();
  try {
    h.ensureDev();
    git(h.root, 'branch', 'stabilize', 'main');
    h.settings.integration.batchSize = 3;
    setChecks(h, [{ paths: ['**'], command: ['true'] }]);

    const controlPlane = h.dispatch('tools/goal/cp-leading.ts', [], ['true'], 'control-plane');
    const stabilize = h.dispatch('stabilize-leading.ts');
    const first = h.dispatch('dev-first.ts');
    const affected = h.dispatch('affected-middle.ts');
    const second = h.dispatch('dev-second.ts');
    const third = h.dispatch('dev-third.ts');
    const fourth = h.dispatch('dev-fourth.ts');
    markTask(h, stabilize.id, { target: 'stabilize' });
    await h.start(controlPlane);
    await h.start(stabilize);
    await h.start(first);
    await h.start(affected);
    markAffectedFailure(h, affected.id);
    await h.start(second);
    await h.start(third);
    await h.start(fourth);

    await h.train(async () => ({ passed: true, output: '', timedOut: false }));

    const dev = [first, second, third, fourth];
    expect(h.outcomes.filter(({ taskId }) => dev.some(({ id }) => id === taskId)).map(({ taskId }) => taskId)).toEqual(
      dev.map(({ id }) => id),
    );
    expect(dev.map(({ id }) => h.outcomes.find(({ taskId }) => taskId === id)?.passed)).toEqual([
      true,
      true,
      true,
      true,
    ]);
    expect(h.outcomes.find(({ taskId }) => taskId === affected.id)).toMatchObject({ passed: false, stage: 'gate' });
    const logs = dev.map(({ id }) => readFileSync(h.outcomes.find(({ taskId }) => taskId === id)!.logPath, 'utf8'));
    expect(logs.slice(0, 3).every((log) => log.includes('Batch integration check on'))).toBe(true);
    expect(logs[3]).toContain('Integration check on');
    expect(logs[3]).not.toContain('Batch integration check on');
    for (const entry of [controlPlane, stabilize]) {
      const log = readFileSync(h.outcomes.find(({ taskId }) => taskId === entry.id)!.logPath, 'utf8');
      expect(log).toContain('Integration check on');
      expect(log).not.toContain('Batch integration check on');
    }
  } finally {
    h.dispose();
  }
}, 60_000);

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

test('a member that conflicts with an earlier batch member is deferred past it, then gets a rebase outcome against dev', async () => {
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

    // Deferred past the member it conflicts with, it then conflicts with dev itself, which only its worker can resolve.
    expect(h.outcomes.map(({ taskId, passed, stage }) => [taskId, passed, passed ? undefined : stage])).toEqual([
      [first.id, true, undefined],
      [later.id, true, undefined],
      [conflict.id, false, 'rebase'],
    ]);
    expect(readFileSync(runs, 'utf8').trim().split('\n')).toHaveLength(1);
    expect(git(h.root, 'show', 'dev:shared.txt')).toBe('shared.txt');
    expect(git(h.root, 'show', 'dev:later.txt')).toBe('later.txt');
    // The rebase outcome starts the worker's conflict-resolution attempt, which lands again.
    expect(h.queue.next()?.request).toMatchObject({ taskId: conflict.id, attempt: 2 });
  } finally {
    h.dispose();
  }
});

test('a landing that conflicts with dev itself, first in its batch, gets a rebase outcome instead of staying deferred', async () => {
  const h = integrationHarness();
  try {
    h.ensureDev();
    setChecks(h, [{ paths: ['**'], command: ['true'] }]);
    const first = h.dispatch('shared.txt');
    const conflict = h.dispatch('shared.txt');
    writeFileSync(
      join(conflict.worktree, '.temp/worker-plan.json'),
      JSON.stringify({ file: 'shared.txt', content: 'conflicting change' }),
    );
    await h.start(first);
    await h.start(conflict);
    await h.train();

    // A busy queue puts the conflicting landing first in every later batch: it was deferred forever (3 h 41 min).
    const next = h.dispatch('next.txt');
    await h.start(next);
    await h.train();

    const outcome = h.outcomes.find(({ taskId }) => taskId === conflict.id);
    expect(outcome?.passed).toBe(false);
    expect(outcome?.stage).toBe('rebase');
    expect(outcome?.conflictedFiles).toEqual(['shared.txt']);
    expect(h.outcomes.find(({ taskId }) => taskId === next.id)?.passed).toBe(true);
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
