import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { currentCommand, noEffect, runCommand, type CommandTransaction } from '../../src/command/command.ts';
import { NativeCollectionWork } from '../../src/library/collection-source-work.ts';
import { readNativeCollectionMetadata } from '../../src/library/collection-source-native.ts';
import {
  createNativeLibrarySourceCustody, type NativeSourceIdentity, type NativeSourceFrontier,
} from '../../src/library/native-source-custody.ts';
import { routeOf, partitionOf } from '../../src/route/route.ts';
import {
  createIdentityScopedObservations, identityScopeAddress,
} from '../../src/semantic/identity-scoped-observations.ts';
import {
  identityEpochStore, recordIdentityEpochNativeCommit, serializeIdentityValue as json,
} from '../../src/semantic/identity-epoch-store.ts';
import { stepIdentityEpochAdmission } from '../../src/semantic/identity-epoch-admission.ts';
import { writeIdentityScopeConsumerNativeCommit } from '../../src/semantic/identity-epoch-native-commit.ts';
import type { IdentityNativeReceipt } from '../../src/semantic/identity-epoch-contract.ts';
import type { IdentityScopeKey, IdentityScopeObservation } from '../../src/semantic/identity-scope-types.ts';
import {
  holdCommittedIdentityScopeReceipt, identityScopeCommittedReceiptFootprint,
  isHeldCommittedIdentityScopeReceipt, resolveCommittedIdentityScopeReceipt,
  type IdentityScopeCommittedLocator,
} from '../../src/semantic/identity-scope-committed-receipt.ts';
import {
  identitySourceConsumerLibraryWork, withIdentitySourceConsumerMaintenance,
  type IdentitySourceConsumerMaintenanceContext,
} from '../../src/semantic/identity-source-consumer-maintenance.ts';
import { digest, epochFixture, release, type EpochFixture } from './support/identity-epoch.ts';
import { libraryCutoverInput, nativeCutoverCoordinator } from './support/identity-epoch-cutover.ts';
import currentSQL from '../../src/semantic/identity-scope-committed-receipt-current.sql';
import repairSQL from '../../src/semantic/identity-scope-committed-receipt-repair.sql';

let f: EpochFixture;
beforeAll(async () => { f = await epochFixture(); });
afterAll(async () => { await f?.close(); });
const deadline = () => Date.now() + 10000;
const allowance = () => ({ reservationId: randomUUID(), remaining: {
  candidateKeys: 100, identityMetadataRows: 0, nativeRows: 100000, nativePoints: 1000,
  witnessKeys: 100, statements: 1000, bytes: 10485760, emptySeeks: 100,
} });
const frame = <T>(body: (context: IdentitySourceConsumerMaintenanceContext) => Promise<T>) =>
  withIdentitySourceConsumerMaintenance({ pool: f.pool, env: {} }, { deadline: deadline() }, body);

async function nativeCapture(originals: string[] = []) {
  const native = await libraryCutoverInput(f, originals);
  const route = routeOf(native.collection.id)!;
  const metadata = await readNativeCollectionMetadata(f.pool, { route, collectionId: native.collection.id },
    { allowance: allowance(), deadline: deadline() });
  if (!metadata.metadata) throw new Error('Native source metadata unavailable');
  const epoch = (await f.admin.query('SELECT epoch FROM core.partition WHERE partition_no=$1', [partitionOf(route)])).rows[0].epoch;
  const identity: NativeSourceIdentity = {
    route, collectionId: native.collection.id, accountId: native.account,
    incarnation: metadata.metadata.incarnation, generation: metadata.metadata.sourceGeneration,
    scope: 'curated', ownerEpoch: epoch, receivingEpoch: '1', effectKey: randomUUID(),
  };
  const owner = createNativeLibrarySourceCustody({ pool: f.pool });
  let frontier: NativeSourceFrontier | null = null;
  for (let page = 0; page < 100; page++) {
    const next = await owner.capturePage({ identity, frontier, limit: 8, allowance: allowance(), deadline: deadline() });
    if (next.status !== 'pending') throw new Error(`Native capture refused: ${next.reason}`);
    frontier = next.frontier;
    if (frontier.driver === 'done') break;
  }
  if (!frontier || frontier.driver !== 'done') throw new Error('Native finite capture did not exhaust');
  const complete = await owner.finishCapture({ identity, frontier, allowance: allowance(), deadline: deadline() });
  if (complete.status !== 'complete') throw new Error(`Native capture finish refused: ${complete.reason}`);
  const key: IdentityScopeKey = { source: { kind: 'library', identity }, scopeId: 'curated' };
  return { native, identity, key, frontier, capture: complete.capture, owner };
}

async function ordinaryRegistration(originals: string[] = []) {
  const source = await nativeCapture(originals);
  const observations = createIdentityScopedObservations(f.pool);
  for (let page = 0; page < 100; page++) {
    const result = await observations.register({ key: source.key, capture: {
      kind: 'library', capture: source.capture, frontier: source.frontier, allowance: allowance(),
    }, deadline: deadline() });
    if (result.status === 'registered') return { ...source, observations, observation: result.observation };
    expect(result.status, 'real registration must progress without synthetic ready rows').toBe('pending');
  }
  throw new Error('Native registration did not settle');
}

async function registrationOf(expected: IdentityScopeObservation): Promise<string> {
  const a = identityScopeAddress(expected.key);
  const row = (await f.admin.query(
    `SELECT registration FROM semantic.identity_scope_summary
     WHERE partition_no=$1 AND source_key=$2 AND scope_id=$3 AND capture_id=$4 AND revision=$5`,
    [a.partition, a.source, a.scope, expected.captureId, expected.committedRevision.toString()],
  )).rows[0];
  if (!row) throw new Error('Exact committed registration absent');
  return row.registration;
}

// Keep these positive writer-journey assertions intact. They intentionally expose
// the missing initial association and provisional Library completion owner body.
test('A committed scope receipt resolves the actual committed native transaction for an initial registration', async () => {
  const s = await ordinaryRegistration();
  const locator: IdentityScopeCommittedLocator = { expected: s.observation,
    registration: await registrationOf(s.observation), completion: { kind: 'initial' } };
  const result = await frame((context) => resolveCommittedIdentityScopeReceipt(f.pool, { locator, context }));
  expect(result.status).toBe('observed');
  if (result.status !== 'observed') throw new Error('Initial registration has no committed native association');
  const native = (await f.admin.query(
    'SELECT epoch,position::text FROM semantic.identity_epoch_native_commit WHERE partition_no=$1 AND transaction_id=$2',
    [result.evidence.native.partition, result.evidence.native.transactionId],
  )).rows[0];
  expect(native).toEqual({ epoch: result.evidence.native.epoch, position: result.evidence.native.position.toString() });
}, 120000);

test('A committed scope receipt resolves an ordinary completed repair and its exact receiving attempt', async () => {
  const original = (await f.create('Receipt repair original', 0x6e10)).subject.id;
  const terminal = (await f.create('Receipt repair terminal', 0x6e20)).subject.id;
  const s = await ordinaryRegistration([original]);
  const actor = await f.actor();
  const request = randomUUID();
  const job = await identityEpochStore.prepareAdmission(f.pool, {
    basis: { actorAccountId: actor.accountId, clientId: actor.clientId, requestedBy: actor.requestedBy },
    authorization: await f.authorization('subject:merge'),
  }, { intent: { kind: 'merge', redirected: original, survivor: terminal, release: release.digest },
    receipt: { kind: 'subject.merge', command: {
      actorAccountId: actor.accountId, kind: 'subject.merge', key: request, digest: digest(request),
    } } });
  for (let step = 0; step < 100; step++) {
    if ((await stepIdentityEpochAdmission(f.pool, job)).state === 'pending') break;
  }
  const address = identityScopeAddress(s.key);
  const retained = (await f.admin.query(
    `SELECT a.registration,a.attempt,r.directory_transaction,r.page_id,r.ordinal
     FROM semantic.identity_scope_attempt a JOIN semantic.identity_scope_prearm_receipt r
     USING(partition_no,source_key,scope_id,registration,job_id,job_epoch)
     WHERE a.partition_no=$1 AND a.source_key=$2 AND a.scope_id=$3 AND a.job_id=$4
     AND a.job_epoch=$5 AND r.disposition='unsafe'`,
    [address.partition, address.source, address.scope, job.jobId, job.epoch.toString()],
  )).rows[0];
  expect(retained, 'ordinary admission must retain the actual source receiving attempt').toBeDefined();
  await (await nativeCutoverCoordinator())(f.pool, job);
  let observation: IdentityScopeObservation | null = null;
  for (let page = 0; page < 100; page++) {
    const result = await s.observations.repair({ key: s.key, limit: 8, allowance: allowance(), deadline: deadline() });
    if (result.status === 'repaired' && result.observation) { observation = result.observation; break; }
    expect(result.status).toBe('pending');
  }
  if (!observation) throw new Error('Ordinary Library receiving completion never settled');
  const locator: IdentityScopeCommittedLocator = { expected: observation, registration: retained.registration,
    completion: { kind: 'repair', receiving: { job, directoryTransactionId: retained.directory_transaction,
      pageId: retained.page_id, ordinal: retained.ordinal },
    attempt: { ...retained.attempt, position: BigInt(retained.attempt.position) } } };
  const result = await frame((context) => resolveCommittedIdentityScopeReceipt(f.pool, { locator, context }));
  expect(result.status).toBe('observed');
}, 120000);

/** Retained-record fixture for the locator's SQL only. Native capture, hold,
 * partition allocator and commit records are real. Local attempt/completion rows
 * are fixture input, not proof that the ordinary Library writer is implemented.
 */
async function retainedFixture(finished = true) {
  const s = await nativeCapture();
  const a = identityScopeAddress(s.key);
  const keys = [a.partition, a.source, a.scope];
  const registration = randomUUID();
  const job = { jobId: randomUUID(), epoch: 1n };
  const directoryTransactionId = randomUUID();
  const pageId = randomUUID();
  const events = [{ type: 'com.rezics.fixture.created.v1', data: {} }];
  await runCommand(f.pool, { partition: a.partition, deadline: deadline() }, async (tx) => {
    const held = await s.owner.readAndHold({ client: tx, at: currentCommand(tx).time, identity: s.identity,
      captureId: s.capture.captureId, holdId: registration, allowance: allowance(), deadline: deadline() });
    expect(held.status).toBe('held');
    await tx.query(`INSERT INTO semantic.identity_scope_summary
      (partition_no,source_key,scope_id,source,registration,capture_id,capture,state,revision,active,frontier,scan_complete)
      VALUES($1,$2,$3,$4,$5,$6,$7,'ready',2,0,$8,true)`,
    [...keys, json(s.key.source), registration, s.capture.captureId,
      json({ kind: 'library', capture: s.capture, frontier: s.frontier, allowance: allowance() }), json(s.frontier)]);
    recordIdentityEpochNativeCommit(tx, 'identity-scope-registration');
    return { value: null, events };
  });
  const initial = (await f.admin.query(
    `SELECT n.epoch,n.position::text,n.transaction_id FROM semantic.identity_epoch_native_commit n
     JOIN semantic.identity_scope_summary s ON s.partition_no=n.partition_no AND s.xmin=n.xmin
     WHERE s.partition_no=$1 AND s.source_key=$2 AND s.scope_id=$3`, keys,
  )).rows[0];
  const attempt: IdentityNativeReceipt = { partition: a.partition, epoch: initial.epoch,
    position: BigInt(initial.position), transactionId: initial.transaction_id };
  await runCommand(f.pool, { partition: a.partition, deadline: deadline() }, async (tx) => {
    await tx.query(`INSERT INTO semantic.identity_scope_attempt
      (partition_no,source_key,scope_id,registration,job_id,job_epoch,attempt,state,transaction_id,revision)
      VALUES($1,$2,$3,$4,$5,$6,$7,'active',$8,3)`,
    [...keys, registration, job.jobId, job.epoch.toString(), json(attempt), currentCommand(tx).transactionId]);
    await tx.query(`INSERT INTO semantic.identity_scope_prearm_receipt
      (partition_no,source_key,scope_id,registration,job_id,job_epoch,directory_transaction,page_id,ordinal,disposition,transaction_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,0,'unsafe',$9)`,
    [...keys, registration, job.jobId, job.epoch.toString(), directoryTransactionId, pageId, currentCommand(tx).transactionId]);
    await tx.query(`UPDATE semantic.identity_scope_summary SET state='repair',active=1,revision=3
      WHERE partition_no=$1 AND source_key=$2 AND scope_id=$3`, keys);
    recordIdentityEpochNativeCommit(tx, 'identity-scope-preparation');
    return { value: null, events };
  });
  const finish = async (tx: CommandTransaction) => {
    const native = await writeIdentityScopeConsumerNativeCommit(tx);
    await tx.query(`INSERT INTO semantic.identity_scope_completion
      (partition_no,source_key,scope_id,registration,job_id,job_epoch,source_generation,capture_id,attempt,seal,complete)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,true)`,
    [...keys, registration, job.jobId, job.epoch.toString(), s.identity.generation, s.capture.captureId, json(attempt),
      json({ key: { job, sourceIdentity: s.identity, scope: s.key.scopeId }, generation: s.identity.generation,
        version: '1', frontier: { after: [], segment: 0 }, receipt: attempt })]);
    await tx.query(`UPDATE semantic.identity_scope_attempt SET state='finished',revision=4,transaction_id=$7
      WHERE partition_no=$1 AND source_key=$2 AND scope_id=$3 AND registration=$4 AND job_id=$5 AND job_epoch=$6`,
    [...keys, registration, job.jobId, job.epoch.toString(), native.transactionId]);
    await tx.query(`UPDATE semantic.identity_scope_summary SET active=0,revision=4
      WHERE partition_no=$1 AND source_key=$2 AND scope_id=$3`, keys);
    return native;
  };
  let native: IdentityNativeReceipt | null = null;
  if (finished) native = (await runCommand(f.pool, { partition: a.partition, deadline: deadline() }, async (tx) =>
    ({ value: await finish(tx), events }))).value;
  const locator: IdentityScopeCommittedLocator = {
    expected: { key: s.key, captureId: s.capture.captureId, committedRevision: 4n }, registration,
    completion: { kind: 'repair', receiving: { job, directoryTransactionId, pageId, ordinal: 0 }, attempt },
  };
  return { ...s, address: a, keys, locator, finish, native, events };
}

async function observed(locator: IdentityScopeCommittedLocator, context: IdentitySourceConsumerMaintenanceContext) {
  const result = await resolveCommittedIdentityScopeReceipt(f.pool, { locator, context });
  expect(result.status).toBe('observed');
  if (result.status !== 'observed') throw new Error(`Retained native receipt refused: ${result.reason}`);
  return result;
}

test('retained completed native records resolve the actual tuple; repeat keeps original funding and fixed costs', async () => {
  const s = await retainedFixture();
  await frame(async (context) => {
    const original = identitySourceConsumerLibraryWork(f.pool, context.identityConsumerWork, context.deadline)!;
    const first = await observed(s.locator, context);
    expect(first.evidence.native).toEqual(s.native!);
    expect(first.work.reservationId).toBe(original.receipt().reservationId);
    expect(first.work.used.nativeRows).toBe(19);
    const second = await observed(s.locator, context);
    expect(second.work.used.nativeRows - first.work.used.nativeRows).toBe(19);
    expect(second.work.used.statements - first.work.used.statements).toBe(6);
    expect(second.work.used.nativePoints - first.work.used.nativePoints).toBe(20);
  });
});

test('pending, uncommitted and rolled back completion cannot resolve a native receipt', async () => {
  const s = await retainedFixture(false);
  await frame(async (context) => {
    expect((await resolveCommittedIdentityScopeReceipt(f.pool, { locator: s.locator, context })).status).toBe('unavailable');
    const reached = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const rollback = new Error('Fixture rolls back its own uncommitted completion');
    const attempt = runCommand(f.pool, { partition: s.address.partition, deadline: deadline() }, async (tx) => {
      await s.finish(tx);
      reached.resolve();
      await release.promise;
      throw rollback;
    });
    try {
      await Promise.race([reached.promise, attempt]);
      expect((await resolveCommittedIdentityScopeReceipt(f.pool, { locator: s.locator, context })).status).toBe('unavailable');
    } finally { release.resolve(); }
    await expect(attempt).rejects.toBe(rollback);
    expect((await resolveCommittedIdentityScopeReceipt(f.pool, { locator: s.locator, context })).status).toBe('unavailable');
  });
});

test('exact revision, capture, registration, foreign scope and receiving mismatches refuse', async () => {
  const s = await retainedFixture();
  for (const change of [
    (l: IdentityScopeCommittedLocator) => ({ ...l, expected: { ...l.expected, committedRevision: 5n } }),
    (l: IdentityScopeCommittedLocator) => ({ ...l, expected: { ...l.expected, captureId: randomUUID() } }),
    (l: IdentityScopeCommittedLocator) => ({ ...l, registration: randomUUID() }),
    (l: IdentityScopeCommittedLocator) => ({ ...l, expected: { ...l.expected,
      key: { ...l.expected.key, scopeId: 'foreign-scope' } } }),
    (l: IdentityScopeCommittedLocator) => ({ ...l, completion: l.completion.kind === 'repair'
      ? { ...l.completion, receiving: { ...l.completion.receiving, ordinal: 1 } } : l.completion }),
  ]) await frame(async (context) => {
    const locator = change(s.locator);
    expect((await resolveCommittedIdentityScopeReceipt(f.pool, { locator, context })).status).toBe('unavailable');
  });
});

test('locked verification rejects a substituted actual native transaction and released observations cannot authorize', async () => {
  const s = await retainedFixture();
  const foreign = await retainedFixture();
  await frame(async (context) => {
    const result = await observed(s.locator, context);
    await runCommand(f.pool, { partition: s.address.partition, deadline: context.deadline }, async (tx) => {
      expect(isHeldCommittedIdentityScopeReceipt(tx, result)).toBe(false);
      const substituted = { ...result.evidence, native: foreign.native! };
      expect((await holdCommittedIdentityScopeReceipt(tx, f.pool, { evidence: substituted, context })).status).toBe('unavailable');
      const held = await holdCommittedIdentityScopeReceipt(tx, f.pool, { evidence: result.evidence, context });
      expect(held.status).toBe('held');
      expect(isHeldCommittedIdentityScopeReceipt(tx, held)).toBe(true);
      expect(isHeldCommittedIdentityScopeReceipt(tx, { ...held })).toBe(false);
      return noEffect(null);
    });
  });
});

test('same-transaction locks exclude capture/source and repair mutations and die at final commit', async () => {
  const s = await retainedFixture();
  let endedTx: CommandTransaction | undefined;
  let heldResult: unknown;
  await frame(async (context) => {
    const result = await observed(s.locator, context);
    await runCommand(f.pool, { partition: s.address.partition, deadline: context.deadline }, async (tx) => {
      heldResult = await holdCommittedIdentityScopeReceipt(tx, f.pool, { evidence: result.evidence, context });
      expect(isHeldCommittedIdentityScopeReceipt(tx, heldResult)).toBe(true);
      endedTx = tx;
      const competing = await f.admin.connect();
      try {
        for (const [sql, values] of [
          [`UPDATE semantic.identity_scope_summary SET active=active+1 WHERE partition_no=$1 AND source_key=$2 AND scope_id=$3`, s.keys],
          [`UPDATE library.native_source_capture SET version=version+1 WHERE route=$1 AND capture_id=$2`, [s.identity.route, s.capture.captureId]],
          [`UPDATE library.collection SET source_generation=source_generation+1 WHERE route=$1 AND collection_id=$2`, [s.identity.route, s.identity.collectionId]],
        ] as const) {
          await competing.query('BEGIN');
          await competing.query("SET LOCAL lock_timeout='100ms'");
          await expect(competing.query(sql, [...values])).rejects.toMatchObject({ code: '55P03' });
          await competing.query('ROLLBACK');
        }
      } finally { await competing.query('ROLLBACK'); competing.release(); }
      return noEffect(null);
    });
    expect(isHeldCommittedIdentityScopeReceipt(endedTx!, heldResult)).toBe(false);
  });
});

test('owner movement and source ABA refuse under native locks without changing another partition permanently', async () => {
  const s = await retainedFixture();
  await frame(async (context) => {
    const result = await observed(s.locator, context);
    const rollback = new Error('Roll back this fixture movement');
    await expect(runCommand(f.pool, { partition: s.address.partition, deadline: context.deadline }, async (tx) => {
      await tx.query("UPDATE core.partition SET write_state='moved',moved_to='fixture-home' WHERE partition_no=$1", [s.address.partition]);
      expect((await holdCommittedIdentityScopeReceipt(tx, f.pool, { evidence: result.evidence, context })).status).toBe('unavailable');
      throw rollback;
    })).rejects.toBe(rollback);
  });
  // Restore the business generation to its old value. Native mutation fences still
  // advance, so an equal-looking Collection cannot revive its old capture.
  await f.admin.query(`UPDATE library.collection SET source_generation=source_generation+1 WHERE route=$1 AND collection_id=$2`,
    [s.identity.route, s.identity.collectionId]);
  await f.admin.query(`UPDATE library.collection SET source_generation=$3 WHERE route=$1 AND collection_id=$2`,
    [s.identity.route, s.identity.collectionId, s.identity.generation]);
  await frame(async (context) => {
    expect((await resolveCommittedIdentityScopeReceipt(f.pool, { locator: s.locator, context })).status).toBe('unavailable');
  });
});

test('same-original funding refuses copied tokens, a foreign Pool, escaped callbacks and an expired deadline', async () => {
  const s = await retainedFixture();
  let escaped: IdentitySourceConsumerMaintenanceContext | undefined;
  await frame(async (context) => {
    escaped = context;
    const work = identitySourceConsumerLibraryWork(f.pool, context.identityConsumerWork, context.deadline)!;
    const before = work.receipt();
    const foreign = new pg.Pool({ connectionString: process.env.DATABASE_URL });
    try {
      for (const [pool, rejected] of [
        [foreign, context],
        [f.pool, { ...context, identityConsumerWork: { ...context.identityConsumerWork } }],
        [f.pool, { ...context, deadline: Date.now() - 1 }],
      ] as const) {
        const result = await resolveCommittedIdentityScopeReceipt(pool, { locator: s.locator, context: rejected });
        expect(result.status).toBe('unavailable');
      }
    } finally { await foreign.end(); }
    expect(work.receipt()).toEqual(before);
  });
  const result = await resolveCommittedIdentityScopeReceipt(f.pool, { locator: s.locator, context: escaped! });
  expect(result).toMatchObject({ status: 'unavailable', reason: 'work_binding', work: null });
});

test('body-derived bounds stay constant with unrelated retained jobs and cannot admit unknown SQL', async () => {
  const s = await retainedFixture();
  const first = await frame((context) => observed(s.locator, context));
  await f.admin.query(`INSERT INTO semantic.identity_scope_attempt
    (partition_no,source_key,scope_id,registration,job_id,job_epoch,attempt,state,transaction_id,revision)
    SELECT $1,$2,$3,$4,gen_random_uuid(),g,$5,'cancelled',gen_random_uuid(),1 FROM generate_series(1,1000) g`,
  [...s.keys, s.locator.registration, json(s.locator.completion.kind === 'repair' ? s.locator.completion.attempt : null)]);
  const second = await frame((context) => observed(s.locator, context));
  expect(second.work.used).toEqual(first.work.used);
  for (const [query, rows] of [[currentSQL.sql, 12], [repairSQL.sql, 7]] as const) {
    const bound = identityScopeCommittedReceiptFootprint(query, []);
    expect(bound?.nativeRows).toBe(rows);
    expect(bound?.nativePoints).toBe(rows);
    expect(bound?.statements).toBe(1);
    expect(query).toContain('s.partition_no=$1 AND s.source_key=$2 AND s.scope_id=$3');
    expect(query).not.toMatch(/OFFSET|count\(\*\)|ORDER BY/i);
  }
  expect(identityScopeCommittedReceiptFootprint('SELECT 1', [])).toBeUndefined();
  const ledger = new NativeCollectionWork(allowance(), deadline());
  const admitted = ledger.reserve(identityScopeCommittedReceiptFootprint(repairSQL.sql, []));
  admitted.dispatch();
  admitted.settle(); // dispatched failure and zero-row absence keep the same bound
  expect(ledger.receipt().used.nativeRows).toBe(7);
});
