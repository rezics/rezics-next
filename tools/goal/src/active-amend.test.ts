import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseBrief, readRiskOwnership } from './briefs.ts';
import type { LandingRequest } from './contracts.ts';
import { briefProposalHash } from './durable-follow-up.ts';
import { authenticatedManager } from './priority-authority.ts';
import { settle } from './settle.ts';
import { git } from './tasks.ts';
import { harness, markdown } from './test-support.ts';
import { runWorkerCommand } from './worker-commands.ts';

function manager(h: ReturnType<typeof harness>, id = 'fixture') {
  const sessionId = randomUUID();
  h.store.db.exec('CREATE TABLE IF NOT EXISTS manager_sessions (id TEXT PRIMARY KEY, state TEXT NOT NULL)');
  h.store.db
    .query('INSERT INTO manager_sessions VALUES (?, ?)')
    .run(id, JSON.stringify({ id, kind: 'managed', provider: 'codex', status: 'running', threadId: sessionId }));
  const env = { GOAL_MANAGER: id, CODEX_THREAD_ID: sessionId };
  return { env, actor: authenticatedManager(h.store.db, env)! };
}

function active(h: ReturnType<typeof harness>) {
  const task = h.store.createTask(
    parseBrief(markdown, readRiskOwnership(h.settings.riskAreasFile)),
    {
      briefPath: h.briefFile,
      worktree: h.root,
      branch: 'main',
      base: git(h.root, ['rev-parse', 'HEAD']),
    },
    'implementation',
  );
  const attempt = h.store.nextAttempt({ taskId: task.id, attempt: 0 }, (attempt) => ({
    taskId: task.id,
    attempt,
    state: 'waiting',
    profile: { cli: 'codex', model: 'fixture', effort: 'medium', poolClass: 'codex' },
    pool: 'fixture',
    tableVersion: 'fixture',
    experiment: null,
    startedAt: new Date().toISOString(),
    endedAt: null,
    process: null,
    driver: null,
    logPath: join(h.settings.stateDirectory, 'runs', task.id, `${attempt}.jsonl`),
    evidencePath: join(h.settings.stateDirectory, 'evidence', task.id, String(attempt)),
    auxiliaryProcesses: [],
    session: 'retained-session',
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
    checks: [randomUUID()],
  }));
  const ref = { taskId: task.id, attempt: attempt.attempt };
  h.store.updateTask(ref, (current) => {
    current.state = 'running';
  });
  return { task: h.store.task(task.id), attempt, ref };
}

function replacement(
  h: ReturnType<typeof harness>,
  text = markdown
    .replace('paths: [result.txt]', 'paths: [result.txt, caller.txt]')
    .replace('command: [bun, test]', 'command: [bun, run, typecheck]'),
) {
  const file = join(h.settings.stateDirectory, `amend-${randomUUID()}.md`);
  writeFileSync(file, text);
  return file;
}

test('active owner amendment retains the same check waiter, source and retry intent without another writer', async () => {
  const h = harness();
  try {
    const { task, attempt, ref } = active(h);
    const owner = manager(h);
    const file = replacement(h);
    h.store.saveRetryIntent(ref, { freshSession: true });
    const intent = h.store.retryIntent(ref);
    const output: string[] = [];
    expect(
      await runWorkerCommand('amend', [task.id, '--active', '--expected-attempt', '1', '--brief', file], {
        tasks: h.tasks,
        env: owner.env,
        print: (value) => output.push(value),
      }),
    ).toBe(0);
    const current = h.store.task(task.id);
    expect(current).toEqual({ ...task, brief: current.brief, briefPath: current.briefPath });
    expect(current.brief.paths).toEqual(['result.txt', 'caller.txt']);
    expect(readFileSync(current.briefPath, 'utf8')).toBe(readFileSync(file, 'utf8'));
    expect(h.store.attempts(task.id)).toEqual([attempt]);
    expect(h.store.retryIntent(ref)).toEqual(intent);
    expect(JSON.parse(output[0]!)).toMatchObject({ ...ref, status: 'amended' });
    expect(
      JSON.parse(h.store.events(task.id, 1).find((event) => event.kind === 'active-contract-amended')!.body),
    ).toMatchObject({
      actor: owner.actor,
      previous: { sha256: briefProposalHash(markdown) },
      current: { sha256: briefProposalHash(current.brief.markdown) },
    });
    expect(h.tasks.amend(task.id, { expectedAttempt: 1, brief: file, active: true }, owner.actor).status).toBe(
      'unchanged',
    );
  } finally {
    h.dispose();
  }
});

test('settlement publishes the latest owner scope and gate even when amendment races its earlier snapshot', async () => {
  const h = harness();
  const write = h.store.write.bind(h.store);
  try {
    const { task, attempt, ref } = active(h);
    const owner = manager(h);
    const file = replacement(h);
    writeFileSync(join(task.worktree, 'result.txt'), 'complete');
    writeFileSync(join(task.worktree, 'caller.txt'), 'reached caller repair');
    git(task.worktree, ['add', 'result.txt', 'caller.txt']);
    git(task.worktree, ['commit', '-m', 'Complete fixture']);
    mkdirSync(dirname(attempt.logPath), { recursive: true });
    writeFileSync(
      attempt.logPath,
      JSON.stringify({
        type: 'item.completed',
        item: {
          type: 'agent_message',
          text: JSON.stringify({ status: 'success', summary: 'complete', checks: [] }),
        },
      }) + '\n',
    );
    let amended = false;
    // This runs after settlement has captured its pre-enqueue task, before its final transaction begins.
    h.store.write = (requested, action) => {
      if (!amended && h.store.record(ref)) {
        amended = true;
        h.tasks.amend(task.id, { expectedAttempt: 1, brief: file, active: true }, owner.actor);
      }
      return write(requested, action);
    };
    const landings: LandingRequest[] = [];
    await settle(
      h.tasks,
      { attempt, exited: Promise.resolve({ code: 0, signal: null }) },
      {
        enqueue: (request) => {
          landings.push(request);
        },
      },
    );
    expect(amended).toBe(true);
    expect(landings).toHaveLength(1);
    expect(landings[0]).toMatchObject({
      ...ref,
      declaredPaths: ['result.txt', 'caller.txt'],
      gate: ['bun', 'run', 'typecheck'],
    });
    expect(h.store.task(task.id).currentAttempt).toBe(1);
    expect(h.store.attempt(ref).checks).toEqual(attempt.checks);
    expect(() => h.tasks.amend(task.id, { expectedAttempt: 1, brief: file, active: true }, owner.actor)).toThrow(
      'before landing',
    );
  } finally {
    h.store.write = write;
    h.dispose();
  }
});

test('active amendment retains generation and authenticated-owner fences and refuses proof/source/profile changes', () => {
  const h = harness();
  try {
    const { task, ref } = active(h);
    const owner = manager(h);
    const stranger = manager(h, 'stranger');
    const file = replacement(h);
    const options = { expectedAttempt: 1, brief: file, active: true };
    const before = h.store.task(task.id);
    expect(() => h.tasks.amend(task.id, { ...options, expectedAttempt: 2 }, owner.actor)).toThrow(
      'is stale; the current attempt is 1',
    );
    expect(() => h.tasks.amend(task.id, options, stranger.actor)).toThrow('authenticated');
    expect(() => h.tasks.amend(task.id, { ...options, active: false }, owner.actor)).toThrow('never-started');
    expect(() =>
      h.tasks.amend(
        task.id,
        { ...options, brief: replacement(h, markdown.replace('kind: implementation', 'kind: interface') + '\n') },
        owner.actor,
      ),
    ).toThrow('source, kind and model');
    for (const front of ['target: stabilize', 'model: fixture-other']) {
      expect(() =>
        h.tasks.amend(
          task.id,
          { ...options, brief: replacement(h, markdown.replace('goal: fixture', `goal: fixture\n${front}`)) },
          owner.actor,
        ),
      ).toThrow('source, kind and model');
    }
    expect(h.store.task(task.id)).toEqual(before);
    h.settings.integration.operationsManager = 'operations';
    const operations = manager(h, 'operations');
    expect(h.tasks.amend(task.id, options, operations.actor).status).toBe('amended');
    h.store.updateTask(ref, (current) => {
      current.brief.kind = 'verification';
    });
    expect(() => h.tasks.amend(task.id, options, owner.actor)).toThrow('ordinary dev');
  } finally {
    h.dispose();
  }
});
