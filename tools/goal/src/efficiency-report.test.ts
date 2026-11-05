import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { openDb } from './db.ts';
import { completedUtcHour, renderHourlyEfficiencyReport, sendHourlyEfficiencyReport } from './efficiency-report.ts';
import { recordFlow, type FlowEvent } from './flow.ts';
import { SqliteLandingQueue } from './land.ts';
import { WorkerStore, workerRecordEndedAtExpression } from './store.ts';
import { temporaryDirectory } from './test-support.ts';

function fixture() {
  const directory = temporaryDirectory();
  const db = openDb(join(directory.path, 'goal.sqlite'));
  const store = new WorkerStore(db);
  new SqliteLandingQueue(db, store);
  return {
    db,
    directory,
    close: () => {
      db.close();
      directory.close();
    },
  };
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
    h.db
      .query('INSERT INTO worker_attempts(task_id,attempt,body) VALUES (?,?,?)')
      .run('queued', 1, JSON.stringify({ taskId: 'queued', attempt: 1, state: 'waiting' }));
    h.db
      .query('INSERT INTO landing_queue(task,attempt,request) VALUES (?,?,?)')
      .run(
        'queued',
        1,
        JSON.stringify({ taskId: 'queued', attempt: 1, declaredPaths: ['services/sample/src/index.ts'] }),
      );
    const at = (minute: number) => new Date(Date.parse(bucket) + minute * 60_000).toISOString();
    task(h.db, 'guarded', 'integrated', 'fixture');
    recordFlow(h.db, {
      taskId: 'landed',
      attempt: 2,
      stage: 'integration',
      action: 'integrated',
      at: at(10),
      detail: JSON.stringify({ integrationTarget: 'integration' }),
    });
    recordFlow(h.db, { taskId: 'landed', attempt: 2, stage: 'worker', action: 'started', at: at(2) });
    recordFlow(h.db, { taskId: 'landed', attempt: 2, stage: 'worker', action: 'started', at: at(3) });
    recordFlow(h.db, { taskId: 'landed', attempt: 2, stage: 'worker', action: 'finished', at: at(12) });
    recordFlow(h.db, { taskId: 'queued', attempt: 1, stage: 'landing', action: 'enqueued', at: at(15) });
    h.db.query('INSERT INTO worker_records(task_id,attempt,body) VALUES (?,?,?)').run(
      'guarded',
      1,
      JSON.stringify({
        taskId: 'guarded',
        attempt: 1,
        endedAt: at(20),
        guardIds: ['new-failure', 'environment', 'new-failure'],
      }),
    );
    h.db
      .query('INSERT INTO worker_promotions(id,body) VALUES (1,?)')
      .run(JSON.stringify({ id: 'promotion', phase: 'stabilize-blocked' }));

    const report = await renderHourlyEfficiencyReport(h.db, { bucket, now });
    expect(report).toContain('Landings in UTC hour: dev 1; stabilize 0; main 0; unknown 0 (each task counted once).');
    expect(report).toContain('Landing identities: landed#2 at 2026-10-31T01:10:00.000Z (dev).');
    expect(report).toContain('Last useful landing: landed#2 at 2026-10-31T01:10:00.000Z.');
    expect(report).toContain('Worker starts / finishes in bucket: 2 starts (including resumes) / 1 finished attempts.');
    expect(report).toContain('Guard endings in bucket: new-failure 1; environment 1.');
    expect(report).toContain('Current landing queue age: 1 queued attempts; oldest 2700000 ms.');
    expect(report).toContain('queued#1');
    expect(report).toContain('Orphaned landings: 1 (orphan).');
    expect(report).toContain(
      'Promotion: blocked; phase stabilize-blocked; main gate result unknown; phase age unknown.',
    );
    expect(report).toContain('worker diff churn: unknown.');
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
    expect(report).toContain('Guard endings in bucket: unknown (attempt history unavailable).');
    expect(report).toContain('Recorded usage: unknown (attempt history unavailable)');
  } finally {
    db.close();
    empty.close();
  }
});

test('hourly aggregation preserves interleaved waits and normalized landings as the bucket grows', async () => {
  const h = fixture();
  const bucket = '2026-10-31T01:00:00.000Z';
  const at = (minute: number) => new Date(Date.parse(bucket) + minute * 60_000).toISOString();
  const flow = (
    taskId: string,
    attempt: number,
    stage: FlowEvent['stage'],
    action: FlowEvent['action'],
    minute: number,
    detail?: string,
  ) => recordFlow(h.db, { taskId, attempt, stage, action, at: at(minute), ...(detail ? { detail } : {}) });
  try {
    task(h.db, 'ordinary', 'integrated', 'search', 2);
    task(h.db, 'urgent', 'integrated', 'control-plane');
    task(h.db, 'ambiguous', 'integrated', 'search');
    task(h.db, 'zeta', 'integrated', 'search');
    task(h.db, 'alpha', 'integrated', 'content');
    h.db.query("UPDATE worker_tasks SET body=json_set(body,'$.brief.urgent',true) WHERE id='urgent'").run();

    flow('ordinary', 1, 'check', 'requested', 1);
    flow('urgent', 1, 'check', 'requested', 2);
    flow('ordinary', 1, 'check', 'acquired', 3);
    flow('urgent', 1, 'check', 'released', 4);
    flow('ordinary', 1, 'check', 'requested', 5);
    flow('urgent', 1, 'check', 'requested', 6);
    flow('ordinary', 1, 'check', 'requested', 8);
    flow('urgent', 1, 'check', 'requested', 9);
    flow('urgent', 1, 'check', 'acquired', 11);
    flow('ordinary', 1, 'check', 'acquired', 12);
    flow('ordinary', 1, 'check', 'requested', 14);
    flow('ordinary', 1, 'check', 'released', 15);
    flow('ordinary', 1, 'check', 'acquired', 18);
    flow('ordinary', 1, 'worker', 'started', 20);
    flow('ordinary', 1, 'worker', 'started', 21);
    flow('ordinary', 1, 'worker', 'finished', 22);
    flow('ordinary', 1, 'worker', 'finished', 23);
    flow('ordinary', 2, 'worker', 'finished', 24);
    flow('urgent', 1, 'worker', 'started', 25);
    flow('urgent', 1, 'worker', 'started', 26);
    flow('urgent', 1, 'worker', 'finished', 27);
    flow('urgent', 1, 'worker', 'finished', 28);
    flow('urgent', 1, 'integration', 'integrated', 1, JSON.stringify({ integrationTarget: 'main' }));
    flow('ambiguous', 1, 'integration', 'integrated', 5, JSON.stringify({ integrationTarget: 'integration' }));
    flow('zeta', 1, 'integration', 'integrated', 10, JSON.stringify({ integrationTarget: 'integration' }));
    flow('alpha', 1, 'integration', 'integrated', 10, JSON.stringify({ integrationTarget: 'integration' }));
    flow('ambiguous', 2, 'integration', 'integrated', 30, JSON.stringify({ integrationTarget: 'main' }));
    for (let index = 0; index < 96; index++) flow('ordinary', 2, 'check', 'released', 40 + (index % 10));

    const { readControlPolicy } = await import('./policy.ts');
    const policy = readControlPolicy({ hourlyReport: { goalRows: 2, landingRows: 2 } });
    const report = await renderHourlyEfficiencyReport(h.db, { bucket, policy });
    expect(report).toContain('Landings in UTC hour: dev 2; stabilize 0; main 0; unknown 1 (each task counted once).');
    expect(report).toContain('Landings by Goal: content 1, search 1; 1 more Goals omitted.');
    expect(report).toContain(
      'Landing identities: ambiguous#1 at 2026-10-31T01:05:00.000Z (unknown); alpha#1 at 2026-10-31T01:10:00.000Z (dev); 1 more omitted.',
    );
    expect(report).toContain('Urgent landings (excluded from throughput): urgent#1.');
    expect(report).toContain('Worker starts / finishes in bucket: 2 starts (including resumes) / 2 finished attempts.');
    expect(report).toContain('Urgent worker starts / finishes in bucket (excluded from throughput): 2 / 1.');
    expect(report).toContain('Check-slot wait in bucket: 3 completed request/acquire pairs; p90 4m.');
  } finally {
    h.close();
  }
});

test('guard endings use the record timestamp and an indexed bucket despite growing history', async () => {
  const h = fixture();
  const bucket = '2026-10-31T01:00:00.000Z';
  const end = '2026-10-31T02:00:00.000Z';
  try {
    task(h.db, 'guarded', 'stopped', 'fixture');
    const record = h.db.query('INSERT INTO worker_records(task_id,attempt,body) VALUES (?,?,?)');
    h.db
      .query('INSERT INTO worker_attempts(task_id,attempt,body) VALUES (?,?,?)')
      .run('guarded', 1, JSON.stringify({ taskId: 'guarded', attempt: 1, endedAt: end }));
    record.run(
      'guarded',
      1,
      JSON.stringify({ taskId: 'guarded', attempt: 1, endedAt: '2026-10-31T01:30:00.000Z', guardIds: ['environment'] }),
    );
    record.run('guarded', 1002, 'not json');
    h.db.exec(
      "DROP INDEX worker_records_ended_at; DELETE FROM schema_migrations WHERE module='worker' AND version=12;",
    );
    new WorkerStore(h.db);
    const before = await renderHourlyEfficiencyReport(h.db, { bucket });
    for (let attempt = 2; attempt < 1002; attempt++)
      record.run(
        'guarded',
        attempt,
        JSON.stringify({ endedAt: '2020-01-01T00:00:00.000Z', guardIds: ['new-failure'] }),
      );
    record.run('guarded', 1003, JSON.stringify({ endedAt: 'invalid', guardIds: ['question'] }));
    record.run('guarded', 1004, JSON.stringify({ endedAt: '2026-10-31T01:45:00.000Z' }));
    const after = await renderHourlyEfficiencyReport(h.db, { bucket });
    const plan = h.db
      .query(
        `EXPLAIN QUERY PLAN SELECT body FROM worker_records INDEXED BY worker_records_ended_at
         WHERE ${workerRecordEndedAtExpression} >= ? AND ${workerRecordEndedAtExpression} < ?`,
      )
      .all(bucket, end) as { detail: string }[];
    expect(after).toBe(before);
    expect(after).toContain('Guard endings in bucket: environment 1.');
    expect(plan.map(({ detail }) => detail).join(' ')).toContain(
      'SEARCH worker_records USING INDEX worker_records_ended_at',
    );
  } finally {
    h.close();
  }
});

test('hourly delivery stores one timestamped outcome and discards notifier output', async () => {
  const h = fixture();
  try {
    const bucket = '2026-10-31T01:00:00.000Z';
    expect(completedUtcHour(Date.parse('2026-10-31T02:15:00.000Z')).start).toBe(bucket);
    const capture = join(h.directory.path, 'sends.txt');
    const append = `import { appendFileSync } from 'node:fs'; appendFileSync(${JSON.stringify(capture)}, 'sent\\n');`;
    const sent = await sendHourlyEfficiencyReport(
      h.db,
      bucket,
      'hourly report',
      [process.execPath, '-e', append],
      2000,
      new Date('2026-10-31T02:15:00.000Z'),
    );
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
    const stored = h.db
      .query('SELECT report, status, created_at, finished_at FROM efficiency_report_deliveries WHERE hour_bucket=?')
      .get(bucket) as {
      report: string;
      status: string;
      created_at: string;
      finished_at: string;
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
    expect(
      (
        h.db.query('SELECT status FROM efficiency_report_deliveries WHERE hour_bucket=?').get(timedOut.bucket) as {
          status: string;
        }
      ).status,
    ).toBe('unknown');
  } finally {
    h.close();
  }
});

test('hourly rendering and notifier output use caller limits, including tiny UTF-8 budgets', async () => {
  const { readControlPolicy } = await import('./policy.ts');
  const h = fixture();
  try {
    const policy = readControlPolicy({ hourlyReport: { reportBytes: 200, notifierOutputBytes: 4 } });
    for (const reportBytes of [1, 3, 200]) {
      const report = await renderHourlyEfficiencyReport(h.db, {
        bucket: '2026-10-31T01:00:00.000Z',
        policy: { ...policy, hourlyReport: { ...policy.hourlyReport, reportBytes } },
      });
      expect(Buffer.byteLength(report)).toBeLessThanOrEqual(reportBytes);
      expect(report).not.toContain('\uFFFD');
    }
    const sent = await sendHourlyEfficiencyReport(
      h.db,
      '2026-10-31T01:00:00.000Z',
      'bounded',
      [process.execPath, '-e', 'console.log("too much output")'],
      2000,
      new Date(),
      policy,
    );
    expect(sent.disposition).toBe('unknown');
    expect(sent.detail).toContain('output limit exceeded');
    const ordinary = await renderHourlyEfficiencyReport(h.db, { bucket: '2026-10-31T01:00:00.000Z' });
    expect(Buffer.byteLength(ordinary)).toBeGreaterThan(200);
  } finally {
    h.close();
  }
});
