import { expect, spyOn, test } from 'bun:test';
import * as fs from 'node:fs';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { GateOutcome } from './contracts.ts';
import { completeContinuation, harvestContinuations } from './continuation.ts';
import { readControlPolicy } from './policy.ts';
import { WorkerJob } from './job.ts';
import { readRiskOwnership } from './briefs.ts';
import { harness, markdown } from './test-support.ts';
import { git } from './merge.ts';
import { SqliteManagerInbox } from './inbox.ts';

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

function beginAttempt(h: ReturnType<typeof harness>, task: ReturnType<typeof h.tasks.dispatch>) {
  return h.store.nextAttempt({ taskId: task.id, attempt: task.currentAttempt }, (attempt) => ({
    taskId: task.id,
    attempt,
    state: 'pending',
    profile: { cli: 'codex', model: 'fixture', effort: 'medium', poolClass: 'codex' },
    pool: 'fixture',
    tableVersion: 'fixture',
    experiment: null,
    startedAt: new Date(Date.now() - 1000).toISOString(),
    endedAt: null,
    process: null,
    driver: null,
    logPath: join(h.settings.stateDirectory, 'runs', task.id, `${attempt}.jsonl`),
    evidencePath: join(h.settings.stateDirectory, 'evidence', task.id, String(attempt)),
    auxiliaryProcesses: [],
    session: null,
    fixRound: 0,
    consulted: false,
    previousFailure: null,
    failure: null,
    escalation: null,
    before: null,
    after: null,
    exitCode: null,
    result: '',
    blocker: null,
    approaches: [],
  }));
}

test("a retried attempt's continuation is dropped once an earlier attempt queued one", () => {
  const h = harness();
  h.settings.policy = readControlPolicy({ backlog: { continuationReview: { fixture: false } } });
  try {
    const task = h.tasks.dispatch(h.briefFile);
    const attempt = beginAttempt(h, task);
    const source = join(task.worktree, '.temp/continuation');
    const rest = markdown.replace('Write the requested result and commit it.', 'Finish the shelf.');
    mkdirSync(source, { recursive: true });
    writeFileSync(join(source, 'rest of shelf.md'), rest);
    const earlier = { taskId: task.id, attempt: attempt.attempt };
    const first = harvestContinuations(h.store, h.settings, task, earlier);
    expect(first.queued).toHaveLength(1);
    expect(readFileSync(first.queued[0]!, 'utf8')).toContain(`after:\n  - ${task.id}\n`);
    writeFileSync(join(source, 'rest of shelf.md'), rest);
    writeFileSync(join(source, 'renamed rest.md'), rest);
    const later = beginAttempt(h, h.store.task(task.id));
    const second = harvestContinuations(h.store, h.settings, task, { taskId: task.id, attempt: later.attempt });
    expect(second.queued).toEqual([]);
    expect(second.dropped.map((drop) => drop.reason)).toEqual([
      `attempt ${earlier.attempt} of this task already queued its continuation`,
      `attempt ${earlier.attempt} of this task already queued its continuation`,
    ]);
    expect(readdirSync(source)).toEqual([]);
    const backlog = join(h.settings.stateDirectory, 'backlog', 'fixture');
    expect(readdirSync(backlog).filter((name) => name.endsWith('.md'))).toHaveLength(1);
    expect(readdirSync(join(backlog, 'failed')).filter((name) => name.endsWith('.md'))).toHaveLength(2);
  } finally {
    h.dispose();
  }
});

test('an invalid Markdown continuation is kept with its reason and reported to its manager', () => {
  const h = harness();
  try {
    const task = h.tasks.dispatch(h.briefFile);
    const attempt = beginAttempt(h, task);
    const source = join(task.worktree, '.temp/continuation');
    mkdirSync(source, { recursive: true });
    writeFileSync(join(source, 'invalid.md'), markdown.replace('goal: fixture', 'goal: web'));
    const failure = harvestContinuations(h.store, h.settings, task, { taskId: task.id, attempt: attempt.attempt })
      .dropped[0]!;
    const failed = join(h.settings.stateDirectory, 'backlog', 'fixture', 'failed');
    const saved = join(
      failed,
      readdirSync(failed).find((name) => name.endsWith('.md'))!,
    );
    const reason = readFileSync(`${saved}.reason`, 'utf8');
    const inbox = new SqliteManagerInbox(h.store.db, h.settings.stateDirectory);
    const notice = inbox
      .pending(task.brief.manager)
      .map(({ event }) => JSON.stringify(event) ?? '')
      .join('\n');
    expect(readFileSync(saved, 'utf8')).toContain('goal: web');
    expect(reason).toContain(failure.reason);
    expect(notice).toContain('instruction');
    expect(notice).toContain('invalid.md');
    expect(notice).toContain(failure.reason);
  } finally {
    h.dispose();
  }
});

test('acceptance placement without a command is removed and the continuation is admitted', () => {
  const h = harness();
  h.settings.policy = readControlPolicy({ backlog: { continuationReview: { fixture: false } } });
  try {
    const task = h.tasks.dispatch(h.briefFile);
    const attempt = beginAttempt(h, task);
    const source = join(task.worktree, '.temp/continuation');
    mkdirSync(source, { recursive: true });
    const placement = markdown.replace('paths: [result.txt]', 'paths: [result.txt]\nacceptance:\n  placement: default');
    writeFileSync(join(source, 'placement-only.md'), placement);
    const result = harvestContinuations(h.store, h.settings, task, { taskId: task.id, attempt: attempt.attempt });
    expect(result.queued).toHaveLength(1);
    expect(readFileSync(result.queued[0]!, 'utf8')).not.toContain('placement:');
  } finally {
    h.dispose();
  }
});

test('Keep distinct worker continuations when filenames normalize alike', () => {
  const h = harness();
  h.settings.policy = readControlPolicy({ backlog: { continuationReview: { fixture: false } } });
  try {
    const task = h.tasks.dispatch(h.briefFile);
    const attempt = beginAttempt(h, task);
    const ref = { taskId: task.id, attempt: attempt.attempt };
    const source = join(task.worktree, '.temp/continuation');
    mkdirSync(source, { recursive: true });
    const ownership = readRiskOwnership(h.settings.riskAreasFile);
    // Published briefs are the completed ones, which wait for the task they continue.
    const brief = (sentence: string) =>
      completeContinuation(
        markdown
          .replace('paths: [result.txt]', `paths: [${sentence.replaceAll(' ', '-')}.txt]`)
          .replace('Write the requested result and commit it.', sentence),
        task,
        ownership,
      );
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

test('harvest attributes new files to the attempt and proposes overlapping Goal work', () => {
  const h = harness();
  h.settings.policy = readControlPolicy({ backlog: { continuationReview: { fixture: false } } });
  try {
    const task = h.tasks.dispatch(h.briefFile);
    const attempt = beginAttempt(h, task);
    const ref = { taskId: task.id, attempt: attempt.attempt };
    const source = join(task.worktree, '.temp/continuation');
    mkdirSync(source, { recursive: true });
    const inherited = join(source, 'inherited.md');
    const inheritedBrief = markdown.replace('goal: fixture', 'goal: web');
    writeFileSync(inherited, inheritedBrief);
    git(task.worktree, 'add', '-f', '--', '.temp/continuation/inherited.md');
    git(task.worktree, 'commit', '-m', 'Preserve another outcome');
    writeFileSync(join(source, 'old.md'), markdown);
    // Touching an inherited file cannot make it this attempt's output.
    h.store.updateAttempt(ref, (current) => {
      current.startedAt = new Date(Date.now() + 1000).toISOString();
    });
    utimesSync(join(source, 'old.md'), new Date(), new Date());
    expect(harvestContinuations(h.store, h.settings, task, ref).dropped[0]?.reason).toBe(
      'file was not created during this attempt',
    );
    expect(readFileSync(inherited, 'utf8')).toBe(inheritedBrief);
    expect(git(task.worktree, 'status', '--porcelain', '--untracked-files=all')).toBe('');
    h.store.updateAttempt(ref, (current) => {
      current.startedAt = attempt.startedAt;
    });
    writeFileSync(join(source, 'foreign.md'), markdown.replace('goal: fixture', 'goal: web'));
    expect(harvestContinuations(h.store, h.settings, task, ref).dropped[0]?.reason).toBe(
      "goal web is not the task's goal fixture",
    );
    const other = h.tasks.dispatch(h.briefFile);
    for (const state of ['running', 'held', 'ready'] as const) {
      h.store.updateTask({ taskId: other.id, attempt: 0 }, (current) => {
        current.state = state;
      });
      writeFileSync(
        join(source, `${state}.md`),
        markdown.replace('Write the requested result and commit it.', `Finish ${state}.`),
      );
      const result = harvestContinuations(h.store, h.settings, task, ref);
      expect(result.queued).toEqual([]);
      expect(result.proposed[0]?.reason).toContain(`overlaps task ${other.id}`);
      expect(readFileSync(`${result.proposed[0]!.file}.reason`, 'utf8')).toContain(other.id);
    }
    h.store.updateTask({ taskId: other.id, attempt: 0 }, (current) => {
      current.state = 'cancelled';
    });
    const backlog = join(h.settings.stateDirectory, 'backlog', 'fixture');
    writeFileSync(
      join(backlog, 'manager.md'),
      markdown
        .replace('paths: [result.txt]', 'paths: [other.txt]')
        .replace('Write the requested result and commit it.', '# Finish shelf'),
    );
    writeFileSync(
      join(source, 'title.md'),
      markdown
        .replace('paths: [result.txt]', 'paths: [separate.txt]')
        .replace('Write the requested result and commit it.', '# Finish shelf'),
    );
    expect(harvestContinuations(h.store, h.settings, task, ref).proposed[0]?.reason).toContain('manager.md');
    writeFileSync(
      join(source, 'distinct.md'),
      markdown
        .replace('paths: [result.txt]', 'paths: [distinct.txt]')
        .replace('Write the requested result and commit it.', '# Distinct outcome'),
    );
    expect(harvestContinuations(h.store, h.settings, task, ref).queued).toHaveLength(1);
    const outside = join(task.worktree, 'outside.md');
    const linked = join(source, 'linked.md');
    const untracked = join(source, 'untracked');
    const tracked = join(source, 'tracked', 'keep.md');
    writeFileSync(outside, markdown);
    fs.symlinkSync(outside, linked);
    mkdirSync(untracked);
    writeFileSync(join(untracked, 'nested.md'), markdown);
    mkdirSync(join(source, 'tracked'));
    writeFileSync(tracked, markdown);
    git(task.worktree, 'add', '-f', '--', '.temp/continuation/tracked/keep.md');
    git(task.worktree, 'commit', '-m', 'Preserve tracked continuation directory');
    const protectedEntries = harvestContinuations(h.store, h.settings, task, ref);
    expect(protectedEntries.dropped.map(({ file }) => file)).toEqual(['linked.md', 'untracked']);
    expect(existsSync(linked)).toBe(false);
    expect(existsSync(outside)).toBe(true);
    expect(existsSync(untracked)).toBe(false);
    expect(readFileSync(tracked, 'utf8')).toBe(markdown);
  } finally {
    h.dispose();
  }
});

test('harvest preserves recreated notes inherited from launch and merge-parent trees', () => {
  const h = harness();
  h.settings.policy = readControlPolicy({ backlog: { continuationReview: { fixture: false } } });
  try {
    const task = h.tasks.dispatch(h.briefFile);
    const attempt = beginAttempt(h, task);
    const ref = { taskId: task.id, attempt: attempt.attempt };
    const source = join(task.worktree, '.temp/continuation');
    const note = join(source, 'launch-note.md');
    const inherited = markdown.replace('Write the requested result and commit it.', 'Finish Bangumi Season.');
    mkdirSync(source, { recursive: true });
    writeFileSync(note, inherited);
    git(task.worktree, 'add', '-f', '--', '.temp/continuation/launch-note.md');
    git(task.worktree, 'commit', '-m', 'Preserve inherited launch note');
    const launch = git(task.worktree, 'rev-parse', 'HEAD');
    h.store.event(ref, 'worker-run-started', { branchHead: launch });
    const originalInode = statSync(note).ino;
    git(task.worktree, 'rm', '--cached', '--', '.temp/continuation/launch-note.md');
    writeFileSync(`${note}.replacement`, inherited);
    rmSync(note);
    fs.renameSync(`${note}.replacement`, note);
    expect(statSync(note).ino).not.toBe(originalInode);
    const first = harvestContinuations(h.store, h.settings, task, ref);
    expect(first).toMatchObject({ queued: [], proposed: [], dropped: [] });
    expect(readFileSync(note, 'utf8')).toBe(inherited);

    const parentNote = join(source, 'merge-parent.md');
    writeFileSync(parentNote, inherited);
    git(task.worktree, 'add', '-f', '--', '.temp/continuation/merge-parent.md');
    git(task.worktree, 'commit', '-m', 'Admit merge-parent note');
    const upstream = git(task.worktree, 'rev-parse', 'HEAD');
    rmSync(note);
    git(task.worktree, 'reset', '--hard', task.base);
    const merge = git(
      task.worktree,
      'commit-tree',
      `${task.base}^{tree}`,
      '-p',
      task.base,
      '-p',
      upstream,
      '-m',
      'Merge upstream without its continuation path',
    );
    git(task.worktree, 'reset', '--hard', merge);
    h.store.event(ref, 'worker-run-started', { branchHead: merge });
    mkdirSync(source, { recursive: true });
    writeFileSync(parentNote, inherited);
    const second = harvestContinuations(h.store, h.settings, task, ref);
    expect(second).toMatchObject({ queued: [], proposed: [], dropped: [] });
    expect(readFileSync(parentNote, 'utf8')).toBe(inherited);
  } finally {
    h.dispose();
  }
});

const SHARED_PATHS = 'README.md, docs/journeys.md, packages/definitions/release/catalog.json';

function continuationMarkdown(title: string, paths: string): string {
  return markdown
    .replace('paths: [result.txt]', `paths: [${paths}]`)
    .replace('Write the requested result and commit it.', title);
}

test('seven planner continuations that share owner docs reach the ready backlog', () => {
  const h = harness();
  h.settings.policy = readControlPolicy({ backlog: { continuationReview: { fixture: false } } });
  try {
    const task = h.tasks.dispatch(h.briefFile);
    const attempt = beginAttempt(h, task);
    const ref = { taskId: task.id, attempt: attempt.attempt };
    const source = join(task.worktree, '.temp/continuation');
    mkdirSync(source, { recursive: true });
    for (let index = 1; index <= 7; index++)
      writeFileSync(
        join(source, `journey-${index}.md`),
        continuationMarkdown(`# Journey ${index}`, `apps/web/src/journeys/j${index}.ts, ${SHARED_PATHS}`),
      );
    const result = harvestContinuations(h.store, h.settings, task, ref);
    expect(result.queued).toHaveLength(7);
    expect(result.proposed).toEqual([]);
    expect(existsSync(join(h.settings.stateDirectory, 'backlog', 'fixture', 'proposed'))).toBe(false);
  } finally {
    h.dispose();
  }
});

test('a growing continuation batch reuses one inventory and incorporates publications into review counts', () => {
  const h = harness();
  try {
    const task = h.tasks.dispatch(h.briefFile);
    const attempt = beginAttempt(h, task);
    const ref = { taskId: task.id, attempt: attempt.attempt };
    const source = join(task.worktree, '.temp/continuation');
    const backlog = join(h.settings.stateDirectory, 'backlog', 'fixture');
    const dispatched = join(backlog, 'dispatched');
    mkdirSync(source, { recursive: true });
    mkdirSync(dispatched, { recursive: true });

    // Existing dispatches from this source attempt are siblings, even when their scopes match the first remainder.
    for (let index = 0; index < 5; index++) {
      const sibling = h.tasks.dispatch(h.briefFile);
      h.store.updateTask({ taskId: sibling.id, attempt: 0 }, (current) => {
        current.state = 'running';
        current.brief.paths = ['apps/web/src/journeys/j1.ts'];
        current.brief.markdown = '# Journey 1';
      });
      writeFileSync(
        join(dispatched, `${sibling.id}-continuation-${task.id.slice(0, 8)}-${ref.attempt}-sibling.md`),
        'sibling\n',
      );
    }

    // Continuation archives count as continuations. Ten ordinary drafts leave room for five new ones.
    for (let index = 0; index < 9; index++) {
      const manager = join(backlog, `manager-${index}.md`);
      writeFileSync(manager, continuationMarkdown(`# Manager ${index}`, `apps/web/src/manager/m${index}.ts`));
    }
    const partialDraft = join(backlog, 'partial.md');
    writeFileSync(partialDraft, '---\ngoal: [\n---\nunfinished draft\n');
    for (let index = 1; index <= 8; index++)
      writeFileSync(
        join(source, `journey-${String(index).padStart(2, '0')}.md`),
        continuationMarkdown(`# Journey ${index}`, `apps/web/src/journeys/j${index}.ts, ${SHARED_PATHS}`),
      );

    const readdir = spyOn(fs, 'readdirSync');
    const readFile = spyOn(fs, 'readFileSync');
    try {
      const result = harvestContinuations(h.store, h.settings, task, ref);

      expect(result.queued).toHaveLength(5);
      expect(result.proposed).toHaveLength(3);
      expect(result.queued.map((file) => basename(file))).toEqual(
        Array.from(
          { length: 5 },
          (_, index) =>
            `continuation-${task.id.slice(0, 8)}-${ref.attempt}-journey-${String(index + 1).padStart(2, '0')}.md`,
        ),
      );
      expect(result.proposed.map(({ file }) => basename(file))).toEqual(
        Array.from(
          { length: 3 },
          (_, index) =>
            `continuation-${task.id.slice(0, 8)}-${ref.attempt}-journey-${String(index + 6).padStart(2, '0')}.md`,
        ),
      );
      expect(result.dropped).toEqual([]);
      expect(result.retained).toEqual([]);
      expect(readdir.mock.calls.filter(([path]) => String(path) === dispatched)).toHaveLength(1);
      expect(readFile.mock.calls.filter(([path]) => String(path) === partialDraft)).toHaveLength(1);
      expect(readFile.mock.calls.filter(([path]) => String(path) === join(backlog, 'manager-0.md'))).toHaveLength(1);
      for (const directory of [backlog, join(backlog, 'held'), join(backlog, '.dispatching')])
        expect(readdir.mock.calls.filter(([path]) => String(path) === directory)).toHaveLength(1);
      expect(result.proposed.map(({ reason }) => reason)).toEqual(
        Array.from({ length: 3 }, () => 'Goal continuation review is enabled; release or retire this proposal'),
      );
    } finally {
      readFile.mockRestore();
      readdir.mockRestore();
    }
  } finally {
    h.dispose();
  }
});

test('title match and remaining-path coverage are still duplicates; proposed briefs are not', () => {
  const h = harness();
  h.settings.policy = readControlPolicy({ backlog: { continuationReview: { fixture: false } } });
  try {
    const task = h.tasks.dispatch(h.briefFile);
    const other = h.tasks.dispatch(h.briefFile);
    h.store.updateTask({ taskId: other.id, attempt: 0 }, (current) => {
      current.state = 'running';
    });
    const attempt = beginAttempt(h, task);
    const ref = { taskId: task.id, attempt: attempt.attempt };
    const source = join(task.worktree, '.temp/continuation');
    const backlog = join(h.settings.stateDirectory, 'backlog', 'fixture');
    mkdirSync(join(backlog, 'proposed'), { recursive: true });
    mkdirSync(source, { recursive: true });
    writeFileSync(
      join(source, 'covered.md'),
      continuationMarkdown('# Covered remainder', `result.txt, ${SHARED_PATHS}`),
    );
    expect(harvestContinuations(h.store, h.settings, task, ref).proposed[0]?.reason).toContain(
      `overlaps task ${other.id}`,
    );
    writeFileSync(
      join(source, 'titled.md'),
      continuationMarkdown('# Finish shelf', `apps/web/src/journeys/titled.ts, ${SHARED_PATHS}`),
    );
    writeFileSync(
      join(backlog, 'manager.md'),
      continuationMarkdown('# Finish shelf', 'apps/web/src/journeys/other.ts'),
    );
    expect(harvestContinuations(h.store, h.settings, task, ref).proposed[0]?.reason).toContain('manager.md');
    writeFileSync(
      join(backlog, 'proposed', 'parked.md'),
      continuationMarkdown('# Parked proposal', `apps/web/src/journeys/parked.ts, ${SHARED_PATHS}`),
    );
    writeFileSync(
      join(source, 'sibling.md'),
      continuationMarkdown('# Fresh journey', `apps/web/src/journeys/parked.ts, ${SHARED_PATHS}`),
    );
    expect(harvestContinuations(h.store, h.settings, task, ref).queued).toHaveLength(1);
    writeFileSync(
      join(source, 'batch.md'),
      continuationMarkdown('# Batch sibling', `apps/web/src/journeys/parked.ts, ${SHARED_PATHS}`),
    );
    expect(harvestContinuations(h.store, h.settings, task, ref).queued).toHaveLength(1);
    writeFileSync(
      join(source, 'partial.md'),
      continuationMarkdown('# Partial remainder', 'result.txt, apps/web/src/journeys/partial.ts'),
    );
    const partial = harvestContinuations(h.store, h.settings, task, ref);
    expect(partial.proposed).toEqual([]);
    expect(readFileSync(partial.queued[0]!, 'utf8')).not.toContain(other.id);
  } finally {
    h.dispose();
  }
});
