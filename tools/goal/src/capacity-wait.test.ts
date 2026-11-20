import { expect, spyOn, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { migrate, openDb } from './db.ts';
import * as hostPressure from './host-pressure.ts';
import { awaitHostCapacity, capacityAvailable, waitersAhead } from './launch.ts';
import { processIdentity } from './process.ts';
import { WorkerStore, workerMigrations } from './store.ts';
import { readWidthSnapshot } from './width-governor.ts';

const temporaryRoot = join(process.cwd(), '.temp');
mkdirSync(temporaryRoot, { recursive: true });

test('the shared current-attempt projection backfills admission and width counts', () => {
  const db = openDb(':memory:');
  try {
    migrate(
      db,
      workerMigrations.filter((migration) => migration.module === 'worker' && migration.version < 11),
    );
    db.query('INSERT INTO worker_tasks (id, sequence, current_attempt, body) VALUES (?, ?, ?, ?)').run(
      'task',
      1,
      2,
      JSON.stringify({ state: 'running', brief: { goal: 'goal', manager: 'manager' } }),
    );
    const process = { pid: 1234, start: '123456', boot: 'boot', group: 1234 };
    db.query('INSERT INTO worker_attempts (task_id, attempt, body) VALUES (?, ?, ?)').run(
      'task',
      1,
      JSON.stringify({ state: 'running', process }),
    );
    db.query('INSERT INTO worker_attempts (task_id, attempt, body) VALUES (?, ?, ?)').run(
      'task',
      2,
      JSON.stringify({ state: 'finished', process, profile: { cli: 'codex' } }),
    );

    const store = new WorkerStore(db);
    expect(store.capacityAttemptsCount(false)).toBe(0);
    expect(readWidthSnapshot(db, 1, { processIsLive: () => true }).system.running).toBe(0);

    db.query('UPDATE worker_attempts SET body=? WHERE task_id=? AND attempt=?').run(
      JSON.stringify({ state: 'running', process, profile: { cli: 'codex' } }),
      'task',
      2,
    );
    expect(store.capacityAttemptsCount(false)).toBe(1);
    expect(readWidthSnapshot(db, 2, { processIsLive: () => true }).system).toMatchObject({
      running: 1,
      codexRunning: 1,
    });
  } finally {
    db.close();
  }
});

test('a start waiting for host capacity counts current running attempts with one indexed query, without reading every attempt body', () => {
  const directory = mkdtempSync(join(temporaryRoot, 'goal-capacity-count-'));
  const path = join(directory, 'capacity.sqlite');
  const db = openDb(path);
  const pressure = spyOn(hostPressure, 'readHostPressure').mockReturnValue({ memoryFull: 0, ioFull: 0 });
  const headroom = spyOn(hostPressure, 'workerHeadroomMiB').mockReturnValue(Number.POSITIVE_INFINITY);
  try {
    const store = new WorkerStore(db);
    const query = db.query.bind(db);
    const insertTask = query('INSERT INTO worker_tasks (id, sequence, current_attempt, body) VALUES (?, ?, ?, ?)');
    const insertAttempt = query('INSERT INTO worker_attempts (task_id, attempt, body) VALUES (?, ?, ?)');
    const schema = query("SELECT sql FROM sqlite_schema WHERE name = 'worker_current_attempts_state'").get() as {
      sql: string;
    };
    expect(schema.sql).toMatch(/ON worker_current_attempts\(attempt_state, urgent, task_id, current_attempt\)/);
    expect(schema.sql).toMatch(/WHERE attempt_state IN \('running', 'waiting'\)/);
    const executions: { sql: string; result: unknown }[] = [];
    db.query = ((sql: string) => {
      const statement = query(sql);
      return new Proxy(statement, {
        get(target, property) {
          const value = Reflect.get(target, property);
          if (typeof value !== 'function') return value;
          return (...args: unknown[]) => {
            const result = value.apply(target, args);
            if (['get', 'all', 'run', 'values', 'iterate'].includes(String(property))) executions.push({ sql, result });
            return result;
          };
        },
      });
    }) as typeof db.query;

    // Cross independent history and payload axes in one task's settled attempt history. A fixed set of
    // superseded running attempts also proves that admission counts each task's current attempt only.
    for (const runningCount of [0, 1, 10, 100]) {
      const work: number[] = [];
      for (const settledCount of [10, 100, 1_000]) {
        for (const payloadBytes of [128, 1_024, 8_192]) {
          db.transaction(() => {
            db.exec('DELETE FROM worker_attempts; DELETE FROM worker_tasks');
            for (let index = 0; index < runningCount; index += 1) {
              const id = `task-${index}`;
              insertTask.run(id, index + 1, 1, '{}');
              insertAttempt.run(
                id,
                1,
                JSON.stringify({
                  state: 'running',
                  payload: 'x'.repeat(128),
                }),
              );
            }
            const history = `history-${runningCount}`;
            insertTask.run(history, runningCount + 1, settledCount + 1, '{}');
            for (let attempt = 1; attempt <= settledCount; attempt += 1)
              insertAttempt.run(
                history,
                attempt,
                JSON.stringify({
                  state: attempt <= 3 ? 'running' : 'finished',
                  payload: 'x'.repeat(payloadBytes),
                }),
              );
            insertAttempt.run(
              history,
              settledCount + 1,
              JSON.stringify({ state: 'finished', payload: 'x'.repeat(payloadBytes) }),
            );
          })();
          executions.length = 0;
          store.resetDecodedRows();
          expect(store.capacityAttemptsCount(false)).toBe(runningCount);
          expect(executions).toHaveLength(1);
          const { sql, result } = executions[0]!;
          expect(result).toEqual({ count: runningCount }); // Returned aggregate, never rows examined.
          expect(store.decodedRows()).toEqual({ tasks: 0, attempts: 0 });
          expect(store.decodedBytes()).toEqual({ tasks: 0, attempts: 0 });
          const plan = query(`EXPLAIN QUERY PLAN ${sql}`).all() as { detail: string }[];
          expect(plan.map((step) => step.detail).join(' ')).toMatch(
            /SEARCH .*USING (?:COVERING )?INDEX worker_current_attempts_state/,
          );

          // Bun exposes no statement-status counters: replay the captured SQL against this same native fixture.
          // VM steps count executed opcodes; fullscan steps exclude indexed visits. Neither is rows examined.
          const native = Bun.spawnSync(['sqlite3', '-readonly', path], {
            stdin: Buffer.from(`.eqp on\n.stats on\n${sql};\n`),
          });
          expect(native.exitCode).toBe(0);
          expect(native.stderr.toString()).toBe('');
          const output = native.stdout.toString();
          expect(output).toMatch(/SEARCH .*USING (?:COVERING )?INDEX worker_current_attempts_state/);
          expect(output).toMatch(new RegExp(`^${runningCount}$`, 'm'));
          const counter = (name: string) => {
            const match = output.match(new RegExp(`^${name}:\\s+(\\d+)`, 'm'));
            expect(match).not.toBeNull();
            return Number(match![1]);
          };
          expect(counter('Number of times run')).toBe(1);
          expect(counter('Fullscan Steps')).toBe(0);
          const steps = counter('Virtual Machine Steps');
          expect(steps).toBeGreaterThan(0);
          expect(steps).toBeLessThanOrEqual(5 * runningCount + 20);
          work.push(steps);
          writeFileSync(
            join(directory, 'capacity.json'),
            JSON.stringify({ maxWorkers: Math.max(1, runningCount), minAvailableMiB: 0 }),
          );
          expect(capacityAvailable(store, directory)).toBe(runningCount === 0);
        }
      }
      expect(new Set(work).size).toBe(1);
    }
  } finally {
    headroom.mockRestore();
    pressure.mockRestore();
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a critical-path start waits at the cap like any other and only goes half an hour ahead in the queue', async () => {
  const directory = mkdtempSync(join(temporaryRoot, 'goal-capacity-critical-'));
  const db = openDb(':memory:');
  const capacityFile = join(directory, 'capacity.json');
  let pending: ReturnType<typeof awaitHostCapacity> | undefined;
  try {
    const store = new WorkerStore(db);
    db.query('INSERT INTO worker_tasks (id, sequence, current_attempt, body) VALUES (?, ?, ?, ?)').run(
      'busy',
      1,
      1,
      '{}',
    );
    db.query('INSERT INTO worker_attempts (task_id, attempt, body) VALUES (?, ?, ?)').run(
      'busy',
      1,
      JSON.stringify({ state: 'running' }),
    );
    writeFileSync(capacityFile, JSON.stringify({ maxWorkers: 1, minAvailableMiB: 0 }));
    const now = Date.now();
    const waits: (readonly string[])[] = [];
    pending = awaitHostCapacity(store, directory, true, 'critical', 1, {
      now: () => now,
      availableMiB: () => Number.POSITIVE_INFINITY,
      pressure: () => ({ memoryFull: 0, ioFull: 0 }),
      workerHeadroomMiB: () => Number.POSITIVE_INFINITY,
      onWaitReasons: (reasons) => waits.push(reasons),
    });
    void pending.catch(() => {});
    // At the cap a critical-path start does not return; it used to start regardless and starve ordinary waiters.
    expect(waits[0]).toContain('worker-limit');
    const queue = join(directory, 'capacity-queue');
    const [critical] = readdirSync(queue);
    expect(critical).toEndWith('-critical');
    expect(Number(critical?.split('.')[0])).toBe(now - 30 * 60_000);
    const owner = processIdentity();
    expect(owner).not.toBeNull();
    const writeStart = (taskId: string, queuedAt: number) => {
      const name = `${String(queuedAt).padStart(15, '0')}.00000001-${process.pid}-${taskId}`;
      writeFileSync(
        join(queue, name),
        JSON.stringify({ ...owner, taskId, attempt: 1, operation: 'start', queuedAt, priorityHeadStart: false }),
      );
      return name;
    };
    const older = writeStart('older', now - 60 * 60_000);
    const newer = writeStart('newer', now - 60_000);
    expect(waitersAhead(queue, older, store)).toBe(0);
    expect(waitersAhead(queue, critical!, store)).toBe(1);
    expect(waitersAhead(queue, newer, store)).toBe(2);
  } finally {
    rmSync(capacityFile, { force: true });
    const [settled] = await Promise.allSettled(pending ? [pending] : []);
    if (settled?.status === 'fulfilled') settled.value();
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
