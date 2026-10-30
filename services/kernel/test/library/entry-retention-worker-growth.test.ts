import { afterAll, beforeAll, expect, test } from 'bun:test';
import { DBOS } from '@dbos-inc/dbos-sdk';
import type { PoolClient } from 'pg';
import { composeWork } from '../../src/work/registry.ts';
import { createWorkClient } from '../../src/work/client.ts';
import { ENTRY_RETENTION_SCHEDULE } from '../../src/library/entry-due-work.ts';
import { libraryWorkModule } from '../../src/library/work-module.ts';
import { partitionOf, routeOf } from '../../src/route/route.ts';
import type { DueEntryDeletionKey } from '../../src/library/entry-due-store.ts';
import { checkGrowth, openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';
import { accountToken } from '../support/admitted-access.ts';
import { deadlineFor } from '../../src/request/deadline.ts';
import {
  archive,
  growRetentionPopulation,
  observeRetentionQueries,
  renewRetentionIdentities,
} from './entry-retention-worker-runtime.ts';
import { createProfileEntryFixture, type NativeProfileFixture } from './support/profile-entry-fixture.ts';

let db: GrowthDatabase, f: NativeProfileFixture;
let work: Awaited<ReturnType<typeof composeWork>>;
let client: Awaited<ReturnType<typeof createWorkClient>>;
let historyWorkflow: () => Promise<null>;
let actor: NativeProfileFixture['owner']['actor'];
let time = Date.now();
const origin = time;
const partition = 4094;
let subjects: string[];
let noise: string;
let targets: DueEntryDeletionKey[] = [];
const completed = new Map<string, () => void>();
beforeAll(async () => {
  db = await openGrowthDatabase();
  const outcomes = new WeakMap<PoolClient, string>();
  await observeRetentionQueries(db.pool, ({ connection, sql, values }) => {
    if (/INSERT INTO "dbos"\.workflow_output\b/i.test(sql)) outcomes.set(connection, String(values[0]));
    if (/^COMMIT$/i.test(sql.trim())) {
      const id = outcomes.get(connection);
      outcomes.delete(connection);
      if (id) completed.get(id)?.();
    } else if (/^ROLLBACK$/i.test(sql.trim())) outcomes.delete(connection);
  });
  f = await createProfileEntryFixture({ pool: db.pool, clock: () => new Date(time), projectLinks: false });
  actor = (await f.identity(['subject:read', 'library_entry:update', 'library_entry:delete'], partition)).actor;
  const route = routeOf(actor.accountId);
  if (route === null) throw new Error('The native fixture owner must carry a route');
  expect(partitionOf(route)).toBe(partition);
  noise = await f.createSubject('game');
  subjects = [];
  for (let n = 0; n < 101; n++) subjects.push(await f.createSubject('game'));
  client = await createWorkClient(db.url, db.openPool());
  work = await composeWork(
    [
      libraryWorkModule,
      {
        name: 'entry-retention-growth-history',
        register() {
          const step = DBOS.registerStep(async () => null, { name: 'retention.history.step' });
          historyWorkflow = DBOS.registerWorkflow(async () => step(), { name: 'retention.history.workflow' });
        },
      },
    ],
    { pool: db.pool, client, databaseUrl: db.url, clock: () => new Date(time), env: {} },
  );
  // Isolate the explicitly queued native cost operation from wall-clock cron dispatch.
  await client.pauseSchedule(ENTRY_RETENTION_SCHEDULE);
  await work.launch();
}, 120000);
afterAll(async () => {
  await work?.shutdown();
  await client?.close();
  await f?.close();
  await db?.close();
});

async function runSegment(cutoff: string, start = partition) {
  const root = `retention-growth:${crypto.randomUUID()}`;
  // Observe the SDK's real outcome COMMIT, then read its result once. Driver polling is not worker work.
  // Every native worker/SDK query remains captured, including this final result and checkpoint read.
  let timeout: ReturnType<typeof setTimeout>;
  const committed = new Promise<void>((resolve, reject) => {
    completed.set(root, resolve);
    timeout = setTimeout(() => reject(new Error(`Native workflow outcome did not commit: ${root}`)), 120000);
  });
  try {
    const handle = await client.enqueue(
      { workflowName: 'library.entryRetentionSegment', workflowID: root, queueName: 'maintenance' },
      { root, sequence: 0, cutoff, cursor: { partition: start } },
    );
    await committed;
    await handle.getResult();
  } finally {
    clearTimeout(timeout!);
    completed.delete(root);
  }
  const steps = await client.listWorkflowSteps(root);
  const pages =
    steps
      ?.filter((s) => s.name === 'library.entryRetentionPage')
      .map(
        (s) =>
          s.output as {
            examined: number;
            purged: number;
            pending: number;
            probes: number;
            cursor: { partition: number; after?: DueEntryDeletionKey };
          },
      ) ?? [];
  expect(pages.length).toBeGreaterThan(0);
  expect(pages.length).toBeLessThanOrEqual(100);
  for (const page of pages) {
    expect(page.examined).toBeLessThanOrEqual(100);
    expect(page.probes).toBeLessThanOrEqual(100);
    expect(page.cursor.partition).toBeGreaterThanOrEqual(start);
    expect(Object.keys(page).sort()).toEqual(['cursor', 'examined', 'pending', 'probes', 'purged']);
  }
  return pages;
}

async function renewActor() {
  await renewRetentionIdentities(f);
  actor = await f.access.authenticate(await accountToken(actor), { pool: db.pool, deadline: deadlineFor(30000) });
}
async function prepare() {
  time = origin;
  await renewActor();
  targets = [];
  for (const subject of subjects) targets.push(await archive(f, subject, actor));
  time = Date.parse(targets[0]!.restoreUntil);
}
async function operation() {
  const pages = await runSegment(new Date(time).toISOString());
  expect(pages.reduce((n, page) => n + page.purged, 0)).toBe(101);
  expect(pages.filter((page) => page.examined > 0).length).toBeGreaterThanOrEqual(2);
  const last = pages.at(-1)!;
  expect(last.cursor).toEqual({ partition: 4096 });
  // Exact same original deadlines exercise the full route/account/deletion tie cursor.
  expect(new Set(targets.map((key) => key.restoreUntil)).size).toBe(1);
}

test('default registered worker pages charge actual native discovery, core command, replay and DBOS work at three legal population scales', async () => {
  const report = await checkGrowth(db, {
    name: 'entry retention worker: dense tied first and continuation pages through the actual maintenance queue',
    scales: [256, 1024, 4096],
    repetitions: 1,
    bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
    async grow(_db, scale, previous) {
      time = origin + 86400000;
      await growRetentionPopulation(f, partition, noise, previous, scale);
      const ids = [];
      for (let n = previous; n < scale; n++) {
        const root = `retention-unrelated:${n}`;
        ids.push(root);
        // Unrelated history uses real SDK execution without consuming the maintenance queue's two slots.
        // The measured retention segment still enters through that actual default queue.
        await (await DBOS.startWorkflow(historyWorkflow, { workflowID: root })()).getResult();
      }
      // Native completed workflows grow status, input, output and step history together.
      const history = await db.admin.query(
        `SELECT count(*)::integer AS count FROM dbos.workflow_status AS status
         JOIN dbos.workflow_output AS output USING (workflow_uuid)
         JOIN dbos.operation_outputs AS step USING (workflow_uuid)
         WHERE status.workflow_uuid = ANY($1::text[]) AND status.status='SUCCESS'
           AND step.function_name='retention.history.step'`,
        [ids],
      );
      expect(history.rows).toEqual([{ count: scale - previous }]);
    },
    prepare,
    async warmup() {
      await prepare();
      await operation();
    },
    operation,
  });
  expect(report.samples).toHaveLength(3);
  for (const sample of report.samples) {
    expect(sample.cost.plans).toBeGreaterThan(0);
    expect(sample.cost.rows).toBeGreaterThan(0);
    expect(sample.cost.relations['library.entry_deleted']?.sequentialScans ?? 0).toBe(0);
    expect(sample.cost.relations['core.partition']?.rows ?? 0).toBeGreaterThan(0);
    expect(sample.cost.relations['core.receipt']?.rows ?? 0).toBeGreaterThan(0);
    expect(sample.cost.relations['dbos.operation_outputs']?.rows ?? 0).toBeGreaterThan(0);
  }
  const empty = await runSegment(new Date(time).toISOString());
  expect(empty.reduce((n, p) => n + p.examined, 0)).toBe(0);
  expect(empty.reduce((n, p) => n + p.probes, 0)).toBe(2);
}, 900000);

test('fenced and moved partition discovery reports pending and a fresh worker sweep resumes without permanent highwater', async () => {
  time = origin;
  await renewActor();
  const target = await archive(f, subjects[0]!, actor);
  time = Date.parse(target.restoreUntil);
  for (const state of ['fenced', 'moved']) {
    await db.admin.query('UPDATE core.partition SET write_state=$2, moved_to=$3 WHERE partition_no=$1', [
      partition,
      state,
      state === 'moved' ? 'retention-other-node' : null,
    ]);
    try {
      const pages = await runSegment(new Date(time).toISOString());
      expect(pages.reduce((n, p) => n + p.pending, 0)).toBe(1);
      expect(pages.reduce((n, p) => n + p.purged, 0)).toBe(0);
    } finally {
      await db.admin.query("UPDATE core.partition SET write_state='active', moved_to=NULL WHERE partition_no=$1", [
        partition,
      ]);
    }
  }
  expect((await runSegment(new Date(time).toISOString())).reduce((n, p) => n + p.purged, 0)).toBe(1);
}, 120000);

test('one finite page deadline survives partial native commits and retries the unfinished cursor without dropping admitted keys', async () => {
  time = origin;
  await renewActor();
  const keys = [];
  for (const subject of subjects.slice(0, 3)) keys.push(await archive(f, subject, actor));
  time = Date.parse(keys[0]!.restoreUntil);
  // A real native delay exhausts the carried five-second service budget after earlier commands commit.
  await db.admin.query(`CREATE FUNCTION public.delay_retention_delete() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN PERFORM pg_sleep(1.8); RETURN OLD; END $$;
    CREATE TRIGGER retention_delete_delay BEFORE DELETE ON library.entry_deleted
    FOR EACH ROW EXECUTE FUNCTION public.delay_retention_delete()`);
  try {
    const pages = await runSegment(new Date(time).toISOString());
    expect(pages.reduce((n, p) => n + p.purged, 0)).toBeLessThan(3);
    const events = await db.admin.query(
      "SELECT data->>'deletionId' AS id FROM core.outbox WHERE subject=$1 AND type='com.rezics.library.entry.purged.v1' AND data->>'deletionId'=ANY($2::text[])",
      [actor.accountId, keys.map((k) => k.deletionId)],
    );
    expect(events.rows.map((r) => r.id).sort()).toEqual(keys.map((k) => k.deletionId).sort());
    expect((await runSegment(new Date(time).toISOString())).reduce((n, p) => n + p.examined, 0)).toBe(0);
  } finally {
    await db.admin.query(
      'DROP TRIGGER retention_delete_delay ON library.entry_deleted; DROP FUNCTION public.delay_retention_delete()',
    );
  }
}, 120000);
