import { afterAll, beforeAll, expect, test } from 'bun:test';
import { DBOS } from '@dbos-inc/dbos-sdk';
import type { AccountActor } from '../../src/request/access.ts';
import { createPersonalLabelCommands } from '../../src/library/label-commands.ts';
import { purgeLabelRetentionPage } from '../../src/library/label-retention.ts';
import { libraryWorkModule, LABEL_RETENTION_SCHEDULE } from '../../src/library/work-module.ts';
import { ENTRY_RETENTION_SCHEDULE } from '../../src/library/entry-due-work.ts';
import { composeWork } from '../../src/work/registry.ts';
import { createWorkClient } from '../../src/work/client.ts';
import { routeOf } from '../../src/route/route.ts';
import { deadlineFor } from '../../src/request/deadline.ts';
import { accountToken } from '../support/admitted-access.ts';
import { checkGrowth, assertGrowthAccessPaths, openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';
import { createProfileEntryFixture, entryKey, type NativeProfileFixture } from './support/profile-entry-fixture.ts';
import { assignment, label } from './support/label-retention-runtime.ts';
import { observeRetentionQueries } from './entry-retention-worker-runtime.ts';
let db: GrowthDatabase, f: NativeProfileFixture, work: Awaited<ReturnType<typeof composeWork>>;
let client: Awaited<ReturnType<typeof createWorkClient>>;
let owner: AccountActor, other: AccountActor, workerOwner: AccountActor;
let time = Date.now();
const origin = time,
  windowMs = 720 * 60 * 60 * 1000,
  clock = () => new Date(time);
const commits = new Map<string, () => void>();
let history: () => Promise<null>;
const subjects: string[] = [];
let target: string;
let observedRows = 0,
  observedStatements = 0,
  observedRequestBytes = 0,
  observedResponseBytes = 0;
const jsonBytes = (value: unknown) =>
  Buffer.byteLength(
    JSON.stringify(value, (_key, item: unknown) => (typeof item === 'bigint' ? item.toString() : item)),
  );
beforeAll(async () => {
  db = await openGrowthDatabase();
  f = await createProfileEntryFixture({ pool: db.pool, clock, projectLinks: false });
  owner = (await f.identity(['library_entry:update'], 4094)).actor;
  other = (await f.identity(['library_entry:update'], 4094)).actor;
  workerOwner = (await f.identity(['library_entry:update'], 4095)).actor;
  for (let n = 0; n < 101; n++) subjects.push(await f.createSubject('game'));
  const pending = new WeakMap<object, string>();
  await observeRetentionQueries(db.pool, ({ connection, sql, values, result }) => {
    observedRows += result.rows?.length ?? 0;
    observedStatements++;
    observedRequestBytes += Buffer.byteLength(sql) + jsonBytes(values);
    observedResponseBytes += jsonBytes(result.rows ?? []);
    if (/INSERT INTO "dbos"\.workflow_output\b/i.test(sql)) pending.set(connection, String(values[0]));
    if (/^COMMIT$/i.test(sql.trim())) {
      const id = pending.get(connection);
      pending.delete(connection);
      if (id) commits.get(id)?.();
    } else if (/^ROLLBACK$/i.test(sql.trim())) pending.delete(connection);
  });
  client = await createWorkClient(db.url, db.openPool());
  work = await composeWork(
    [
      libraryWorkModule,
      {
        name: 'label-growth-history',
        register() {
          const step = DBOS.registerStep(async () => null, { name: 'label.history.step' });
          history = DBOS.registerWorkflow(async () => step(), { name: 'label.history.workflow' });
        },
      },
    ],
    { pool: db.pool, client, databaseUrl: db.url, clock, env: {} },
  );
  await client.pauseSchedule(LABEL_RETENTION_SCHEDULE);
  await client.pauseSchedule(ENTRY_RETENTION_SCHEDULE);
  await work.launch();
}, 120000);
afterAll(async () => {
  await work?.shutdown();
  await client?.close();
  await f?.close();
  await db?.close();
});
async function renew() {
  for (const identity of [f.owner, f.other, f.steward]) {
    identity.bearer = await accountToken(identity.actor);
    identity.actor = await f.access.authenticate(identity.bearer, { pool: db.pool, deadline: deadlineFor(30000) });
  }
  for (const name of ['owner', 'other', 'worker'] as const) {
    const actor = name === 'owner' ? owner : name === 'other' ? other : workerOwner;
    const current = await f.access.authenticate(await accountToken(actor), {
      pool: db.pool,
      deadline: deadlineFor(30000),
    });
    if (name === 'owner') owner = current;
    else if (name === 'other') other = current;
    else workerOwner = current;
  }
}
async function workerRun() {
  const root = `label-growth:${crypto.randomUUID()}`;
  let timeout: ReturnType<typeof setTimeout>;
  const committed = new Promise<void>((resolve, reject) => {
    commits.set(root, resolve);
    timeout = setTimeout(() => reject(new Error(`Native workflow outcome did not commit: ${root}`)), 120000);
  });
  try {
    const handle = await client.enqueue(
      { workflowName: 'library.labelRetentionSegment', workflowID: root, queueName: 'maintenance' },
      { root, sequence: 0, partition: 4095, after: null },
    );
    await committed;
    await handle.getResult();
  } finally {
    clearTimeout(timeout!);
    commits.delete(root);
  }
  const pages = (await client.listWorkflowSteps(root))?.filter((s) => s.name === 'library.labelRetentionPage') ?? [];
  expect(pages.length).toBeGreaterThan(0);
  for (const page of pages) {
    expect((page.output as { examined: number }).examined).toBeLessThanOrEqual(100);
    expect(Buffer.byteLength(JSON.stringify(page.output))).toBeLessThanOrEqual(4096);
  }
  return pages;
}

test('exact native due discovery retains all raw control rows and byte costs at 64/512/4096 unrelated same-owner and other-owner histories', async () => {
  const commands = createPersonalLabelCommands({ pool: db.pool, tokens: f.tokens, clock });
  const report = await checkGrowth(db, {
    name: 'ordinary label exact due discovery',
    scales: [64, 512, 4096],
    repetitions: 1,
    bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
    byteBounds: { requestBytes: 'constant', responseBytes: 'constant' },
    async grow(_db, scale, previous) {
      for (let n = previous; n < scale; n++) {
        time = origin;
        if (n % 32 === 0) await renew();
        const actor = n % 3 ? owner : other;
        const made = await commands.createLabel(actor, { name: `History ${n} ${'x'.repeat(64)}` }, entryKey());
        if (n % 4 !== 0) {
          time = origin + (n % 2 ? 0 : windowMs);
          await commands.deleteLabel(actor, made.value.label.id, 1, entryKey());
        }
        // Grow actual SDK status/input/output/step copies without consuming the maintenance queue.
        await (await DBOS.startWorkflow(history, { workflowID: `label-history:${n}` })()).getResult();
      }
    },
    async prepare() {
      time = origin + windowMs;
    },
    async warmup() {},
    async operation() {
      const result = await purgeLabelRetentionPage(
        { pool: db.pool, clock },
        { partition: 4094, limit: 1, after: null },
      );
      expect(result.examined).toBe(1);
      expect(result.removed).toBe(0);
      expect(result.next).not.toBeNull();
    },
  });
  assertGrowthAccessPaths(report.name, report.samples, ['library.personal_label', 'library.label_assignment']);
  expect(report.samples.at(-1)!.relationSizes['library.personal_label']!.relpages).toBeGreaterThan(8);
}, 900000);

async function prepareGraph(count: number) {
  time = origin;
  await renew();
  const made = await label(f, workerOwner, clock);
  target = made.id;
  for (let n = 0; n < count; n++) {
    if (n % 32 === 0) await renew();
    await assignment(f, workerOwner, target, subjects[n]!, clock);
  }
  await made.commands.deleteLabel(workerOwner, target, 1, entryKey());
  time = origin + windowMs;
}

test('default native worker child pages charge Core and SDK rows blocks statements bytes and retries across unrelated growth', async () => {
  const report = await checkGrowth(db, {
    name: 'ordinary label default worker full child-first pages',
    scales: [64, 512, 4096],
    repetitions: 1,
    bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
    byteBounds: { requestBytes: 'constant', responseBytes: 'constant' },
    async grow(_db, scale, previous) {
      time = origin + windowMs;
      const commands = createPersonalLabelCommands({ pool: db.pool, tokens: f.tokens, clock });
      for (let n = previous; n < scale; n++) {
        if (n % 32 === 0) await renew();
        const made = await commands.createLabel(workerOwner, { name: `Future ${n} ${'y'.repeat(64)}` }, entryKey());
        await assignment(f, workerOwner, made.value.label.id, subjects[n % subjects.length]!, clock);
        await commands.deleteLabel(workerOwner, made.value.label.id, 1, entryKey());
      }
    },
    async prepare() {
      await prepareGraph(101);
      observedRows = observedStatements = observedRequestBytes = observedResponseBytes = 0;
    },
    async warmup() {},
    async operation() {
      const pages = await workerRun();
      expect(pages.reduce((n, p) => n + (p.output as { removed: number }).removed, 0)).toBe(102);
      expect(pages.length).toBeGreaterThanOrEqual(2);
      expect(observedRows).toBeGreaterThan(100);
      expect(observedStatements).toBeGreaterThan(0);
      expect(observedRequestBytes).toBeGreaterThan(0);
      expect(observedResponseBytes).toBeGreaterThan(0);
      expect(
        (
          await db.admin.query(
            'SELECT label_id FROM library.personal_label WHERE route=$1 AND account_id=$2 AND label_id=$3',
            [routeOf(workerOwner.accountId), workerOwner.accountId, target],
          )
        ).rows,
      ).toEqual([]);
    },
  });
  assertGrowthAccessPaths(report.name, report.samples, ['library.personal_label', 'library.label_assignment']);
  for (const sample of report.samples) {
    expect(sample.cost.relations['core.partition']?.rows ?? 0).toBeGreaterThan(0);
    expect(sample.cost.relations['dbos.operation_outputs']?.rows ?? 0).toBeGreaterThan(0);
    expect(sample.occurrenceRepetitions.length).toBeGreaterThan(0);
  }
}, 900000);

test('selected child graph grows linearly while every default worker page stays within its raw key and byte bound', async () => {
  const report = await checkGrowth(db, {
    name: 'ordinary label selected graph through default worker',
    scales: [64, 512, 4096],
    repetitions: 1,
    bounds: { rows: 'linear', statements: 'linear', blocks: 'linear' },
    byteBounds: { requestBytes: 'linear', responseBytes: 'linear' },
    async grow(_db, scale) {
      time = origin;
      await renew();
      while (subjects.length < scale) {
        if (subjects.length % 32 === 0) await renew();
        subjects.push(await f.createSubject('game'));
      }
    },
    async prepare(_db, scale) {
      await prepareGraph(scale);
    },
    async warmup() {
      await workerRun();
    },
    async operation(_db, scale) {
      const pages = await workerRun();
      expect(pages.reduce((n, p) => n + (p.output as { removed: number }).removed, 0)).toBe(scale + 1);
      expect(pages.reduce((n, p) => n + (p.output as { examined: number }).examined, 0)).toBe(scale + 1);
      expect(pages.length).toBeLessThanOrEqual(Math.ceil((scale + 1) / 100) + 1);
    },
  });
  assertGrowthAccessPaths(report.name, report.samples, ['library.personal_label', 'library.label_assignment']);
  expect(report.samples).toHaveLength(3);
}, 900000);
