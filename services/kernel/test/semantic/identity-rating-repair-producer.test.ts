import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { currentCommand, noEffect, runCommand, type CommandTransaction } from '../../src/command/command.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { STANDARD_QUESTION_ID } from '../../src/rating/votes.ts';
import { IDENTITY_EPOCH_PROGRESS } from '../../src/semantic/events.ts';
import {
  createIdentityRatingRepairProducer,
  identityRatingRepairMappingDigest,
  IDENTITY_RATING_REPAIR_CONTINUATION,
  type IdentityRatingRepairPage,
} from '../../src/semantic/identity-rating-repair-producer.ts';
import {
  epochFixture,
  home,
  identityEpochDatabase,
  seedLegacyRoot,
  type EpochFixture,
} from './support/identity-epoch.ts';
import { isolatedDeployment, settle } from './support/identity-terminal-closure.ts';
import { installIdentityEpochBootstrap } from '../../src/semantic/identity-epoch-bootstrap-install.ts';

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

test('unmapped originals and voter-home mismatch stay pending without writing an obligation', async () => {
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

test('foreign homes prepare and handoff then hold exact terminals', async () => {
  const db = await identityEpochDatabase();
  try {
    const local = await seedLegacyRoot(db, 0x7230);
    const foreign = await seedLegacyRoot(db, 0x1110);
    await installIdentityEpochBootstrap(db.pool);
    const settledLocal = await settle(db, [local]);
    const settledForeign = await settle(db, [foreign]);
    expect(settledLocal.observed).toMatchObject({ state: 'mapped', original: local });
    expect(settledForeign.observed).toMatchObject({ state: 'mapped', original: foreign });
    if (settledForeign.observed.state !== 'mapped') throw new Error('expected mapped foreign original');
    const voterRoute = routeOf(local)!;
    const homePartition = home(local);
    const foreignPartition = home(foreign);
    const selected = page({
      voterId: newId(voterRoute),
      pageId: newId(voterRoute),
      workId: newId(voterRoute),
      terminal: false,
      through: { questionId: STANDARD_QUESTION_ID, targetId: foreign },
      next: { questionId: STANDARD_QUESTION_ID, targetId: foreign },
      votes: [vote(foreign)],
    });
    const commandProducer = createIdentityRatingRepairProducer();
    const held = await runCommand(db.pool, { partition: homePartition }, async (tx) => {
      const authority = await commandProducer.hold(tx, selected);
      expect(authority.status).toBe('pending');
      if (authority.status !== 'pending') throw new Error(authority.status);
      expect(authority.reason).toBe('semantic-cross-home-repair-preparing');
      expect(authority.obligationId).toBeTruthy();
      expect(authority.events?.some((event) => event.type === IDENTITY_RATING_REPAIR_CONTINUATION)).toBe(true);
      return {
        value: authority.obligationId!,
        events: authority.events ?? [{ type: IDENTITY_EPOCH_PROGRESS, data: { partition: homePartition, generation: '1' } }],
      };
    });
    const prepared = await runCommand(db.pool, { partition: foreignPartition }, async (tx) => {
      const authority = await commandProducer.prepare(tx, {
        obligationId: held.value,
        voterPartition: homePartition,
        originals: [foreign],
      });
      expect(authority.status).toBe('current');
      return {
        value: authority,
        events: [{ type: IDENTITY_EPOCH_PROGRESS, data: { partition: foreignPartition, generation: '1' } }],
      };
    });
    const preparedAuthority = prepared.value;
    expect(preparedAuthority.status).toBe('current');
    if (preparedAuthority.status !== 'current') throw new Error('expected prepared mappings');
    await runCommand(db.pool, { partition: homePartition }, async (tx) => {
      const handed = await commandProducer.handoff(tx, {
        obligationId: held.value,
        home: foreignPartition,
        originals: [foreign],
        mappings: preparedAuthority.mappings,
      });
      expect(handed.status).toBe('pending');
      return {
        value: handed,
        events: [{ type: IDENTITY_EPOCH_PROGRESS, data: { partition: homePartition, generation: '1' } }],
      };
    });
    await runCommand(db.pool, { partition: homePartition }, async (tx) => {
      const authority = await commandProducer.hold(tx, selected);
      expect(authority.status).toBe('current');
      if (authority.status !== 'current') throw new Error(authority.reason);
      expect(authority.mappings).toEqual([
        {
          originalId: foreign,
          terminalId: settledForeign.observed.state === 'mapped' ? settledForeign.observed.terminal : foreign,
          epoch: settledForeign.observed.state === 'mapped' ? settledForeign.observed.epoch.toString() : '0',
        },
      ]);
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
  } finally {
    await db.close();
  }
});

test('later mapping writes and later votes drain through bounded owner receipts', async () => {
  const db = await isolatedDeployment();
  try {
    const original = await seedLegacyRoot(db, 0x7230);
    await db.install();
    const settled = await settle(db, [original]);
    expect(settled.observed).toMatchObject({ state: 'mapped', original });
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
    const obligationId = (
      await runCommand(db.pool, { partition: homePartition }, async (tx) => {
        const authority = await commandProducer.hold(tx, selected);
        if (authority.status !== 'current') throw new Error(authority.reason);
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
      })
    ).value;
    await db.admin.query(
      `UPDATE semantic.identity_epoch_mapping SET epoch = epoch + 1 WHERE original=$1`,
      [original],
    );
    expect(
      (
        await db.admin.query(
          `SELECT later_change FROM semantic.identity_rating_repair_obligation WHERE partition_no=$1 AND obligation_id=$2`,
          [homePartition, obligationId],
        )
      ).rows[0]?.later_change,
    ).toBe(true);
    const drained = await runCommand(db.pool, { partition: homePartition }, async (tx) => {
      const result = await commandProducer.drain(tx);
      return {
        value: result,
        events: result.events.length
          ? result.events
          : [{ type: IDENTITY_EPOCH_PROGRESS, data: { partition: homePartition, generation: '1' } }],
      };
    });
    expect(drained.value.drained).toBeGreaterThan(0);
    expect(
      (
        await db.admin.query(
          `SELECT drain_receipt_id IS NOT NULL AS drained FROM semantic.identity_rating_repair_obligation
            WHERE partition_no=$1 AND obligation_id=$2`,
          [homePartition, obligationId],
        )
      ).rows[0]?.drained,
    ).toBe(true);
    await db.admin.query(`SELECT semantic.mark_identity_rating_repair_later_vote($1,$2,$3,$4)`, [
      homePartition,
      selected.voterId,
      STANDARD_QUESTION_ID,
      'ffffffff-ffff-ffff-ffff-ffffffffffff',
    ]);
    expect(
      (
        await db.admin.query(
          `SELECT later_vote FROM semantic.identity_rating_repair_obligation WHERE partition_no=$1 AND obligation_id=$2`,
          [homePartition, obligationId],
        )
      ).rows[0]?.later_vote,
    ).toBe(true);
  } finally {
    await db.close();
  }
});

test('mapping later_change trigger marks at most 64 obligations then drain continues', async () => {
  const db = await isolatedDeployment();
  try {
    const original = await seedLegacyRoot(db, 0x7230);
    await db.install();
    const settled = await settle(db, [original]);
    expect(settled.observed).toMatchObject({ state: 'mapped' });
    const homePartition = home(original);
    const originalRoute = routeOf(original)!;
    const digest = createHash('sha256').update('bounded-trigger').digest('hex');
    for (let index = 0; index < 65; index++) {
      await db.admin.query(
        `INSERT INTO semantic.identity_rating_repair_obligation
           (partition_no,obligation_id,voter_id,work_id,generation,page_id,page_digest,mapping_digest,mappings,originals,
            owner_node,owner_epoch,state)
         VALUES ($1,$2,$3,$4,'1',$5,$6,$7,'[]'::jsonb,$8::jsonb,'owner',1,'held')`,
        [
          homePartition,
          newId(originalRoute),
          newId(originalRoute),
          newId(originalRoute),
          newId(originalRoute),
          digest,
          digest,
          JSON.stringify([original]),
        ],
      );
    }
    await db.admin.query(`UPDATE semantic.identity_epoch_mapping SET epoch = epoch + 1 WHERE original=$1`, [original]);
    const marked = (
      await db.admin.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM semantic.identity_rating_repair_obligation
          WHERE partition_no=$1 AND later_change AND originals ? $2::text`,
        [homePartition, original],
      )
    ).rows[0]?.n;
    expect(marked).toBe(64);
    expect(
      (
        await db.admin.query(
          `SELECT overflow FROM semantic.identity_rating_repair_drain_head WHERE partition_no=$1`,
          [homePartition],
        )
      ).rows[0]?.overflow,
    ).toBe(true);
    const commandProducer = createIdentityRatingRepairProducer();
    await runCommand(db.pool, { partition: homePartition }, async (tx) => {
      const result = await commandProducer.drain(tx);
      return {
        value: result,
        events: result.events.length
          ? result.events
          : [{ type: IDENTITY_EPOCH_PROGRESS, data: { partition: homePartition, generation: '1' } }],
      };
    });
    expect(
      (
        await db.admin.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM semantic.identity_rating_repair_obligation
            WHERE partition_no=$1 AND later_change AND originals ? $2::text`,
          [homePartition, original],
        )
      ).rows[0]?.n,
    ).toBe(65);
  } finally {
    await db.close();
  }
});
