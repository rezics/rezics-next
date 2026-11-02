import { expect, test } from 'bun:test';
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { GateOutcome } from './contracts.ts';
import { harvestContinuations } from './continuation.ts';
import { WorkerJob } from './job.ts';
import { harness, markdown } from './test-support.ts';

test("a gate failure's automatic retry survives the process that recorded it exiting before it ran", async () => {
  const h = harness();
  try {
    const task = h.tasks.dispatch(h.briefFile);
    const first = new WorkerJob(h.tasks, { enqueue() {} }, { deliver() {} });
    await first.start(task.id);
    await first.drain();
    const ref = { taskId: task.id, attempt: 1 };
    h.store.updateAttempt(ref, (attempt) => {
      attempt.result = 'Blocked';
      attempt.blocker = 'The implementation is incomplete.';
    });

    const outcome: GateOutcome = {
      ...ref,
      passed: false,
      stage: 'gate',
      logPath: 'fixture',
      hostMs: 1,
      changedFiles: [],
      diffLines: 1,
      firstFailure: { fingerprint: 'new', assertion: 'acceptance failed', excerpt: 'expected result' },
    };
    // The first process exits after committing the outcome and before starting tracked work.
    Object.assign(first, { runRetryIntent: async () => {} });
    first.onGateOutcome(outcome);
    rmSync(join(h.settings.stateDirectory, 'leases', task.id), { recursive: true, force: true });

    const recovered = new WorkerJob(h.tasks, { enqueue() {} }, { deliver() {} });
    await recovered.recoverOrphans();

    expect(h.store.task(task.id).currentAttempt).toBe(2);
    expect(h.store.attempt({ taskId: task.id, attempt: 2 }).fixRound).toBe(1);
    expect(h.store.retryIntent(ref)?.options).toMatchObject({ escalation: 'new-failure', fixRound: 1 });
    await new WorkerJob(h.tasks, { enqueue() {} }, { deliver() {} }).recoverOrphans();
    expect(h.store.task(task.id).currentAttempt).toBe(2);
  } finally {
    await h.disposeAsync();
  }
});

test("a command leaves another task's pending retry to the host instead of running it first", async () => {
  const h = harness();
  try {
    const task = h.tasks.dispatch(h.briefFile);
    const first = new WorkerJob(h.tasks, { enqueue() {} }, { deliver() {} });
    await first.start(task.id);
    await first.drain();
    const ref = { taskId: task.id, attempt: 1 };
    h.store.updateAttempt(ref, (attempt) => {
      attempt.result = 'Blocked';
      attempt.blocker = 'The implementation is incomplete.';
    });
    const outcome: GateOutcome = {
      ...ref,
      passed: false,
      stage: 'gate',
      logPath: 'fixture',
      hostMs: 1,
      changedFiles: [],
      diffLines: 1,
      firstFailure: { fingerprint: 'new', assertion: 'acceptance failed', excerpt: 'expected result' },
    };
    Object.assign(first, { runRetryIntent: async () => {} });
    first.onGateOutcome(outcome);
    rmSync(join(h.settings.stateDirectory, 'leases', task.id), { recursive: true, force: true });

    // A retry command once ran other tasks' pending retries first and followed their workers for 25 minutes.
    const command = new WorkerJob(h.tasks, { enqueue() {} }, { deliver() {} });
    await command.recoverOrphans({ adoptRunning: false });
    await command.drain();
    expect(h.store.task(task.id).currentAttempt).toBe(1);
    expect(h.store.retryIntent(ref)?.status).toBe('pending');

    const host = new WorkerJob(h.tasks, { enqueue() {} }, { deliver() {} });
    await host.recoverOrphans();
    await host.drain();
    expect(h.store.task(task.id).currentAttempt).toBe(2);
  } finally {
    await h.disposeAsync();
  }
});

test('Keep distinct worker continuations when filenames normalize alike', () => {
  const h = harness();
  try {
    const task = h.tasks.dispatch(h.briefFile);
    const ref = { taskId: task.id, attempt: task.currentAttempt };
    const source = join(task.worktree, '.temp/continuation');
    mkdirSync(source, { recursive: true });
    const brief = (sentence: string) => markdown.replace('Write the requested result and commit it.', sentence);
    const normalized = brief('Finish the shelf from the spaced name.');
    const hyphenated = brief('Finish the shelf from the hyphenated name.');
    const longA = brief('Finish the shelf from the first long name.');
    const longB = brief('Finish the shelf from the second long name.');
    const same = brief('This brief was already published.');
    const fresh = brief('This brief still needs its own backlog file.');
    const occupant = brief('An earlier different brief already uses this name.');
    const long = 'n'.repeat(80);
    writeFileSync(join(source, 'rest of shelf.md'), normalized);
    writeFileSync(join(source, 'rest-of-shelf.md'), hyphenated);
    writeFileSync(join(source, `${long}-one.md`), longA);
    writeFileSync(join(source, `${long}-two.md`), longB);
    writeFileSync(join(source, 'same brief.md'), same);
    writeFileSync(join(source, 'fresh topic.md'), fresh);
    const backlog = join(h.settings.stateDirectory, 'backlog', 'fixture');
    mkdirSync(backlog, { recursive: true });
    const prefix = `continuation-${task.id.slice(0, 8)}-${ref.attempt}-`;
    const sameDest = join(backlog, `${prefix}same-brief.md`);
    const occupiedDest = join(backlog, `${prefix}fresh-topic.md`);
    writeFileSync(sameDest, same);
    writeFileSync(occupiedDest, occupant);
    const publishedAt = new Date('2020-01-01T00:00:00Z');
    utimesSync(sameDest, publishedAt, publishedAt);
    utimesSync(occupiedDest, publishedAt, publishedAt);
    const sameMtime = statSync(sameDest).mtimeMs;
    const occupiedMtime = statSync(occupiedDest).mtimeMs;

    const first = harvestContinuations(h.store, h.settings, task, ref);
    const published = readdirSync(backlog).sort();
    const second = harvestContinuations(h.store, h.settings, h.store.task(task.id), ref);

    expect(readdirSync(source)).toEqual([]);
    expect(new Set(first.queued).size).toBe(first.queued.length);
    expect(first.queued).toContain(sameDest);
    expect(first.queued).not.toContain(occupiedDest);
    expect(first.dropped).toEqual([]);
    expect(first.retained).toEqual([]);
    expect(readFileSync(sameDest, 'utf8')).toBe(same);
    expect(readFileSync(occupiedDest, 'utf8')).toBe(occupant);
    expect(statSync(sameDest).mtimeMs).toBe(sameMtime);
    expect(statSync(occupiedDest).mtimeMs).toBe(occupiedMtime);
    expect(first.queued.map((path) => readFileSync(path, 'utf8')).sort()).toEqual(
      [fresh, hyphenated, longA, longB, normalized, same].sort(),
    );
    expect(published.every((name) => name.endsWith('.md') && !name.includes('.tmp'))).toBe(true);
    expect(second.queued).toEqual([]);
    expect(readdirSync(backlog).sort()).toEqual(published);
  } finally {
    h.dispose();
  }
});
