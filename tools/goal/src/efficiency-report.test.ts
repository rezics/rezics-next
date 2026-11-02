import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { openDb } from './db.ts';
import { completedUtcHour, renderHourlyEfficiencyReport, sendHourlyEfficiencyReport } from './efficiency-report.ts';
import { recordFlow } from './flow.ts';
import { SqliteLandingQueue } from './land.ts';
import { WorkerStore } from './store.ts';
import { temporaryDirectory } from './test-support.ts';

function fixture() {
  const directory = temporaryDirectory();
  const db = openDb(join(directory.path, 'goal.sqlite'));
  const store = new WorkerStore(db);
  new SqliteLandingQueue(db, store);
  return { db, directory, close: () => { db.close(); directory.close(); } };
}

function task(db: ReturnType<typeof openDb>, id: string, state: string, goal: string, attempt = 1): void {
  db.query('INSERT INTO worker_tasks(id,sequence,current_attempt,body) VALUES (?,?,?,?)').run(
    id,
    (db.query('SELECT count(*) AS count FROM worker_tasks').get() as { count: number }).count + 1,
    attempt,
    JSON.stringify({ id, currentAttempt: attempt, state, brief: { goal, paths: ['services/sample/src/index.ts'] } }),
  );
}

test('hourly report uses timestamped outcomes and leaves missing lifecycle evidence unknown', async () => {
  const h = fixture();
  try {
    const bucket = '2026-10-31T01:00:00.000Z';
    const now = new Date('2026-10-31T02:00:00.000Z');
    task(h.db, 'landed', 'integrated', 'search', 2);
    task(h.db, 'queued', 'landing', 'content');
    task(h.db, 'orphan', 'landing', 'content', 2);
    h.db.query('INSERT INTO worker_attempts(task_id,attempt,body) VALUES (?,?,?)').run(
      'queued',
      1,
      JSON.stringify({ taskId: 'queued', attempt: 1, state: 'waiting' }),
    );
    h.db.query('INSERT INTO landing_queue(task,attempt,request) VALUES (?,?,?)').run(
      'queued',
      1,
      JSON.stringify({ taskId: 'queued', attempt: 1, declaredPaths: ['services/sample/src/index.ts'] }),
    );
    const at = (minute: number) => new Date(Date.parse(bucket) + minute * 60_000).toISOString();
    recordFlow(h.db, { taskId: 'landed', attempt: 2, stage: 'integration', action: 'integrated', at: at(10), detail: JSON.stringify({ integrationTarget: 'integration' }) });
    recordFlow(h.db, { taskId: 'landed', attempt: 2, stage: 'worker', action: 'started', at: at(2) });
    recordFlow(h.db, { taskId: 'landed', attempt: 2, stage: 'worker', action: 'started', at: at(3) });
    recordFlow(h.db, { taskId: 'landed', attempt: 2, stage: 'worker', action: 'finished', at: at(12) });
    recordFlow(h.db, { taskId: 'queued', attempt: 1, stage: 'landing', action: 'enqueued', at: at(15) });
    h.db.query('INSERT INTO worker_promotions(id,body) VALUES (1,?)').run(
      JSON.stringify({ id: 'promotion', phase: 'stabilize-blocked' }),
    );

    const report = await renderHourlyEfficiencyReport(h.db, { bucket, now });
    expect(report).toContain('Landings in UTC hour: dev 1; stabilize 0; main 0; unknown 0 (each task counted once).');
    expect(report).toContain('Landing identities: landed#2 at 2026-10-31T01:10:00.000Z (dev).');
    expect(report).toContain('Last useful landing: landed#2 at 2026-10-31T01:10:00.000Z.');
    expect(report).toContain('Worker starts / finishes in bucket: 2 starts (including resumes) / 1 finished attempts.');
    expect(report).toContain('Current landing queue age: 1 queued attempts; oldest 2700000 ms.');
    expect(report).toContain('queued#1');
    expect(report).toContain('Orphaned landings: 1 (orphan).');
    expect(report).toContain('Promotion: blocked; phase stabilize-blocked; main gate result unknown; phase age unknown.');
    expect(report).toContain('Worker diff churn: unknown.');
  } finally {
    h.close();
  }

  const empty = temporaryDirectory();
  const db = openDb(join(empty.path, 'empty.sqlite'));
  try {
    const report = await renderHourlyEfficiencyReport(db, { bucket: '2026-10-31T01:00:00.000Z' });
    expect(report).toContain('Landings: unknown (timestamped integration history unavailable).');
    expect(report).toContain('Last useful landing: unknown');
    expect(report).toContain('Current waits: unknown (current task state unavailable).');
    expect(report).toContain('Promotion: unknown (promotion state unavailable).');
    expect(report).toContain('Recorded usage: unknown (attempt history unavailable)');
  } finally {
    db.close();
    empty.close();
  }
});

test('hourly delivery stores one timestamped outcome and never logs notifier credentials', async () => {
  const h = fixture();
  try {
    const bucket = '2026-10-31T01:00:00.000Z';
    expect(completedUtcHour(Date.parse('2026-10-31T02:15:00.000Z')).start).toBe(bucket);
    const capture = join(h.directory.path, 'sends.txt');
    const append = `import { appendFileSync } from 'node:fs'; appendFileSync(${JSON.stringify(capture)}, 'sent\\n');`;
    const sent = await sendHourlyEfficiencyReport(h.db, bucket, 'hourly report', [process.execPath, '-e', append], 2000);
    expect(sent.disposition).toBe('sent');
    const duplicate = await sendHourlyEfficiencyReport(
      h.db,
      bucket,
      'a changed retry cannot replace the persisted report',
      [process.execPath, '-e', `throw new Error('duplicate send')`],
      2000,
    );
    expect(duplicate.disposition).toBe('already-sent');
    expect(readFileSync(capture, 'utf8')).toBe('sent\n');
    const stored = h.db.query('SELECT report, status, created_at, finished_at FROM efficiency_report_deliveries WHERE hour_bucket=?').get(bucket) as {
      report: string; status: string; created_at: string; finished_at: string;
    };
    expect(stored).toMatchObject({ report: 'hourly report', status: 'sent', created_at: '2026-10-31T02:15:00.000Z' });
    expect(Date.parse(stored.finished_at)).not.toBeNaN();

    const failed = await sendHourlyEfficiencyReport(
      h.db,
      '2026-10-31T02:00:00.000Z',
      'failure report',
      [process.execPath, '-e', 'console.error("fake-secret-value"); process.exit(7)'],
      2000,
    );
    expect(failed.disposition).toBe('failed');
    expect(failed.detail).toBe('notifier exited with code 7');
    expect(failed.detail).not.toContain('fake-secret-value');

    const timedOut = await sendHourlyEfficiencyReport(
      h.db,
      '2026-10-31T03:00:00.000Z',
      'timeout report',
      [process.execPath, '-e', 'setTimeout(() => {}, 30000)'],
      25,
    );
    expect(timedOut.disposition).toBe('unknown');
    expect((h.db.query('SELECT status FROM efficiency_report_deliveries WHERE hour_bucket=?').get(timedOut.bucket) as { status: string }).status).toBe('unknown');
  } finally {
    h.close();
  }
});
