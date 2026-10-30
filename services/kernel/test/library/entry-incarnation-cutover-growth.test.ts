import { afterAll, beforeAll, expect, test } from 'bun:test';
import { DBOS } from '@dbos-inc/dbos-sdk';
import type { PoolClient } from 'pg';
import type { AccountActor } from '../../src/request/access.ts';
import { cutoverEntryIncarnationsPage } from '../../src/library/entry-incarnation-cutover.ts';
import {
  libraryWorkModule,
  ENTRY_INCARNATION_CUTOVER_SCHEDULE,
  LABEL_RETENTION_SCHEDULE,
} from '../../src/library/work-module.ts';
import { ENTRY_RETENTION_SCHEDULE } from '../../src/library/entry-due-work.ts';
import { createWorkClient } from '../../src/work/client.ts';
import { composeWork } from '../../src/work/registry.ts';
import { accountToken } from '../support/admitted-access.ts';
import { deadlineFor } from '../../src/request/deadline.ts';
import {
  assertGrowthAccessPaths,
  checkGrowth,
  openGrowthDatabase,
  type GrowthDatabase,
  type ReportSample,
} from '../support/growth.ts';
import { createProfileEntryFixture, entryKey, type NativeProfileFixture } from './support/profile-entry-fixture.ts';
import { fact, legacy } from './support/entry-incarnation-cutover-runtime.ts';
import { observeRetentionQueries, renewRetentionIdentities } from './entry-retention-worker-runtime.ts';

let db: GrowthDatabase, f: NativeProfileFixture;
let client: Awaited<ReturnType<typeof createWorkClient>>, work: Awaited<ReturnType<typeof composeWork>>;
let owner: AccountActor, noiseOwner: AccountActor, noiseSubject: string;
let history: () => Promise<null>;
const subjects: string[] = [];
const completed = new Map<string, () => void>();
let retried = false;
type PageWireCost = { rows: number; statements: number; requestBytes: number; responseBytes: number };
let measured = false;
let pageWireCosts: PageWireCost[] = [];
// Query values include native bigint revisions. Preserve their exact decimal representation in this
// supplementary per-page ledger; shared growth capture measures the actual PostgreSQL wire bytes.
function jsonBytes(value: unknown) {
  return Buffer.byteLength(JSON.stringify(value, (_key, item) => (typeof item === 'bigint' ? item.toString() : item)));
}
beforeAll(async () => {
  db = await openGrowthDatabase();
  f = await createProfileEntryFixture({ pool: db.pool, projectLinks: false });
  owner = (await f.identity(['subject:read', 'library_entry:read', 'library_entry:update'], 4095)).actor;
  noiseOwner = (await f.identity(['subject:read', 'library_entry:read', 'library_entry:update'], 4094)).actor;
  noiseSubject = await f.createSubject('game');
  await f.commands.putEntry(noiseOwner, noiseSubject, { state: 'playing' }, entryKey());
  for (let n = 0; n < 101; n++) {
    const subject = await f.createSubject('game');
    subjects.push(subject);
    await f.commands.putEntry(owner, subject, { state: 'playing' }, entryKey());
  }
  subjects.sort();
  const outcomes = new WeakMap<PoolClient, string>();
  await observeRetentionQueries(db.pool, ({ connection, sql, values, result }) => {
    if (measured && /^BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY/i.test(sql))
      pageWireCosts.push({ rows: 0, statements: 0, requestBytes: 0, responseBytes: 0 });
    const page = measured ? pageWireCosts.at(-1) : undefined;
    if (page) {
      page.rows += result.rows.length;
      page.statements++;
      page.requestBytes += Buffer.byteLength(sql) + jsonBytes(values);
      page.responseBytes += jsonBytes(result.rows);
    }
    if (/INSERT INTO "dbos"\.workflow_output\b/i.test(sql)) outcomes.set(connection, String(values[0]));
    if (/^COMMIT$/i.test(sql.trim())) {
      const id = outcomes.get(connection);
      outcomes.delete(connection);
      if (id) completed.get(id)?.();
    } else if (/^ROLLBACK$/i.test(sql.trim())) outcomes.delete(connection);
  });
  client = await createWorkClient(db.url, db.openPool());
  work = await composeWork(
    [
      libraryWorkModule,
      {
        name: 'cutover-growth-history',
        register() {
          const step = DBOS.registerStep(async () => null, { name: 'cutover.history.step' });
          history = DBOS.registerWorkflow(async () => step(), { name: 'cutover.history.workflow' });
        },
      },
    ],
    { pool: db.pool, client, databaseUrl: db.url, env: {} },
  );
  for (const schedule of [ENTRY_INCARNATION_CUTOVER_SCHEDULE, ENTRY_RETENTION_SCHEDULE, LABEL_RETENTION_SCHEDULE])
    await client.pauseSchedule(schedule);
  await work.launch();
}, 180000);
afterAll(async () => {
  await work?.shutdown();
  await client?.close();
  await f?.close();
  await db?.close();
});

async function renew() {
  await renewRetentionIdentities(f);
  owner = await f.access.authenticate(await accountToken(owner), { pool: db.pool, deadline: deadlineFor(30000) });
  noiseOwner = await f.access.authenticate(await accountToken(noiseOwner), {
    pool: db.pool,
    deadline: deadlineFor(30000),
  });
}
async function reset(ids = subjects) {
  for (const subject of ids) await legacy(db.pool, owner.accountId, subject);
}
async function segment() {
  const root = `cutover-growth:${crypto.randomUUID()}`;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const committed = new Promise<void>((resolve, reject) => {
    completed.set(root, resolve);
    timeout = setTimeout(() => reject(new Error(`Native workflow outcome did not commit: ${root}`)), 120000);
  });
  try {
    const handle = await client.enqueue(
      { workflowName: 'library.entryIncarnationCutoverSegment', queueName: 'maintenance', workflowID: root },
      { root, sequence: 0, partition: 4095, after: null },
    );
    await committed;
    expect(await handle.getResult()).toEqual({ partition: 4096, after: null });
  } finally {
    clearTimeout(timeout);
    completed.delete(root);
  }
  const pages = (await client.listWorkflowSteps(root))!
    .filter((s) => s.name === 'library.entryIncarnationCutoverPage')
    .map((s) => s.output as { examined: number; stamped: number; pending: number; next: string | null });
  expect(pages).toHaveLength(2);
  expect(pages.map((p) => p.examined)).toEqual([100, 1]);
  for (const page of pages) expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(4096);
  return pages;
}
function evidence(name: string, samples: readonly ReportSample[], worker = false) {
  assertGrowthAccessPaths(name, samples, [
    'library.entry',
    'core.partition',
    'core.receipt',
    'access.account',
    'dbos.operation_outputs',
  ]);
  expect(samples).toHaveLength(3);
  for (const sample of samples) {
    expect(sample.cost.plans).toBeGreaterThan(0);
    expect(sample.cost.rows).toBeGreaterThan(0);
    expect(sample.cost.blocks).toBeGreaterThan(0);
    expect(sample.cost.statements).toBeGreaterThan(0);
    expect(sample.cost.controlStatements).toBeGreaterThan(0);
    expect(sample.cost.requestBytes).toBeGreaterThan(0);
    expect(sample.cost.responseBytes).toBeGreaterThan(0);
    expect(sample.cost.relations['core.partition']?.rows ?? 0).toBeGreaterThan(0);
    expect(sample.cost.relations['access.account']?.rows ?? 0).toBeGreaterThan(0);
    expect(sample.occurrenceRepetitions[0]!.statements.length).toBeGreaterThan(0);
    // Charge the source BEGIN, native attempts and intervening SDK checkpoint/control statements to each
    // page through the next source BEGIN. Setup is outside the capture; background remains in its own ledger.
    const pages: { rows: number; blocks: number; statements: number }[] = [];
    for (const occurrence of sample.occurrenceRepetitions[0]!.statements) {
      if (/^BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY/i.test(occurrence.statement))
        pages.push({ rows: 0, blocks: 0, statements: 0 });
      const page = pages.at(-1);
      if (page) {
        page.rows += occurrence.rows;
        page.blocks += occurrence.blocks;
        page.statements++;
      }
    }
    expect(pages.length).toBeGreaterThan(0);
    for (const page of pages) {
      expect(page.rows).toBeGreaterThan(0);
      expect(page.blocks).toBeGreaterThan(0);
      expect(page.statements).toBeGreaterThan(0);
    }
    console.log(
      JSON.stringify({ name, scale: sample.scale, pages, backgroundStatements: sample.cost.backgroundStatements ?? 0 }),
    );
    if (worker) expect(sample.cost.relations['dbos.operation_outputs']?.rows ?? 0).toBeGreaterThan(0);
  }
}

async function wirePages<T>(count: number, body: () => Promise<T>): Promise<T> {
  pageWireCosts = [];
  measured = true;
  let result: T;
  try {
    result = await body();
  } finally {
    measured = false;
  }
  expect(pageWireCosts).toHaveLength(count);
  for (const page of pageWireCosts) {
    expect(page.rows).toBeGreaterThan(0);
    expect(page.statements).toBeGreaterThan(0);
    expect(page.requestBytes).toBeGreaterThan(0);
    expect(page.responseBytes).toBeGreaterThan(0);
  }
  console.log(JSON.stringify({ nativePageWireCosts: pageWireCosts }));
  return result;
}

// Grow SDK history first through its real 64/512/4096 axis. Later independent live-entry and receipt
// axes hold that history fixed; their own measured workflows must not become a second growing axis.
test('default SDK dense pages and genuine native serialization retry stay bounded at 64/512/4096 independently growing work histories', async () => {
  // One real SQLSTATE 40001 before native COMMIT, tracked by a nontransactional test sequence.
  // The sequence is test fault control, not a row/identity/authority producer.
  await db.admin.query(`CREATE SEQUENCE public.cutover_retry;
    CREATE FUNCTION public.cutover_retry_once() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF nextval('public.cutover_retry') = 1 THEN
      RAISE EXCEPTION 'cutover native serialization retry' USING ERRCODE='40001';
    END IF; RETURN NEW; END $$;
    CREATE TRIGGER cutover_retry BEFORE UPDATE OF incarnation_id ON library.entry
      FOR EACH ROW WHEN (NEW.incarnation_id IS NOT NULL) EXECUTE FUNCTION public.cutover_retry_once()`);
  try {
    const report = await checkGrowth(db, {
      name: 'entry incarnation default worker against independently growing SDK histories with native retry',
      scales: [64, 512, 4096],
      repetitions: 1,
      bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
      byteBounds: { requestBytes: 'constant', responseBytes: 'constant' },
      async grow(_db, scale, previous) {
        for (let n = previous; n < scale; n++)
          await (await DBOS.startWorkflow(history, { workflowID: `cutover-unrelated:${n}` })()).getResult();
      },
      async prepare() {
        await reset();
        await db.admin.query('ALTER SEQUENCE public.cutover_retry RESTART WITH 1');
      },
      async warmup() {},
      async operation() {
        await wirePages(2, async () => {
          const pages = await segment();
          expect(pages.map((p) => p.stamped)).toEqual([100, 1]);
          expect(pages.reduce((n, p) => n + p.pending, 0)).toBe(0);
          retried = true;
        });
      },
    });
    evidence(report.name, report.samples, true);
    expect(retried).toBe(true);
    for (const sample of report.samples) expect(sample.cost.failedStatements?.['40001'] ?? 0).toBeGreaterThan(0);
  } finally {
    await db.admin.query(
      'DROP TRIGGER cutover_retry ON library.entry; DROP FUNCTION public.cutover_retry_once(); DROP SEQUENCE public.cutover_retry',
    );
  }
}, 900000);

test('raw native dense and sparse cutover pages charge actual rows blocks statements bytes and controls at 64/512/4096 unrelated live entries', async () => {
  const report = await checkGrowth(db, {
    name: 'entry incarnation raw dense and sparse pages against independently growing live entries',
    scales: [64, 512, 4096],
    repetitions: 1,
    bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
    byteBounds: { requestBytes: 'constant', responseBytes: 'constant' },
    async grow(_db, scale, previous) {
      for (let n = previous; n < scale; n++) {
        if (n % 20 === 0) await renew();
        // Each row enters through native identity/grant/profile/source admission. No payload seeding.
        const unrelated = (await f.identity(['subject:read', 'library_entry:update'], 4094)).actor;
        await f.commands.putEntry(unrelated, noiseSubject, { state: 'playing' }, entryKey());
      }
    },
    async prepare() {
      await reset();
    },
    async warmup() {},
    async operation() {
      await wirePages(3, async () => {
        const first = await cutoverEntryIncarnationsPage(
          { pool: db.pool, client },
          { partition: 4095, after: null, limit: 100 },
        );
        expect(first.examined).toBe(100);
        expect(first.stamped).toBe(100);
        expect(first.pending).toBe(0);
        const tail = await cutoverEntryIncarnationsPage(
          { pool: db.pool, client },
          { partition: 4095, after: first.next, limit: 100 },
        );
        expect(tail.examined).toBe(1);
        expect(tail.stamped).toBe(1);
        expect(tail.next).toBeNull();
        const nonlegacy = await cutoverEntryIncarnationsPage(
          { pool: db.pool, client },
          { partition: 4095, after: null, limit: 100 },
        );
        expect(nonlegacy.examined).toBe(100);
        expect(nonlegacy.stamped).toBe(0);
        for (const page of [first, tail, nonlegacy])
          expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(4096);
        await expect(
          cutoverEntryIncarnationsPage({ pool: db.pool }, { partition: -1, after: null, limit: 100 }),
        ).rejects.toThrow('Invalid partition');
      });
    },
  });
  evidence(report.name, report.samples);
  expect(report.samples.at(-1)!.relationSizes['library.entry']!.relpages).toBeGreaterThan(8);
}, 900000);

test('default SDK sparse and nonlegacy pages stay bounded at 64/512/4096 independently growing native command receipts', async () => {
  const report = await checkGrowth(db, {
    name: 'entry incarnation default worker against independently growing native receipt history',
    scales: [64, 512, 4096],
    repetitions: 1,
    bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
    byteBounds: { requestBytes: 'constant', responseBytes: 'constant' },
    async grow(_db, scale, previous) {
      for (let n = previous; n < scale; n++) {
        if (n % 20 === 0) await renew();
        const current = await f.commands.readEntry(noiseOwner, noiseSubject);
        await f.commands.putEntry(
          noiseOwner,
          noiseSubject,
          { state: 'playing', revision: current.revision, incarnationId: current.incarnationId! },
          entryKey(),
        );
      }
    },
    async prepare() {
      await reset([subjects.at(-1)!]);
    },
    async warmup() {},
    async operation() {
      await wirePages(2, async () => {
        const pages = await segment();
        expect(pages.map((p) => p.stamped)).toEqual([0, 1]);
        expect(pages.reduce((n, p) => n + p.pending, 0)).toBe(0);
      });
    },
  });
  evidence(report.name, report.samples, true);
}, 900000);

test('fenced and moved native partitions remain pending and later fresh default sweeps recover rows behind the frontier', async () => {
  await reset([subjects[0]!]);
  const before = await fact(db.pool, owner.accountId, subjects[0]!);
  for (const state of ['fenced', 'moved']) {
    await db.admin.query('UPDATE core.partition SET write_state=$2,moved_to=$3 WHERE partition_no=$1', [
      4095,
      state,
      state === 'moved' ? 'cutover-other-node' : null,
    ]);
    try {
      const root = `cutover-fenced:${crypto.randomUUID()}`;
      const handle = await client.enqueue(
        { workflowName: 'library.entryIncarnationCutoverSegment', queueName: 'maintenance', workflowID: root },
        { root, sequence: 0, partition: 4095, after: null },
      );
      await handle.getResult({ pollingIntervalMs: 20 });
      const pages = (await client.listWorkflowSteps(root))!.filter(
        (s) => s.name === 'library.entryIncarnationCutoverPage',
      );
      expect(pages.map((p) => p.output)).toEqual([{ examined: 0, stamped: 0, next: null, pending: 1 }]);
      expect(await fact(db.pool, owner.accountId, subjects[0]!)).toEqual(before);
    } finally {
      await db.admin.query(
        "UPDATE core.partition SET write_state='active',moved_to=NULL WHERE partition_no=$1",
        [4095],
      );
    }
  }
  expect((await segment()).reduce((n, p) => n + p.stamped, 0)).toBe(1);
}, 120000);
