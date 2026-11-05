import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sweepBacklog, type BacklogRuntime } from './backlog.ts';
import { backlogDirectory } from './backlog-shared.ts';
import { chainRuntime, sessionContextTokens } from './chain.ts';
import type { GateOutcome } from './contracts.ts';
import { flowReport, readFlow, readFlowTasks } from './flow.ts';
import { SqliteManagerInbox } from './inbox.ts';
import { WorkerJob } from './job.ts';
import { git } from './merge.ts';
import { defaultPolicy, readControlPolicy } from './policy.ts';
import { harness, markdown, temporaryDirectory } from './test-support.ts';

// A successful worker that records whether each launch resumed a session, as fresh-session.test.ts does.
const recordingCli = `#!/usr/bin/env bun
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
mkdirSync('.temp/goal', { recursive: true });
appendFileSync('.temp/goal/launches.jsonl', JSON.stringify(process.argv.includes('resume')) + '\\n');
writeFileSync('result.txt', String(Date.now()));
spawnSync('git', ['add', 'result.txt']);
spawnSync('git', ['commit', '-m', 'Complete fixture']);
console.log(JSON.stringify({type:'thread.started',thread_id:'fixture-session'}));
console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'RESULT: success'}}));
console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:10,output_tokens:2}}));
`;

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

type Harness = ReturnType<typeof harness>;

/** The landed attempt's outcome as the merge train reports it. */
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

/** Run one ordinary task to its landing, with dev advanced to that landing as the train would advance it. */
async function landFirst(h: Harness) {
  const job = new WorkerJob(h.tasks, { enqueue() {} }, { deliver() {} });
  const first = h.tasks.dispatch(h.briefFile);
  await job.start(first.id);
  await job.drain();
  const commit = git(h.store.task(first.id).worktree, 'rev-parse', 'HEAD');
  git(h.root, 'update-ref', 'refs/heads/dev', commit, git(h.root, 'rev-parse', 'dev'));
  job.onGateOutcome(merged(first.id, commit));
  await job.drain();
  return { job, first, commit };
}

/** A settled brief of the Goal in its backlog directory, as a manager writes it. */
function queueBrief(h: Harness, goal: string, name: string, paths: string[], body: string): string {
  const directory = backlogDirectory(h.settings.stateDirectory, goal);
  mkdirSync(directory, { recursive: true });
  const file = join(directory, name);
  writeFileSync(
    file,
    markdown
      .replace('lines: 100', `lines: ${defaultPolicy.brief.minimumEstimateLines}`)
      .replace('paths: [result.txt]', `paths: [${paths.join(', ')}]`)
      .replace('Write the requested result and commit it.', body),
  );
  return file;
}

/** The backlog run with the composed chain runtime; briefs written just now count as settled one minute later. */
function backlogRuntime(h: Harness): BacklogRuntime {
  const now = () => Date.now() + 60_000;
  return {
    db: h.store.db,
    stateDirectory: h.settings.stateDirectory,
    inbox: new SqliteManagerInbox(h.store.db, h.settings.stateDirectory, now),
    now,
    policy: h.settings.policy,
    chain: chainRuntime({ settings: h.settings, store: h.store, tasks: h.tasks }),
    async dispatch(file) {
      const task = h.tasks.dispatch(file, null);
      h.store.saveRetryIntent({ taskId: task.id, attempt: 0 }, {});
      return { taskId: task.id };
    },
    async continueTask() {
      throw new Error('this fixture has no continuations');
    },
    async cancel() {
      throw new Error('this fixture has no cancellations');
    },
  };
}

/** The fixture session's rollout as Codex writes it; the input of its latest request is the session's context size. */
function writeRollout(h: Harness, lastRequestInputTokens: number): void {
  const pool = h.settings.pools.find((candidate) => candidate.name === 'fixture')!;
  const directory = join(pool.configDirectory, 'sessions/2026/11/06');
  mkdirSync(directory, { recursive: true });
  const event = {
    timestamp: '2026-11-06T00:00:01Z',
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: {
        total_token_usage: { input_tokens: 400_000, cached_input_tokens: 0, output_tokens: 10 },
        last_token_usage: { input_tokens: lastRequestInputTokens, cached_input_tokens: 0, output_tokens: 10 },
      },
    },
  };
  writeFileSync(join(directory, 'rollout-2026-11-06T00-00-00-fixture-session.jsonl'), `${JSON.stringify(event)}\n`);
}

/** Recorded answers to offers, in order. */
function declines(h: Harness): unknown[] {
  return readFlow(h.store.db)
    .filter((event) => event.stage === 'chain' && event.action === 'declined')
    .map((event) => JSON.parse(event.detail ?? '{}'));
}

test('a landed session continues the next overlapping brief as a new task in a fresh worktree, resuming its session', async () => {
  const h = harness(recordingCli);
  cleanups.push(() => h.dispose());
  const { job, first, commit } = await landFirst(h);
  const goal = h.store.task(first.id).brief.goal;
  const profile = h.store.attempt({ taskId: first.id, attempt: 1 }).profile;
  writeRollout(h, 20_000);
  queueBrief(h, goal, 'follow-up.md', ['result.txt'], 'Write the follow-up result.');

  const sweep = await sweepBacklog(backlogRuntime(h));

  expect(sweep.chained).toEqual([
    { goal, taskId: expect.any(String), from: { taskId: first.id, attempt: 1 }, brief: 'follow-up.md' },
  ]);
  const { taskId } = sweep.chained[0]!;
  const next = h.store.task(taskId);
  expect(next.id).not.toBe(first.id);
  expect(next.brief.markdown).toContain('Write the follow-up result.');
  expect(next.worktree).not.toBe(h.store.task(first.id).worktree);
  expect(next.base).toBe(commit);
  expect(next.chain).toEqual({
    from: { taskId: first.id, attempt: 1 },
    session: 'fixture-session',
    cli: profile.cli,
    pool: 'fixture',
    model: profile.model,
    effort: profile.effort,
    depth: 2,
  });
  expect(readFileSync(join(h.store.task(first.id).worktree, '.temp/goal/launches.jsonl'), 'utf8')).toBe('false\n');

  job.resumePendingRetries();
  await job.drain();
  // The chained first attempt launches with the resume flag: its session is the landed task's session.
  expect(readFileSync(join(next.worktree, '.temp/goal/launches.jsonl'), 'utf8')).toBe('true\n');
  expect(h.store.attempt({ taskId, attempt: 1 }).session).toBe('fixture-session');

  // The chained task lands on its own: its own landing, and the landed task keeps its own.
  const nextCommit = git(h.store.task(taskId).worktree, 'rev-parse', 'HEAD');
  git(h.root, 'update-ref', 'refs/heads/dev', nextCommit, git(h.root, 'rev-parse', 'dev'));
  job.onGateOutcome(merged(taskId, nextCommit));
  await job.drain();
  expect(h.store.task(taskId).state).toBe('integrated');
  expect(h.store.task(taskId).integratedCommit).toBe(nextCommit);
  expect(h.store.task(first.id)).toMatchObject({ state: 'integrated', integratedCommit: commit, currentAttempt: 1 });

  // The flow report splits chained from unchained tasks on the same terms.
  const report = flowReport(
    readFlow(h.store.db),
    readFlowTasks(h.store.db).map((task) => ({ ...task, diffLines: 1 })),
    Date.now(),
  );
  expect(report.chain.offered).toBe(2);
  expect(report.chain.chained).toMatchObject({ tasks: 1, integrated: 1, lines: 1 });
  expect(report.chain.unchained).toMatchObject({ tasks: 1, integrated: 1, lines: 1 });
  expect(report.chain.declined).toEqual({});
}, 30_000);

test('a landed session ends as today when no settled brief of its Goal overlaps its paths', async () => {
  const h = harness(recordingCli);
  cleanups.push(() => h.dispose());
  const { first } = await landFirst(h);
  writeRollout(h, 20_000);
  queueBrief(h, h.store.task(first.id).brief.goal, 'unrelated.md', ['other.txt'], 'Write an unrelated result.');

  const sweep = await sweepBacklog(backlogRuntime(h));

  expect(sweep.chained).toEqual([]);
  // The brief still runs through the ordinary sweep, as a new task with a fresh session.
  expect(sweep.dispatched.map((entry) => entry.brief)).toEqual(['unrelated.md']);
  expect(h.store.task(sweep.dispatched[0]!.taskId).chain).toBeUndefined();
  expect(declines(h)).toEqual([{ reason: 'no-overlapping-brief' }]);
}, 30_000);

test('a landed session at the context bound ends as today even when a brief overlaps', async () => {
  const h = harness(recordingCli);
  cleanups.push(() => h.dispose());
  const { first } = await landFirst(h);
  // The session's latest model request carried exactly the bound; the rule is strictly below it.
  writeRollout(h, 150_000);
  queueBrief(h, h.store.task(first.id).brief.goal, 'follow-up.md', ['result.txt'], 'Write the follow-up result.');

  const sweep = await sweepBacklog(backlogRuntime(h));

  expect(sweep.chained).toEqual([]);
  expect(declines(h)).toEqual([{ reason: 'context-limit' }]);
  // The overlapping brief still runs through the ordinary sweep, in a fresh session.
  expect(sweep.dispatched.map((entry) => entry.brief)).toEqual(['follow-up.md']);
  expect(h.store.task(sweep.dispatched[0]!.taskId).chain).toBeUndefined();
}, 30_000);

test('a chain stops at policy.chain.maximumTasks', async () => {
  const h = harness(recordingCli);
  cleanups.push(() => h.dispose());
  h.settings.policy = readControlPolicy({ chain: { maximumTasks: 1 } });
  const { first } = await landFirst(h);
  queueBrief(h, h.store.task(first.id).brief.goal, 'follow-up.md', ['result.txt'], 'Write the follow-up result.');

  const sweep = await sweepBacklog(backlogRuntime(h));

  expect(sweep.chained).toEqual([]);
  expect(declines(h)).toEqual([{ reason: 'maximum-tasks' }]);
}, 30_000);

test('a Claude session reports the input of its latest request from its project transcript', () => {
  const directory = temporaryDirectory();
  cleanups.push(() => directory.close());
  const project = join(directory.path, 'projects', '-work-tree');
  mkdirSync(project, { recursive: true });
  writeFileSync(
    join(project, 'session-1.jsonl'),
    [
      {
        type: 'assistant',
        message: {
          usage: {
            input_tokens: 5,
            cache_read_input_tokens: 90_000,
            cache_creation_input_tokens: 1_000,
            output_tokens: 3,
          },
        },
      },
      { type: 'user', message: { content: 'next' } },
      {
        type: 'assistant',
        message: {
          usage: {
            input_tokens: 2,
            cache_read_input_tokens: 120_000,
            cache_creation_input_tokens: 500,
            output_tokens: 9,
          },
        },
      },
    ]
      .map((event) => JSON.stringify(event))
      .join('\n') + '\n',
  );
  expect(sessionContextTokens('claude', directory.path, 'session-1')).toBe(120_502);
  expect(sessionContextTokens('claude', directory.path, 'missing')).toBeNull();
});
