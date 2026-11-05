import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import {
  createNativeLibrarySourceCustody,
  type NativeSourceIdentity,
  type NativeSourceFrontier,
} from '../../src/library/native-source-custody.ts';
import { readNativeCollectionMetadata } from '../../src/library/collection-source-native.ts';
import { routeOf, partitionOf } from '../../src/route/route.ts';
import { identityEpochStore } from '../../src/semantic/identity-epoch-store.ts';
import {
  cancelIdentityEpochAdmission,
  stepIdentityEpochAdmission,
} from '../../src/semantic/identity-epoch-admission.ts';
import { identityJobPartition } from '../../src/semantic/identity-epoch-store.ts';
import type { IdentityPrearmTicketLocator } from '../../src/semantic/identity-epoch-prearm-contract.ts';
import { cancelIdentityScopePrearm, receiveIdentityScopePrearm } from '../../src/semantic/identity-scoped-prearm.ts';
import { createIdentityScopedObservations } from '../../src/semantic/identity-scoped-observations.ts';
import type { IdentityScopeKey, IdentityScopeObservation } from '../../src/semantic/identity-scope-types.ts';
import { digest, release, epochFixture, type EpochFixture } from './support/identity-epoch.ts';
import { libraryCutoverInput, nativeCutoverCoordinator } from './support/identity-epoch-cutover.ts';

let f: EpochFixture;
beforeAll(async () => {
  f = await epochFixture();
});
afterAll(async () => {
  await f?.close();
});
const budget = () => ({
  reservationId: randomUUID(),
  remaining: {
    candidateKeys: 100,
    identityMetadataRows: 0,
    nativeRows: 100000,
    nativePoints: 1000,
    witnessKeys: 100,
    statements: 100,
    bytes: 1048576,
    emptySeeks: 100,
  },
});

async function source(originals: string[]) {
  const native = await libraryCutoverInput(f, originals);
  const route = routeOf(native.collection.id)!;
  const metadata = await readNativeCollectionMetadata(
    f.pool,
    { route, collectionId: native.collection.id },
    { allowance: budget(), deadline: Date.now() + 5000 },
  );
  if (!metadata.metadata) throw new Error('Native Library metadata unavailable');
  const epoch = (await f.admin.query('SELECT epoch FROM core.partition WHERE partition_no=$1', [partitionOf(route)]))
    .rows[0].epoch;
  const identity: NativeSourceIdentity = {
    route,
    collectionId: native.collection.id,
    accountId: native.account,
    incarnation: metadata.metadata.incarnation,
    generation: metadata.metadata.sourceGeneration,
    scope: 'curated',
    ownerEpoch: epoch,
    receivingEpoch: '1',
    effectKey: randomUUID(),
  };
  const owner = createNativeLibrarySourceCustody({ pool: f.pool });
  let frontier: NativeSourceFrontier | null = null;
  for (let page = 0; page < 100; page++) {
    const progress = await owner.capturePage({
      identity,
      frontier,
      limit: 8,
      allowance: budget(),
      deadline: Date.now() + 5000,
    });
    if (progress.status !== 'pending') throw new Error(`Native Source capture unavailable: ${progress.reason}`);
    frontier = progress.frontier;
    if (frontier.driver === 'done') break;
  }
  if (!frontier || frontier.driver !== 'done') throw new Error('Finite native Source did not complete capture');
  const complete = await owner.finishCapture({ identity, frontier, allowance: budget(), deadline: Date.now() + 5000 });
  if (complete.status !== 'complete') throw new Error(`Native Source final fence unavailable: ${complete.reason}`);
  const key: IdentityScopeKey = { source: { kind: 'library', identity }, scopeId: 'curated' };
  const observations = createIdentityScopedObservations(f.pool);
  for (let page = 0; page < 100; page++) {
    const registered = await observations.register({
      key,
      capture: { kind: 'library', capture: complete.capture, frontier, allowance: budget() },
      deadline: Date.now() + 5000,
    });
    if (registered.status === 'registered') return { key, observation: registered.observation, observations, native };
    expect(registered.status, 'native complete capture must make bounded retained registration progress').toBe(
      'pending',
    );
  }
  throw new Error('Finite native Source registration did not settle');
}
async function prepare(original: string, terminal: string) {
  const actor = await f.actor();
  const key = randomUUID();
  return identityEpochStore().prepareAdmission(
    f.pool,
    {
      basis: { actorAccountId: actor.accountId, clientId: actor.clientId, requestedBy: actor.requestedBy },
      authorization: await f.authorization('subject:merge'),
    },
    {
      intent: { kind: 'merge', redirected: original, survivor: terminal, release: release.digest },
      receipt: {
        kind: 'subject.merge',
        command: { actorAccountId: actor.accountId, kind: 'subject.merge', key, digest: digest(key) },
      },
    },
  );
}
async function current(s: Awaited<ReturnType<typeof source>>, expected: IdentityScopeObservation = s.observation) {
  return s.observations.revalidate({ key: s.key, expected, deadline: Date.now() + 5000 });
}
async function pending(job: Awaited<ReturnType<typeof prepare>>) {
  for (let step = 0; step < 100; step++) {
    const result = await stepIdentityEpochAdmission(f.pool, job);
    if (result.state === 'pending') return;
    expect(result.state).toBe('preparing');
  }
  throw new Error('Finite native pre-arm admission did not reach its first pending claim');
}

test('complete native source registration detects relevant pending claims before arm delivery and clean-to-clean scoped revision changes while disjoint work does not starve the source', async () => {
  const excluded = (await f.create('Excluded structural original', 0x6a10)).subject.id;
  const orderOnly = (await f.create('Order-only structural original', 0x6a20)).subject.id;
  const positive = (await f.create('Returned positive', 0x6a30)).subject.id;
  const target = (await f.create('Relevant terminal', 0x6a40)).subject.id;
  // Capture the complete native population, including both originals that a returned-hit vector omits.
  const s = await source([excluded, orderOnly, positive]);
  expect((await current(s)).status).toBe('current');
  const factBefore = (
    await f.admin.query('SELECT current_facts FROM semantic.subject WHERE route=$1 AND subject_id=$2', [
      routeOf(positive),
      positive,
    ])
  ).rows[0];
  const membersBefore = (
    await f.admin.query(
      'SELECT subject_id FROM library.collection_member WHERE route=$1 AND collection_id=$2 ORDER BY member_id',
      [routeOf(s.native.collection.id), s.native.collection.id],
    )
  ).rows;
  const relevant = await prepare(excluded, target);
  // Advance actual native pre-arm/claim custody, but never deliver the post-admission arm API here.
  await pending(relevant);
  for (const phase of ['start', 'final', 'continuation'])
    expect((await current(s)).status, `${phase} must reject the old complete Source basis before arm`).not.toBe(
      'current',
    );
  expect(
    (
      await f.admin.query('SELECT current_facts FROM semantic.subject WHERE route=$1 AND subject_id=$2', [
        routeOf(positive),
        positive,
      ])
    ).rows[0],
  ).toEqual(factBefore);
  expect(
    (
      await f.admin.query(
        'SELECT subject_id FROM library.collection_member WHERE route=$1 AND collection_id=$2 ORDER BY member_id',
        [routeOf(s.native.collection.id), s.native.collection.id],
      )
    ).rows,
  ).toEqual(membersBefore);
}, 120000);

test('an unchanged finite complete Source remains current during real disjoint identity work', async () => {
  const own = (await f.create('Finite unchanged Source', 0x6b10)).subject.id;
  const s = await source([own]);
  for (let n = 0; n < 3; n++) {
    const left = (await f.create('Unrelated original', 0x6b20 + n * 0x20)).subject.id;
    const right = (await f.create('Unrelated terminal', 0x6b30 + n * 0x20)).subject.id;
    const job = await prepare(left, right);
    await pending(job);
    expect((await current(s)).status).toBe('current');
    const coordinator = await nativeCutoverCoordinator();
    await coordinator(f.pool, job);
    expect((await identityEpochStore().readJob(f.pool, job))?.state).toBe('published');
    expect((await current(s)).status).toBe('current');
  }
}, 120000);

test('a pending order-only original invalidates the complete Source before asynchronous arm delivery', async () => {
  const orderOnly = (await f.create('Order dependency', 0x6d10)).subject.id;
  const positive = (await f.create('Order result', 0x6d20)).subject.id;
  const target = (await f.create('Order destination', 0x6d30)).subject.id;
  const s = await source([orderOnly, positive]);
  const before = (
    await f.admin.query('SELECT current_facts FROM semantic.subject WHERE route=$1 AND subject_id=$2', [
      routeOf(positive),
      positive,
    ])
  ).rows[0];
  await pending(await prepare(orderOnly, target));
  expect((await current(s)).status).not.toBe('current');
  expect(
    (
      await f.admin.query('SELECT current_facts FROM semantic.subject WHERE route=$1 AND subject_id=$2', [
        routeOf(positive),
        positive,
      ])
    ).rows[0],
  ).toEqual(before);
}, 120000);

test('native cancellation retains the closed scope attempt against delayed and duplicate pre-arm delivery', async () => {
  const original = (await f.create('Cancelled dependency', 0x6e10)).subject.id;
  const target = (await f.create('Cancelled destination', 0x6e20)).subject.id;
  const s = await source([original]);
  const job = await prepare(original, target);
  let locator: IdentityPrearmTicketLocator | null = null;
  // Read only a genuinely delivered Source item and its immutable directory commit. Never seed receipts.
  for (let step = 0; step < 100; step++) {
    const item = (
      await f.admin.query(
        `SELECT r.page_id,r.ordinal,c.partition_no,c.epoch,c.position::text,c.transaction_id
      FROM semantic.identity_scope_prearm_receipt r JOIN semantic.identity_epoch_native_commit c
      ON c.transaction_id=r.directory_transaction
      WHERE r.job_id=$1 AND r.job_epoch=$2 AND r.disposition='unsafe' LIMIT 1`,
        [job.jobId, job.epoch.toString()],
      )
    ).rows[0];
    if (item) {
      locator = {
        job,
        pageId: item.page_id,
        ordinal: item.ordinal,
        directory: {
          partition: item.partition_no,
          epoch: item.epoch,
          position: BigInt(item.position),
          transactionId: item.transaction_id,
        },
      };
      break;
    }
    const progress = await stepIdentityEpochAdmission(f.pool, job);
    expect(progress.state, 'pre-arm Source custody must precede pending admission').toBe('preparing');
  }
  expect(locator, 'native preparation must retain a delivered Source item before the first claim').not.toBeNull();
  await cancelIdentityEpochAdmission(f.pool, job);
  let closed: { partition_no: number; epoch: number; position: string; transaction_id: string } | undefined;
  for (let step = 0; step < 100; step++) {
    closed = (
      await f.admin.query(
        `SELECT c.partition_no,c.epoch,c.position::text,c.transaction_id
      FROM semantic.identity_epoch_admission_receipt r JOIN semantic.identity_epoch_native_commit c
      ON (c.partition_no,c.transaction_id)=(r.partition_no,r.transaction_id) AND c.xmin=r.xmin
      WHERE r.partition_no=$1 AND r.job_id=$2 AND r.job_epoch=$3 AND r.stage='closed'`,
        [identityJobPartition(job), job.jobId, job.epoch.toString()],
      )
    ).rows[0];
    if (closed) break;
    await stepIdentityEpochAdmission(f.pool, job);
  }
  expect(closed, 'cancellation requires the actual native closed-home receipt').toBeDefined();
  const cancellation = {
    partition: closed!.partition_no,
    epoch: closed!.epoch,
    position: BigInt(closed!.position),
    transactionId: closed!.transaction_id,
  };
  const receipt = await cancelIdentityScopePrearm(f.pool, { locator: locator!, cancellation });
  expect(await cancelIdentityScopePrearm(f.pool, { locator: locator!, cancellation })).toEqual(receipt);
  await expect(receiveIdentityScopePrearm(f.pool, locator!)).rejects.toMatchObject({
    code: 'identity_epoch_unavailable',
  });
  for (let step = 0; step < 100; step++) {
    if ((await stepIdentityEpochAdmission(f.pool, job)).state === 'cancelled') break;
  }
  expect((await identityEpochStore().readJob(f.pool, job))?.state).toBe('cancelled');
  let repaired: IdentityScopeObservation | null = null;
  for (let step = 0; step < 100; step++) {
    const result = await s.observations.repair({ key: s.key, limit: 1, deadline: Date.now() + 5000 });
    if (result.status === 'repaired') {
      repaired = result.observation;
      break;
    }
  }
  expect(repaired, 'finite unchanged Source must become useful after native cancellation custody').not.toBeNull();
  expect(repaired!.committedRevision).toBeGreaterThan(s.observation.committedRevision);
  expect((await current(s)).status).not.toBe('current');
  expect((await current(s, repaired!)).status).toBe('current');
}, 120000);

test('clean-to-clean scope completion invalidates an old basis when a lower allocated job finishes after a higher job', async () => {
  const lowerOriginal = (await f.create('Lower allocation', 0x6c10)).subject.id;
  const lowerTarget = (await f.create('Lower destination', 0x6c20)).subject.id;
  const higherOriginal = (await f.create('Higher allocation', 0x6c30)).subject.id;
  const higherTarget = (await f.create('Higher destination', 0x6c40)).subject.id;
  const s = await source([lowerOriginal, higherOriginal]);
  const lower = await prepare(lowerOriginal, lowerTarget);
  const higher = await prepare(higherOriginal, higherTarget);
  expect(lower.epoch).toBeLessThan(higher.epoch);
  await pending(higher);
  await pending(lower);
  const coordinator = await nativeCutoverCoordinator();
  await coordinator(f.pool, higher);
  expect((await current(s)).status).not.toBe('current');
  await coordinator(f.pool, lower);
  let next: IdentityScopeObservation | null = null;
  for (let step = 0; step < 100; step++) {
    const result = await s.observations.repair({ key: s.key, limit: 1, deadline: Date.now() + 5000 });
    if (result.status === 'repaired') {
      next = result.observation;
      break;
    }
  }
  expect(next, 'actual complete scope-specific receiving custody must settle the finite Source').not.toBeNull();
  expect(next!.committedRevision).toBeGreaterThan(s.observation.committedRevision);
  expect((await current(s)).status).not.toBe('current');
  expect((await current(s, next!)).status).toBe('current');
}, 120000);
