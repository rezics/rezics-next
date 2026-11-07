import { expect, test } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { openDb } from './db.ts';
import { launch } from './launch.ts';
import { prepareOwnerDecisionPrompt, submitOwnerDecision } from './owner-decisions.ts';
import { readControlPolicy } from './policy.ts';
import { waitForWorkerExit } from './process.ts';
import { WorkerStore } from './store.ts';
import { WorkerTasks } from './tasks.ts';
import { harness, reading } from './test-support.ts';
import type { Attempt, Task } from './types.ts';

const captureCli = `#!/usr/bin/env bun
import { appendFileSync, mkdirSync } from 'node:fs';
mkdirSync('.temp', { recursive: true });
appendFileSync('.temp/prompts.jsonl', JSON.stringify({prompt: process.argv.at(-1), attempt: process.env.GOAL_ATTEMPT}) + String.fromCharCode(10));
console.log(JSON.stringify({type:'thread.started',thread_id:'retained-worker-session'}));
console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'RESULT: success'}}));
`;
const ownerEnv = { GOAL_MANAGER: 'fixture', CODEX_THREAD_ID: 'owner-session' };

function owner(h: ReturnType<typeof harness>) {
  h.store.db.exec('CREATE TABLE manager_sessions (id TEXT PRIMARY KEY, state TEXT NOT NULL)');
  h.store.db.query('INSERT INTO manager_sessions VALUES (?, ?)').run(
    'fixture',
    JSON.stringify({
      id: 'fixture',
      status: 'running',
      threadId: 'owner-session',
    }),
  );
}

function next(h: ReturnType<typeof harness>, task: Task) {
  const ref = { taskId: task.id, attempt: h.store.task(task.id).currentAttempt };
  const attempt = h.store.nextAttempt(ref, (attempt): Attempt => ({
    taskId: task.id,
    attempt,
    state: 'exited',
    profile: { cli: 'codex', model: 'gpt-6-luna', effort: 'high', poolClass: 'codex' },
    pool: 'fixture',
    tableVersion: 'fixture',
    experiment: null,
    startedAt: new Date().toISOString(),
    endedAt: new Date().toISOString(),
    process: null,
    driver: null,
    logPath: join(h.settings.stateDirectory, 'runs', task.id, `${attempt}.jsonl`),
    evidencePath: join(h.settings.stateDirectory, 'evidence', task.id, String(attempt)),
    auxiliaryProcesses: [],
    session: 'retained-worker-session',
    fixRound: 0,
    consulted: false,
    previousFailure: null,
    failure: null,
    escalation: null,
    before: null,
    after: null,
    exitCode: 0,
    result: 'RESULT: success',
    blocker: null,
    approaches: [],
  }));
  h.store.updateTask(attempt, (current) => {
    current.state = 'stopped';
  });
  mkdirSync(dirname(attempt.logPath), { recursive: true });
  return attempt;
}

function captured(task: Task) {
  return readFileSync(join(task.worktree, '.temp/prompts.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as { prompt: string; attempt: string });
}

function accept(
  h: ReturnType<typeof harness>,
  attempt: Attempt,
  decisionId = 'caller-rule',
  summary = 'Implement the reached caller correction.',
) {
  submitOwnerDecision(
    h.store,
    attempt,
    {
      decisionId,
      summary,
      documentRefs: [{ path: 'available.md', change: 'Original caller contract.' }, { path: 'missing.md' }],
    },
    ownerEnv,
  );
}

test('pending attempt-two intent survives restart and ordinary retry, then partial delivery resumes without repeated context', async () => {
  const h = harness(captureCli);
  let restarted: WorkerStore | undefined;
  try {
    h.settings.policy = readControlPolicy({ workerPrompt: { characters: 100000 }, brief: { bytes: 100000 } });
    owner(h);
    const routing = JSON.parse(readFileSync(h.settings.routingFile, 'utf8'));
    routing.experiments = [];
    h.settings.routingFile = join(h.settings.stateDirectory, 'fixture-routing.json');
    writeFileSync(h.settings.routingFile, JSON.stringify(routing));
    const task = h.tasks.dispatch(h.briefFile);
    next(h, task);
    const original = next(h, task);
    writeFileSync(join(task.worktree, 'available.md'), 'Caller contract.');
    accept(h, original);
    const accepted = h.store.ownerDecisionEvents(original)[0]!;
    // Simulate the existing accepted event format from before contract binding was introduced.
    const legacy = JSON.parse(accepted.body);
    delete legacy.contractSha256;
    h.store.db.query('UPDATE worker_events SET body=? WHERE sequence=?').run(JSON.stringify(legacy), accepted.sequence);
    restarted = new WorkerStore(openDb(join(h.settings.stateDirectory, 'goal.sqlite')));
    const tasks = new WorkerTasks(h.settings, restarted, (pool) => reading(pool));
    const worker = await tasks.retry(task.id);
    await worker.exited;
    expect(worker.attempt.attempt).toBe(3);
    expect(captured(task).at(-1)).toMatchObject({ attempt: '3' });
    expect(captured(task).at(-1)!.prompt).toContain('Implement the reached caller correction.');
    expect(captured(task).at(-1)!.prompt).toContain('available.md — Original caller contract.');
    let deliveries = restarted.events(task.id).filter((event) => event.kind === 'owner-contract-decision-delivery');
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]!.attempt).toBe(3);
    expect(JSON.parse(deliveries[0]!.body)).toMatchObject({
      decisionId: 'fixture:caller-rule',
      decisionSequence: accepted.sequence,
      originatingAttempt: 2,
      managerId: 'fixture',
      senderSessionId: 'owner-session',
      receivingAttempt: 3,
      launchSequence: expect.any(Number),
      summaryDelivered: true,
      documentRefs: [
        { path: 'available.md', status: 'delivered' },
        { path: 'missing.md', status: 'pending' },
      ],
    });
    let resumed = await launch(
      restarted,
      restarted.task(task.id),
      restarted.attempt(worker.attempt),
      h.settings.pools[0]!,
      'Continue after the checks.',
      h.settings.codex,
      'retained-worker-session',
      h.settings.policy,
    );
    await resumed.exited;
    expect(captured(task).at(-1)!.prompt).not.toContain('Decision: Implement');
    expect(captured(task).at(-1)!.prompt).not.toContain('available.md');
    expect(captured(task).at(-1)!.prompt).toContain('missing.md');
    writeFileSync(join(task.worktree, 'missing.md'), 'Now available.');
    resumed = await launch(
      restarted,
      restarted.task(task.id),
      restarted.attempt(worker.attempt),
      h.settings.pools[0]!,
      'Continue.',
      h.settings.codex,
      'retained-worker-session',
      h.settings.policy,
    );
    await resumed.exited;
    deliveries = restarted.events(task.id).filter((event) => event.kind === 'owner-contract-decision-delivery');
    expect(JSON.parse(deliveries.at(-1)!.body).documentRefs).toEqual([{ path: 'missing.md', status: 'delivered' }]);
    restarted = new WorkerStore(restarted.db);
    const retry = await new WorkerTasks(h.settings, restarted, (pool) => reading(pool)).retry(task.id, {
      profile: worker.attempt.profile,
    });
    await retry.exited;
    expect(retry.attempt.attempt).toBe(4);
    expect(captured(task).at(-1)!.prompt).not.toContain('Owner decision');
    expect(restarted.events(task.id).filter((event) => event.kind === 'owner-contract-decision-delivery')).toHaveLength(
      3,
    );
  } finally {
    restarted?.db.close();
    await h.disposeAsync();
  }
});

test('failed or unacknowledged launch leaves intent pending and a newer decision supersedes it at actual spawn', async () => {
  const h = harness(captureCli);
  const write = h.store.write.bind(h.store);
  try {
    owner(h);
    const task = h.tasks.dispatch(h.briefFile);
    const attempt = next(h, task);
    accept(h, attempt, 'old-rule', 'Use the old caller rule.');
    const pool = h.settings.pools[0]!;
    await expect(
      launch(h.store, h.store.task(task.id), attempt, { ...pool, command: '/missing/worker-cli' }, 'Continue.'),
    ).rejects.toThrow('Worker CLI not found');
    expect(h.store.events(task.id).filter((event) => event.kind === 'owner-contract-decision-delivery')).toEqual([]);
    expect(prepareOwnerDecisionPrompt(h.store, h.store.task(task.id), attempt, 'Continue.').prompt).toContain(
      'old caller rule',
    );
    const recordDelivery = h.store.recordOwnerDecisionDelivery;
    h.store.recordOwnerDecisionDelivery = () => {
      throw new Error('crash before launch acknowledgement');
    };
    try {
      await expect(launch(h.store, h.store.task(task.id), attempt, pool, 'Continue.')).rejects.toThrow(
        'crash before launch acknowledgement',
      );
    } finally {
      h.store.recordOwnerDecisionDelivery = recordDelivery;
    }
    await waitForWorkerExit(null, attempt.logPath);
    expect(h.store.events(task.id).filter((event) => event.kind === 'owner-contract-decision-delivery')).toEqual([]);
    expect(prepareOwnerDecisionPrompt(h.store, h.store.task(task.id), attempt, 'Continue.').prompt).toContain(
      'old caller rule',
    );
    // A newer accepted decision wins even if it arrives after launch's initial task snapshot.
    let inserted = false;
    h.store.write = (ref, action) => {
      if (!inserted) {
        inserted = true;
        accept(h, attempt, 'current-rule', 'Use the current caller rule.');
      }
      return write(ref, action);
    };
    const worker = await launch(h.store, h.store.task(task.id), attempt, pool, 'Continue.');
    expect(await worker.exited).toMatchObject({ code: 0 });
    expect(readFileSync(attempt.logPath + '.err', 'utf8')).toBe('');
    expect(captured(task).at(-1)!.prompt).toContain('current caller rule');
    expect(captured(task).at(-1)!.prompt).not.toContain('old caller rule');
  } finally {
    h.store.write = write;
    await h.disposeAsync();
  }
});

test('canonical replacement permanently supersedes old intent, and authority and event provenance stay scoped', () => {
  const h = harness();
  try {
    owner(h);
    const task = h.tasks.dispatch(h.briefFile);
    const attempt = next(h, task);
    accept(h, attempt);
    const original = h.store.task(task.id).brief.markdown;
    const prepared = () => prepareOwnerDecisionPrompt(h.store, h.store.task(task.id), attempt, 'Continue.');
    expect(prepared().delivery).toBeDefined();
    h.store.updateTask(attempt, (current) => {
      current.brief.markdown += '\nUse the rewritten canonical contract.\n';
    });
    expect(prepared().delivery).toBeUndefined();
    h.store.updateTask(attempt, (current) => {
      current.brief.markdown = original;
    });
    accept(h, attempt); // Reusing an old decision identity cannot restore superseded intent.
    expect(prepared().delivery).toBeUndefined();
    accept(h, attempt, 'new-rule', 'Apply the new owner rule.');
    expect(prepared().prompt).toContain('new owner rule');
    h.store.updateTask(attempt, (current) => {
      current.brief.manager = 'different-owner';
    });
    expect(prepared().delivery).toBeUndefined();
    expect(() => accept(h, attempt, 'unauthorized')).toThrow('authenticated owning manager');
    expect(() => submitOwnerDecision(h.store, { taskId: task.id, attempt: 0 }, {}, ownerEnv)).toThrow('stale');
  } finally {
    h.dispose();
  }
});

test('legacy unbound intent stays superseded after an already-retained canonical retry and later generations', () => {
  const h = harness();
  try {
    owner(h);
    const task = h.tasks.dispatch(h.briefFile);
    next(h, task);
    const second = next(h, task);
    accept(h, second);
    const accepted = h.store.ownerDecisionEvents(second)[0]!;
    const body = JSON.parse(accepted.body);
    delete body.contractSha256;
    h.store.db.query('UPDATE worker_events SET body=? WHERE sequence=?').run(JSON.stringify(body), accepted.sequence);
    const third = next(h, task);
    h.store.updateAttempt(third, (current) => {
      current.newBriefHash = 'a'.repeat(64);
    });
    expect(prepareOwnerDecisionPrompt(h.store, h.store.task(task.id), third, 'Continue.').delivery).toBeUndefined();
    const fourth = next(h, task);
    expect(prepareOwnerDecisionPrompt(h.store, h.store.task(task.id), fourth, 'Continue.').delivery).toBeUndefined();
  } finally {
    h.dispose();
  }
});
