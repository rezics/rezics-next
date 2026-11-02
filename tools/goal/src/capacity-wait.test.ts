import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openDb } from './db.ts';
import { awaitHostCapacity, capacityAvailable, waitersAhead } from './launch.ts';
import { WorkerStore } from './store.ts';

const temporaryRoot = join(process.cwd(), '.temp');
mkdirSync(temporaryRoot, { recursive: true });

test('a start waiting for host capacity counts running attempts with one indexed query, without reading every attempt body', () => {
  const directory = mkdtempSync(join(temporaryRoot, 'goal-capacity-count-'));
  const path = join(directory, 'capacity.sqlite');
  const db = openDb(path);
  try {
    const store = new WorkerStore(db);
    const query = db.query.bind(db);
    const insertTask = query('INSERT INTO worker_tasks (id, sequence, current_attempt, body) VALUES (?, ?, ?, ?)');
    const insertAttempt = query('INSERT INTO worker_attempts (task_id, attempt, body) VALUES (?, ?, ?)');
    const schema = query("SELECT sql FROM sqlite_schema WHERE name = 'worker_attempts_state'").get() as { sql: string };
    expect(schema.sql).toMatch(/ON worker_attempts\(json_extract\(body, '\$\.state'\)\)/);
    expect(schema.sql).not.toMatch(/WHERE/i);
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

    // Cross independent history and payload axes; active entries retain the same small bodies.
    for (const runningCount of [0, 1, 10, 100]) {
      const work: number[] = [];
      for (const settledCount of [10, 100, 1_000]) {
        for (const payloadBytes of [128, 1_024, 8_192]) {
          db.transaction(() => {
            db.exec('DELETE FROM worker_attempts; DELETE FROM worker_tasks');
            for (let index = 0; index < runningCount + settledCount; index += 1) {
              const id = `task-${index}`;
              const running = index < runningCount;
              insertTask.run(id, index + 1, 1, '{}');
              insertAttempt.run(
                id,
                1,
                JSON.stringify({
                  state: running ? 'running' : 'finished',
                  payload: 'x'.repeat(running ? 128 : payloadBytes),
                }),
              );
            }
          })();
          executions.length = 0;
          store.resetDecodedRows();
          expect(store.runningAttemptsCount()).toBe(runningCount);
          expect(executions).toHaveLength(1);
          const { sql, result } = executions[0]!;
          expect(result).toEqual({ count: runningCount }); // Returned aggregate, never rows examined.
          expect(store.decodedRows()).toEqual({ tasks: 0, attempts: 0 });
          expect(store.decodedBytes()).toEqual({ tasks: 0, attempts: 0 });
          const plan = query(`EXPLAIN QUERY PLAN ${sql}`).all() as { detail: string }[];
          expect(plan.map((step) => step.detail).join(' ')).toMatch(
            /SEARCH .*USING (?:COVERING )?INDEX worker_attempts_state/,
          );

          // Bun exposes no statement-status counters: replay the captured SQL against this same native fixture.
          // VM steps count executed opcodes; fullscan steps exclude indexed visits. Neither is rows examined.
          const native = Bun.spawnSync(['sqlite3', '-readonly', path], {
            stdin: `.eqp on\n.stats on\n${sql};\n`,
          });
          expect(native.exitCode).toBe(0);
          expect(native.stderr.toString()).toBe('');
          const output = native.stdout.toString();
          expect(output).toMatch(/SEARCH .*USING (?:COVERING )?INDEX worker_attempts_state/);
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
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a critical-path start waits at the cap like any other and only goes half an hour ahead in the queue', async () => {
  const directory = mkdtempSync(join(temporaryRoot, 'goal-capacity-critical-'));
  const db = openDb(':memory:');
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
    writeFileSync(join(directory, 'capacity.json'), JSON.stringify({ maxWorkers: 1, minAvailableMiB: 0 }));
    // At the cap a critical-path start does not return; it used to start regardless and starve ordinary waiters.
    const started = await Promise.race([
      awaitHostCapacity(store, directory, true, 'critical').then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 300)),
    ]);
    expect(started).toBe(false);
    const queue = join(directory, 'capacity-queue');
    const [critical] = readdirSync(queue);
    const now = Date.now();
    const older = `${String(now - 60 * 60_000).padStart(15, '0')}-${process.pid}-older`;
    const newer = `${String(now - 60_000).padStart(15, '0')}-${process.pid}-newer`;
    writeFileSync(join(queue, older), '');
    writeFileSync(join(queue, newer), '');
    expect(waitersAhead(queue, critical!)).toBe(1);
    expect(waitersAhead(queue, newer)).toBe(2);
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
