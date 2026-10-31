import { expect, test } from 'bun:test';
import { agentReportingEvidence } from './agents.ts';
import { openDb } from './db.ts';
import { SqliteManagerInbox } from './inbox.ts';
import { WorkerStore } from './store.ts';
import { temporaryDirectory } from './test-support.ts';
import { formatWidthSnapshot, readWidthSnapshot, sweepWidthGovernor } from './width-governor.ts';

test('reporting distinguishes Codex, other known agents, and absent or unrecognized provider evidence', () => {
  expect(agentReportingEvidence('codex')).toEqual({ codex: true, unknown: false });
  for (const cli of ['claude', 'grok', 'cursor'])
    expect(agentReportingEvidence(cli)).toEqual({ codex: false, unknown: false });
  for (const cli of [undefined, null, '', 'unrecognized-provider', 'constructor'])
    expect(agentReportingEvidence(cli)).toEqual({ codex: false, unknown: true });
});

test('historical report snapshots expose missing width evidence as unknown', () => {
  for (const snapshot of [undefined, null]) {
    const lines = formatWidthSnapshot(snapshot);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('system-wide running workers: unknown');
    expect(lines[1]).toContain('Codex running workers: unknown');
  }
});

test('unknown ownership cannot suppress a low-width wake and the notice retains its Goal', async () => {
  const temporary = temporaryDirectory();
  const db = openDb(`${temporary.path}/width.sqlite`);
  try {
    new WorkerStore(db);
    const inbox = new SqliteManagerInbox(db, temporary.path);
    for (let index = 0; index < 10; index++) {
      const id = `unknown-${index}`;
      db.query('INSERT INTO worker_tasks VALUES (?, ?, 1, ?)').run(
        id,
        index + 1,
        JSON.stringify({ state: 'running', brief: { goal: 'sample-goal', manager: 'actual-manager' } }),
      );
      db.query('INSERT INTO worker_attempts VALUES (?, 1, ?)').run(
        id,
        JSON.stringify({ state: 'running', profile: { cli: 'codex' }, process: null }),
      );
    }
    db.query('INSERT INTO worker_tasks VALUES (?, 11, 0, ?)').run(
      'undispatched',
      JSON.stringify({ state: 'ready', brief: { goal: 'sample-goal', manager: 'actual-manager' } }),
    );
    const result = await sweepWidthGovernor(db, inbox, Date.UTC(2026, 9, 31, 12));
    expect(result.snapshot.system).toMatchObject({ running: 0, unknownRunning: 10, unknownCodexRunning: 10 });
    expect(result.deliveredGoals).toEqual(['sample-goal']);
    expect(inbox.pending('actual-manager')[0]?.event).toMatchObject({
      kind: 'width',
      goalId: 'sample-goal',
      managerId: 'actual-manager',
    });
    expect(inbox.pending('sample-goal')).toHaveLength(0);
  } finally {
    db.close();
    temporary.close();
  }
});

test('system counts include tasks without Goal metadata and use only their current attempt', () => {
  const temporary = temporaryDirectory();
  const db = openDb(`${temporary.path}/width.sqlite`);
  try {
    new WorkerStore(db);
    db.query('INSERT INTO worker_tasks VALUES (?, 1, 2, ?)').run('worker', JSON.stringify({ state: 'running' }));
    const process = { pid: 1234, start: 'start', boot: 'boot', group: 1234 };
    db.query('INSERT INTO worker_attempts VALUES (?, 1, ?)').run(
      'worker',
      JSON.stringify({ state: 'running', profile: { cli: 'codex' }, process }),
    );
    db.query('INSERT INTO worker_attempts VALUES (?, 2, ?)').run(
      'worker',
      JSON.stringify({ state: 'running', profile: { cli: 'unrecognized-provider' }, process }),
    );
    for (const [index, state] of ['ready', 'held', 'stopped'].entries())
      db.query('INSERT INTO worker_tasks VALUES (?, ?, 0, ?)').run(state, index + 2, JSON.stringify({ state }));
    const snapshot = readWidthSnapshot(db, Date.UTC(2026, 9, 31, 12), { processIsLive: () => true });
    expect(snapshot.system).toMatchObject({
      running: 1,
      codexRunning: 0,
      unknownCodexClassification: 1,
      ready: 1,
      held: 1,
      stopped: 1,
    });
    expect(snapshot.goals).toEqual([]);
  } finally {
    db.close();
    temporary.close();
  }
});
