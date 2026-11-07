import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawn, execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { migrate, openDb } from './db.ts';
import {
  captureHourlyEfficiencyObservation,
  completedUtcHour,
  efficiencyReportMigrations,
  measureProductLineObservation,
  parseUtcHour,
  readFrozenHourlyEfficiencyReport,
  renderHourlyEfficiencyReport,
  sendHourlyEfficiencyReport,
} from './efficiency-report.ts';
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

function measuredLines(productLines: number, sourceRevision: string) {
  return {
    productLines,
    attribution: 'measured' as const,
    sourceRevision,
    backfillProductLines: null,
    backfillAttribution: 'unknown' as const,
    backfillFromRevision: null,
    filterVersion: 'rezics-product-code-v1',
  };
}

function git(repository: string, args: string[], env?: Record<string, string>): string {
  return execFileSync('git', ['-C', repository, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

function runCaptureChild(databasePath: string, productLines: number, sourceRevision: string): Promise<string> {
  const dbModule = new URL('./db.ts', import.meta.url).href;
  const reportModule = new URL('./efficiency-report.ts', import.meta.url).href;
  const code = `
    const { openDb } = await import(${JSON.stringify(dbModule)});
    const { captureHourlyEfficiencyObservation } = await import(${JSON.stringify(reportModule)});
    const db = openDb(${JSON.stringify(databasePath)});
    const result = captureHourlyEfficiencyObservation(db, {
      bucket: '2026-10-31T01:00:00.000Z',
      now: new Date('2026-10-31T02:15:00.000Z'),
      productLineMeasurement: {
        productLines: ${productLines}, attribution: 'measured',
        sourceRevision: ${JSON.stringify(sourceRevision)}, backfillProductLines: null,
        backfillAttribution: 'unknown', backfillFromRevision: null, filterVersion: 'rezics-product-code-v1'
      }
    });
    console.log(JSON.stringify({ disposition: result.disposition, reportRef: result.snapshot.reportRef, report: result.snapshot.report }));
    db.close();
  `;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', code], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout?.setEncoding('utf8').on('data', (chunk) => (stdout += chunk));
    child.stderr?.setEncoding('utf8').on('data', (chunk) => (stderr += chunk));
    child.once('error', reject);
    child.once('close', (code) => (code === 0 ? resolve(stdout.trim()) : reject(new Error(stderr || `child exited ${code}`))));
  });
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
    expect(report).toContain('Backlog returns in bucket: 0.');
    expect(report).toContain('Landing identities: landed#2 at 2026-10-31T01:10:00.000Z (dev).');
    expect(report).toContain('Last useful landing: landed#2 at 2026-10-31T01:10:00.000Z.');
    expect(report).toContain('Worker starts / finishes in bucket: 2 starts (including resumes) / 1 finished attempts.');
    expect(report).toContain('Guard firings in bucket: new-failure 1; environment 1.');
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
    expect(report).toContain('Backlog returns in bucket: unknown (flow history unavailable).');
    expect(report).toContain('Last useful landing: unknown');
    expect(report).toContain('Current waits: unknown (current task state unavailable).');
    expect(report).toContain('Promotion: unknown (promotion state unavailable).');
    expect(report).toContain('Guard firings in bucket: unknown (attempt history unavailable).');
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
    expect(after).toContain('Guard firings in bucket: environment 1.');
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
    expect(parseUtcHour(bucket)).toEqual({ start: bucket, end: '2026-10-31T02:00:00.000Z' });
    const capture = join(h.directory.path, 'report.txt');
    const append = `require('node:fs').writeFileSync(${JSON.stringify(capture)}, process.argv[process.argv.length - 1]);`;
    const sent = await sendHourlyEfficiencyReport(
      h.db,
      bucket,
      'hourly report',
      [process.execPath, '-e', append],
      2000,
      new Date('2026-10-31T02:15:00.000Z'),
    );
    expect(sent.disposition).toBe('sent');
    expect(sent.reportRef).toBe(createHash('sha256').update('hourly report').digest('hex'));
    const duplicate = await sendHourlyEfficiencyReport(
      h.db,
      bucket,
      'a changed retry cannot replace the persisted report',
      [process.execPath, '-e', `throw new Error('duplicate send')`],
      2000,
    );
    expect(duplicate.disposition).toBe('already-sent');
    expect(duplicate.reportRef).toBe(sent.reportRef);
    expect(readFileSync(capture, 'utf8')).toBe('hourly report');
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
    const attemptedResend = join(h.directory.path, 'unknown-resend.txt');
    const repeatedUnknown = await sendHourlyEfficiencyReport(
      h.db,
      timedOut.bucket,
      'a timed-out report remains unknown',
      [process.execPath, '-e', `require('node:fs').writeFileSync(${JSON.stringify(attemptedResend)}, 'sent')`],
      2000,
    );
    expect(repeatedUnknown.disposition).toBe('already-unknown');
    expect(repeatedUnknown.reportRef).toBe(timedOut.reportRef);
    expect(existsSync(attemptedResend)).toBe(false);
  } finally {
    h.close();
  }
});

test('hourly delivery preserves disabled, competing and interrupted-claim outcomes through the public API', async () => {
  const h = fixture();
  try {
    const bucket = '2026-10-31T01:00:00.000Z';
    const disabled = await sendHourlyEfficiencyReport(h.db, bucket, 'not sent', undefined, 2000);
    expect(disabled).toMatchObject({
      disposition: 'disabled',
      bucket,
      reportRef: null,
      detail: 'notifier unconfigured',
    });
    expect(
      Boolean(
        h.db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='efficiency_report_deliveries'").get(),
      ),
    ).toBe(false);

    const capture = join(h.directory.path, 'competing-report.txt');
    const firstReport = 'first report\nwith spaces; $(not-a-command)';
    const notifier = `require('node:fs').writeFileSync(${JSON.stringify(capture)}, process.argv[process.argv.length - 1]); setTimeout(() => {}, 40);`;
    const ownerPromise = sendHourlyEfficiencyReport(
      h.db,
      bucket,
      firstReport,
      [process.execPath, '-e', notifier],
      2000,
      new Date('2026-10-31T02:15:00.000Z'),
    );
    const competing = await sendHourlyEfficiencyReport(
      h.db,
      bucket,
      'replacement report',
      [process.execPath, '-e', 'process.exit(31)'],
      2000,
      new Date('2026-10-31T02:15:01.000Z'),
    );
    const owner = await ownerPromise;
    const firstReportRef = createHash('sha256').update(firstReport).digest('hex');
    expect(owner.disposition).toBe('sent');
    expect(owner.reportRef).toBe(firstReportRef);
    expect(competing).toMatchObject({ disposition: 'claimed', reportRef: firstReportRef });
    expect(readFileSync(capture, 'utf8')).toBe(firstReport);

    migrate(h.db, efficiencyReportMigrations);
    const interruptedBucket = '2026-10-31T03:00:00.000Z';
    const interruptedRef = 'persisted-report-reference';
    h.db
      .query(
        `INSERT INTO efficiency_report_deliveries(hour_bucket, report_ref, report, status, created_at, claimed_at)
         VALUES (?, ?, ?, 'claimed', ?, ?)`,
      )
      .run(
        interruptedBucket,
        interruptedRef,
        'original persisted report',
        '2026-10-31T03:00:00.000Z',
        '2026-10-31T03:01:00.000Z',
      );
    const attemptedResend = join(h.directory.path, 'interrupted-resend.txt');
    const interrupted = await sendHourlyEfficiencyReport(
      h.db,
      interruptedBucket,
      'replacement after interruption',
      [process.execPath, '-e', `require('node:fs').writeFileSync(${JSON.stringify(attemptedResend)}, 'sent')`],
      2000,
      new Date('2026-10-31T08:00:00.000Z'),
    );
    expect(interrupted).toMatchObject({
      disposition: 'already-unknown',
      reportRef: interruptedRef,
      detail: 'previous notifier outcome unknown after interruption',
    });
    expect(existsSync(attemptedResend)).toBe(false);
    expect(
      (
        h.db.query('SELECT status FROM efficiency_report_deliveries WHERE hour_bucket=?').get(interruptedBucket) as {
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
    for (const [index, reportBytes] of [1, 3, 200].entries()) {
      const report = await renderHourlyEfficiencyReport(h.db, {
        bucket: `2026-10-31T0${index + 1}:00:00.000Z`,
        policy: { ...policy, hourlyReport: { ...policy.hourlyReport, reportBytes } },
      });
      expect(Buffer.byteLength(report)).toBeLessThanOrEqual(reportBytes);
      expect(report).not.toContain('\uFFFD');
    }
    const sent = await sendHourlyEfficiencyReport(
      h.db,
      '2026-10-31T04:00:00.000Z',
      'bounded',
      [process.execPath, '-e', 'console.log("too much output")'],
      2000,
      new Date(),
      policy,
    );
    expect(sent.disposition).toBe('unknown');
    expect(sent.detail).toContain('output limit exceeded');
    const ordinary = await renderHourlyEfficiencyReport(h.db, { bucket: '2026-10-31T05:00:00.000Z' });
    expect(Buffer.byteLength(ordinary)).toBeGreaterThan(200);
  } finally {
    h.close();
  }
});

test('late commits and integrations remain backfill after the first measured bucket capture', async () => {
  const h = fixture();
  const repository = join(h.directory.path, 'dev');
  const bucket = '2026-10-31T01:00:00.000Z';
  const capturedAt = new Date('2026-10-31T02:15:00.000Z');
  try {
    mkdirSync(repository);
    git(repository, ['init', '-q']);
    git(repository, ['config', 'user.name', 'Goal report test']);
    git(repository, ['config', 'user.email', 'goal-report@example.invalid']);
    mkdirSync(join(repository, 'services/demo/src'), { recursive: true });
    writeFileSync(join(repository, 'services/demo/src/index.ts'), 'export const first = 1;\nexport const second = 2;\n');
    git(repository, ['add', '.']);
    git(repository, ['commit', '-q', '-m', 'initial product source'], {
      GIT_AUTHOR_DATE: '2026-10-31T01:10:00Z',
      GIT_COMMITTER_DATE: '2026-10-31T01:10:00Z',
    });
    git(repository, ['branch', '-M', 'dev']);

    const firstMeasurement = measureProductLineObservation(repository, bucket, capturedAt);
    expect(firstMeasurement.productLines).toBe(2);
    const first = captureHourlyEfficiencyObservation(h.db, {
      bucket,
      now: capturedAt,
      productLineMeasurement: firstMeasurement,
    });
    expect(first.snapshot.report).toContain(`Product lines added in UTC bucket: 2 (attribution measured; dev@${firstMeasurement.sourceRevision}`);

    writeFileSync(join(repository, 'services/demo/src/late.ts'), 'export const late = true;\n');
    git(repository, ['add', '.']);
    git(repository, ['commit', '-q', '-m', 'late integration source'], {
      GIT_AUTHOR_DATE: '2026-10-31T01:40:00Z',
      GIT_COMMITTER_DATE: '2026-10-31T01:40:00Z',
    });
    const lateMeasurement = measureProductLineObservation(repository, bucket, capturedAt);
    expect(lateMeasurement.productLines).toBe(3);
    expect(lateMeasurement.sourceRevision).not.toBe(firstMeasurement.sourceRevision);

    task(h.db, 'late-integration', 'integrated', 'web');
    recordFlow(h.db, {
      taskId: 'late-integration',
      attempt: 1,
      stage: 'integration',
      action: 'integrated',
      at: '2026-10-31T02:10:00.000Z',
      detail: JSON.stringify({ integrationTarget: 'integration' }),
    });
    const retry = captureHourlyEfficiencyObservation(h.db, {
      bucket,
      now: capturedAt,
      productLineMeasurement: lateMeasurement,
    });
    expect(retry.disposition).toBe('conflicting');
    expect(retry.attribution).toBe('conflicting');
    expect(retry.snapshot.reportRef).toBe(first.snapshot.reportRef);
    expect(retry.snapshot.report).toBe(first.snapshot.report);
    expect(retry.snapshot.observation.productLines).toBe(2);
    expect(retry.snapshot.conflict).toMatchObject({
      reportRef: first.snapshot.reportRef,
      productLines: 3,
      attribution: 'measured',
      sourceRevision: lateMeasurement.sourceRevision,
    });

    const nextBucket = '2026-10-31T02:00:00.000Z';
    const nextMeasurement = measureProductLineObservation(
      repository,
      nextBucket,
      new Date('2026-10-31T03:15:00.000Z'),
      firstMeasurement.sourceRevision,
    );
    expect(nextMeasurement.productLines).toBe(0);
    expect(nextMeasurement.backfillProductLines).toBe(1);
    expect(nextMeasurement.backfillFromRevision).toBe(firstMeasurement.sourceRevision);
    const backfill = captureHourlyEfficiencyObservation(h.db, {
      bucket: nextBucket,
      now: new Date('2026-10-31T03:15:00.000Z'),
      productLineMeasurement: nextMeasurement,
    });
    expect(backfill.snapshot.report).toContain('Landing identities: late-integration#1 at 2026-10-31T02:10:00.000Z (dev).');
    expect(backfill.snapshot.report).toContain('Late integration backfill in this bucket: 1 additions newly visible since');
    expect(backfill.snapshot.report).toContain('Late integrations remain visible in their integration bucket');
    expect(backfill.snapshot.observation.backfillProductLines).toBe(1);
    expect(backfill.snapshot.rolling).toEqual({ productLines: 2, attribution: 'measured' });
  } finally {
    h.close();
  }
});

test('two-hour product totals sum independent frozen observations', () => {
  const h = fixture();
  try {
    const first = captureHourlyEfficiencyObservation(h.db, {
      bucket: '2026-10-31T00:00:00.000Z',
      now: new Date('2026-10-31T01:15:00.000Z'),
      productLineMeasurement: measuredLines(2979, 'a'.repeat(40)),
    });
    const second = captureHourlyEfficiencyObservation(h.db, {
      bucket: '2026-10-31T01:00:00.000Z',
      now: new Date('2026-10-31T02:15:00.000Z'),
      productLineMeasurement: measuredLines(4266, 'b'.repeat(40)),
    });
    expect(first.snapshot.rolling).toEqual({ productLines: null, attribution: 'unknown' });
    expect(second.snapshot.rolling).toEqual({ productLines: 7245, attribution: 'measured' });
    expect(second.snapshot.report).toContain('Product lines across this and the previous completed UTC hour: 7245 across two frozen observations.');
    expect(second.snapshot.report).not.toContain('10232');
    const stored = h.db
      .query('SELECT hour_bucket, product_lines, source_revision, source_window_start, source_window_end, filter_version, report_ref FROM efficiency_report_deliveries ORDER BY hour_bucket')
      .all() as {
      hour_bucket: string;
      product_lines: number;
      source_revision: string;
      source_window_start: string;
      source_window_end: string;
      filter_version: string;
      report_ref: string;
    }[];
    expect(stored.map((row) => [row.hour_bucket, row.product_lines])).toEqual([
      ['2026-10-31T00:00:00.000Z', 2979],
      ['2026-10-31T01:00:00.000Z', 4266],
    ]);
    expect(stored[1]).toMatchObject({
      source_revision: 'b'.repeat(40),
      source_window_start: '2026-10-31T01:00:00.000Z',
      source_window_end: '2026-10-31T02:00:00.000Z',
      filter_version: 'rezics-product-code-v1',
      report_ref: second.snapshot.reportRef,
    });
  } finally {
    h.close();
  }
});

test('missing historical product evidence remains unknown after a measured retry', () => {
  const h = fixture();
  try {
    const bucket = '2026-10-31T01:00:00.000Z';
    const unknown = captureHourlyEfficiencyObservation(h.db, {
      bucket,
      now: new Date('2026-10-31T02:15:00.000Z'),
    });
    expect(unknown.snapshot.observation).toMatchObject({ productLines: null, attribution: 'unknown' });
    expect(unknown.snapshot.rolling).toMatchObject({ productLines: null, attribution: 'unknown' });
    expect(unknown.snapshot.report).toContain('Product lines added in UTC bucket: unknown (attribution unknown; source revision unavailable');

    const retry = captureHourlyEfficiencyObservation(h.db, {
      bucket,
      now: new Date('2026-10-31T02:20:00.000Z'),
      productLineMeasurement: measuredLines(10_232, 'c'.repeat(40)),
    });
    expect(retry.disposition).toBe('conflicting');
    expect(retry.attribution).toBe('conflicting');
    expect(retry.snapshot.reportRef).toBe(unknown.snapshot.reportRef);
    expect(retry.snapshot.observation).toMatchObject({ productLines: null, attribution: 'unknown' });
    expect(retry.snapshot.report).toBe(unknown.snapshot.report);
    expect(retry.snapshot.conflict).toMatchObject({
      productLines: 10_232,
      attribution: 'measured',
      sourceRevision: 'c'.repeat(40),
      reportRef: unknown.snapshot.reportRef,
    });
  } finally {
    h.close();
  }
});

test('concurrent first capture, restart and delivery replay share the original report bytes', async () => {
  const h = fixture();
  const databasePath = join(h.directory.path, 'goal.sqlite');
  const reportFile = join(h.directory.path, 'delivered.txt');
  type ChildCapture = { disposition: string; reportRef: string; report: string };
  h.db.close();
  try {
    const [one, two] = await Promise.all([
      runCaptureChild(databasePath, 2979, 'a'.repeat(40)).then((value) => JSON.parse(value) as ChildCapture),
      runCaptureChild(databasePath, 4266, 'b'.repeat(40)).then((value) => JSON.parse(value) as ChildCapture),
    ]);
    expect([one.disposition, two.disposition].sort()).toEqual(['captured', 'conflicting']);
    expect(one.report).toBe(two.report);
    expect(one.reportRef).toBe(two.reportRef);

    const reopened = openDb(databasePath);
    try {
      const replay = await renderHourlyEfficiencyReport(reopened, { bucket: '2026-10-31T01:00:00.000Z' });
      const frozen = readFrozenHourlyEfficiencyReport(reopened, '2026-10-31T01:00:00.000Z')!;
      expect(replay).toBe(one.report);
      expect(frozen.reportRef).toBe(one.reportRef);
      expect(frozen.conflict).toMatchObject({ reportRef: one.reportRef });

      const send = `require('node:fs').writeFileSync(${JSON.stringify(reportFile)}, process.argv[process.argv.length - 1]);`;
      const firstDelivery = await sendHourlyEfficiencyReport(
        reopened,
        frozen.bucket,
        'different retry bytes',
        [process.execPath, '-e', send],
        2000,
      );
      const duplicate = await sendHourlyEfficiencyReport(
        reopened,
        frozen.bucket,
        'replacement must not be sent',
        [process.execPath, '-e', 'process.exit(9)'],
        2000,
      );
      expect(firstDelivery).toMatchObject({ disposition: 'sent', reportRef: one.reportRef });
      expect(duplicate).toMatchObject({ disposition: 'already-sent', reportRef: one.reportRef });
      expect(readFileSync(reportFile, 'utf8')).toBe(one.report);
    } finally {
      reopened.close();
    }
  } finally {
    h.directory.close();
  }
});
