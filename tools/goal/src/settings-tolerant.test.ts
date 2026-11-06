import { expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { choosePool, countRunningByPool, countWaitingByPool, poolBurnStatus } from './allowance.ts';
import { openDb } from './db.ts';
import { readPoolPolicies } from './pools.ts';
import { checkSettings } from './settings.ts';
import { WorkerStore } from './store.ts';
import { fixturePool, temporaryDirectory } from './test-support.ts';
import type { Pool, Profile, Settings } from './types.ts';
import { runWorkerCommand } from './worker-commands.ts';

const main = join(import.meta.dir, '../../..');
const now = Date.parse('2026-11-06T00:00:00.000Z');
const span = 90 * 60 * 1000;
const profile: Profile = { cli: 'codex', model: 'gpt-6-luna', effort: 'high', poolClass: 'codex' };

function captureStderr(run: () => void): string[] {
  const lines: string[] = [];
  const previous = console.error;
  console.error = (...args: unknown[]) => lines.push(args.map(String).join(' '));
  try {
    run();
  } finally {
    console.error = previous;
  }
  return lines;
}

test('Settings and pool policy parsing warn once per unknown key on stderr and ignore it; invalid known values still throw', () => {
  const temporary = temporaryDirectory();
  try {
    const localFile = join(temporary.path, 'local.json');
    const pool = { ...fixturePool(), policy: { ...fixturePool().policy, maxConcurrent: 8, futurePolicyKey: 1 } };
    writeFileSync(localFile, JSON.stringify({ version: 1, pools: [pool], futureSettingKey: true }));
    const load = () => checkSettings({ cwd: main, localFile, env: { GOAL_MAIN_CHECKOUT: main } });
    const first = captureStderr(() => {
      const settings = load();
      expect(settings.pools[0]!.policy.maxConcurrent).toBe(8);
      expect(settings).not.toHaveProperty('futureSettingKey');
      expect(settings.pools[0]!.policy).not.toHaveProperty('futurePolicyKey');
    });
    const second = captureStderr(() => load());
    expect([...first, ...second].filter((line) => line.startsWith('ignoring unknown'))).toEqual([
      'ignoring unknown settings field: futureSettingKey',
      'ignoring unknown pool policy field: futurePolicyKey',
    ]);
    expect(() =>
      readPoolPolicies([{ ...fixturePool(), policy: { ...fixturePool().policy, maxConcurrent: 0 } }], localFile),
    ).toThrow('invalid maxConcurrent');
    writeFileSync(localFile, JSON.stringify({ version: 1, pools: [], silenceMs: 'nope' }));
    expect(() => load()).toThrow('invalid silenceMs');
  } finally {
    temporary.close();
  }
});

test('policy.maxConcurrent counts live sessions only; status lists live and waiting separately', async () => {
  const attempts = [
    { pool: 'claude-worker', state: 'running' },
    { pool: 'claude-worker', state: 'running' },
    { pool: 'claude-worker', state: 'running' },
    { pool: 'claude-worker', state: 'running' },
    { pool: 'claude-worker', state: 'pending' },
    { pool: 'claude-worker', state: 'waiting' },
    { pool: 'claude-worker', state: 'waiting' },
    { pool: 'claude-worker', state: 'waiting' },
    { pool: 'claude-worker', state: 'exited' },
  ];
  expect(countRunningByPool(attempts)).toEqual({ 'claude-worker': 5 });
  expect(countWaitingByPool(attempts)).toEqual({ 'claude-worker': 3 });

  const capped: Pool = {
    ...fixturePool(),
    name: 'claude-worker',
    allowanceKey: 'claude-worker',
    policy: { ...fixturePool().policy, maxConcurrent: 8 },
  };
  expect(choosePool(profile, [capped], [], { now, running: { 'claude-worker': 5 } }).name).toBe('claude-worker');
  expect(() => choosePool(profile, [capped], [], { now, running: { 'claude-worker': 8 } })).toThrow('no allowed pool');
  expect(poolBurnStatus([capped], [], now, span, { 'claude-worker': 5 }, { 'claude-worker': 11 })).toEqual([
    {
      name: 'claude-worker',
      allowanceKey: 'claude-worker',
      burnPerHour: 0,
      live: 5,
      waiting: 11,
      maxConcurrent: 8,
    },
  ]);

  const db = openDb(':memory:');
  try {
    const store = new WorkerStore(db);
    let sequence = 1;
    const insert = (id: string, state: string) => {
      db.query('INSERT INTO worker_tasks(id, sequence, current_attempt, body) VALUES (?, ?, ?, ?)').run(
        id,
        sequence++,
        1,
        JSON.stringify({ id, state: 'running', currentAttempt: 1 }),
      );
      db.query('INSERT INTO worker_attempts(task_id, attempt, body) VALUES (?, ?, ?)').run(
        id,
        1,
        JSON.stringify({ taskId: id, attempt: 1, state, pool: 'claude-worker' }),
      );
    };
    for (let i = 0; i < 4; i++) insert(`run-${i}`, 'running');
    insert('pending-1', 'pending');
    for (let i = 0; i < 3; i++) insert(`wait-${i}`, 'waiting');
    insert('exited-1', 'exited');
    expect(store.runningAttemptsByPool()).toEqual({ 'claude-worker': 5 });
    expect(store.waitingAttemptsByPool()).toEqual({ 'claude-worker': 3 });
  } finally {
    db.close();
  }

  const temporary = temporaryDirectory();
  const output: string[] = [];
  try {
    const settings = {
      stateDirectory: temporary.path,
      mainCheckout: main,
      integrationBranch: 'dev',
      pools: [capped],
    } as Settings;
    const store = {
      db: { query: () => ({ all: () => [], get: () => null, run() {} }), close() {} },
      tasks: () => [],
      runningAttemptsByPool: () => ({ 'claude-worker': 5 }),
      waitingAttemptsByPool: () => ({ 'claude-worker': 11 }),
    };
    await runWorkerCommand('status', [], {
      settings,
      store: store as never,
      tasks: { settings, store } as never,
      print: (value) => output.push(String(value)),
    });
    expect(JSON.parse(output[0]!).pools).toContainEqual({
      name: 'claude-worker',
      allowanceKey: 'claude-worker',
      burnPerHour: 0,
      live: 5,
      waiting: 11,
      maxConcurrent: 8,
    });
  } finally {
    temporary.close();
  }
});
