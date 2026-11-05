import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { currentCommand, noEffect, runCommand, type CommandTransaction } from '../../src/command/command.ts';
import { NativeCollectionWork } from '../../src/library/collection-source-work.ts';
import { readNativeCollectionMetadata } from '../../src/library/collection-source-native.ts';
import {
  createNativeLibrarySourceCustody,
  type NativeSourceIdentity,
  type NativeSourceFrontier,
} from '../../src/library/native-source-custody.ts';
import { routeOf, partitionOf } from '../../src/route/route.ts';
import {
  createIdentityScopedObservations,
  identityScopeAddress,
} from '../../src/semantic/identity-scoped-observations.ts';
import {
  identityEpochStore,
  recordIdentityEpochNativeCommit,
  serializeIdentityValue as json,
} from '../../src/semantic/identity-epoch-store.ts';
import { stepIdentityEpochAdmission } from '../../src/semantic/identity-epoch-admission.ts';
import { writeIdentityScopeConsumerNativeCommit } from '../../src/semantic/identity-epoch-native-commit.ts';
import type { IdentityNativeReceipt } from '../../src/semantic/identity-epoch-contract.ts';
import type { IdentityScopeKey, IdentityScopeObservation } from '../../src/semantic/identity-scope-types.ts';
import {
  holdCommittedIdentityScopeReceipt,
  identityScopeCommittedReceiptFootprint,
  isHeldCommittedIdentityScopeReceipt,
  resolveCommittedIdentityScopeReceipt,
  type IdentityScopeCommittedLocator,
} from '../../src/semantic/identity-scope-committed-receipt.ts';
import {
  identitySourceConsumerLibraryWork,
  withIdentitySourceConsumerMaintenance,
  type IdentitySourceConsumerMaintenanceContext,
} from '../../src/semantic/identity-source-consumer-maintenance.ts';
import { digest, epochFixture, release, type EpochFixture } from './support/identity-epoch.ts';
import { libraryCutoverInput, nativeCutoverCoordinator } from './support/identity-epoch-cutover.ts';
import currentSQL from '../../src/semantic/identity-scope-committed-receipt-current.sql';
import repairSQL from '../../src/semantic/identity-scope-committed-receipt-repair.sql';

let f: EpochFixture;
beforeAll(async () => {
  f = await epochFixture();
});
afterAll(async () => {
  await f?.close();
});
const deadline = () => Date.now() + 10000;
const allowance = () => ({
  reservationId: randomUUID(),
  remaining: {
    candidateKeys: 100,
    identityMetadataRows: 0,
    nativeRows: 100000,
    nativePoints: 1000,
    witnessKeys: 100,
    statements: 1000,
    bytes: 10485760,
    emptySeeks: 100,
  },
});
const frame = <T>(body: (context: IdentitySourceConsumerMaintenanceContext) => Promise<T>) =>
  withIdentitySourceConsumerMaintenance({ pool: f.pool, env: {} }, { deadline: deadline() }, body);

async function nativeCapture(originals: string[] = []) {
  const native = await libraryCutoverInput(f, originals);
  const route = routeOf(native.collection.id)!;
  const metadata = await readNativeCollectionMetadata(
    f.pool,
    { route, collectionId: native.collection.id },
    { allowance: allowance(), deadline: deadline() },
  );
  if (!metadata.metadata) throw new Error('Native source metadata unavailable');
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
    const next = await owner.capturePage({
      identity,
      frontier,
      limit: 8,
      allowance: allowance(),
      deadline: deadline(),
    });
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
    const result = await observations.register({
      key: source.key,
      capture: {
        kind: 'library',
        capture: source.capture,
        frontier: source.frontier,
        allowance: allowance(),
      },
      deadline: deadline(),
    });
    if (result.status === 'registered') return { ...source, observations, observation: result.observation };
    expect(result.status, 'real registration must progress without synthetic ready rows').toBe('pending');
  }
  throw new Error('Native registration did not settle');
}

async function registrationOf(expected: IdentityScopeObservation): Promise<string> {
  const a = identityScopeAddress(expected.key);
  const row = (
    await f.admin.query(
      `SELECT registration FROM semantic.identity_scope_summary
     WHERE partition_no=$1 AND source_key=$2 AND scope_id=$3 AND capture_id=$4 AND revision=$5`,
      [a.partition, a.source, a.scope, expected.captureId, expected.committedRevision.toString()],
    )
  ).rows[0];
  if (!row) throw new Error('Exact committed registration absent');
  return row.registration;
}

// Keep these positive writer-journey assertions intact. They intentionally expose
// the missing initial association and provisional Library completion owner body.
test('A committed scope receipt resolves the actual committed native transaction for an initial registration', async () => {
  const s = await ordinaryRegistration();
  const locator: IdentityScopeCommittedLocator = {
    expected: s.observation,
    registration: await registrationOf(s.observation),
    completion: { kind: 'initial' },
  };
  const result = await frame((context) => resolveCommittedIdentityScopeReceipt(f.pool, { locator, context }));
  expect(result.status).toBe('observed');
  if (result.status !== 'observed') throw new Error('Initial registration has no committed native association');
  const native = (
    await f.admin.query(
      'SELECT epoch,position::text FROM semantic.identity_epoch_native_commit WHERE partition_no=$1 AND transaction_id=$2',
      [result.evidence.native.partition, result.evidence.native.transactionId],
    )
  ).rows[0];
  expect(native).toEqual({ epoch: result.evidence.native.epoch, position: result.evidence.native.position.toString() });
}, 120000);

test('A committed scope receipt resolves an ordinary completed repair and its exact receiving attempt', async () => {
  const original = (await f.create('Receipt repair original', 0x6e10)).subject.id;
  const terminal = (await f.create('Receipt repair terminal', 0x6e20)).subject.id;
  const s = await ordinaryRegistration([original]);
  const actor = await f.actor();
  const request = randomUUID();
  const job = await identityEpochStore().prepareAdmission(
    f.pool,
    {
      basis: { actorAccountId: actor.accountId, clientId: actor.clientId, requestedBy: actor.requestedBy },
      authorization: await f.authorization('subject:merge'),
    },
    {
      intent: { kind: 'merge', redirected: original, survivor: terminal, release: release.digest },
      receipt: {
        kind: 'subject.merge',
        command: {
          actorAccountId: actor.accountId,
          kind: 'subject.merge',
          key: request,
          digest: digest(request),
        },
      },
    },
  );
  for (let step = 0; step < 100; step++) {
    if ((await stepIdentityEpochAdmission(f.pool, job)).state === 'pending') break;
  }
  const address = identityScopeAddress(s.key);
  const retained = (
    await f.admin.query(
      `SELECT a.registration,a.attempt,r.directory_transaction,r.page_id,r.ordinal
     FROM semantic.identity_scope_attempt a JOIN semantic.identity_scope_prearm_receipt r
     USING(partition_no,source_key,scope_id,registration,job_id,job_epoch)
     WHERE a.partition_no=$1 AND a.source_key=$2 AND a.scope_id=$3 AND a.job_id=$4
     AND a.job_epoch=$5 AND r.disposition='unsafe'`,
      [address.partition, address.source, address.scope, job.jobId, job.epoch.toString()],
    )
  ).rows[0];
  expect(retained, 'ordinary admission must retain the actual source receiving attempt').toBeDefined();
  await (
    await nativeCutoverCoordinator()
  )(f.pool, job);
  let observation: IdentityScopeObservation | null = null;
  for (let page = 0; page < 100; page++) {
    const result = await s.observations.repair({ key: s.key, limit: 8, allowance: allowance(), deadline: deadline() });
    if (result.status === 'repaired' && result.observation) {
      observation = result.observation;
      break;
    }
    expect(result.status).toBe('pending');
  }
  if (!observation) throw new Error('Ordinary Library receiving completion never settled');
  const locator: IdentityScopeCommittedLocator = {
    expected: observation,
    registration: retained.registration,
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
    const held = await s.owner.readAndHold({
      client: tx,
      at: currentCommand(tx).time,
      identity: s.identity,
      captureId: s.capture.captureId,
      holdId: registration,
      allowance: allowance(),
      deadline: deadline(),
    });
    expect(held.status).toBe('held');
    await tx.query(
      `INSERT INTO semantic.identity_scope_summary
      (partition_no,source_key,scope_id,source,registration,capture_id,capture,state,revision,active,frontier,scan_complete)
      VALUES($1,$2,$3,$4,$5,$6,$7,'ready',2,0,$8,true)`,
      [
        ...keys,
        json(s.key.source),
        registration,
        s.capture.captureId,
        json({ kind: 'library', capture: s.capture, frontier: s.frontier, allowance: allowance() }),
        json(s.frontier),
      ],
    );
    recordIdentityEpochNativeCommit(tx, 'identity-scope-registration');
    return { value: null, events };
  });
  const initial = (
    await f.admin.query(
      `SELECT n.epoch,n.position::text,n.transaction_id FROM semantic.identity_epoch_native_commit n
     JOIN semantic.identity_scope_summary s ON s.partition_no=n.partition_no AND s.xmin=n.xmin
     WHERE s.partition_no=$1 AND s.source_key=$2 AND s.scope_id=$3`,
      keys,
    )
  ).rows[0];
  const attempt: IdentityNativeReceipt = {
    partition: a.partition,
    epoch: initial.epoch,
    position: BigInt(initial.position),
    transactionId: initial.transaction_id,
  };
  await runCommand(f.pool, { partition: a.partition, deadline: deadline() }, async (tx) => {
    await tx.query(
      `INSERT INTO semantic.identity_scope_attempt
      (partition_no,source_key,scope_id,registration,job_id,job_epoch,attempt,state,transaction_id,revision)
      VALUES($1,$2,$3,$4,$5,$6,$7,'active',$8,3)`,
      [...keys, registration, job.jobId, job.epoch.toString(), json(attempt), currentCommand(tx).transactionId],
    );
    await tx.query(
      `INSERT INTO semantic.identity_scope_prearm_receipt
      (partition_no,source_key,scope_id,registration,job_id,job_epoch,directory_transaction,page_id,ordinal,disposition,transaction_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,0,'unsafe',$9)`,
      [
        ...keys,
        registration,
        job.jobId,
        job.epoch.toString(),
        directoryTransactionId,
        pageId,
        currentCommand(tx).transactionId,
      ],
    );
    await tx.query(
      `UPDATE semantic.identity_scope_summary SET state='repair',active=1,revision=3
      WHERE partition_no=$1 AND source_key=$2 AND scope_id=$3`,
      keys,
    );
    recordIdentityEpochNativeCommit(tx, 'identity-scope-preparation');
    return { value: null, events };
  });
  const finish = async (tx: CommandTransaction) => {
    const native = await writeIdentityScopeConsumerNativeCommit(tx);
    await tx.query(
      `INSERT INTO semantic.identity_scope_completion
      (partition_no,source_key,scope_id,registration,job_id,job_epoch,source_generation,capture_id,attempt,seal,complete)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,true)`,
      [
        ...keys,
        registration,
        job.jobId,
        job.epoch.toString(),
        s.identity.generation,
        s.capture.captureId,
        json(attempt),
        json({
          key: { job, sourceIdentity: s.identity, scope: s.key.scopeId },
          generation: s.identity.generation,
          version: '1',
          frontier: { after: [], segment: 0 },
          receipt: attempt,
        }),
      ],
    );
    await tx.query(
      `UPDATE semantic.identity_scope_attempt SET state='finished',revision=4,transaction_id=$7
      WHERE partition_no=$1 AND source_key=$2 AND scope_id=$3 AND registration=$4 AND job_id=$5 AND job_epoch=$6`,
      [...keys, registration, job.jobId, job.epoch.toString(), native.transactionId],
    );
    await tx.query(
      `UPDATE semantic.identity_scope_summary SET active=0,revision=4
      WHERE partition_no=$1 AND source_key=$2 AND scope_id=$3`,
      keys,
    );
    return native;
  };
  let native: IdentityNativeReceipt | null = null;
  if (finished)
    native = (
      await runCommand(f.pool, { partition: a.partition, deadline: deadline() }, async (tx) => ({
        value: await finish(tx),
        events,
      }))
    ).value;
  const locator: IdentityScopeCommittedLocator = {
    expected: { key: s.key, captureId: s.capture.captureId, committedRevision: 4n },
    registration,
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
    expect((await resolveCommittedIdentityScopeReceipt(f.pool, { locator: s.locator, context })).status).toBe(
      'unavailable',
    );
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
      expect((await resolveCommittedIdentityScopeReceipt(f.pool, { locator: s.locator, context })).status).toBe(
        'unavailable',
      );
    } finally {
      release.resolve();
    }
    await expect(attempt).rejects.toBe(rollback);
    expect((await resolveCommittedIdentityScopeReceipt(f.pool, { locator: s.locator, context })).status).toBe(
      'unavailable',
    );
  });
});

test('exact revision, capture, registration, foreign scope and receiving mismatches refuse', async () => {
  const s = await retainedFixture();
  for (const change of [
    (l: IdentityScopeCommittedLocator) => ({ ...l, expected: { ...l.expected, committedRevision: 5n } }),
    (l: IdentityScopeCommittedLocator) => ({ ...l, expected: { ...l.expected, captureId: randomUUID() } }),
    (l: IdentityScopeCommittedLocator) => ({ ...l, registration: randomUUID() }),
    (l: IdentityScopeCommittedLocator) => ({
      ...l,
      expected: { ...l.expected, key: { ...l.expected.key, scopeId: 'foreign-scope' } },
    }),
    (l: IdentityScopeCommittedLocator) => ({
      ...l,
      completion:
        l.completion.kind === 'repair'
          ? { ...l.completion, receiving: { ...l.completion.receiving, ordinal: 1 } }
          : l.completion,
    }),
  ])
    await frame(async (context) => {
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
      expect((await holdCommittedIdentityScopeReceipt(tx, f.pool, { evidence: substituted, context })).status).toBe(
        'unavailable',
      );
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
          [
            `UPDATE semantic.identity_scope_summary SET active=active+1 WHERE partition_no=$1 AND source_key=$2 AND scope_id=$3`,
            s.keys,
          ],
          [
            `UPDATE library.native_source_capture SET version=version+1 WHERE route=$1 AND capture_id=$2`,
            [s.identity.route, s.capture.captureId],
          ],
          [
            `UPDATE library.collection SET source_generation=source_generation+1 WHERE route=$1 AND collection_id=$2`,
            [s.identity.route, s.identity.collectionId],
          ],
        ] as const) {
          await competing.query('BEGIN');
          await competing.query("SET LOCAL lock_timeout='100ms'");
          await expect(competing.query(sql, [...values])).rejects.toMatchObject({ code: '55P03' });
          await competing.query('ROLLBACK');
        }
      } finally {
        await competing.query('ROLLBACK');
        competing.release();
      }
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
    await expect(
      runCommand(f.pool, { partition: s.address.partition, deadline: context.deadline }, async (tx) => {
        await tx.query("UPDATE core.partition SET write_state='moved',moved_to='fixture-home' WHERE partition_no=$1", [
          s.address.partition,
        ]);
        expect(
          (await holdCommittedIdentityScopeReceipt(tx, f.pool, { evidence: result.evidence, context })).status,
        ).toBe('unavailable');
        throw rollback;
      }),
    ).rejects.toBe(rollback);
  });
  // Restore the business generation to its old value. Native mutation fences still
  // advance, so an equal-looking Collection cannot revive its old capture.
  await f.admin.query(
    `UPDATE library.collection SET source_generation=source_generation+1 WHERE route=$1 AND collection_id=$2`,
    [s.identity.route, s.identity.collectionId],
  );
  await f.admin.query(`UPDATE library.collection SET source_generation=$3 WHERE route=$1 AND collection_id=$2`, [
    s.identity.route,
    s.identity.collectionId,
    s.identity.generation,
  ]);
  await frame(async (context) => {
    expect((await resolveCommittedIdentityScopeReceipt(f.pool, { locator: s.locator, context })).status).toBe(
      'unavailable',
    );
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
    } finally {
      await foreign.end();
    }
    expect(work.receipt()).toEqual(before);
  });
  const result = await resolveCommittedIdentityScopeReceipt(f.pool, { locator: s.locator, context: escaped! });
  expect(result).toMatchObject({ status: 'unavailable', reason: 'work_binding', work: null });
});

test('body-derived bounds stay constant with unrelated retained jobs and cannot admit unknown SQL', async () => {
  const s = await retainedFixture();
  const first = await frame((context) => observed(s.locator, context));
  await f.admin.query(
    `INSERT INTO semantic.identity_scope_attempt
    (partition_no,source_key,scope_id,registration,job_id,job_epoch,attempt,state,transaction_id,revision)
    SELECT $1,$2,$3,$4,gen_random_uuid(),g,$5,'cancelled',gen_random_uuid(),1 FROM generate_series(1,1000) g`,
    [
      ...s.keys,
      s.locator.registration,
      json(s.locator.completion.kind === 'repair' ? s.locator.completion.attempt : null),
    ],
  );
  const second = await frame((context) => observed(s.locator, context));
  expect(second.work.used).toEqual(first.work.used);
  for (const [query, rows] of [
    [currentSQL.sql, 12],
    [repairSQL.sql, 7],
  ] as const) {
    const bound = identityScopeCommittedReceiptFootprint(query, []);
    expect(bound?.nativeRows).toBe(rows);
    expect(bound?.nativePoints).toBe(rows);
    expect(bound?.statements).toBe(1);
    expect(query).toContain('s.partition_no=i.partition_no AND s.source_key=i.source_key AND s.scope_id=i.scope_id');
    expect(query).not.toMatch(/OFFSET|count\(\*\)|ORDER BY/i);
  }
  expect(identityScopeCommittedReceiptFootprint('SELECT 1', [])).toBeUndefined();
  const ledger = new NativeCollectionWork(allowance(), deadline());
  const admitted = ledger.reserve(identityScopeCommittedReceiptFootprint(repairSQL.sql, []));
  admitted.dispatch();
  admitted.settle(); // dispatched failure and zero-row absence keep the same bound
  expect(ledger.receipt().used.nativeRows).toBe(7);
});

// Association continuation regressions. Existing regression bytes above are frozen.
import {
  prepayIdentityScopeNativeAssociation,
  bindIdentityScopeNativeAssociation,
  recordIdentityScopeNativeAssociation,
  identityScopeNativeAssociationPrices,
  type IdentityScopeNativeAssociationAdmission,
} from '../../src/semantic/identity-scope-native-association.ts';
import associationSQL from '../../src/semantic/identity-scope-committed-receipt-association.sql';
import associationInsertSQL from '../../src/semantic/identity-scope-native-association-insert.sql';
import { IDENTITY_SCOPE_NATIVE_ASSOCIATED } from '../../src/semantic/events.ts';

async function fundedInitial() {
  return frame(async (context) => {
    const s = await ordinaryRegistration();
    const locator: IdentityScopeCommittedLocator = {
      expected: s.observation,
      registration: await registrationOf(s.observation),
      completion: { kind: 'initial' },
    };
    const result = await observed(locator, context);
    return { ...s, locator, evidence: result.evidence };
  });
}

async function associationsFor(locator: IdentityScopeCommittedLocator) {
  const a = identityScopeAddress(locator.expected.key);
  return (
    await f.admin.query(
      `SELECT phase,revision::text,capture_id,registration,
    transaction_id,epoch,position::text,purpose,scan_complete,job_id,job_epoch::text,completion_version::text
    FROM semantic.identity_scope_native_association
    WHERE partition_no=$1 AND source_key=$2 AND scope_id=$3 AND registration=$4
    ORDER BY revision,phase`,
      [a.partition, a.source, a.scope, locator.registration],
    )
  ).rows;
}

test('funded real initial registration commits capture and ready associations with the genuine closed event', async () => {
  const s = await fundedInitial();
  const rows = await associationsFor(s.locator);
  const ready = rows.find((r) => r.phase === 'ready');
  const capture = rows.find(
    (r) => r.phase === 'capture' && r.scan_complete && r.capture_id === s.observation.captureId,
  );
  expect(ready).toBeDefined();
  expect(capture).toBeDefined();
  expect(BigInt(capture.revision) + 1n).toBe(s.observation.committedRevision);
  expect(ready.transaction_id).toBe(s.evidence.native.transactionId);
  expect(ready.epoch).toBe(s.evidence.native.epoch);
  expect(BigInt(ready.position)).toBe(s.evidence.native.position);
  expect(ready.purpose).toBe('identity-scope-registration');
  expect(ready.job_id).toBeNull(); // initial success never invents a repair job
  const event = (
    await f.admin.query(
      `SELECT data FROM core.outbox
    WHERE partition_no=$1 AND position=$2 AND type=$3`,
      [s.evidence.native.partition, s.evidence.native.position.toString(), IDENTITY_SCOPE_NATIVE_ASSOCIATED],
    )
  ).rows[0];
  expect(event.data).toMatchObject({ phase: 'ready', transactionId: s.evidence.native.transactionId });
  await frame(async (context) => {
    const replay = await s.observations.register({
      key: s.key,
      capture: {
        kind: 'library',
        capture: s.capture,
        frontier: s.frontier,
        allowance: allowance(),
      },
      deadline: context.deadline,
    });
    expect(replay.status).toBe('registered');
    expect((await observed(s.locator, context)).evidence).toEqual(s.evidence);
  });
  expect(await associationsFor(s.locator)).toEqual(rows);
}, 120000);

test('historical ready metadata cannot mint registration evidence during replay or resolution', async () => {
  const s = await retainedFixture();
  await f.admin.query(
    `UPDATE semantic.identity_scope_summary SET state='ready',revision=5
    WHERE partition_no=$1 AND source_key=$2 AND scope_id=$3`,
    s.keys,
  );
  const locator: IdentityScopeCommittedLocator = {
    expected: { ...s.locator.expected, committedRevision: 5n },
    registration: s.locator.registration,
    completion: { kind: 'initial' },
  };
  await frame(async (context) => {
    const before = await associationsFor(locator);
    expect((await resolveCommittedIdentityScopeReceipt(f.pool, { locator, context })).status).toBe('unavailable');
    const replay = await createIdentityScopedObservations(f.pool).register({
      key: s.key,
      capture: {
        kind: 'library',
        capture: s.capture,
        frontier: s.frontier,
        allowance: allowance(),
      },
      deadline: context.deadline,
    });
    expect(replay.status).toBe('registered');
    expect((await resolveCommittedIdentityScopeReceipt(f.pool, { locator, context })).status).toBe('unavailable');
    expect(await associationsFor(locator)).toEqual(before);
  });
});

test('initial association rejects committed native substitution and cannot authorize after release', async () => {
  const s = await fundedInitial();
  const address = identityScopeAddress(s.key);
  const unrelated = (
    await runCommand(f.pool, { partition: address.partition, deadline: deadline() }, async (tx) => {
      recordIdentityEpochNativeCommit(tx, 'identity-scope-registration');
      return { value: currentCommand(tx).transactionId, events: [{ type: 'com.rezics.fixture.created.v1', data: {} }] };
    })
  ).value;
  const other = (
    await f.admin.query(
      `SELECT epoch,position::text FROM semantic.identity_epoch_native_commit
    WHERE partition_no=$1 AND transaction_id=$2`,
      [address.partition, unrelated],
    )
  ).rows[0];
  await f.admin.query(
    `UPDATE semantic.identity_scope_native_association
    SET transaction_id=$7,epoch=$8,position=$9
    WHERE partition_no=$1 AND source_key=$2 AND scope_id=$3 AND registration=$4
     AND capture_id=$5 AND revision=$6 AND phase='ready'`,
    [
      address.partition,
      address.source,
      address.scope,
      s.locator.registration,
      s.observation.captureId,
      s.observation.committedRevision.toString(),
      unrelated,
      other.epoch,
      other.position,
    ],
  );
  // Use a same-home native substitution as well as the original suite's foreign
  // completion substitution. The native/association transaction version must match.
  await frame(async (context) => {
    expect((await resolveCommittedIdentityScopeReceipt(f.pool, { locator: s.locator, context })).status).toBe(
      'unavailable',
    );
    await runCommand(f.pool, { partition: address.partition, deadline: context.deadline }, async (tx) => {
      expect(isHeldCommittedIdentityScopeReceipt(tx, { status: 'observed', evidence: s.evidence })).toBe(false);
      return noEffect(null);
    });
  });
}, 120000);

test('association admission belongs to the original Pool, episode, deadline and single actual transaction', async () => {
  expect(() => prepayIdentityScopeNativeAssociation(f.pool, deadline())).toThrow();
  let escaped: IdentityScopeNativeAssociationAdmission | undefined;
  const address = identityScopeAddress((await nativeCapture()).key);
  await frame(async (context) => {
    const original = identitySourceConsumerLibraryWork(f.pool, context.identityConsumerWork, context.deadline)!;
    const before = original.receipt();
    expect(() => prepayIdentityScopeNativeAssociation(f.pool, Date.now() - 1)).toThrow();
    const foreign = new pg.Pool({ connectionString: process.env.DATABASE_URL });
    try {
      expect(() => prepayIdentityScopeNativeAssociation(foreign, context.deadline)).toThrow();
    } finally {
      await foreign.end();
    }
    expect(original.receipt()).toEqual(before);
    escaped = prepayIdentityScopeNativeAssociation(f.pool, context.deadline);
    const charged = original.receipt();
    expect(charged.reservationId).toBe(before.reservationId);
    const expectedRows = Object.values(identityScopeNativeAssociationPrices()).reduce((n, p) => n + p.nativeRows, 0);
    expect(charged.used.nativeRows - before.used.nativeRows).toBe(expectedRows);
    await runCommand(f.pool, { partition: address.partition, deadline: escaped.deadline }, async (tx) => {
      expect(() => bindIdentityScopeNativeAssociation(tx, { ...escaped! })).toThrow();
      bindIdentityScopeNativeAssociation(tx, escaped!);
      return noEffect(null);
    });
    await expect(
      runCommand(f.pool, { partition: address.partition, deadline: escaped.deadline }, async (tx) => {
        bindIdentityScopeNativeAssociation(tx, escaped!);
        return noEffect(null);
      }),
    ).rejects.toThrow();
    expect(original.receipt()).toEqual(charged); // repeats never reset the balance
  });
  await frame(async (context) => {
    await expect(
      runCommand(f.pool, { partition: address.partition, deadline: context.deadline }, async (tx) => {
        bindIdentityScopeNativeAssociation(tx, escaped!);
        return noEffect(null);
      }),
    ).rejects.toThrow();
  });
});

test('rolled-back native association and expired callback cannot produce committed evidence', async () => {
  const s = await fundedInitial();
  const address = identityScopeAddress(s.key);
  const before = await associationsFor(s.locator);
  await frame(async (context) => {
    const admission = prepayIdentityScopeNativeAssociation(f.pool, context.deadline);
    const rollback = new Error('Association transaction intentionally rolled back');
    await expect(
      runCommand(f.pool, { partition: address.partition, deadline: admission.deadline }, async (tx) => {
        bindIdentityScopeNativeAssociation(tx, admission);
        await tx.query(
          `UPDATE semantic.identity_scope_summary SET state='enrolling',revision=revision+1
        WHERE partition_no=$1 AND source_key=$2 AND scope_id=$3`,
          [address.partition, address.source, address.scope],
        );
        recordIdentityScopeNativeAssociation(tx, admission, s.key, 'capture');
        throw rollback;
      }),
    ).rejects.toBe(rollback);
    expect((await observed(s.locator, context)).evidence).toEqual(s.evidence);
    const expiring = prepayIdentityScopeNativeAssociation(f.pool, Date.now() + 100);
    await expect(
      runCommand(f.pool, { partition: address.partition, deadline: expiring.deadline }, async (tx) => {
        bindIdentityScopeNativeAssociation(tx, expiring);
        await tx.query(
          `UPDATE semantic.identity_scope_summary SET state='enrolling',revision=revision+1
        WHERE partition_no=$1 AND source_key=$2 AND scope_id=$3`,
          [address.partition, address.source, address.scope],
        );
        const event = recordIdentityScopeNativeAssociation(tx, expiring, s.key, 'capture');
        await new Promise((resolve) => setTimeout(resolve, 110));
        return { value: null, events: [event] };
      }),
    ).rejects.toThrow();
  });
  expect(await associationsFor(s.locator)).toEqual(before);
}, 120000);

test('ready association reads and writer prices remain literal under unrelated revision growth', async () => {
  const s = await fundedInitial();
  const first = await frame((context) => observed(s.locator, context));
  const address = identityScopeAddress(s.key);
  await f.admin.query(
    `INSERT INTO semantic.identity_scope_native_association
    (partition_no,source_key,scope_id,registration,capture_id,revision,phase,source,
     transaction_id,epoch,position,purpose,scan_complete)
    SELECT partition_no,source_key,scope_id,registration,capture_id,revision+g,'progress',source,
     transaction_id,epoch,position,purpose,scan_complete
    FROM semantic.identity_scope_native_association CROSS JOIN generate_series(1,1000) g
    WHERE partition_no=$1 AND source_key=$2 AND scope_id=$3 AND registration=$4 AND phase='ready'`,
    [address.partition, address.source, address.scope, s.locator.registration],
  );
  const second = await frame((context) => observed(s.locator, context));
  expect(second.work.used).toEqual(first.work.used);
  expect(identityScopeCommittedReceiptFootprint(associationSQL.sql, [])?.nativeRows).toBe(7);
  expect(associationSQL.sql).not.toMatch(/OFFSET|ORDER BY|count\(\*\)/i);
  expect(associationInsertSQL.sql).toContain('FOR UPDATE OF s');
  expect(associationInsertSQL.sql).toContain('a.transaction_id=n.transaction_id');
  expect(identityScopeNativeAssociationPrices().association.nativeRows).toBe(8);
  expect(identityScopeNativeAssociationPrices().event.nativeRows).toBe(2);
  for (const p of Object.values(identityScopeNativeAssociationPrices())) {
    expect(Object.keys(p)).toHaveLength(8);
    expect(p.bytes).toBeGreaterThan(0);
    expect(p.statements).toBeGreaterThan(0);
  }
}, 120000);

test('finish association binds the exact completion and ready advancement materializes its own component', async () => {
  const s = await retainedFixture(false);
  if (s.locator.completion.kind !== 'repair') throw new Error('Expected repair fixture');
  const { attempt, receiving } = s.locator.completion;
  await frame(async (context) => {
    const admission = prepayIdentityScopeNativeAssociation(f.pool, context.deadline);
    const finished = (
      await runCommand(f.pool, { partition: s.address.partition, deadline: admission.deadline }, async (tx) => {
        bindIdentityScopeNativeAssociation(tx, admission);
        const transactionId = currentCommand(tx).transactionId;
        await tx.query(
          `INSERT INTO semantic.identity_scope_completion
        (partition_no,source_key,scope_id,registration,job_id,job_epoch,source_generation,capture_id,attempt,seal,complete)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,true)`,
          [
            ...s.keys,
            s.locator.registration,
            receiving.job.jobId,
            receiving.job.epoch.toString(),
            s.identity.generation,
            s.capture.captureId,
            json(attempt),
            json({
              key: { job: receiving.job, sourceIdentity: s.identity, scope: s.key.scopeId },
              generation: s.identity.generation,
              version: '1',
              frontier: { after: [], segment: 0 },
              receipt: attempt,
            }),
          ],
        );
        await tx.query(
          `UPDATE semantic.identity_scope_attempt SET state='finished',revision=4,transaction_id=$7
        WHERE partition_no=$1 AND source_key=$2 AND scope_id=$3 AND registration=$4 AND job_id=$5 AND job_epoch=$6`,
          [...s.keys, s.locator.registration, receiving.job.jobId, receiving.job.epoch.toString(), transactionId],
        );
        await tx.query(
          `UPDATE semantic.identity_scope_summary SET active=0,revision=4
        WHERE partition_no=$1 AND source_key=$2 AND scope_id=$3`,
          s.keys,
        );
        return {
          value: transactionId,
          events: [recordIdentityScopeNativeAssociation(tx, admission, s.key, 'finish', { job: receiving.job })],
        };
      })
    ).value;
    const resolved = await observed(s.locator, context);
    expect(resolved.evidence.native.transactionId).toBe(finished);
    const association = (await associationsFor(s.locator)).find((r) => r.phase === 'finish');
    expect(association.transaction_id).toBe(finished);
    expect(association.job_id).toBe(receiving.job.jobId);
    expect(association.job_epoch).toBe(receiving.job.epoch.toString());
    expect(association.completion_version).toBe('1');
    const ready = await createIdentityScopedObservations(f.pool).register({
      key: s.key,
      capture: {
        kind: 'library',
        capture: s.capture,
        frontier: s.frontier,
        allowance: allowance(),
      },
      deadline: context.deadline,
    });
    expect(ready.status).toBe('registered');
    if (ready.status !== 'registered') throw new Error('Ready transition did not settle');
    expect(ready.observation.committedRevision).toBe(5n);
    const currentLocator = { ...s.locator, expected: ready.observation };
    const current = await observed(currentLocator, context);
    expect(current.evidence.native.transactionId).not.toBe(finished);
    expect(current.evidence.completionRevision).toBe(4n);
    const readyAssociation = (await associationsFor(currentLocator)).find((r) => r.phase === 'ready');
    expect(current.evidence.native.transactionId).toBe(readyAssociation.transaction_id);
  });
}, 120000);

test('initial held verification locks the ready association through commit and loses authority on release', async () => {
  const s = await fundedInitial();
  const a = identityScopeAddress(s.key);
  let released: unknown;
  await frame(async (context) => {
    await runCommand(f.pool, { partition: a.partition, deadline: context.deadline }, async (tx) => {
      const result = await holdCommittedIdentityScopeReceipt(tx, f.pool, { evidence: s.evidence, context });
      expect(result.status).toBe('held');
      expect(isHeldCommittedIdentityScopeReceipt(tx, result)).toBe(true);
      released = result;
      const competing = await f.admin.connect();
      try {
        await competing.query('BEGIN');
        await competing.query("SET LOCAL lock_timeout = '30ms'");
        await expect(
          competing.query(
            `UPDATE semantic.identity_scope_native_association SET scan_complete=false
          WHERE partition_no=$1 AND source_key=$2 AND scope_id=$3 AND registration=$4
          AND capture_id=$5 AND revision=$6 AND phase='ready'`,
            [
              a.partition,
              a.source,
              a.scope,
              s.locator.registration,
              s.observation.captureId,
              s.observation.committedRevision.toString(),
            ],
          ),
        ).rejects.toThrow();
      } finally {
        await competing.query('ROLLBACK');
        competing.release();
      }
      return noEffect(null);
    });
    await runCommand(f.pool, { partition: a.partition, deadline: context.deadline }, async (tx) => {
      expect(isHeldCommittedIdentityScopeReceipt(tx, released)).toBe(false);
      return noEffect(null);
    });
  });
}, 120000);

test('initial held verification retains both capture association and its native component locks', async () => {
  const s = await fundedInitial();
  const a = identityScopeAddress(s.key);
  const capture = (await associationsFor(s.locator)).find((row) => row.phase === 'capture' && row.scan_complete);
  if (!capture) throw new Error('Completed capture association absent');
  await frame(async (context) => {
    await runCommand(f.pool, { partition: a.partition, deadline: context.deadline }, async (tx) => {
      const held = await holdCommittedIdentityScopeReceipt(tx, f.pool, { evidence: s.evidence, context });
      expect(held.status).toBe('held');
      for (const statement of [
        {
          sql: `UPDATE semantic.identity_scope_native_association SET scan_complete=false
            WHERE partition_no=$1 AND source_key=$2 AND scope_id=$3 AND registration=$4
            AND capture_id=$5 AND revision=$6 AND phase='capture'`,
          values: [a.partition, a.source, a.scope, s.locator.registration, capture.capture_id, capture.revision],
        },
        {
          sql: `UPDATE semantic.identity_epoch_native_commit SET purpose='identity-scope-enrollment'
            WHERE partition_no=$1 AND transaction_id=$2`,
          values: [a.partition, capture.transaction_id],
        },
      ]) {
        const competing = await f.admin.connect();
        try {
          await competing.query('BEGIN');
          await competing.query("SET LOCAL lock_timeout = '30ms'");
          await expect(competing.query(statement.sql, statement.values)).rejects.toThrow();
        } finally {
          await competing.query('ROLLBACK');
          competing.release();
        }
      }
      expect(isHeldCommittedIdentityScopeReceipt(tx, held)).toBe(true);
      return noEffect(null);
    });
  });
}, 120000);

test('native association package refuses an attributed command before an unpriced basis write', async () => {
  const s = await fundedInitial();
  const address = identityScopeAddress(s.key);
  const actor = await f.actor();
  const before = await associationsFor(s.locator);
  let transactionId: string | undefined;
  await frame(async (context) => {
    const token = prepayIdentityScopeNativeAssociation(f.pool, context.deadline);
    await expect(
      runCommand(
        f.pool,
        {
          partition: address.partition,
          deadline: token.deadline,
          basis: { actorAccountId: actor.accountId, clientId: actor.clientId, requestedBy: actor.requestedBy },
        },
        async (tx) => {
          transactionId = currentCommand(tx).transactionId;
          bindIdentityScopeNativeAssociation(tx, token);
          throw new Error('Attributed association must refuse before the writer body');
        },
      ),
    ).rejects.toMatchObject({ code: 'dependency_unavailable' });
  });
  expect(transactionId).toBeDefined();
  expect(
    (
      await f.admin.query(
        `SELECT 1 FROM editorial.write_basis
    WHERE partition_no=$1 AND transaction_id=$2`,
        [address.partition, transactionId],
      )
    ).rowCount,
  ).toBe(0);
  expect(await associationsFor(s.locator)).toEqual(before);
}, 120000);

test('invalid native routes and schema scalars refuse before charging or querying', async () => {
  const s = await fundedInitial();
  await frame(async (context) => {
    const work = identitySourceConsumerLibraryWork(f.pool, context.identityConsumerWork, context.deadline)!;
    const before = work.receipt();
    for (const [field, value] of [
      ['route', -1],
      ['route', 65536],
      ['ownerEpoch', 2147483648],
      ['generation', '-1'],
      ['receivingEpoch', '0'],
    ] as const) {
      const locator = structuredClone(s.locator);
      Object.assign(locator.expected.key.source.identity, { [field]: value });
      expect(await resolveCommittedIdentityScopeReceipt(f.pool, { locator, context })).toMatchObject({
        status: 'unavailable',
        reason: 'source_binding',
      });
    }
    const locator = structuredClone(s.locator);
    Object.assign(locator.expected.key, { scopeId: 'x'.repeat(257) });
    expect(await resolveCommittedIdentityScopeReceipt(f.pool, { locator, context })).toMatchObject({
      status: 'unavailable',
      reason: 'source_binding',
    });
    expect(work.receipt()).toEqual(before);
  });
}, 120000);
