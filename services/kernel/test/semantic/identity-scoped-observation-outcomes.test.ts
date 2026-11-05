import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { partitionOf, routeOf } from '../../src/route/route.ts';
import {
  createNativeLibrarySourceCustody,
  type NativeSourceFrontier,
  type NativeSourceIdentity,
} from '../../src/library/native-source-custody.ts';
import { readNativeCollectionMetadata } from '../../src/library/collection-source-native.ts';
import { createIdentityScopedObservations } from '../../src/semantic/identity-scoped-observations.ts';
import { identityEpochStore } from '../../src/semantic/identity-epoch-store.ts';
import {
  stepIdentityEpochAdmission,
  cancelIdentityEpochAdmission,
} from '../../src/semantic/identity-epoch-admission.ts';
import { readIdentityPrearmTicket } from '../../src/semantic/identity-epoch-prearm-contract.ts';
import type { IdentityScopeObservation } from '../../src/semantic/identity-scope-types.ts';
import { epochFixture, digest, release, type EpochFixture } from './support/identity-epoch.ts';
import { libraryCutoverInput } from './support/identity-epoch-cutover.ts';

// The existing native Source fixture allowance; admission's own preparation work is separate.
const sourceWork = () => ({
  deadline: Date.now() + 5000,
  allowance: {
    reservationId: randomUUID(),
    remaining: {
      candidateKeys: 100,
      identityMetadataRows: 0,
      nativeRows: 100000,
      nativePoints: 1000,
      witnessKeys: 100,
      statements: 100,
      bytes: 1024 * 1024,
      emptySeeks: 100,
    },
  },
});
async function observe(f: EpochFixture, original: string): Promise<IdentityScopeObservation> {
  const library = await libraryCutoverInput(f, [original]);
  const route = routeOf(library.collection.id)!;
  const metadata = await readNativeCollectionMetadata(
    f.pool,
    { route, collectionId: library.collection.id },
    sourceWork(),
  );
  if (!metadata.metadata) throw new Error('Missing actual committed Collection metadata');
  const owner = (await f.pool.query('SELECT epoch FROM core.partition WHERE partition_no=$1', [partitionOf(route)]))
    .rows[0];
  const identity: NativeSourceIdentity = {
    route,
    collectionId: library.collection.id,
    accountId: library.account,
    incarnation: metadata.metadata.incarnation,
    generation: metadata.metadata.sourceGeneration,
    scope: 'curated',
    ownerEpoch: owner.epoch,
    receivingEpoch: '1',
    effectKey: randomUUID(),
  };
  const custody = createNativeLibrarySourceCustody({ pool: f.pool });
  let frontier: NativeSourceFrontier | null = null;
  for (let page = 0; page < 100; page++) {
    const result = await custody.capturePage({ ...sourceWork(), identity, frontier, limit: 1 });
    expect(result.status).toBe('pending');
    if (result.status !== 'pending') throw new Error(`Native Source capture unavailable: ${result.reason}`);
    frontier = result.frontier;
    if (frontier.driver === 'done') break;
  }
  if (!frontier || frontier.driver !== 'done') throw new Error('Finite native capture did not exhaust');
  const captured = await custody.finishCapture({ ...sourceWork(), identity, frontier });
  expect(captured.status).toBe('complete');
  if (captured.status !== 'complete') throw new Error('Native Source capture did not retain its receipt');
  const observations = createIdentityScopedObservations(f.pool);
  const key = { source: { kind: 'library' as const, identity }, scopeId: randomUUID() };
  for (let step = 0; step < 100; step++) {
    const result = await observations.register({
      key,
      capture: { kind: 'library', capture: captured.capture, frontier, allowance: sourceWork().allowance },
      deadline: Date.now() + 5000,
    });
    if (result.status === 'registered') return result.observation;
    expect(result.status, 'native capture must enroll through the real Source producer').toBe('pending');
  }
  throw new Error('Finite native registration did not finish');
}
async function prepare(f: EpochFixture, original: string, terminal: string, key = randomUUID()) {
  const actor = await f.actor();
  return identityEpochStore().prepareAdmission(
    f.pool,
    {
      basis: { actorAccountId: actor.accountId, clientId: actor.clientId, requestedBy: actor.requestedBy },
      authorization: await f.authorization('subject:merge'),
      deadline: Date.now() + 5000,
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

test('Real pending identity claims commit only after complete native scope pre-arm custody so two unchanged local Source probes detect relevant claims without disjoint blocking', async () => {
  const f = await epochFixture();
  try {
    const original = (await f.create('Relevant original', 0x8710)).id;
    const terminal = (await f.create('Relevant terminal', 0x8720)).id;
    const unrelated = (await f.create('Disjoint original', 0x8730)).id;
    const relevant = await observe(f, original),
      disjoint = await observe(f, unrelated);
    const observations = createIdentityScopedObservations(f.pool);
    const probe = (expected: IdentityScopeObservation) =>
      observations.revalidate({ key: expected.key, expected, deadline: Date.now() + 5000 });
    expect((await probe(relevant)).status).toBe('current');
    expect((await probe(disjoint)).status).toBe('current');
    const before = await f.snapshot([original, terminal, unrelated]);
    const job = await prepare(f, original, terminal);
    const claims = async () =>
      (await f.pool.query('SELECT terminal FROM semantic.identity_epoch_group WHERE pending_job=$1', [job.jobId])).rows;
    expect(await claims()).toHaveLength(0);
    expect((await identityEpochStore().readJob(f.pool, job))?.state).toBe('preparing');
    let claimed = false;
    for (let step = 0; step < 100; step++) {
      await stepIdentityEpochAdmission(f.pool, job);
      if ((await claims()).length) {
        claimed = true;
        break;
      }
      // Every intermediate preparation commit is genuinely claim-free.
      expect((await identityEpochStore().readJob(f.pool, job))?.state).toBe('preparing');
    }
    expect(claimed, 'finite real pre-arm must eventually permit an actual native pending claim').toBe(true);
    const root = partitionOf(routeOf(job.jobId)!);
    const unresolved = await f.pool.query(
      `SELECT terminal FROM semantic.identity_epoch_input
      WHERE partition_no=$1 AND job_id=$2 AND prearm_transaction_id IS NULL`,
      [root, job.jobId],
    );
    expect(unresolved.rows).toHaveLength(0);
    const uncopied = await f.pool.query(
      `SELECT p.page_id FROM semantic.identity_epoch_prearm_page p
      LEFT JOIN semantic.identity_epoch_prearm_custody c ON c.partition_no=$1 AND c.job_id=p.job_id
       AND c.directory_partition=p.partition_no AND c.page_id=p.page_id
      WHERE p.job_id=$2 AND c.page_id IS NULL`,
      [root, job.jobId],
    );
    expect(uncopied.rows).toHaveLength(0);
    const retainedTickets = await f.pool.query(
      `SELECT p.page_id FROM semantic.identity_epoch_prearm_page p
      JOIN semantic.identity_epoch_prearm_disposition d ON d.partition_no=p.partition_no AND d.page_id=p.page_id
       AND d.stage='unsafe' AND d.source_receipt IS NOT NULL
      WHERE p.job_id=$1 AND p.original IS NOT NULL`,
      [job.jobId],
    );
    expect(
      retainedTickets.rows.length,
      'the real relevant Source must have native pre-arm receiving custody',
    ).toBeGreaterThan(0);
    // Ordinary asynchronous arm was never invoked. Both probes use their unchanged native observation.
    const relevantFinal = await probe(relevant),
      disjointFinal = await probe(disjoint);
    expect(relevantFinal.status).not.toBe('current');
    if (relevantFinal.status !== 'current') expect(relevantFinal.reason).toBe('pending_claim');
    expect(disjointFinal.status).toBe('current');
    if (disjointFinal.status === 'current') expect(disjointFinal.observation).toEqual(disjoint);
    for (const result of [relevantFinal, disjointFinal]) expect(result.work.statements).toBeLessThanOrEqual(12);
    const after = await f.snapshot([original, terminal, unrelated]);
    for (const field of ['subjects', 'revisions', 'redirects', 'members']) expect(after[field]).toBe(before[field]);
    for (let step = 0; step < 100; step++) {
      if ((await stepIdentityEpochAdmission(f.pool, job)).state === 'pending') break;
    }
    expect((await identityEpochStore().readJob(f.pool, job))?.state).toBe('pending');
  } finally {
    await f.close();
  }
}, 120000);

test('Claim-free native preparation cancels every planned attempt before releasing its original reservation and rejects invented ticket locators', async () => {
  const f = await epochFixture();
  try {
    const original = (await f.create('Cancelled original', 0x8810)).id;
    const terminal = (await f.create('Cancelled terminal', 0x8820)).id;
    const key = randomUUID();
    const job = await prepare(f, original, terminal, key);
    expect(
      await readIdentityPrearmTicket(f.pool, {
        job,
        pageId: randomUUID(),
        ordinal: 0,
        directory: { partition: partitionOf(routeOf(job.jobId)!), transactionId: randomUUID(), epoch: 1, position: 1n },
      }),
    ).toBeNull();
    await cancelIdentityEpochAdmission(f.pool, job);
    for (let step = 0; step < 100; step++) {
      const claims = await f.pool.query('SELECT terminal FROM semantic.identity_epoch_group WHERE pending_job=$1', [
        job.jobId,
      ]);
      expect(claims.rows).toHaveLength(0);
      if ((await stepIdentityEpochAdmission(f.pool, job)).state === 'cancelled') break;
    }
    expect((await identityEpochStore().readJob(f.pool, job))?.state).toBe('cancelled');
    const retained = await f.pool.query(
      'SELECT partition_no FROM semantic.identity_epoch_control WHERE prepare_job=$1',
      [job.jobId],
    );
    expect(retained.rows).toHaveLength(0);
    const planned = (
      await f.pool.query(
        `SELECT p.resource_home,a.state,p.released FROM semantic.identity_epoch_admission_plan p
      LEFT JOIN semantic.identity_epoch_admission_attempt a ON a.partition_no=p.resource_home AND a.job_id=p.job_id
      WHERE p.partition_no=$1 AND p.job_id=$2`,
        [partitionOf(routeOf(job.jobId)!), job.jobId],
      )
    ).rows;
    expect(planned.length).toBeGreaterThan(0);
    for (const home of planned) {
      expect(home.state).toBe('closed');
      expect(home.released).toBe(true);
    }
    const resumed = await prepare(f, original, terminal, key);
    expect(resumed.jobId).not.toBe(job.jobId);
    expect(resumed.epoch).toBeGreaterThan(job.epoch);
    expect((await identityEpochStore().readJob(f.pool, resumed))?.state).toBe('preparing');
    for (let step = 0; step < 100; step++) {
      if ((await stepIdentityEpochAdmission(f.pool, resumed)).state === 'pending') break;
    }
    expect((await identityEpochStore().readJob(f.pool, resumed))?.state).toBe('pending');
    const receipts = (
      await f.pool.query(
        `SELECT receipt_key,receipt,intent FROM semantic.identity_epoch_job
      WHERE partition_no=$1 AND job_id=ANY($2::uuid[]) ORDER BY epoch`,
        [partitionOf(routeOf(job.jobId)!), [job.jobId, resumed.jobId]],
      )
    ).rows;
    expect(receipts).toHaveLength(2);
    expect(receipts[0]).toEqual(receipts[1]);
  } finally {
    await f.close();
  }
}, 120000);
