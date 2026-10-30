import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { CommandUnavailableError } from '../../src/command/command.ts';
import {
  EntryPurgeNotDueError,
  EntryPurgeStaleError,
  purgeExpiredEntryDeletion,
} from '../../src/library/entry-due-command.ts';
import type { DueEntryDeletionKey } from '../../src/library/entry-due-store.ts';
import { partitionOf, routeOf } from '../../src/route/route.ts';
import {
  capture,
  catalogStatementBound,
  checkGrowth,
  costOf,
  openGrowthDatabase,
  type GrowthDatabase,
} from '../support/growth.ts';
import { archive, growRetentionPopulation, renewRetentionIdentities } from './entry-retention-worker-runtime.ts';
import { createProfileEntryFixture, type NativeProfileFixture } from './support/profile-entry-fixture.ts';

let db: GrowthDatabase, f: NativeProfileFixture;
let time = Date.now();
const origin = time;
const clock = () => new Date(time);
let subject: string, noise: string;
let partition: number;
beforeAll(async () => {
  db = await openGrowthDatabase();
  f = await createProfileEntryFixture({ pool: db.pool, clock, singleConnection: true, projectLinks: false });
  subject = await f.createSubject('game');
  noise = await f.createSubject('game');
  partition = partitionOf(routeOf(f.owner.actor.accountId));
}, 120000);
afterAll(async () => {
  await f?.close();
  await db?.close();
});
const purge = (key: DueEntryDeletionKey, deadline?: number) =>
  purgeExpiredEntryDeletion({ pool: db.pool, clock, ...(deadline === undefined ? {} : { deadline }) }, key);

test('whole native exact due command stays keyed across legal unrelated owners, archives, live facts, receipts and outbox history', async () => {
  let key: DueEntryDeletionKey, second: DueEntryDeletionKey;
  const prepare = async () => {
    time = origin;
    await renewRetentionIdentities(f);
    key = await archive(f, subject);
    second = await archive(f, noise);
  };
  const operation = async () => {
    time = Date.parse(key.restoreUntil) - 1;
    await expect(purge(key)).rejects.toBeInstanceOf(EntryPurgeNotDueError);
    time += 2;
    await expect(purge({ ...key, restoreUntil: new Date(time).toISOString() })).rejects.toBeInstanceOf(
      EntryPurgeStaleError,
    );
    const missing = { ...key, deletionId: randomUUID() };
    const empty = await purge(missing);
    expect(empty.value).toEqual({ purged: false });
    expect(await purge(missing)).toEqual({ ...empty, replayed: true });
    const [first, concurrent, independent] = await Promise.all([purge(key), purge(key), purge(second)]);
    expect(first.value).toEqual({ purged: true });
    expect(concurrent.value).toEqual({ purged: true });
    expect([first.replayed, concurrent.replayed].sort()).toEqual([false, true]);
    expect(independent.value).toEqual({ purged: true });
    expect((await purge(key)).replayed).toBe(true);
  };
  const report = await checkGrowth(db, {
    name: 'entry retention: exact native due authorization, absent, effect, replay and concurrent envelopes',
    scales: [256, 1024, 4096],
    bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
    repetitions: 1,
    async grow(_db, scale, previous) {
      // All unrelated archives have a later original deadline than the fixed target.
      time = origin + 86400000;
      await growRetentionPopulation(f, partition, noise, previous, scale);
    },
    prepare,
    async warmup() {
      await prepare();
      await operation();
    },
    operation,
  });
  expect(report.samples).toHaveLength(3);
  await prepare();
  const proof = await capture(db, operation, { includeBackends: true });
  const classification = catalogStatementBound(proof.capture);
  expect(classification.catalogStatements).toBeLessThanOrEqual(classification.allowedStatements);
  expect(costOf(proof.capture).rows).toBeGreaterThan(0);
  expect(proof.capture.statements.some((sql) => /FOR UPDATE/.test(sql) && /entry_deleted/.test(sql))).toBe(true);
}, 900000);

test('native authorization and the delete bind the same immutable exact episode across asynchronous checkout', async () => {
  time = origin;
  const first = await archive(f, subject);
  const later = await archive(f, noise);
  time = Date.parse(first.restoreUntil);
  const mutable = { ...first };
  const delivery = purge(mutable);
  Object.assign(mutable, later);
  expect((await delivery).value).toEqual({ purged: true });
  const remaining = await db.admin.query(
    'SELECT deletion_id FROM library.entry_deleted WHERE route=$1 AND account_id=$2 AND deletion_id=ANY($3::uuid[])',
    [first.route, first.accountId, [first.deletionId, later.deletionId]],
  );
  expect(remaining.rows).toEqual([{ deletion_id: later.deletionId }]);
  expect((await purge(later)).value).toEqual({ purged: true });
}, 120000);

test('native supplied budgets expire without renewal, partition fences preserve the archive, and ordinary expiry needs no active owner', async () => {
  time = origin;
  const key = await archive(f, subject);
  time = Date.parse(key.restoreUntil);
  for (const deadline of [NaN, Infinity, -Infinity, Date.now() - 1])
    await expect(purge(key, deadline)).rejects.toMatchObject({ reason: 'deadline' });
  await db.admin.query("UPDATE core.partition SET write_state='fenced' WHERE partition_no=$1", [partition]);
  try {
    await expect(purge(key, Date.now() + 150)).rejects.toBeInstanceOf(CommandUnavailableError);
    expect(
      (
        await db.admin.query(
          'SELECT deletion_id FROM library.entry_deleted WHERE route=$1 AND account_id=$2 AND deletion_id=$3',
          [key.route, key.accountId, key.deletionId],
        )
      ).rows,
    ).toHaveLength(1);
  } finally {
    await db.admin.query("UPDATE core.partition SET write_state='active' WHERE partition_no=$1", [partition]);
  }
  time = origin;
  await f.suspend(f.owner.actor.accountId);
  time = Date.parse(key.restoreUntil);
  expect((await purge(key)).value).toEqual({ purged: true });
}, 120000);
