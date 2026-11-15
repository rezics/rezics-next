import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import canonicalize from 'canonicalize';
import { runOperationalTransaction, type OperationalTransaction } from '../../src/command/operational.ts';
import {
  admitCollectionKindPreparationStep,
  bindCollectionKindPreparationStep,
  type CollectionKindPreparationLocator,
} from '../../src/library/collection-kind-work-admission.ts';
import { NativeCollectionWork } from '../../src/library/collection-native-work.ts';
import { readNativeCollectionMetadata } from '../../src/library/collection-source-native.ts';
import { nativeSourceFence } from '../../src/library/native-source-fence.ts';
import {
  createNativeLibrarySourceCustody,
  type NativeSourceFrontier,
  type NativeSourceIdentity,
} from '../../src/library/native-source-custody.ts';
import { partitionOf, routeOf } from '../../src/route/route.ts';
import { stepIdentityEpochAdmission } from '../../src/semantic/identity-epoch-admission.ts';
import { identityEpochStore } from '../../src/semantic/identity-epoch-store.ts';
import {
  createIdentityScopedObservations,
  identityScopeAddress,
} from '../../src/semantic/identity-scoped-observations.ts';
import {
  holdCommittedIdentityScopeReceipt,
  isHeldCommittedIdentityScopeReceipt,
  resolveCommittedIdentityScopeReceipt,
  type IdentityScopeCommittedKindContext,
  type IdentityScopeCommittedLocator,
} from '../../src/semantic/identity-scope-committed-receipt.ts';
import type { IdentityScopeKey, IdentityScopeObservation } from '../../src/semantic/identity-scope-types.ts';
import {
  currentIdentitySourceConsumerMaintenance,
  withIdentitySourceConsumerMaintenance,
} from '../../src/semantic/identity-source-consumer-maintenance.ts';
import { createWorkClient, type WorkClient } from '../../src/work/client.ts';
import { digest, epochFixture, release, type EpochFixture } from './support/identity-epoch.ts';
import { libraryCutoverInput, nativeCutoverCoordinator } from './support/identity-epoch-cutover.ts';

let f: EpochFixture;
let workClient: WorkClient;
beforeAll(async () => {
  f = await epochFixture();
  workClient = await createWorkClient(process.env.DATABASE_URL!, f.pool);
});
afterAll(async () => {
  await workClient?.close();
  await f?.close();
});

const allowance = () => ({
  reservationId: randomUUID(),
  remaining: {
    candidateKeys: 1000,
    identityMetadataRows: 0,
    nativeRows: 100000,
    nativePoints: 10000,
    witnessKeys: 1000,
    statements: 10000,
    bytes: 16 * 1024 * 1024,
    emptySeeks: 1000,
  },
});

/** The existing native writers produce capture, registration and repair receipts.
 * A missing foreign completion must fail here; never replace it with fixture tuples.
 */
async function committedScope(repaired: boolean) {
  const original = repaired ? (await f.create('Kind receipt original', 0x6e10)).subject.id : undefined;
  const terminal = repaired ? (await f.create('Kind receipt terminal', 0x6e20)).subject.id : undefined;
  const native = await libraryCutoverInput(f, original ? [original] : []);
  const route = routeOf(native.collection.id)!;
  const deadline = Date.now() + 60000;
  const metadata = await readNativeCollectionMetadata(
    f.pool,
    { route, collectionId: native.collection.id },
    { allowance: allowance(), deadline },
  );
  if (!metadata.metadata) throw new Error('Native Collection metadata unavailable');
  const identity: NativeSourceIdentity = {
    route,
    collectionId: native.collection.id,
    accountId: native.account,
    incarnation: metadata.metadata.incarnation,
    generation: metadata.metadata.sourceGeneration,
    scope: 'curated',
    ownerEpoch: metadata.metadata.stamp.epoch,
    receivingEpoch: '1',
    effectKey: randomUUID(),
  };
  const custody = createNativeLibrarySourceCustody({ pool: f.pool });
  let frontier: NativeSourceFrontier | null = null;
  for (let page = 0; page < 100; page++) {
    const result = await custody.capturePage({ identity, frontier, limit: 8, allowance: allowance(), deadline });
    if (result.status !== 'pending') throw new Error('Native capture did not progress');
    frontier = result.frontier;
    if (frontier.driver === 'done') break;
  }
  if (!frontier || frontier.driver !== 'done') throw new Error('Native capture did not exhaust');
  const completeFrontier = frontier;
  const captured = await custody.finishCapture({
    identity,
    frontier: completeFrontier,
    allowance: allowance(),
    deadline,
  });
  if (captured.status !== 'complete') throw new Error('Native capture did not commit');
  const key: IdentityScopeKey = { source: { kind: 'library', identity }, scopeId: 'collection-source' };
  const observations = createIdentityScopedObservations(f.pool);
  const observation = await withIdentitySourceConsumerMaintenance(
    { pool: f.pool, env: {} },
    { deadline },
    async (context) => {
      for (let page = 0; page < 100; page++) {
        const result = await observations.register({
          key,
          capture: { kind: 'library', capture: captured.capture, frontier: completeFrontier, allowance: allowance() },
          deadline: context.deadline,
        });
        if (result.status === 'registered') return result.observation;
        expect(result.status).toBe('pending');
      }
      throw new Error('Native scope registration did not settle');
    },
  );
  const address = identityScopeAddress(key);
  const keys = [address.partition, address.source, address.scope];
  const registration = (
    await f.admin.query<{ registration: string }>(
      `SELECT registration FROM semantic.identity_scope_summary
       WHERE partition_no=$1 AND source_key=$2 AND scope_id=$3 AND capture_id=$4 AND revision=$5`,
      [...keys, observation.captureId, observation.committedRevision.toString()],
    )
  ).rows[0]!.registration;
  let locator: IdentityScopeCommittedLocator = {
    expected: observation,
    registration,
    completion: { kind: 'initial' },
  };
  if (repaired) {
    const actor = await f.actor();
    const request = randomUUID();
    const job = await identityEpochStore().prepareAdmission(
      f.pool,
      {
        basis: { actorAccountId: actor.accountId, clientId: actor.clientId, requestedBy: actor.requestedBy },
        authorization: await f.authorization('subject:merge'),
      },
      {
        intent: { kind: 'merge', redirected: original!, survivor: terminal!, release: release.digest },
        receipt: {
          kind: 'subject.merge',
          command: { actorAccountId: actor.accountId, kind: 'subject.merge', key: request, digest: digest(request) },
        },
      },
    );
    for (let step = 0; step < 100; step++) {
      if ((await stepIdentityEpochAdmission(f.pool, job)).state === 'pending') break;
    }
    const retained = (
      await f.admin.query(
        `SELECT a.attempt,r.directory_transaction,r.page_id,r.ordinal
         FROM semantic.identity_scope_attempt a JOIN semantic.identity_scope_prearm_receipt r
         USING(partition_no,source_key,scope_id,registration,job_id,job_epoch)
         WHERE a.partition_no=$1 AND a.source_key=$2 AND a.scope_id=$3 AND a.registration=$4
           AND a.job_id=$5 AND a.job_epoch=$6 AND r.disposition='unsafe'`,
        [...keys, registration, job.jobId, job.epoch.toString()],
      )
    ).rows[0];
    if (!retained) throw new Error('Native repair receiving attempt absent');
    await (await nativeCutoverCoordinator())(f.pool, job);
    const repairedObservation = await withIdentitySourceConsumerMaintenance(
      { pool: f.pool, env: {} },
      { deadline: Date.now() + 60000 },
      async (context): Promise<IdentityScopeObservation> => {
        for (let page = 0; page < 100; page++) {
          const result = await observations.repair({
            key,
            limit: 8,
            allowance: allowance(),
            deadline: context.deadline,
          });
          if (result.status === 'repaired' && result.observation) return result.observation;
          expect(result.status).toBe('pending');
        }
        throw new Error('Native repair completion did not settle');
      },
    );
    locator = {
      expected: repairedObservation,
      registration,
      completion: {
        kind: 'repair',
        receiving: {
          job,
          directoryTransactionId: retained.directory_transaction,
          pageId: retained.page_id,
          ordinal: retained.ordinal,
        },
        attempt: { ...retained.attempt, position: BigInt(retained.attempt.position) },
      },
    };
  }
  return {
    identity,
    frontier: completeFrontier,
    capture: captured.capture,
    locator,
    fence: nativeSourceFence(metadata.metadata),
  };
}

/** Fixture only the enrolled raw Kind input around real committed Source records.
 * Core and Library still issue the actual live admission; no Type or audience proof is supplied.
 */
async function enrolledOriginal(source: Awaited<ReturnType<typeof committedScope>>, deadline: number) {
  const { identity, locator, capture, frontier, fence } = source;
  const preparation: CollectionKindPreparationLocator = {
    route: identity.route,
    ownerAccountId: identity.accountId,
    collectionId: identity.collectionId,
    preparationId: randomUUID(),
  };
  const token = JSON.stringify([
    1,
    fence,
    capture.captureId,
    locator.registration,
    locator.expected.captureId,
    locator.expected.committedRevision.toString(),
  ]);
  const origin = randomUUID();
  const root = `sha256:${'a'.repeat(64)}`;
  await f.admin.query(
    `INSERT INTO library.canonical_source_scope
     (route,collection_id,source_fence,identity,frontier,capture_id,committed_revision)
     VALUES($1,$2,$3,$4,$5,$6,$7)`,
    [
      identity.route, identity.collectionId, fence, JSON.stringify(identity), JSON.stringify(frontier),
      locator.expected.captureId, locator.expected.committedRevision.toString(),
    ],
  );
  await f.admin.query(
    `INSERT INTO library.collection_kind_observation
     (route,collection_id,account_id,audience,generation,source_generation,capture)
     VALUES($1,$2,$3,'anonymous',$4,$5,$6)`,
    [identity.route, identity.collectionId, identity.accountId, preparation.preparationId, identity.generation, token],
  );
  await f.admin.query(
    `INSERT INTO library.collection_kind_audience_origin
     (route,origin_id,owner_account_id,collection_id,preparation_id,audience,original_digest,formula_digest,
      source_generation,source_capture,origin_at,expires_at,deadline_at)
     VALUES($1,$2,$3,$4,$5,'anonymous',$6,$6,$7,$8,clock_timestamp(),to_timestamp($9::bigint/1000.0),$9::bigint)`,
    [
      identity.route, origin, identity.accountId, identity.collectionId, preparation.preparationId,
      root, identity.generation, token, String(deadline),
    ],
  );
  await f.admin.query(
    `INSERT INTO library.collection_kind_consent_consumer
     (route,reference_id,owner_account_id,collection_id,preparation_id,origin_id,
      source_generation,capture_generation,source_capture,enrollment_generation,catalogue_root)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [
      identity.route, randomUUID(), identity.accountId, identity.collectionId, preparation.preparationId,
      origin, identity.generation, capture.captureId, token, randomUUID(), root,
    ],
  );
  return preparation;
}

async function withoutCheckout<T>(body: () => Promise<T>): Promise<T> {
  const connect = f.pool.connect;
  f.pool.connect = (() => {
    throw new Error('Receipt opened a connection while its home was held');
  }) as typeof connect;
  try {
    return await body();
  } finally {
    f.pool.connect = connect;
  }
}

test('initial and repaired Kind originals resolve and hold genuine receipts on one ledger and deadline', async () => {
  for (const repaired of [false, true]) {
    const source = await committedScope(repaired);
    const deadline = Date.now() + 30000;
    const preparation = await enrolledOriginal(source, deadline);
    const work = new NativeCollectionWork(allowance(), deadline);
    const home = <T>(body: (context: IdentityScopeCommittedKindContext) => Promise<T>) =>
      runOperationalTransaction(
        f.pool,
        {
          mode: 'work-step',
          kind: 'library.collectionKind.receipt',
          partition: partitionOf(preparation.route),
          accounts: [preparation.ownerAccountId],
          workClient,
          admission: work,
          attemptLimit: 1,
          deadline,
        },
        async (tx) => {
          bindCollectionKindPreparationStep(tx, preparation, work);
          expect(await admitCollectionKindPreparationStep(tx, preparation, work)).toBe(true);
          return body({ kind: 'collection-kind', tx, preparation, work, deadline });
        },
      );
    let escaped!: IdentityScopeCommittedKindContext;
    const resolved = await home(async (context) => {
      escaped = context;
      expect(currentIdentitySourceConsumerMaintenance(f.pool, deadline)).toBeNull();
      const before = work.receipt();
      const result = await withoutCheckout(() =>
        resolveCommittedIdentityScopeReceipt(f.pool, { locator: source.locator, context }),
      );
      expect(result.status).toBe('observed');
      if (result.status !== 'observed') throw new Error('Admitted Kind receipt did not resolve');
      expect(result.work).toEqual(work.receipt());
      expect(result.work.reservationId).toBe(before.reservationId);
      const readyRepair =
        repaired && result.evidence.completionRevision + 1n === source.locator.expected.committedRevision;
      expect(result.work.used.nativeRows - before.used.nativeRows).toBe(readyRepair ? 26 : 19);
      expect(result.work.used.nativePoints - before.used.nativePoints).toBe(readyRepair ? 26 : 19);
      expect(result.work.used.statements - before.used.statements).toBe(readyRepair ? 3 : 2);
      expect(result.work.used.bytes).toBeGreaterThan(before.used.bytes);
      expect(result.evidence.sourceGeneration).toBe(source.identity.generation);
      expect(result.evidence.native.transactionId).not.toBe(source.capture.transactionId);
      expect(isHeldCommittedIdentityScopeReceipt(context.tx, result)).toBe(false);
      const spent = work.receipt();
      expect(await withoutCheckout(() => resolveCommittedIdentityScopeReceipt(f.pool, {
        locator: source.locator, context: { ...context, deadline: deadline + 1 },
      }))).toMatchObject({ status: 'unavailable', reason: 'work_binding' });
      const copy = new NativeCollectionWork({ ...allowance(), reservationId: spent.reservationId }, deadline);
      expect(await withoutCheckout(() => resolveCommittedIdentityScopeReceipt(f.pool, {
        locator: source.locator, context: { ...context, work: copy },
      }))).toMatchObject({ status: 'unavailable', reason: 'work_binding' });
      expect(copy.receipt().used.statements).toBe(0);
      copy.close();
      expect(work.receipt()).toEqual(spent);
      return result;
    });
    // Only after the Source home is released do we inspect the committed native component.
    const native = (await f.admin.query(
      `SELECT epoch,position::text FROM semantic.identity_epoch_native_commit
       WHERE partition_no=$1 AND transaction_id=$2`,
      [resolved.evidence.native.partition, resolved.evidence.native.transactionId],
    )).rows[0];
    expect(native).toEqual({
      epoch: resolved.evidence.native.epoch,
      position: resolved.evidence.native.position.toString(),
    });
    if (source.locator.completion.kind === 'repair') {
      const { job } = source.locator.completion.receiving;
      const address = identityScopeAddress(source.locator.expected.key);
      const completion = (await f.admin.query(
        `SELECT c.version::text,c.seal,c.source_generation,a.revision::text
         FROM semantic.identity_scope_completion c JOIN semantic.identity_scope_attempt a
         USING(partition_no,source_key,scope_id,registration,job_id,job_epoch)
         WHERE c.partition_no=$1 AND c.source_key=$2 AND c.scope_id=$3 AND c.registration=$4
           AND c.job_id=$5 AND c.job_epoch=$6 AND c.complete AND a.state='finished'`,
        [address.partition, address.source, address.scope, source.locator.registration, job.jobId, job.epoch.toString()],
      )).rows[0];
      expect(resolved.evidence.completionRevision).toBe(BigInt(completion.revision));
      expect(resolved.evidence.completionVersion).toBe(BigInt(completion.version));
      expect(resolved.evidence.sourceGeneration).toBe(completion.source_generation);
      expect(resolved.evidence.sealDigest).toBe(
        createHash('sha256').update(canonicalize(completion.seal)!).digest('hex'),
      );
    } else {
      expect(resolved.evidence.completionVersion).toBe(0n);
      expect(resolved.evidence.completionRevision).toBe(source.locator.expected.committedRevision);
    }
    const spent = work.receipt();
    expect(await withoutCheckout(() => resolveCommittedIdentityScopeReceipt(f.pool, {
      locator: source.locator, context: escaped,
    }))).toMatchObject({ status: 'unavailable', reason: 'work_binding' });
    expect(work.receipt()).toEqual(spent);

    for (const rollback of [false, true]) {
      let held: unknown;
      let heldTx!: OperationalTransaction;
      const abort = new Error('Release receipt locks by rollback');
      const holding = home(async (context) => {
        heldTx = context.tx;
        const changed = { ...resolved.evidence, completionVersion: resolved.evidence.completionVersion + 1n };
        expect(await withoutCheckout(() => holdCommittedIdentityScopeReceipt(context.tx, f.pool, {
          evidence: changed, context,
        }))).toMatchObject({ status: 'unavailable', reason: 'not_current' });
        const before = work.receipt();
        held = await withoutCheckout(() => holdCommittedIdentityScopeReceipt(context.tx, f.pool, {
          evidence: resolved.evidence, context,
        }));
        expect(held).toMatchObject({ status: 'held', evidence: resolved.evidence, transactionId: null });
        expect(isHeldCommittedIdentityScopeReceipt(context.tx, held)).toBe(true);
        expect(isHeldCommittedIdentityScopeReceipt(context.tx, { ...Object(held) })).toBe(false);
        expect(work.deadlineAt).toBe(deadline);
        expect(work.receipt().reservationId).toBe(resolved.work.reservationId);
        const readyRepair =
          repaired && resolved.evidence.completionRevision + 1n === source.locator.expected.committedRevision;
        expect(work.receipt().used.nativeRows - before.used.nativeRows).toBe(readyRepair ? 26 : 19);
        expect(work.receipt().used.nativePoints - before.used.nativePoints).toBe(readyRepair ? 26 : 19);
        expect(work.receipt().used.statements - before.used.statements).toBe(readyRepair ? 3 : 2);
        expect(held).toMatchObject({ work: work.receipt() });
        // This is a competing Source-home lock probe, not a foreign producer call.
        const competing = await f.admin.connect();
        try {
          await competing.query('BEGIN');
          await competing.query("SET LOCAL lock_timeout = '30ms'");
          await expect(competing.query(
            `SELECT transaction_id FROM semantic.identity_epoch_native_commit
             WHERE partition_no=$1 AND transaction_id=$2 FOR UPDATE`,
            [resolved.evidence.native.partition, resolved.evidence.native.transactionId],
          )).rejects.toMatchObject({ code: '55P03' });
        } finally {
          await competing.query('ROLLBACK');
          competing.release();
        }
        expect(isHeldCommittedIdentityScopeReceipt(context.tx, held)).toBe(true);
        if (rollback) {
          work.close();
          expect(isHeldCommittedIdentityScopeReceipt(context.tx, held)).toBe(false);
          throw abort;
        }
      });
      if (rollback) await expect(holding).rejects.toBe(abort);
      else await holding;
      expect(isHeldCommittedIdentityScopeReceipt(heldTx, held)).toBe(false);
      await f.admin.query(
        `SELECT transaction_id FROM semantic.identity_epoch_native_commit
         WHERE partition_no=$1 AND transaction_id=$2 FOR UPDATE NOWAIT`,
        [resolved.evidence.native.partition, resolved.evidence.native.transactionId],
      );
    }
  }
}, 240000);
