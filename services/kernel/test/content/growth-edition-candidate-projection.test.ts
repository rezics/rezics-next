import { expect, setDefaultTimeout, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { newId } from '../../src/route/route.ts';
import compareAdvanceCheckpoint from '../../src/events/compare-advance-checkpoint.sql';
import markAuthorErased from '../../src/content/account-erasure-authored-mark.sql';
import { readErasureStatus } from '../../src/access/erasure.ts';
import { deletePersona } from '../support/account-deletion.ts';
import {
  assertGrowthAccessPaths,
  checkGrowth,
  seed,
  type GrowthDatabase,
  type GrowthReport,
  type Population,
} from '../support/growth.ts';
import { observeSql } from './support/sql-observer.ts';
import {
  CREATOR_INDEXED,
  MAX_EDITION_ENVELOPE_SLOTS,
  growthEditionCandidateProjectionFixture,
  type EditionSourceSlot,
  type GrowthEditionCandidateProjectionFixture,
} from './support/growth-edition-candidate-projection-fixture.ts';

setDefaultTimeout(600_000);

const scales = [256, 1024, 4096] as const;
const bounds = { rows: 'constant', blocks: 'logarithmic', statements: 'constant' } as const;
const noopHistoryType = CREATOR_INDEXED;

function assertGrowthEvidence(report: GrowthReport): void {
  expect(report.samples.map(({ scale }) => scale)).toEqual([...scales]);
  expect(report.samples.every(({ repetitions }) => repetitions.length === 1)).toBe(true);
  for (const sample of report.samples) {
    expect(sample.cost.statements).toBeGreaterThan(0);
    expect(sample.cost.plans).toBeGreaterThan(0);
    expect(sample.cost.rows).toBeGreaterThan(0);
    expect(sample.cost.blocks).toBe(sample.cost.sharedHit + sample.cost.sharedRead);
    expect(sample.cost.blocks).toBeGreaterThan(0);
    expect(Object.keys(sample.cost.relations).length).toBeGreaterThan(0);
  }
  const relations = [
    ...new Set(
      report.samples.flatMap((sample) => sample.repetitions.flatMap((repetition) => Object.keys(repetition.relations))),
    ),
  ].sort();
  expect(relations.length).toBeGreaterThan(0);
  assertGrowthAccessPaths(report.name, report.samples, relations);
}

async function partitionPosition(database: GrowthDatabase, partition: number): Promise<bigint> {
  const result = await database.admin.query<{ position: string }>(
    'SELECT position::text FROM core.partition WHERE partition_no=$1',
    [partition],
  );
  const position = result.rows[0]?.position;
  if (position === undefined) throw new Error(`Growth partition ${partition} is absent`);
  return BigInt(position);
}

function sourceEditionHistory(fixture: GrowthEditionCandidateProjectionFixture) {
  let base = 0n;
  let rangeFrom = 0;
  const population: Population = {
    name: `growth-edition-source-history-${randomUUID()}`,
    hotPartition: fixture.source.partition,
    hotShare: 1,
    rows({ ordinal }) {
      const editionId = newId(fixture.source.route);
      const transactionId = randomUUID();
      const accountId = fixture.creator.accountId;
      return {
        'content.edition': [
          {
            route: fixture.source.route,
            edition_id: editionId,
            creator_account_id: accountId,
            target_subject_id: fixture.source.targetSubjectId,
            thread_id: fixture.source.threadId,
            post_id: fixture.source.postId,
            revision_id: fixture.source.revisionId,
            body_sha256: new Uint8Array(32).fill(ordinal % 251),
            licence: 'CC0-1.0',
            state: 'draft',
            security_revision: 1,
            recorded_transaction_id: transactionId,
            created_at: '2030-01-01T00:00:00.000Z',
          },
        ],
        'core.outbox': [
          {
            partition_no: fixture.source.partition,
            position: base + BigInt(ordinal - rangeFrom + 1),
            event_seq: 0,
            event_count: 1,
            epoch: 1,
            id: randomUUID(),
            type: noopHistoryType,
            subject: editionId,
            data: { editionId, creatorAccountId: accountId },
          },
        ],
      };
    },
  };
  return {
    async grow(database: GrowthDatabase, scale: number, previous: number) {
      base = await partitionPosition(database, fixture.source.partition);
      rangeFrom = previous;
      await seed(database, {
        ...population,
        async finish(admin, range) {
          await admin.query('UPDATE core.partition SET position=$2 WHERE partition_no=$1', [
            fixture.source.partition,
            base + BigInt(range.to - range.from),
          ]);
        },
      }, { from: previous, to: scale });
    },
  };
}

function creatorCandidateHistory(fixture: GrowthEditionCandidateProjectionFixture): Population {
  return {
    name: `growth-edition-creator-candidates-${randomUUID()}`,
    hotPartition: fixture.creatorPartition,
    hotShare: 1,
    rows() {
      return {
        'content.creator_edition': [
          {
            route: fixture.creatorRoute,
            creator_account_id: fixture.creator.accountId,
            edition_id: newId(fixture.source.route),
          },
        ],
      };
    },
  };
}

function accountAndWriteBasisHistory(fixture: GrowthEditionCandidateProjectionFixture) {
  let creatorBase = 0n;
  let sourceBase = 0n;
  let rangeFrom = 0;
  const population: Population = {
    name: `growth-edition-account-basis-history-${randomUUID()}`,
    hotPartition: fixture.creatorPartition,
    hotShare: 1,
    rows({ ordinal }) {
      const homeAccountId = newId(fixture.creatorRoute);
      const homeTransactionId = randomUUID();
      const sourceTransactionId = randomUUID();
      const sourceEditionId = newId(fixture.source.route);
      const homePosition = creatorBase + BigInt(ordinal - rangeFrom + 1);
      const sourcePosition = sourceBase + BigInt(ordinal - rangeFrom + 1);
      return {
        'access.account': [
          {
            route: fixture.creatorRoute,
            account_id: homeAccountId,
            kind: 'actor',
            state: 'active',
            transaction_id: homeTransactionId,
          },
        ],
        'editorial.write_basis': [
          {
            partition_no: fixture.creatorPartition,
            transaction_id: homeTransactionId,
            epoch: 1,
            position: homePosition,
            principal_kind: 'account',
            principal_id: fixture.creator.accountId,
            client_id: 'growth-fixture',
            requested_by: null,
          },
          {
            partition_no: fixture.source.partition,
            transaction_id: sourceTransactionId,
            epoch: 1,
            position: sourcePosition,
            principal_kind: 'account',
            principal_id: fixture.creator.accountId,
            client_id: 'growth-fixture',
            requested_by: null,
          },
        ],
        'core.outbox': [
          {
            partition_no: fixture.creatorPartition,
            position: homePosition,
            event_seq: 0,
            event_count: 1,
            epoch: 1,
            id: randomUUID(),
            type: 'com.rezics.access.account-updated.v1',
            subject: homeAccountId,
            data: { accountId: homeAccountId },
          },
          {
            partition_no: fixture.source.partition,
            position: sourcePosition,
            event_seq: 0,
            event_count: 1,
            epoch: 1,
            id: randomUUID(),
            type: noopHistoryType,
            subject: sourceEditionId,
            data: { editionId: sourceEditionId, creatorAccountId: fixture.creator.accountId },
          },
        ],
      };
    },
  };
  return {
    async grow(database: GrowthDatabase, scale: number, previous: number) {
      creatorBase = await partitionPosition(database, fixture.creatorPartition);
      sourceBase = await partitionPosition(database, fixture.source.partition);
      rangeFrom = previous;
      await seed(database, {
        ...population,
        async finish(admin, range) {
          const added = BigInt(range.to - range.from);
          await admin.query('UPDATE core.partition SET position=$2 WHERE partition_no=$1', [
            fixture.creatorPartition,
            creatorBase + added,
          ]);
          await admin.query('UPDATE core.partition SET position=$2 WHERE partition_no=$1', [
            fixture.source.partition,
            sourceBase + added,
          ]);
        },
      }, { from: previous, to: scale });
    },
  };
}

async function createNativeEdition(fixture: GrowthEditionCandidateProjectionFixture, keyPrefix: string) {
  const value = await fixture.native.checked(
    'POST',
    '/v1/contentEditions',
    {
      postId: fixture.source.postId,
      revisionId: fixture.source.revisionId,
      targetSubjectId: fixture.source.targetSubjectId,
    },
    201,
    { bearer: fixture.creator.bearer, key: `${keyPrefix}-${randomUUID()}` },
  );
  const editionId = (value as { editionId?: unknown }).editionId;
  if (typeof editionId !== 'string') throw new Error('Native edition creation omitted its identity');
  const slot = await fixture.sourceSlot(editionId);
  expect(slot.eventCount).toBeLessThanOrEqual(MAX_EDITION_ENVELOPE_SLOTS);
  return slot;
}

async function runWorkerGrowth(
  fixture: GrowthEditionCandidateProjectionFixture,
  name: string,
  grow: (database: GrowthDatabase, scale: number, previous: number) => Promise<void>,
): Promise<EditionSourceSlot[]> {
  const pending = new Map<number, EditionSourceSlot>();
  const selected: EditionSourceSlot[] = [];
  const report = await checkGrowth(fixture.native.db, {
    name,
    scales,
    bounds,
    rule: 'series',
    indexProbes: 8,
    repetitions: 1,
    warmups: 1,
    grow,
    async warmup(_database, scale) {
      const slot = await createNativeEdition(fixture, `${name}-${scale}-warmup`);
      await fixture.relayEdition(slot);
      expect(await fixture.candidateCount(slot.editionId)).toBe(1);
      expect(await fixture.creatorIndexedEventCount(slot.editionId)).toBe(1);
    },
    async prepare(_database, scale, repetition) {
      const slot = await createNativeEdition(fixture, `${name}-${scale}-selected`);
      expect(await fixture.candidateCount(slot.editionId)).toBe(0);
      expect(await fixture.creatorIndexedEventCount(slot.editionId)).toBe(0);
      pending.set(repetition, slot);
    },
    async operation(_database, _scale, repetition) {
      const slot = pending.get(repetition);
      if (!slot) throw new Error('Native selected edition source was not prepared');
      await fixture.relayEdition(slot);
      expect(await fixture.candidateCount(slot.editionId)).toBe(1);
      expect(await fixture.creatorIndexedEventCount(slot.editionId)).toBe(1);
      selected.push(slot);
      return slot;
    },
  });
  assertGrowthEvidence(report);
  return selected;
}

test('Creator edition candidate projection stays bounded across independent histories and native lifecycle delivery', async () => {
  const fixture = await growthEditionCandidateProjectionFixture();
  let observer: ReturnType<typeof observeSql> | undefined;
  let authoredBarrier: ReturnType<ReturnType<typeof observeSql>['hold']> | undefined;
  try {
    const sourcePopulation = sourceEditionHistory(fixture);
    const creationSlots: EditionSourceSlot[] = [];
    const creation = await checkGrowth(fixture.native.db, {
      name: 'Native edition creation with source edition and outbox history',
      scales,
      bounds,
      rule: 'series',
      indexProbes: 8,
      repetitions: 1,
      warmups: 1,
      grow: sourcePopulation.grow,
      async warmup(_database, scale) {
        const slot = await createNativeEdition(fixture, `native-create-${scale}-warmup`);
        creationSlots.push(slot);
        expect(await fixture.candidateCount(slot.editionId)).toBe(0);
        expect(await fixture.creatorIndexedEventCount(slot.editionId)).toBe(0);
      },
      async operation(_database, scale) {
        const slot = await createNativeEdition(fixture, `native-create-${scale}-selected`);
        creationSlots.push(slot);
        expect(await fixture.candidateCount(slot.editionId)).toBe(0);
        expect(await fixture.creatorIndexedEventCount(slot.editionId)).toBe(0);
        return slot;
      },
    });
    assertGrowthEvidence(creation);

    await fixture.relayCurrent(fixture.source.partition);
    const threadEvent = await fixture.threadCreationEvent();
    await fixture.waitForRegisteredEffect(threadEvent, 'content_author_item');
    await Promise.all(creationSlots.map((slot) => fixture.waitForEffect(slot)));

    await runWorkerGrowth(
      fixture,
      'Registered edition candidate effect with source edition and outbox history',
      sourcePopulation.grow,
    );

    await runWorkerGrowth(
      fixture,
      'Registered edition candidate effect with creator candidate history',
      async (database, scale, previous) => {
        await seed(database, creatorCandidateHistory(fixture), { from: previous, to: scale });
      },
    );

    await runWorkerGrowth(
      fixture,
      'Registered edition candidate effect with account and write-basis history',
      async (database, scale, previous) => {
        await accountAndWriteBasisHistory(fixture).grow(database, scale, previous);
      },
    );

    const notCreator = await fixture.native.call('GET', `/v1/accounts/${fixture.creator.accountId}/editions`, {
      bearer: fixture.native.governor.bearer,
    });
    expect(notCreator.response.status).toBe(404);

    observer = observeSql(fixture.native.mutationPool);
    fixture.native.mutationPool.options.max = Math.max(fixture.native.mutationPool.options.max, 4);
    const duplicate = await createNativeEdition(fixture, 'native-duplicate-delivery');
    const duplicateBarrier = observer.hold({ statement: compareAdvanceCheckpoint.sql }, 'before');
    const firstDelivery = fixture.runtime.relayThrough(duplicate.sourcePartition, duplicate.position);
    await duplicateBarrier.entered;
    await fixture.runtime.relayThrough(duplicate.sourcePartition, duplicate.position);
    duplicateBarrier.release();
    await firstDelivery;
    await fixture.waitForEffect(duplicate);
    expect(await fixture.candidateCount(duplicate.editionId)).toBe(1);
    expect(await fixture.creatorIndexedEventCount(duplicate.editionId)).toBe(1);

    const late = await createNativeEdition(fixture, 'native-late-enrollment');
    expect(await fixture.candidateCount(late.editionId)).toBe(0);
    authoredBarrier = observer.hold({ statement: markAuthorErased.sql }, 'before');
    await deletePersona(
      { pool: fixture.native.db.pool, auth: fixture.native.auth },
      { accountId: fixture.creator.accountId, bearer: fixture.creator.bearer },
    );
    const tombstone = await fixture.native.db.admin.query<{ position: string }>(
      `SELECT position::text FROM core.outbox
        WHERE partition_no=$1 AND type='com.rezics.access.account-tombstoned.v1'
          AND (subject=$2 OR data->>'accountId'=$2)
        ORDER BY position DESC LIMIT 1`,
      [fixture.creatorPartition, fixture.creator.accountId],
    );
    const tombstonePosition = tombstone.rows[0]?.position;
    if (tombstonePosition === undefined) throw new Error('Native account deletion omitted its tombstone event');
    await fixture.runtime.relayThrough(fixture.creatorPartition, BigInt(tombstonePosition));
    await authoredBarrier.entered;

    const fence = await fixture.native.db.admin.query<{ closed_at: string | null }>(
      'SELECT closed_at::text FROM content.erasure_fence WHERE route=$1 AND account_id=$2',
      [fixture.creatorRoute, fixture.creator.accountId],
    );
    expect(fence.rows).toHaveLength(1);
    expect(fence.rows[0]!.closed_at).not.toBeNull();
    expect((await readErasureStatus(fixture.native.db.pool, fixture.creator.accountId))?.participants.content?.outcome).toBe(
      'pending',
    );

    await fixture.relayEdition(late);
    expect(await fixture.candidateCount(late.editionId)).toBe(0);
    expect(await fixture.creatorIndexedEventCount(late.editionId)).toBe(0);
    expect((await readErasureStatus(fixture.native.db.pool, fixture.creator.accountId))?.participants.content?.outcome).toBe(
      'pending',
    );
  } finally {
    authoredBarrier?.release();
    await observer?.close();
    await fixture.close();
  }
});
