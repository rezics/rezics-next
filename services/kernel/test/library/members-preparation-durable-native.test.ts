import { afterAll, beforeAll, expect, test } from 'bun:test';
import {
  fundOperationalWorkOriginal,
  OPERATIONAL_WORK_LOCAL_DECLARATION,
} from '../../src/history/operational-work-budget.ts';
import {
  operationalWorkSource,
  receiveCommittedOperationalWork,
  resolveCommittedOperationalWork,
  verifyCommittedOperationalWorkOrigin,
} from '../../src/history/operational-work.ts';
import {
  inspectOperationalWorkRetirement,
  verifyOperationalWorkReplay,
} from '../../src/history/operational-work-receiving.ts';
import { NativeCollectionWork } from '../../src/library/collection-source-work.ts';
import { definition, membersPreparationRuntime } from './support/members-preparation-runtime.ts';

let native: Awaited<ReturnType<typeof membersPreparationRuntime>>;
beforeAll(async () => {
  native = await membersPreparationRuntime();
}, 120_000);
afterAll(async () => {
  await native?.close();
});

test('one funded History child registers the real native reservation and transfers committed receiving and readback work', async () => {
  const fixture = await native.fixture();
  const deadline = Date.now() + 60_000;
  const parent = new NativeCollectionWork(
    {
      reservationId: 'native-members-history',
      remaining: OPERATIONAL_WORK_LOCAL_DECLARATION,
    },
    deadline,
  );
  const history = fundOperationalWorkOriginal(parent, native.db.pool, native.workClient, deadline);
  expect(parent.receipt().used).toEqual(OPERATIONAL_WORK_LOCAL_DECLARATION);
  const result = await fixture.store.reserve(fixture.actor, fixture.collectionId, [definition()], { history });
  expect(result.episodes[0]!.state).toBe('preparing');
  expect(result.history).toBeDefined();
  const transfers = result.history!;
  const stored = (
    await native.db.admin.query(
      'SELECT * FROM core.operational_work_original WHERE partition_no=$1 AND custody_id=$2',
      [transfers.registration.partition, transfers.registration.custodyId],
    )
  ).rows[0];
  const headers = await native.rows(fixture.owner);
  expect(stored.sealed).toBe(true);
  expect(stored.creation_captured).toBe(true);
  expect(stored.intent).toEqual(result.intent);
  expect(stored.binding.episodes[0]).toMatchObject({
    episodeId: result.episodes[0]!.locator.episodeId,
    canonicalBasis: headers[0]!.canonical_basis,
    reservedIncarnation: headers[0]!.reserved_incarnation,
    reservedGeneration: headers[0]!.reserved_generation,
  });
  const origin = await resolveCommittedOperationalWork(native.db.pool, transfers.registration, transfers.resolve);
  expect(origin).not.toBeNull();
  const source = operationalWorkSource(native.db.pool, origin!);
  expect(await verifyCommittedOperationalWorkOrigin(native.db.pool, origin!, transfers.verify)).toEqual(source.stamp!);
  expect(await receiveCommittedOperationalWork(native.db.pool, native.workClient, origin!, transfers.receive)).toBe(
    'registered-pending-source-currentness',
  );
  // Registration and a successful receiving transaction must never certify uncaptured Source currentness.
  await expect(
    verifyOperationalWorkReplay(native.db.pool, native.workClient, origin!, transfers.replay),
  ).rejects.toThrow('operational-work-source-currentness-unavailable');
  expect(
    await inspectOperationalWorkRetirement(native.db.pool, native.workClient, transfers.registration.custodyId, {
      origin: origin!,
      transfer: transfers.retirement,
    }),
  ).toBe('operational-work-source-currentness-unavailable');
  await expect(
    resolveCommittedOperationalWork(native.db.pool, transfers.registration, transfers.resolve),
  ).rejects.toThrow('operational-work-native-transfer-unavailable');
  const duplicate = await fixture.store.reserve(fixture.actor, fixture.collectionId, [definition()]);
  expect(duplicate.intent).toBeNull();
  expect(duplicate.history).toBeUndefined();
  expect(duplicate.episodes).toEqual(result.episodes);
});
