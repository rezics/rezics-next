import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { currentCommand, noEffect, runCommand, type CommandTransaction } from '../../src/command/command.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { STANDARD_QUESTION_ID } from '../../src/rating/votes.ts';
import { IDENTITY_EPOCH_PROGRESS } from '../../src/semantic/events.ts';
import {
  createIdentityRatingRepairProducer,
  identityRatingRepairMappingDigest,
  type IdentityRatingRepairPage,
} from '../../src/semantic/identity-rating-repair-producer.ts';
import { epochFixture, home, seedLegacyRoot, type EpochFixture } from './support/identity-epoch.ts';
import { isolatedDeployment, settle } from './support/identity-terminal-closure.ts';

let f: EpochFixture;
beforeAll(async () => {
  f = await epochFixture();
});
afterAll(async () => {
  await f?.close();
});

const route = 0x6e10;
const partition = partitionOf(route);
const digest = createHash('sha256').update('identity-rating-repair-page').digest('hex');
const producer = createIdentityRatingRepairProducer();

function page(overrides: Partial<IdentityRatingRepairPage> = {}): IdentityRatingRepairPage {
  return {
    pageId: newId(route),
    voterId: newId(route),
    workId: newId(route),
    generation: '1',
    mode: 'repair',
    after: null,
    through: null,
    next: null,
    terminal: true,
    votes: [],
    digest,
    ...overrides,
  };
}

function vote(targetId: string) {
  return {
    questionId: STANDARD_QUESTION_ID,
    targetId,
    units: 7,
    revision: 1,
    countedTargetId: null,
    countedRevision: 0,
    changedAt: '2026-11-07T00:00:00Z',
  };
}

const write = <T>(body: (tx: CommandTransaction) => Promise<T>, homePartition = partition) =>
  runCommand(f.pool, { partition: homePartition }, async (tx) => ({
    value: await body(tx),
    events: [{ type: IDENTITY_EPOCH_PROGRESS, data: { partition: homePartition, generation: '1' } }],
  }));

test('empty terminal pages hold and bind a native obligation on the voter command', async () => {
  const selected = page();
  const committed = await write(async (tx) => {
    const authority = await producer.hold(tx, selected);
    expect(authority).toMatchObject({ status: 'current', mappings: [] });
    if (authority.status !== 'current') throw new Error(authority.reason);
    expect(
      await producer.complete(tx, {
        page: selected,
        obligationId: authority.obligationId,
        mappingDigest: identityRatingRepairMappingDigest([]),
        transactionId: currentCommand(tx).transactionId,
      }),
    ).toBe(true);
    return authority.obligationId;
  });
  const stored = await f.admin.query(
    `SELECT state, later_change, receipt_transaction_id IS NOT NULL AS bound
     FROM semantic.identity_rating_repair_obligation WHERE partition_no=$1 AND obligation_id=$2`,
    [partition, committed.value],
  );
  expect(stored.rows[0]).toEqual({ state: 'bound', later_change: false, bound: true });
});

test('unmapped originals and foreign homes stay pending without writing an obligation', async () => {
  const missing = page({ terminal: false, votes: [vote(newId(route))] });
  expect((await write((tx) => producer.hold(tx, missing))).value).toEqual({
    status: 'pending',
    reason: 'source-unavailable',
  });
  expect((await write((tx) => producer.hold(tx, page({ voterId: newId(0x1110) })))).value).toEqual({
    status: 'pending',
    reason: 'voter-home-mismatch',
  });
  expect(
    (await write((tx) => producer.hold(tx, page({ terminal: false, votes: [vote(newId(0x1110))] })))).value,
  ).toEqual({
    status: 'pending',
    reason: 'semantic-cross-home-repair-hold-required',
  });
  expect(
    (
      await f.admin.query(
        'SELECT count(*)::int AS n FROM semantic.identity_rating_repair_obligation WHERE partition_no=$1 AND page_id=$2',
        [partition, missing.pageId],
      )
    ).rows[0]?.n,
  ).toBe(0);
});

test('complete without a same-transaction hold returns false', async () => {
  const selected = page();
  expect(
    (
      await write((tx) =>
        producer.complete(tx, {
          page: selected,
          obligationId: newId(route),
          mappingDigest: identityRatingRepairMappingDigest([]),
          transactionId: currentCommand(tx).transactionId,
        }),
      )
    ).value,
  ).toBe(false);
});

test('published same-home originals hold exact terminals through COMMIT and keep the owner lock', async () => {
  const db = await isolatedDeployment();
  try {
    const original = await seedLegacyRoot(db, 0x7230);
    await db.install();
    const settled = await settle(db, [original]);
    expect(settled.observed).toMatchObject({ state: 'mapped', original, terminal: original });
    if (settled.observed.state !== 'mapped') throw new Error('expected mapped original');
    const homePartition = home(original);
    const originalRoute = routeOf(original)!;
    const selected = page({
      voterId: newId(originalRoute),
      pageId: newId(originalRoute),
      workId: newId(originalRoute),
      terminal: false,
      through: { questionId: STANDARD_QUESTION_ID, targetId: original },
      next: { questionId: STANDARD_QUESTION_ID, targetId: original },
      votes: [vote(original)],
    });
    const commandProducer = createIdentityRatingRepairProducer();
    const result = await runCommand(db.pool, { partition: homePartition }, async (tx) => {
      const authority = await commandProducer.hold(tx, selected);
      expect(authority.status).toBe('current');
      if (authority.status !== 'current') throw new Error(authority.reason);
      expect(authority.mappings).toEqual([
        {
          originalId: original,
          terminalId: settled.observed.state === 'mapped' ? settled.observed.terminal : original,
          epoch: settled.observed.state === 'mapped' ? settled.observed.epoch.toString() : '0',
        },
      ]);
      await expect(
        db.admin.query('SELECT 1 FROM core.partition WHERE partition_no=$1 FOR UPDATE NOWAIT', [homePartition]),
      ).rejects.toMatchObject({ code: '55P03' });
      expect(
        await commandProducer.complete(tx, {
          page: selected,
          obligationId: authority.obligationId,
          mappingDigest: identityRatingRepairMappingDigest(authority.mappings),
          transactionId: currentCommand(tx).transactionId,
        }),
      ).toBe(true);
      return {
        value: authority.obligationId,
        events: [{ type: IDENTITY_EPOCH_PROGRESS, data: { partition: homePartition, generation: '1' } }],
      };
    });
    expect(result.value).toBeTruthy();
    await expect(
      db.admin.query('SELECT 1 FROM core.partition WHERE partition_no=$1 FOR UPDATE NOWAIT', [homePartition]),
    ).resolves.toMatchObject({ rowCount: 1 });
  } finally {
    await db.close();
  }
});

test('read-only commands cannot retain a repair obligation', async () => {
  const selected = page();
  await expect(
    runCommand(f.pool, { partition }, async (tx) => noEffect(await producer.hold(tx, selected))),
  ).rejects.toThrow();
});
