import { expect, test } from 'bun:test';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { historicalManager } from '../test-support/historical-manager.ts';
import { importAttempt } from './import-attempt.ts';
import { runWorkerCommand } from './worker-commands.ts';
import { git } from './tasks.ts';
import type { Attempt, Task } from './types.ts';
import { harness, markdown } from './test-support.ts';
import { authenticatedManager } from './priority-authority.ts';

function runtimeFor(h: ReturnType<typeof harness>) {
  return { settings: h.settings, db: h.store.db, store: h.store, tasks: h.tasks, drain: async () => {} } as never;
}

function addManager(
  db: ReturnType<typeof harness>['store']['db'],
  id: string,
  sessionId: string,
  supermanager: string,
) {
  if (!db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'manager_sessions'").get())
    db.exec('CREATE TABLE manager_sessions (id TEXT PRIMARY KEY, state TEXT NOT NULL)');
  db.query('INSERT OR REPLACE INTO manager_sessions (id, state) VALUES (?, ?)').run(
    id,
    JSON.stringify({ id, engine: 'codex', status: 'running', threadId: sessionId, supermanager }),
  );
}

function authenticatePriorityManagers(h: ReturnType<typeof harness>, task: Task, ownerSession = 'owner-session') {
  const hasManagerSessions = h.store.db
    .query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'manager_sessions'")
    .get();
  if (!hasManagerSessions || !h.store.db.query('SELECT 1 FROM manager_sessions WHERE id = ?').get(task.brief.manager))
    addManager(h.store.db, task.brief.manager, ownerSession, 'supermanager');
  addManager(h.store.db, 'supermanager', 'super-session', 'root');
}

function ownerEnvironment(task: Task, sessionId = 'owner-session'): NodeJS.ProcessEnv {
  return { CODEX_THREAD_ID: sessionId, GOAL_MANAGER: task.brief.manager };
}

async function makeCritical(h: ReturnType<typeof harness>, task: Task, ownerSession = 'owner-session') {
  authenticatePriorityManagers(h, task, ownerSession);
  const runtime = runtimeFor(h);
  const grants: string[] = [];
  await runWorkerCommand('priority', ['grant', task.id], {
    runtime,
    env: { CODEX_THREAD_ID: 'super-session', GOAL_MANAGER: 'supermanager' },
    print: (value) => grants.push(value),
  });
  await runWorkerCommand('priority', [task.id, 'critical'], {
    runtime,
    env: ownerEnvironment(task, ownerSession),
  });
  return JSON.parse(grants[0]!) as { id: string };
}

function existingOwner(h: ReturnType<typeof harness>, task: Task) {
  h.store.db.exec('CREATE TABLE IF NOT EXISTS manager_sessions (id TEXT PRIMARY KEY, state TEXT NOT NULL)');
  const manager = task.brief.manager;
  const { threadId: sessionId } = historicalManager(h.store.db, h.root, {
    id: manager,
    goal: task.brief.goal,
    engine: 'codex',
    status: 'running',
  });
  if (!sessionId) throw new Error('The fixture owner must have an active thread');
  const environment = ownerEnvironment(task, sessionId);
  expect(authenticatedManager(h.store.db, environment)).toEqual({ id: manager, sessionId });
  return { sessionId, environment };
}

function seedStoppedAttempt(h: ReturnType<typeof harness>, task: Task, state: 'stopped' | 'held' = 'stopped') {
  const startedAt = new Date().toISOString();
  const attempt = h.store.nextAttempt({ taskId: task.id, attempt: 0 }, (n): Attempt => ({
    taskId: task.id,
    attempt: n,
    state: 'exited',
    profile: { cli: 'codex', model: 'gpt-6-luna', effort: 'high', poolClass: 'codex' },
    pool: 'fixture',
    tableVersion: 'fixture',
    experiment: null,
    startedAt,
    endedAt: startedAt,
    process: null,
    driver: null,
    logPath: join(h.settings.stateDirectory, 'runs', task.id, `${n}.jsonl`),
    evidencePath: join(h.settings.stateDirectory, 'evidence', task.id, String(n)),
    auxiliaryProcesses: [],
    session: 'stopped-session',
    fixRound: 0,
    consulted: false,
    previousFailure: null,
    failure: null,
    escalation: null,
    before: null,
    after: null,
    exitCode: 1,
    result: 'stopped before retry',
    blocker: null,
    approaches: [],
  }));
  const ref = { taskId: task.id, attempt: attempt.attempt };
  h.store.updateTask(ref, (current) => {
    current.state = state;
  });
  return ref;
}

function writeAmendment(
  h: ReturnType<typeof harness>,
  name: string,
  source: string,
  criticalPath: boolean,
  note: string,
): string {
  const amended = source.replace(/criticalPath: (?:true|false)/, `criticalPath: ${criticalPath}`) + `\n${note}\n`;
  const path = join(h.settings.stateDirectory, `${name}.md`);
  writeFileSync(path, amended);
  return path;
}

function priorityPath(task: Task): string {
  return join(task.worktree, '.temp/goal/task-priority');
}

async function retryCommand(
  h: ReturnType<typeof harness>,
  taskId: string,
  briefPath: string,
  env: NodeJS.ProcessEnv = { GOAL_MANAGER: 'fixture' },
): Promise<number> {
  return runWorkerCommand('retry', [taskId, '--brief', briefPath], { runtime: runtimeFor(h), env });
}

test('retry --brief retains a consumed critical grant and its exact audit without another priority decision', async () => {
  const h = harness();
  try {
    const task = h.tasks.dispatch(h.briefFile);
    const ref = seedStoppedAttempt(h, task);
    const owner = existingOwner(h, task);
    const grant = await makeCritical(h, task, owner.sessionId);
    const before = h.store.task(task.id);
    const beforeAttempt = h.store.attempt(ref);
    const sourceHead = git(task.worktree, ['rev-parse', 'HEAD']);
    const priorityBytes = readFileSync(priorityPath(task));
    expect(before.priorityGrants?.[0]).toMatchObject({ id: grant.id, consumedBy: task.brief.manager });
    expect(before.priorityHistory?.at(-1)).toMatchObject({ value: 'critical', grantId: grant.id });

    const corrected = writeAmendment(h, 'critical-correction', markdown, true, 'Corrected acceptance details.');
    const correctedText = readFileSync(corrected, 'utf8');
    await retryCommand(h, task.id, corrected, owner.environment);

    const after = h.store.task(task.id);
    const intent = h.store.retryIntent(ref);
    expect(after).toMatchObject({
      id: task.id,
      currentAttempt: ref.attempt,
      state: 'ready',
      brief: { criticalPath: true, markdown: correctedText },
      branch: before.branch,
      worktree: before.worktree,
    });
    expect(after.priorityGrants).toEqual(before.priorityGrants);
    expect(after.priorityHistory).toEqual(before.priorityHistory);
    expect(readFileSync(priorityPath(task))).toEqual(priorityBytes);
    expect(readFileSync(priorityPath(task), 'utf8')).toBe('critical\n');
    expect(h.store.attempt(ref)).toMatchObject({ state: 'exited', session: beforeAttempt.session });
    expect(h.store.attempts(task.id)).toHaveLength(1);
    expect(git(task.worktree, ['rev-parse', 'HEAD'])).toBe(sourceHead);
    expect(intent).toMatchObject({ taskId: task.id, attempt: ref.attempt, status: 'pending', options: {} });
    expect(h.store.retryIntents().filter((value) => value.taskId === task.id)).toHaveLength(1);
  } finally {
    h.dispose();
  }
});

test('a held stopped retry reshapes its one pending intent while retaining critical priority', async () => {
  const h = harness();
  try {
    const dependency = h.tasks.dispatch(h.writeBrief('Complete the prerequisite for the held retry.'));
    const heldSource = markdown.replace('waiting: []', `waiting: []\nafter: [${dependency.id}]`);
    const sourcePath = join(h.settings.stateDirectory, 'held-source.md');
    writeFileSync(sourcePath, heldSource);
    const task = h.tasks.dispatch(sourcePath);
    const ref = seedStoppedAttempt(h, task, 'held');
    const owner = existingOwner(h, task);
    const grant = await makeCritical(h, task, owner.sessionId);
    h.store.saveRetryIntent(ref, { evidence: 'prior-evidence' });
    const before = h.store.task(task.id);
    const beforeAttempt = h.store.attempt(ref);
    const corrected = writeAmendment(h, 'held-critical-correction', heldSource, true, 'Clarified held acceptance.');
    const correctedText = readFileSync(corrected, 'utf8');

    await retryCommand(h, task.id, corrected, owner.environment);

    const after = h.store.task(task.id);
    const intent = h.store.retryIntent(ref);
    expect(after).toMatchObject({
      state: 'held',
      currentAttempt: ref.attempt,
      brief: { criticalPath: true, markdown: correctedText },
    });
    expect(after.priorityGrants).toEqual(before.priorityGrants);
    expect(after.priorityGrants?.[0]).toMatchObject({ id: grant.id, consumedBy: task.brief.manager });
    expect(after.priorityHistory).toEqual(before.priorityHistory);
    expect(h.store.attempt(ref)).toMatchObject({ state: 'exited', session: beforeAttempt.session });
    expect(intent).toMatchObject({ ...ref, status: 'pending', options: { evidence: 'prior-evidence' } });
    expect(h.store.retryIntents().filter((value) => value.taskId === task.id)).toHaveLength(1);
    expect(h.store.attempts(task.id)).toHaveLength(1);
  } finally {
    h.dispose();
  }
});

test('retained normal priority and its audit survive an authenticated-owner corrective retry', async () => {
  const h = harness();
  try {
    const task = h.tasks.dispatch(h.briefFile);
    const ref = seedStoppedAttempt(h, task);
    const owner = existingOwner(h, task);
    const grant = await makeCritical(h, task, owner.sessionId);
    await runWorkerCommand('priority', [task.id, 'normal'], {
      runtime: runtimeFor(h),
      env: owner.environment,
    });
    const before = h.store.task(task.id);
    const priorityBytes = readFileSync(priorityPath(task));
    expect(before.priorityHistory?.map((entry) => entry.value)).toEqual(['critical', 'normal']);

    const corrected = writeAmendment(h, 'normal-correction', markdown, false, 'Clarified normal acceptance.');
    await retryCommand(h, task.id, corrected, owner.environment);

    const after = h.store.task(task.id);
    expect(after.brief.criticalPath).toBe(false);
    expect(after.taskClass).not.toBe('critical-path');
    expect(after.priorityHistory).toEqual(before.priorityHistory);
    expect(after.priorityGrants).toEqual(before.priorityGrants);
    expect(after.priorityGrants?.[0]).toMatchObject({ id: grant.id, consumedBy: task.brief.manager });
    expect(readFileSync(priorityPath(task))).toEqual(priorityBytes);
    expect(readFileSync(priorityPath(task), 'utf8')).toBe('normal\n');
    expect(h.store.attempt(ref).session).toBe('stopped-session');
    expect(h.store.retryIntent(ref)).toMatchObject({ status: 'pending' });
  } finally {
    h.dispose();
  }
});

test('an imported critical task keeps unknown priority provenance when a corrective retry retains it', async () => {
  const h = harness();
  try {
    const task = h.tasks.dispatch(h.briefFile);
    const logPath = join(h.settings.stateDirectory, 'legacy.jsonl');
    const now = Date.now();
    writeFileSync(
      logPath,
      [
        JSON.stringify({ type: 'thread.started', thread_id: 'legacy-session' }),
        JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'RESULT: stopped' } }),
        JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 2, output_tokens: 1 } }),
      ].join('\n') + '\n',
    );
    importAttempt(h.tasks, logPath, {
      taskId: task.id,
      startedAt: new Date(now - 1000).toISOString(),
      endedAt: new Date(now).toISOString(),
      profile: { cli: 'codex', model: 'gpt-6-luna', effort: 'high', poolClass: 'codex' },
      pool: 'fixture',
      outcome: 'stopped',
    });
    const ref = { taskId: task.id, attempt: 1 };
    h.store.updateTask(ref, (current) => {
      current.brief.criticalPath = true;
      current.taskClass = 'critical-path';
      delete current.priorityHistory;
      delete current.priorityGrants;
    });
    const owner = existingOwner(h, task);
    authenticatePriorityManagers(h, task, owner.sessionId);
    mkdirSync(join(task.worktree, '.temp/goal'), { recursive: true });
    writeFileSync(priorityPath(task), 'critical\n');
    const beforeAttempt = h.store.attempt(ref);
    const corrected = writeAmendment(h, 'legacy-correction', markdown, true, 'Corrected imported contract.');

    await retryCommand(h, task.id, corrected, owner.environment);

    const after = h.store.task(task.id);
    expect(after.brief.criticalPath).toBe(true);
    expect(after.taskClass).toBe('implementation');
    expect(after.priorityHistory).toBeUndefined();
    expect(after.priorityGrants).toBeUndefined();
    expect(readFileSync(priorityPath(task), 'utf8')).toBe('critical\n');
    expect(h.store.attempt(ref)).toMatchObject({ escalation: 'import', session: beforeAttempt.session });
    expect(h.store.retryIntent(ref)).toMatchObject({ status: 'pending' });
  } finally {
    h.dispose();
  }
});

test('an unchanged-critical amended retry still requires the current unambiguous owner session', async () => {
  const h = harness();
  try {
    const task = h.tasks.dispatch(h.briefFile);
    const ref = seedStoppedAttempt(h, task);
    const owner = existingOwner(h, task);
    await makeCritical(h, task, owner.sessionId);
    const before = h.store.task(task.id);
    const beforeBriefFiles = readdirSync(join(h.settings.stateDirectory, 'briefs'));
    const amendment = writeAmendment(h, 'unchanged-critical-correction', markdown, true, 'Clarified acceptance only.');
    const managerId = task.brief.manager;
    const rejected: NodeJS.ProcessEnv[] = [
      { GOAL_MANAGER: managerId },
      { CODEX_THREAD_ID: owner.sessionId, CLAUDE_CODE_SESSION_ID: 'other-session', GOAL_MANAGER: managerId },
      { CODEX_THREAD_ID: 'wrong-session', GOAL_MANAGER: managerId },
      { CODEX_THREAD_ID: owner.sessionId, GOAL_MANAGER: 'wrong-manager' },
    ];
    for (const env of rejected) {
      await expect(retryCommand(h, task.id, amendment, env)).rejects.toThrow(
        'priority changes require an authenticated manager session',
      );
      expect(h.store.task(task.id)).toEqual(before);
      expect(h.store.retryIntent(ref)).toBeUndefined();
    }

    const ownerRow = h.store.db.query('SELECT state FROM manager_sessions WHERE id = ?').get(managerId) as {
      state: string;
    };
    const liveOwner = JSON.parse(ownerRow.state) as Record<string, unknown>;
    h.store.db
      .query('UPDATE manager_sessions SET state = ? WHERE id = ?')
      .run(JSON.stringify({ ...liveOwner, status: 'stopped' }), managerId);
    await expect(retryCommand(h, task.id, amendment, owner.environment)).rejects.toThrow(
      'priority changes require an authenticated manager session',
    );
    expect(h.store.task(task.id)).toEqual(before);
    expect(h.store.retryIntent(ref)).toBeUndefined();
    expect(readdirSync(join(h.settings.stateDirectory, 'briefs'))).toEqual(beforeBriefFiles);
  } finally {
    h.dispose();
  }
});

test('unauthenticated substantive retries cannot escalate or demote priority and leave no partial intent', async () => {
  const h = harness();
  try {
    const normal = h.tasks.dispatch(h.briefFile);
    const normalRef = seedStoppedAttempt(h, normal);
    const escalate = writeAmendment(h, 'unauthorized-escalation', markdown, true, 'Escalation must be authorized.');
    const normalBefore = h.store.task(normal.id);
    const briefFilesBefore = readdirSync(join(h.settings.stateDirectory, 'briefs'));
    await expect(retryCommand(h, normal.id, escalate)).rejects.toThrow(
      'priority changes require an authenticated manager session',
    );
    expect(h.store.task(normal.id)).toEqual(normalBefore);
    expect(h.store.retryIntent(normalRef)).toBeUndefined();
    expect(readdirSync(join(h.settings.stateDirectory, 'briefs'))).toEqual(briefFilesBefore);

    const critical = h.tasks.dispatch(h.writeBrief('Complete the separate critical task.'));
    const criticalRef = seedStoppedAttempt(h, critical);
    await makeCritical(h, critical);
    const criticalBefore = h.store.task(critical.id);
    const priorityBytes = readFileSync(priorityPath(critical));
    const demote = writeAmendment(h, 'unauthorized-demotion', markdown, false, 'Demotion must be authorized.');
    const beforeDemotionFiles = readdirSync(join(h.settings.stateDirectory, 'briefs'));
    await expect(retryCommand(h, critical.id, demote)).rejects.toThrow(
      'priority changes require an authenticated manager session',
    );
    expect(h.store.task(critical.id)).toEqual(criticalBefore);
    expect(h.store.retryIntent(criticalRef)).toBeUndefined();
    expect(readFileSync(priorityPath(critical))).toEqual(priorityBytes);
    expect(readdirSync(join(h.settings.stateDirectory, 'briefs'))).toEqual(beforeDemotionFiles);
  } finally {
    h.dispose();
  }
});

test('retry brief identity, stale generations and concurrent intent submission remain fenced', async () => {
  const h = harness();
  try {
    const task = h.tasks.dispatch(h.briefFile);
    const ref = seedStoppedAttempt(h, task);
    const base = markdown;
    const wrongGoal = writeAmendment(
      h,
      'wrong-goal',
      base.replace('goal: fixture', 'goal: another-goal'),
      false,
      'Wrong goal.',
    );
    const wrongManager = writeAmendment(
      h,
      'wrong-manager',
      base.replace('goal: fixture', 'goal: fixture\nmanager: another-manager'),
      false,
      'Wrong manager.',
    );
    const before = h.store.task(task.id);
    await expect(retryCommand(h, task.id, wrongGoal)).rejects.toThrow(
      'a reshaped brief must keep the same goal and manager',
    );
    await expect(retryCommand(h, task.id, wrongManager)).rejects.toThrow(
      'a reshaped brief must keep the same goal and manager',
    );
    expect(h.store.task(task.id)).toEqual(before);
    expect(h.store.retryIntent(ref)).toBeUndefined();

    const correction = writeAmendment(h, 'fenced-correction', base, false, 'Current generation correction.');
    await expect(retryCommand(h, task.id, correction, { GOAL_TASK_ID: task.id, GOAL_ATTEMPT: '0' })).rejects.toThrow(
      ' is stale; the current attempt is 1',
    );
    expect(h.store.task(task.id)).toEqual(before);
    expect(h.store.retryIntent(ref)).toBeUndefined();

    const owner = existingOwner(h, task);
    const [first, second] = await Promise.allSettled([
      runWorkerCommand('retry', [task.id], { runtime: runtimeFor(h), env: {} }),
      runWorkerCommand('retry', [task.id, '--brief', correction], {
        runtime: runtimeFor(h),
        env: owner.environment,
      }),
    ]);
    // A product brief amends a retry that is still waiting to start; a plain retry after it, or a submission that
    // finds the task's lease held, is refused. Either way the task keeps exactly one pending retry.
    expect([first.status, second.status].filter((status) => status === 'fulfilled').length).toBeGreaterThanOrEqual(1);
    if (second.status === 'fulfilled')
      expect(h.store.task(task.id).brief.markdown).toContain('Current generation correction.');
    expect(h.store.retryIntents().filter((value) => value.taskId === task.id)).toHaveLength(1);
    expect(h.store.retryIntent(ref)?.status).toBe('pending');
    expect(h.store.attempt(ref).session).toBe('stopped-session');
    expect(h.store.attempts(task.id)).toHaveLength(1);
  } finally {
    h.dispose();
  }
});

test('dispatch still refuses a critical brief before creating a task or attempt', () => {
  const h = harness();
  try {
    const critical = writeAmendment(h, 'critical-dispatch', markdown, true, 'Must not dispatch as critical.');
    const taskIds = h.store.taskIds();
    expect(() => h.tasks.dispatch(critical)).toThrow('critical priority cannot be set by dispatch');
    expect(h.store.taskIds()).toEqual(taskIds);
    expect(h.store.attempts()).toHaveLength(0);
  } finally {
    h.dispose();
  }
});

test('configured operations can rewrite an ordinary normal retry without priority authority or audit mutation', async () => {
  const h = harness();
  try {
    const task = h.tasks.dispatch(h.briefFile);
    const ref = seedStoppedAttempt(h, task);
    authenticatePriorityManagers(h, task);
    h.settings.integration.operationsManager = 'operations';
    addManager(h.store.db, 'operations', 'operations-session', 'root');
    addManager(h.store.db, 'unrelated', 'unrelated-session', 'root');
    h.tasks.grantPriority(task.id, { id: 'supermanager', sessionId: 'super-session' });
    const before = h.store.task(task.id);
    const correction = writeAmendment(
      h,
      'operations-correction',
      markdown,
      false,
      'Use the rewritten canonical contract.',
    );
    const environment = { CODEX_THREAD_ID: 'operations-session', GOAL_MANAGER: 'operations' };
    await retryCommand(h, task.id, correction, environment);
    const current = h.store.task(task.id);
    expect(current.brief.markdown).toContain('rewritten canonical contract');
    expect(current.priorityHistory).toEqual(before.priorityHistory);
    expect(current.priorityGrants).toEqual(before.priorityGrants);
    expect(h.store.attempt(ref).session).toBe('stopped-session');
    expect(h.store.retryIntent(ref)?.status).toBe('pending');
    const invalidCorrection = writeAmendment(
      h,
      'unauthorized-normal',
      markdown,
      false,
      'Requires a live authorized caller.',
    );
    for (const env of [
      {},
      { GOAL_MANAGER: 'operations' },
      { CODEX_THREAD_ID: 'stale-operations', GOAL_MANAGER: 'operations' },
      { CODEX_THREAD_ID: 'operations-session', GOAL_MANAGER: 'fixture' },
      { CODEX_THREAD_ID: 'unrelated-session', GOAL_MANAGER: 'unrelated' },
    ]) {
      await expect(retryCommand(h, task.id, invalidCorrection, env)).rejects.toThrow();
      expect(h.store.task(task.id)).toEqual(current);
    }
    expect(() =>
      h.tasks.queueRetry(task.id, { brief: invalidCorrection }, { id: 'operations', sessionId: 'forged' }),
    ).toThrow('authenticated manager');
    const escalation = writeAmendment(h, 'operations-escalation', markdown, true, 'Operations may not escalate.');
    await expect(retryCommand(h, task.id, escalation, environment)).rejects.toThrow('only task manager');
    h.store.updateTask(ref, (value) => {
      value.brief.criticalPath = true;
      value.taskClass = 'critical-path';
    });
    const critical = h.store.task(task.id);
    await expect(retryCommand(h, task.id, invalidCorrection, environment)).rejects.toThrow('only task manager');
    const retained = writeAmendment(
      h,
      'operations-retained-critical',
      markdown,
      true,
      'Operations may not restate critical priority.',
    );
    await expect(retryCommand(h, task.id, retained, environment)).rejects.toThrow('only task manager');
    expect(h.store.task(task.id)).toEqual(critical);
  } finally {
    h.dispose();
  }
});

test.each(['codex', 'claude'] as const)(
  'configured operations %s can rewrite a control-plane/main normal retry',
  async (provider) => {
    const h = harness();
    try {
      const source = markdown
        .replace('goal: fixture', 'goal: control-plane\nmanager: fixture\ntarget: main')
        .replace('paths: [result.txt]', 'paths: [tools/goal/src/tasks.ts]');
      const original = join(h.settings.stateDirectory, 'control-plane-main.md');
      writeFileSync(original, source);
      const task = h.tasks.dispatch(original);
      const ref = seedStoppedAttempt(h, task);
      authenticatePriorityManagers(h, task);
      h.settings.integration.operationsManager = 'operations';
      h.store.db.query('INSERT INTO manager_sessions VALUES (?, ?)').run(
        'operations',
        JSON.stringify({
          id: 'operations',
          kind: 'resident-supermanager',
          provider,
          status: 'running',
          threadId: 'operations-session',
        }),
      );
      const environment = {
        GOAL_MANAGER: 'operations',
        ...(provider === 'claude'
          ? { CLAUDE_CODE_SESSION_ID: 'operations-session' }
          : { CODEX_THREAD_ID: 'operations-session' }),
      };
      h.tasks.grantPriority(task.id, { id: 'supermanager', sessionId: 'super-session' });
      const before = h.store.task(task.id);
      const escalation = writeAmendment(h, 'control-plane-escalation', source, true, 'Only the owner may escalate.');
      await expect(retryCommand(h, task.id, escalation, environment)).rejects.toThrow('only task manager');
      const verification = writeAmendment(
        h,
        'control-plane-verification',
        source.replace('kind: implementation', 'kind: verification'),
        false,
        'Proof registration is still required.',
      );
      await expect(retryCommand(h, task.id, verification, environment)).rejects.toThrow();
      expect(h.store.task(task.id)).toEqual(before);
      const correction = writeAmendment(
        h,
        'control-plane-correction',
        source,
        false,
        'Use the complete planner correction.',
      );
      await retryCommand(h, task.id, correction, environment);
      const amended = h.store.task(task.id);
      expect(amended.brief).toMatchObject({
        goal: 'control-plane',
        target: 'main',
        manager: 'fixture',
        criticalPath: false,
      });
      expect(amended.brief.markdown).toContain('complete planner correction');
      expect(amended.priorityGrants).toEqual(before.priorityGrants);
      expect(amended.priorityHistory).toEqual(before.priorityHistory);
      expect(h.store.attempt(ref).session).toBe('stopped-session');
      expect(h.store.retryIntent(ref)?.status).toBe('pending');
      h.store.updateRetryIntent(ref, (intent) => {
        intent.status = 'abandoned';
      });
      h.store.updateTask(ref, (current) => {
        current.brief.criticalPath = true;
        current.taskClass = 'critical-path';
      });
      const critical = h.store.task(task.id);
      const demotion = writeAmendment(h, 'control-plane-demotion', source, false, 'Only the owner may demote.');
      await expect(retryCommand(h, task.id, demotion, environment)).rejects.toThrow('only task manager');
      const retained = writeAmendment(
        h,
        'control-plane-critical',
        source,
        true,
        'Only the owner may restate critical priority.',
      );
      await expect(retryCommand(h, task.id, retained, environment)).rejects.toThrow('only task manager');
      expect(h.store.task(task.id)).toEqual(critical);
    } finally {
      h.dispose();
    }
  },
);
