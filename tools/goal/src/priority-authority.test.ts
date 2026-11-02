import { expect, test } from 'bun:test';
import { runWorkerCommand } from './worker-commands.ts';
import { authenticatedManager } from './priority-authority.ts';
import { harness } from './test-support.ts';

function runtimeFor(h: ReturnType<typeof harness>) {
  return { settings: h.settings, db: h.store.db, store: h.store, tasks: h.tasks } as never;
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
    JSON.stringify({ id, status: 'running', threadId: sessionId, supermanager }),
  );
}

test('Critical escalation needs a durable supermanager grant and records setter, grantor and time; ordinary manager self-grant is refused', async () => {
  const h = harness();
  try {
    const task = h.tasks.dispatch(h.briefFile);
    const owner = task.brief.manager;
    addManager(h.store.db, owner, 'owner-session', 'supermanager');
    addManager(h.store.db, 'supermanager', 'super-session', 'root');
    addManager(h.store.db, 'control-plane', 'operations-session', 'root');
    const runtime = runtimeFor(h);

    await expect(
      runWorkerCommand('priority', [task.id, 'critical'], {
        runtime,
        env: { CODEX_THREAD_ID: 'owner-session', GOAL_MANAGER: owner },
      }),
    ).rejects.toThrow('critical priority requires an active task-bound grant');
    await expect(
      runWorkerCommand('priority', ['grant', task.id], {
        runtime,
        env: { CODEX_THREAD_ID: 'owner-session', GOAL_MANAGER: owner },
      }),
    ).rejects.toThrow('only configured supermanager');
    await expect(
      runWorkerCommand('priority', ['grant', task.id], {
        runtime,
        env: { CODEX_THREAD_ID: 'operations-session', GOAL_MANAGER: 'control-plane' },
      }),
    ).rejects.toThrow('only configured supermanager');
    await expect(
      runWorkerCommand('priority', ['grant', task.id, '--grant', 'supermanager'], {
        runtime,
        env: { CODEX_THREAD_ID: 'super-session', GOAL_MANAGER: 'supermanager' },
      }),
    ).rejects.toThrow('usage: priority grant <task>');

    const printed: string[] = [];
    await runWorkerCommand('priority', ['grant', task.id], {
      runtime,
      env: { CODEX_THREAD_ID: 'super-session', GOAL_MANAGER: 'supermanager' },
      print: (value) => printed.push(value),
    });
    const grant = JSON.parse(printed[0]!);
    expect(grant).toMatchObject({
      taskId: task.id,
      grantor: 'supermanager',
      grantee: owner,
      scope: 'critical-path',
      provenance: { kind: 'manager-session', sessionId: 'super-session' },
    });
    expect(Date.parse(grant.grantedAt)).not.toBeNaN();

    await runWorkerCommand('priority', [task.id, 'critical'], {
      runtime,
      env: { CODEX_THREAD_ID: 'owner-session', GOAL_MANAGER: owner },
    });
    const updated = h.store.task(task.id);
    expect(updated.brief.criticalPath).toBe(true);
    expect(updated.priorityHistory).toHaveLength(1);
    expect(updated.priorityHistory![0]).toMatchObject({
      value: 'critical',
      setter: owner,
      grantor: 'supermanager',
      grantId: grant.id,
      provenance: { kind: 'manager-session', sessionId: 'owner-session' },
    });
    expect(Date.parse(updated.priorityHistory![0]!.at)).not.toBeNaN();
    expect(updated.priorityGrants?.[0]).toMatchObject({ consumedBy: owner });
    expect(Date.parse(updated.priorityGrants![0]!.consumedAt!)).not.toBeNaN();
  } finally {
    h.dispose();
  }
});

test('foreign and revoked priority grants fail closed', async () => {
  const h = harness();
  try {
    const task = h.tasks.dispatch(h.briefFile);
    const foreignTask = h.tasks.dispatch(h.briefFile);
    const owner = task.brief.manager;
    addManager(h.store.db, owner, 'owner-session', 'supermanager');
    addManager(h.store.db, 'supermanager', 'super-session', 'root');
    const runtime = runtimeFor(h);
    const printed: string[] = [];
    await runWorkerCommand('priority', ['grant', task.id], {
      runtime,
      env: { CODEX_THREAD_ID: 'super-session', GOAL_MANAGER: 'supermanager' },
      print: (value) => printed.push(value),
    });
    const grant = JSON.parse(printed[0]!);

    h.store.updatePriorityMetadata({ taskId: foreignTask.id, attempt: 0 }, (current) => {
      current.priorityGrants = [grant];
    });
    await expect(
      runWorkerCommand('priority', [foreignTask.id, 'critical'], {
        runtime,
        env: { CODEX_THREAD_ID: 'owner-session', GOAL_MANAGER: owner },
      }),
    ).rejects.toThrow('critical priority requires an active task-bound grant');

    await runWorkerCommand('priority', ['revoke', task.id, grant.id], {
      runtime,
      env: { CODEX_THREAD_ID: 'super-session', GOAL_MANAGER: 'supermanager' },
    });
    await expect(
      runWorkerCommand('priority', [task.id, 'critical'], {
        runtime,
        env: { CODEX_THREAD_ID: 'owner-session', GOAL_MANAGER: owner },
      }),
    ).rejects.toThrow('critical priority requires an active task-bound grant');
    expect(h.store.task(task.id).priorityGrants?.[0]).toMatchObject({ revokedBy: 'supermanager' });
  } finally {
    h.dispose();
  }
});

test('a worker-supplied GOAL_MANAGER without a registered provider session cannot grant or consume priority', async () => {
  const h = harness();
  try {
    const task = h.tasks.dispatch(h.briefFile);
    const runtime = runtimeFor(h);
    await expect(
      runWorkerCommand('priority', [task.id, 'critical'], {
        runtime,
        env: { GOAL_MANAGER: task.brief.manager },
      }),
    ).rejects.toThrow('authenticated manager session');
    await expect(
      runWorkerCommand('priority', ['grant', task.id], {
        runtime,
        env: { GOAL_MANAGER: 'supermanager' },
      }),
    ).rejects.toThrow('authenticated manager session');
    expect(h.store.task(task.id).brief.criticalPath).toBe(false);
  } finally {
    h.dispose();
  }
});

test('provider identity is ambiguous when a caller supplies both Codex and Claude sessions', () => {
  const h = harness();
  try {
    addManager(h.store.db, 'owner', 'owner-session', 'supermanager');
    expect(
      authenticatedManager(h.store.db, {
        CODEX_THREAD_ID: 'owner-session',
        CLAUDE_CODE_SESSION_ID: 'another-session',
        GOAL_MANAGER: 'owner',
      }),
    ).toBeUndefined();
  } finally {
    h.dispose();
  }
});

test('legacy critical task records keep unknown setter provenance', () => {
  const h = harness();
  try {
    const task = h.tasks.dispatch(h.briefFile);
    h.store.updateTask({ taskId: task.id, attempt: 0 }, (current) => {
      current.brief.criticalPath = true;
      current.taskClass = 'critical-path';
    });
    const legacy = h.store.task(task.id);
    expect(legacy.brief.criticalPath).toBe(true);
    expect(legacy.priorityHistory).toBeUndefined();
    expect(legacy.priorityGrants).toBeUndefined();
  } finally {
    h.dispose();
  }
});
