import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import type { GateOutcome, ManagerEvent } from './contracts.ts';
import { completeContinuation } from './continuation.ts';
import { parseBrief } from './briefs.ts';
import { authenticatedManager } from './priority-authority.ts';
import { WorkerJob } from './job.ts';
import { promote } from './promotion.ts';
import { harness, markdown } from './test-support.ts';
import { git } from './merge.ts';

const merged = (taskId: string, commit: string): GateOutcome => ({
  taskId,
  attempt: 1,
  passed: true,
  stage: 'merge',
  mergedCommit: commit,
  logPath: 'fixture',
  hostMs: 1,
  changedFiles: ['result.txt'],
  diffLines: 1,
});

test('a task held after another launches when that task integrates, and the Goal reports idle after promotion', async () => {
  const h = harness(),
    inbox: ManagerEvent[] = [];
  try {
    h.settings.gate = ['true'];
    writeFileSync(h.briefFile, markdown.replace('command: [bun, test]', 'command: ["true"]'));
    const job = new WorkerJob(h.tasks, { enqueue() {} }, { deliver: (event) => inbox.push(event) });
    const first = h.tasks.dispatch(h.briefFile);
    const secondBrief = join(h.root, '.temp/goal/second.md');
    writeFileSync(
      secondBrief,
      markdown
        .replace('command: [bun, test]', 'command: ["true"]')
        .replace('waiting: []', `waiting: []\nafter: [${first.id}]`),
    );
    const second = h.tasks.dispatch(secondBrief);
    expect(h.store.task(second.id).state).toBe('held');
    expect(h.store.task(second.id).currentAttempt).toBe(0);

    await job.start(first.id);
    const firstCommit = git(h.store.task(first.id).worktree, 'rev-parse', 'HEAD');
    const devBeforeFirst = git(h.root, 'rev-parse', 'dev');
    git(h.root, 'update-ref', 'refs/heads/dev', firstCommit, devBeforeFirst);
    job.onGateOutcome(merged(first.id, firstCommit));
    await job.drain();
    expect(h.store.task(first.id).state).toBe('integrated');
    expect(h.store.task(second.id).currentAttempt).toBe(1);
    expect(inbox).toEqual([]);

    const secondCommit = git(h.store.task(second.id).worktree, 'rev-parse', 'HEAD');
    const devBeforeSecond = git(h.root, 'rev-parse', 'dev');
    if (secondCommit !== devBeforeSecond) git(h.root, 'update-ref', 'refs/heads/dev', secondCommit, devBeforeSecond);
    job.onGateOutcome(merged(second.id, secondCommit));
    await job.drain();
    expect(h.store.task(second.id).state).toBe('integrated');
    expect(inbox).toEqual([]);
    await promote({ settings: h.settings, job });
    await job.drain();
    expect(inbox.map((event) => [event.kind, event.managerId])).toEqual([['goal-idle', 'fixture']]);
    // A replayed outcome does not report idle again.
    job.onGateOutcome(merged(second.id, secondCommit));
    await job.drain();
    expect(inbox).toHaveLength(1);
  } finally {
    h.dispose();
  }
});

test('a brief held after an unknown task is refused', () => {
  const h = harness();
  try {
    const brief = join(h.root, '.temp/goal/orphan.md');
    writeFileSync(brief, markdown.replace('waiting: []', 'waiting: []\nafter: [no-such-task]'));
    expect(() => h.tasks.dispatch(brief)).toThrow();
  } finally {
    h.dispose();
  }
});

test('a brief held after a merged task is ready at once', () => {
  const h = harness();
  try {
    const first = h.tasks.dispatch(h.briefFile);
    h.store.updateTask({ taskId: first.id, attempt: 0 }, (task) => {
      task.state = 'merged';
    });
    const brief = join(h.root, '.temp/goal/later.md');
    writeFileSync(brief, markdown.replace('waiting: []', `waiting: []\nafter: [${first.id}]`));
    expect(h.store.task(h.tasks.dispatch(brief).id).state).toBe('ready');
  } finally {
    h.dispose();
  }
});

test('a stopped task held by a reshape starts when a later reshape drops the unmet dependency', async () => {
  const h = harness();
  try {
    writeFileSync(h.briefFile, markdown.replace('command: [bun, test]', 'command: ["true"]'));
    const job = new WorkerJob(h.tasks, { enqueue() {} }, { deliver() {} });
    const blocker = h.tasks.dispatch(h.briefFile);
    const task = h.tasks.dispatch(h.briefFile);
    await job.start(task.id);
    await h.tasks.stop(task.id);
    const heldBrief = join(h.root, '.temp/goal/held.md');
    writeFileSync(
      heldBrief,
      markdown
        .replace('command: [bun, test]', 'command: ["true"]')
        .replace('waiting: []', `waiting: []\nafter: [${blocker.id}]`),
    );
    await expect(h.tasks.retry(task.id, { brief: heldBrief })).rejects.toThrow('held until its dependencies merge');
    expect(h.store.task(task.id).state).toBe('held');
    // Retrying without a reshape keeps it held while the dependency is unmet.
    await expect(h.tasks.retry(task.id)).rejects.toThrow('held until its dependencies merge');
    expect(h.store.task(task.id).state).toBe('held');

    const freeBrief = join(h.root, '.temp/goal/free.md');
    writeFileSync(freeBrief, markdown.replace('command: [bun, test]', 'command: ["true"]'));
    const before = h.store.task(task.id).currentAttempt;
    const worker = await h.tasks.retry(task.id, { brief: freeBrief });
    await worker.exited;
    expect(h.store.task(task.id).currentAttempt).toBe(before + 1);
    expect(h.store.task(task.id).brief.after).toEqual([]);
  } finally {
    h.dispose();
  }
});

test('the recovery sweep starts a released task that no process started', async () => {
  const h = harness();
  try {
    writeFileSync(h.briefFile, markdown.replace('command: [bun, test]', 'command: ["true"]'));
    const job = new WorkerJob(h.tasks, { enqueue() {} }, { deliver() {} });
    const first = h.tasks.dispatch(h.briefFile);
    const secondBrief = join(h.root, '.temp/goal/second.md');
    writeFileSync(
      secondBrief,
      markdown
        .replace('command: [bun, test]', 'command: ["true"]')
        .replace('waiting: []', `waiting: []\nafter: [${first.id}]`),
    );
    const second = h.tasks.dispatch(secondBrief);
    // The release happened, but the process that should have started the task ended first.
    h.store.updateTask({ taskId: first.id, attempt: 0 }, (task) => {
      task.state = 'integrated';
    });
    h.store.updateTask({ taskId: second.id, attempt: 0 }, (task) => {
      task.state = 'ready';
    });

    await job.recoverOrphans();
    await job.drain();

    expect(h.store.task(second.id).currentAttempt).toBe(1);
  } finally {
    h.dispose();
  }
});

test('only the host starts a released task, and a second starter leaves it to the one holding its lease', async () => {
  const h = harness();
  try {
    writeFileSync(h.briefFile, markdown.replace('command: [bun, test]', 'command: ["true"]'));
    const first = h.tasks.dispatch(h.briefFile);
    const secondBrief = join(h.root, '.temp/goal/second.md');
    writeFileSync(
      secondBrief,
      markdown
        .replace('command: [bun, test]', 'command: ["true"]')
        .replace('waiting: []', `waiting: []\nafter: [${first.id}]`),
    );
    const second = h.tasks.dispatch(secondBrief);
    h.store.updateTask({ taskId: first.id, attempt: 0 }, (task) => {
      task.state = 'integrated';
    });
    h.store.updateTask({ taskId: second.id, attempt: 0 }, (task) => {
      task.state = 'ready';
    });

    // A command's sweep leaves released tasks to the host.
    const command = new WorkerJob(h.tasks, { enqueue() {} }, { deliver() {} });
    await command.recoverOrphans({ adoptRunning: false });
    await command.drain();
    expect(h.store.task(second.id).currentAttempt).toBe(0);

    // Two host sweeps at once start it once, without failing either.
    const hosts = [1, 2].map(() => new WorkerJob(h.tasks, { enqueue() {} }, { deliver() {} }));
    await Promise.all(hosts.map((job) => job.recoverOrphans()));
    await Promise.all(hosts.map((job) => job.drain()));
    expect(h.store.task(second.id).currentAttempt).toBe(1);
  } finally {
    h.dispose();
  }
});

test('a dev task after a stabilize task stays held until stabilize reaches dev, then the host sweep releases it', async () => {
  const h = harness();
  try {
    writeFileSync(h.briefFile, markdown.replace('command: [bun, test]', 'command: ["true"]'));
    git(h.root, 'branch', 'stabilize', git(h.root, 'rev-parse', 'HEAD'));
    const job = new WorkerJob(h.tasks, { enqueue() {} }, { deliver() {} });
    const fixBrief = join(h.root, '.temp/goal/fix.md');
    writeFileSync(
      fixBrief,
      markdown
        .replace('command: [bun, test]', 'command: ["true"]')
        .replace('waiting: []', 'waiting: []\ntarget: stabilize'),
    );
    const fix = h.tasks.dispatch(fixBrief);
    const laterBrief = join(h.root, '.temp/goal/later.md');
    writeFileSync(
      laterBrief,
      markdown
        .replace('command: [bun, test]', 'command: ["true"]')
        .replace('waiting: []', `waiting: []\nafter: [${fix.id}]`),
    );
    const later = h.tasks.dispatch(laterBrief);
    expect(h.store.task(later.id).state).toBe('held');

    await job.start(fix.id);
    const fixCommit = git(h.store.task(fix.id).worktree, 'rev-parse', 'HEAD');
    git(h.root, 'update-ref', 'refs/heads/stabilize', fixCommit, git(h.root, 'rev-parse', 'stabilize'));
    job.onGateOutcome(merged(fix.id, fixCommit));
    await job.drain();
    expect(h.store.task(fix.id).state).toBe('integrated');
    // Integrated on stabilize only: dev does not have the fix, so the dev task does not start without it.
    expect(h.store.task(later.id).state).toBe('held');
    await job.recoverOrphans();
    await job.drain();
    expect(h.store.task(later.id).state).toBe('held');

    git(h.root, 'update-ref', 'refs/heads/dev', fixCommit, git(h.root, 'rev-parse', 'dev'));
    await job.recoverOrphans();
    await job.drain();
    expect(h.store.task(later.id).currentAttempt).toBe(1);
  } finally {
    h.dispose();
  }
});

test('a brief after a stabilize task that dev does not contain yet is held at dispatch', () => {
  const h = harness();
  try {
    git(h.root, 'branch', 'stabilize', git(h.root, 'rev-parse', 'HEAD'));
    const fixBrief = join(h.root, '.temp/goal/fix.md');
    writeFileSync(fixBrief, markdown.replace('waiting: []', 'waiting: []\ntarget: stabilize'));
    const fix = h.tasks.dispatch(fixBrief);
    h.store.updateTask({ taskId: fix.id, attempt: 0 }, (task) => {
      task.state = 'integrated';
      task.integratedCommit = git(h.root, 'commit-tree', '-p', 'HEAD', '-m', 'fix', 'HEAD^{tree}');
    });
    const laterBrief = join(h.root, '.temp/goal/later.md');
    writeFileSync(laterBrief, markdown.replace('waiting: []', `waiting: []\nafter: [${fix.id}]`));
    expect(h.tasks.dispatch(laterBrief).state).toBe('held');
  } finally {
    h.dispose();
  }
});

test('a continuation keeps its parent source-required edge even when its draft omits it', () => {
  const ownership = { version: 1 as const, areas: {} };
  const predecessor = 'producer-one';
  const parentMarkdown = markdown.replace(
    'waiting: []',
    `waiting: []\nafter: [${predecessor}]\nafterSource: [${predecessor}]`,
  );
  const parent = { id: 'parent-task', brief: parseBrief(parentMarkdown, ownership) };
  const draft = parentMarkdown.replace(
    `after: [${predecessor}]\nafterSource: [${predecessor}]`,
    'after: []',
  );

  const completed = completeContinuation(draft, parent, ownership);

  expect(parseBrief(completed, ownership)).toMatchObject({
    after: [predecessor, parent.id],
    afterSource: [predecessor],
  });
});

test('a stopped source producer stays held until its commit is integrated into the target branch', async () => {
  const h = harness(), inbox: ManagerEvent[] = [];
  try {
    const producer = h.tasks.dispatch(h.briefFile);
    writeFileSync(join(producer.worktree, 'retained-http-source.ts'), 'export const route = "/book";\n');
    git(producer.worktree, 'add', 'retained-http-source.ts');
    git(producer.worktree, 'commit', '-m', 'Retain unlanded HTTP source');
    const producerCommit = git(producer.worktree, 'rev-parse', 'HEAD');
    await h.tasks.stop(producer.id);

    const strictBrief = join(h.root, '.temp/goal/source-required.md');
    writeFileSync(
      strictBrief,
      markdown.replace(
        'waiting: []',
        `waiting: []\nafter: [${producer.id}]\nafterSource: [${producer.id}]`,
      ),
    );
    const strict = h.tasks.dispatch(strictBrief);
    expect(strict).toMatchObject({ state: 'held', currentAttempt: 0 });
    const job = new WorkerJob(h.tasks, { enqueue() {} }, { deliver: (event) => inbox.push(event) });
    await job.recoverOrphans({ adoptRunning: false });
    expect(inbox).toHaveLength(1);
    expect(inbox[0]?.taskId).toBe(producer.id);
    expect(inbox[0]?.summary).toContain(strict.id);
    expect(inbox[0]?.summary).toContain('authenticated reshape');

    const advisoryBrief = join(h.root, '.temp/goal/advisory.md');
    writeFileSync(advisoryBrief, markdown.replace('waiting: []', `waiting: []\nafter: [${producer.id}]`));
    const advisory = h.tasks.dispatch(advisoryBrief);
    expect(advisory.state).toBe('ready');
    await job.start(advisory.id);
    expect(h.store.task(advisory.id).currentAttempt).toBe(1);
    expect(h.store.task(strict.id)).toMatchObject({ state: 'held', currentAttempt: 0 });

    h.store.updateTask({ taskId: producer.id, attempt: 0 }, (task) => {
      task.state = 'integrated';
    });
    expect(h.tasks.dependenciesMet(h.store.task(strict.id))).toBe(false);
    h.store.updateTask({ taskId: producer.id, attempt: 0 }, (task) => {
      task.integratedCommit = producerCommit;
    });
    expect(h.tasks.dependenciesMet(h.store.task(strict.id))).toBe(false);

    const devBefore = git(h.root, 'rev-parse', 'refs/heads/dev');
    git(h.root, 'update-ref', 'refs/heads/dev', producerCommit, devBefore);
    expect(h.tasks.dependenciesMet(h.store.task(strict.id))).toBe(true);

    await job.recoverOrphans();
    await job.drain();
    await job.recoverOrphans();
    await job.drain();
    expect(h.store.task(strict.id).currentAttempt).toBe(1);
    expect(h.store.events(strict.id).filter((event) => event.kind === 'worker-run-started')).toHaveLength(1);
    expect(h.store.events(strict.id).filter((event) => event.kind === 'held-task-released')).toHaveLength(1);
  } finally {
    await h.disposeAsync();
  }
});

test('an authenticated current-generation reshape can replace a stopped source edge with integrated evidence', async () => {
  const h = harness();
  try {
    const stopped = h.tasks.dispatch(h.briefFile);
    writeFileSync(join(stopped.worktree, 'unlanded-http-source.ts'), 'export const route = "/book";\n');
    git(stopped.worktree, 'add', 'unlanded-http-source.ts');
    git(stopped.worktree, 'commit', '-m', 'Retain stopped HTTP source');
    await h.tasks.stop(stopped.id);

    const waitingBrief = join(h.root, '.temp/goal/waiting-source.md');
    writeFileSync(
      waitingBrief,
      markdown.replace('waiting: []', `waiting: []\nafter: [${stopped.id}]\nafterSource: [${stopped.id}]`),
    );
    const consumer = h.tasks.dispatch(waitingBrief);
    expect(consumer.state).toBe('held');
    const retryConsumer = h.tasks.dispatch(waitingBrief);
    expect(retryConsumer.state).toBe('held');

    const replacement = h.tasks.dispatch(h.briefFile);
    writeFileSync(join(replacement.worktree, 'integrated-http-source.ts'), 'export const route = "/book";\n');
    git(replacement.worktree, 'add', 'integrated-http-source.ts');
    git(replacement.worktree, 'commit', '-m', 'Integrate replacement HTTP source');
    const replacementCommit = git(replacement.worktree, 'rev-parse', 'HEAD');
    const devBefore = git(h.root, 'rev-parse', 'refs/heads/dev');
    git(h.root, 'update-ref', 'refs/heads/dev', replacementCommit, devBefore);
    h.store.updateTask({ taskId: replacement.id, attempt: 0 }, (task) => {
      task.state = 'integrated';
      task.integratedCommit = replacementCommit;
    });

    const replacementBrief = join(h.root, '.temp/goal/replacement.md');
    writeFileSync(
      replacementBrief,
      markdown
        .replace('waiting: []', `waiting: []\nafter: [${replacement.id}]\nafterSource: [${replacement.id}]`)
        .replace('Write the requested result and commit it.', `Evidence: ${replacementCommit} is on dev.`),
    );
    const sessionId = randomUUID();
    h.store.db.exec('CREATE TABLE IF NOT EXISTS manager_sessions (id TEXT PRIMARY KEY, state TEXT NOT NULL)');
    h.store.db.query('INSERT INTO manager_sessions VALUES (?, ?)').run(
      'fixture',
      JSON.stringify({
        id: 'fixture',
        kind: 'managed',
        provider: 'codex',
        engine: 'codex',
        status: 'running',
        threadId: sessionId,
      }),
    );
    const owner = authenticatedManager(h.store.db, { GOAL_MANAGER: 'fixture', CODEX_THREAD_ID: sessionId });
    expect(owner).toBeDefined();
    if (!owner) throw new Error('fixture manager session failed authentication');

    expect(() =>
      h.tasks.queueRetry(retryConsumer.id, { expectedAttempt: 0, brief: replacementBrief }, null),
    ).toThrow('source-required dependency reshapes require the authenticated owning or operations manager');
    h.tasks.queueRetry(retryConsumer.id, { expectedAttempt: 0, brief: replacementBrief }, owner);
    expect(h.store.task(retryConsumer.id)).toMatchObject({
      state: 'held',
      currentAttempt: 0,
      brief: { after: [replacement.id], afterSource: [replacement.id] },
    });

    expect(() => h.tasks.amend(consumer.id, { expectedAttempt: 0, brief: replacementBrief }, null)).toThrow(
      'authenticated owning or operations manager',
    );
    expect(() => h.tasks.amend(consumer.id, { expectedAttempt: 1, brief: replacementBrief }, owner)).toThrow(
      'prelaunch amendment refused stale/current generation',
    );
    expect(h.tasks.amend(consumer.id, { expectedAttempt: 0, brief: replacementBrief }, owner).status).toBe('amended');
    expect(h.store.task(consumer.id)).toMatchObject({
      state: 'ready',
      currentAttempt: 0,
      brief: { after: [replacement.id], afterSource: [replacement.id] },
    });
  } finally {
    h.dispose();
  }
});

test('an integrated research task wakes its manager with the report path', async () => {
  const h = harness(),
    inbox: ManagerEvent[] = [];
  try {
    writeFileSync(
      h.briefFile,
      markdown.replace('command: [bun, test]', 'command: ["true"]').replace('kind: implementation', 'kind: research'),
    );
    const job = new WorkerJob(h.tasks, { enqueue() {} }, { deliver: (event) => inbox.push(event) });
    const research = h.tasks.dispatch(h.briefFile);
    await job.start(research.id);
    const commit = git(h.store.task(research.id).worktree, 'rev-parse', 'HEAD');
    git(h.root, 'update-ref', 'refs/heads/dev', commit, git(h.root, 'rev-parse', 'dev'));
    job.onGateOutcome({ ...merged(research.id, commit), changedFiles: ['docs/research/shelves.md'] });
    await job.drain();
    expect(h.store.task(research.id).state).toBe('integrated');
    const notice = inbox.find((event) => event.kind === 'instruction');
    expect(notice?.managerId).toBe('fixture');
    expect(notice?.summary).toContain('docs/research/shelves.md');
  } finally {
    h.dispose();
  }
});
