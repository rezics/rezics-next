import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { noEffect, runCommand } from '../../src/command/command.ts';
import { newId } from '../../src/route/route.ts';
import { identityEpochStore as store } from '../../src/semantic/identity-epoch-store.ts';
import { epochFixture, home, type EpochFixture } from './support/identity-epoch.ts';
import { admittedReceivingJob, completeReceivingParticipant } from './support/identity-receiving-effects.ts';

let f: EpochFixture;
beforeAll(async () => {
  f = await epochFixture();
});
afterAll(async () => {
  await f?.close();
});

test('real native receiving-home admission permits the fixed participant owned effect and preserves source control custody', async () => {
  const input = await admittedReceivingJob(f);
  expect(home(input.original)).not.toBe(home(input.library.collection.id));
  const before = await input.members();
  const progress = await completeReceivingParticipant(f, input.job);
  const accepted = await store().reconcileStepReceipt(f.pool, progress.receipt);
  expect(accepted).toEqual(progress);
  expect(await store().reconcileStepReceipt(f.pool, progress.receipt)).toEqual(accepted);
  expect(await input.members()).toEqual(before);
  expect((await store().readJob(f.pool, input.job))?.participants['library-private-follow-counts']).toEqual(accepted);
  // Library completion cannot fabricate the separate mapping and Search acknowledgements.
  await expect(
    runCommand(f.pool, { partition: home(input.job.jobId) }, (tx) => store().publish(tx, input.job)),
  ).rejects.toMatchObject({ code: 'identity_participants_incomplete' });
  for (const receipt of [
    { ...progress.receipt, job: { ...input.job, jobId: newId(0x8b10) } },
    { ...progress.receipt, native: { ...progress.receipt.native, transactionId: randomUUID() } },
    { ...progress.receipt, native: { ...progress.receipt.native, epoch: progress.receipt.native.epoch + 1 } },
  ])
    await expect(store().reconcileStepReceipt(f.pool, receipt)).rejects.toMatchObject({
      code: 'identity_step_receipt_invalid',
    });
});

test('a real admitted job and a platform command alone do not admit an unregistered receiving owner', async () => {
  const input = await admittedReceivingJob(f);
  const before = await input.members();
  await expect(
    runCommand(f.pool, { partition: home(input.library.collection.id) }, async (tx) => {
      await store().admitHomeEffect(tx, { kind: 'structural', original: input.original, job: input.job });
      throw new Error('unregistered receiving effect was admitted');
    }),
  ).rejects.toMatchObject({ code: 'identity_effect_stale' });
  await expect(
    runCommand(f.pool, { partition: home(input.library.collection.id) }, async (tx) => {
      await store().admitHomeEffect(tx, {
        kind: 'follow-count',
        original: input.original,
        terminal: input.terminal,
        epoch: input.job.epoch,
      });
      return noEffect(null);
    }),
  ).rejects.toMatchObject({ code: 'identity_effect_stale' });
  expect(await input.members()).toEqual(before);
});

test('an authentic native transaction cannot become receiving proof through the original-home structural branch', async () => {
  const input = await admittedReceivingJob(f);
  const before = await input.members();
  // A real command locator is deliberately NOT a receiving record. No fixture proof is inserted.
  const native = await runCommand(f.pool, { partition: home(input.original) }, async () => noEffect(null));
  const receiving = {
    kind: 'receiving' as const,
    original: input.original,
    job: input.job,
    effectKey: 'library-owner-rekey',
    receipt: {
      partition: native.partition,
      epoch: native.epoch,
      position: native.position,
      transactionId: native.transactionId,
    },
  };
  for (const partition of [home(input.original), home(input.library.collection.id)]) {
    for (const effect of [
      receiving,
      { ...receiving, job: { ...input.job, jobId: newId(0x8b20) } },
      { ...receiving, job: { ...input.job, epoch: input.job.epoch + 1n } },
      { ...receiving, effectKey: 'another-owner-rekey' },
      { ...receiving, receipt: { ...receiving.receipt, transactionId: randomUUID() } },
    ]) {
      await expect(
        runCommand(f.pool, { partition }, async (tx) => {
          await store().admitHomeEffect(tx, effect);
          return noEffect(null);
        }),
      ).rejects.toMatchObject({ code: 'identity_effect_stale' });
    }
  }
  expect(await input.members()).toEqual(before);
  expect((await store().readJob(f.pool, input.job))?.participants['library-private-follow-counts']).toBeNull();
  await expect(
    runCommand(f.pool, { partition: home(input.job.jobId) }, (tx) => store().publish(tx, input.job)),
  ).rejects.toMatchObject({ code: 'identity_participants_incomplete' });
});

// Product receiving admission, rather than a fixture-written grant, is the regression boundary.
test('a committed source-specific receiving record admits only its exact home job owner and effect', async () => {
  const { prepareIdentityReceivingEffect, lookupIdentityReceivingEffect } =
    await import('../../src/semantic/identity-receiving-effects.ts');
  const input = await admittedReceivingJob(f);
  const effect = await prepareIdentityReceivingEffect(f.pool, {
    job: input.job,
    original: input.original,
    owner: input.library.collection.id,
    sourceId: input.library.collection.id,
    scope: input.original,
    effectKey: 'library-owner-rekey',
    disposition: 'NEW',
  });
  const before = await input.members();
  const rollback = new Error('roll back after genuine receiving admission');
  await expect(
    runCommand(f.pool, { partition: effect.receipt.partition }, async (tx) => {
      const record = await lookupIdentityReceivingEffect(tx, effect);
      expect(record?.owner).toBe(input.library.collection.id);
      expect(record?.source.id).toBe(input.library.collection.id);
      await store().admitHomeEffect(tx, effect);
      throw rollback;
    }),
  ).rejects.toBe(rollback);
  for (const invalid of [
    { ...effect, effectKey: 'wrong-effect' },
    { ...effect, original: input.terminal },
    { ...effect, job: { ...effect.job, epoch: effect.job.epoch + 1n } },
    { ...effect, job: { ...effect.job, jobId: newId(0x8b30) } },
    { ...effect, receipt: { ...effect.receipt, epoch: effect.receipt.epoch + 1 } },
    { ...effect, receipt: { ...effect.receipt, transactionId: randomUUID() } },
  ])
    await expect(
      runCommand(f.pool, { partition: effect.receipt.partition }, async (tx) => {
        await store().admitHomeEffect(tx, invalid);
        return noEffect(null);
      }),
    ).rejects.toMatchObject({ code: 'identity_effect_stale' });
  await expect(
    runCommand(f.pool, { partition: home(input.original) }, async (tx) => {
      await store().admitHomeEffect(tx, effect);
      return noEffect(null);
    }),
  ).rejects.toMatchObject({ code: 'identity_effect_stale' });
  expect(await input.members()).toEqual(before);
  expect((await store().readJob(f.pool, input.job))?.participants['library-private-follow-counts']).toBeNull();
});

test('receiving source selection cannot be replaced with a different owner source or scope', async () => {
  const { prepareIdentityReceivingEffect } = await import('../../src/semantic/identity-receiving-effects.ts');
  const input = await admittedReceivingJob(f);
  const selected = {
    job: input.job,
    original: input.original,
    owner: input.library.collection.id,
    sourceId: input.library.collection.id,
    scope: input.original,
    effectKey: 'library-owner-rekey',
    disposition: 'NEW' as const,
  };
  for (const invalid of [
    { ...selected, owner: newId(0xac10) },
    { ...selected, sourceId: newId(0xac10) },
    { ...selected, scope: newId(0x8b40) },
    { ...selected, job: { ...input.job, jobId: newId(0x8b50) } },
    { ...selected, original: newId(0x8b60) },
  ])
    await expect(prepareIdentityReceivingEffect(f.pool, invalid)).rejects.toMatchObject({
      code: 'identity_effect_stale',
    });
});

test('preparing and cancelled native jobs cannot create a receiving record or open a pending gate', async () => {
  const { prepareIdentityReceivingEffect } = await import('../../src/semantic/identity-receiving-effects.ts');
  const { cancelIdentityEpochAdmission, stepIdentityEpochAdmission } =
    await import('../../src/semantic/identity-epoch-admission.ts');
  const input = await admittedReceivingJob(f, { pending: false });
  const selection = {
    job: input.job,
    original: input.original,
    owner: input.library.collection.id,
    sourceId: input.library.collection.id,
    scope: input.original,
    effectKey: 'library-owner-rekey',
    disposition: 'NEW' as const,
  };
  await expect(prepareIdentityReceivingEffect(f.pool, selection)).rejects.toMatchObject({
    code: 'identity_effect_stale',
  });
  await cancelIdentityEpochAdmission(f.pool, input.job);
  for (let step = 0; step < 8; step++) {
    if ((await stepIdentityEpochAdmission(f.pool, input.job)).state === 'cancelled') break;
  }
  expect((await store().readJob(f.pool, input.job))?.state).toBe('cancelled');
  await expect(prepareIdentityReceivingEffect(f.pool, selection)).rejects.toMatchObject({
    code: 'identity_effect_stale',
  });
  expect(
    (
      await f.admin.query(
        `SELECT 1 FROM semantic.identity_epoch_receiving_record
    WHERE partition_no=$1 AND job_id=$2`,
        [home(input.library.collection.id), input.job.jobId],
      )
    ).rows,
  ).toEqual([]);
});

test('an uncommitted receiving record cannot be observed and an interrupted delivery retains its exact native plan', async () => {
  const { prepareIdentityReceivingEffect } = await import('../../src/semantic/identity-receiving-effects.ts');
  const { duringNativeSQL, interruptNativeStatement } = await import('./support/identity-epoch-cutover.ts');
  const input = await admittedReceivingJob(f);
  const selection = {
    job: input.job,
    original: input.original,
    owner: input.library.collection.id,
    sourceId: input.library.collection.id,
    scope: input.original,
    effectKey: 'library-owner-rekey',
    disposition: 'NEW' as const,
  };
  await interruptNativeStatement(f, /INSERT INTO semantic.identity_epoch_receiving_record/, () =>
    prepareIdentityReceivingEffect(f.pool, selection),
  );
  const plans = async () =>
    (
      await f.admin.query(
        `SELECT binding_digest,transaction_id FROM semantic.identity_epoch_receiving_plan
    WHERE partition_no=$1 AND job_id=$2 AND effect_key=$3`,
        [home(input.job.jobId), input.job.jobId, selection.effectKey],
      )
    ).rows;
  const retained = await plans();
  expect(retained).toHaveLength(1);
  const effect = await duringNativeSQL(
    f,
    /INSERT INTO semantic.identity_epoch_receiving_record/,
    () => prepareIdentityReceivingEffect(f.pool, selection),
    async () => {
      expect(
        (
          await f.admin.query(
            `SELECT 1 FROM semantic.identity_epoch_receiving_record
        WHERE partition_no=$1 AND job_id=$2 AND effect_key=$3`,
            [home(input.library.collection.id), input.job.jobId, selection.effectKey],
          )
        ).rows,
      ).toEqual([]);
      await expect(
        runCommand(f.pool, { partition: home(input.job.jobId) }, (tx) => store().publish(tx, input.job)),
      ).rejects.toMatchObject({ code: 'identity_participants_incomplete' });
    },
  );
  expect(await plans()).toEqual(retained);
  expect(await prepareIdentityReceivingEffect(f.pool, selection)).toEqual(effect);
});

test('a moved receiving owner and a different admitted job cannot reuse the same native gate', async () => {
  const { prepareIdentityReceivingEffect } = await import('../../src/semantic/identity-receiving-effects.ts');
  const input = await admittedReceivingJob(f);
  const other = await admittedReceivingJob(f);
  const effect = await prepareIdentityReceivingEffect(f.pool, {
    job: input.job,
    original: input.original,
    owner: input.library.collection.id,
    sourceId: input.library.collection.id,
    scope: input.original,
    effectKey: 'library-owner-rekey',
    disposition: 'NEW',
  });
  await expect(
    runCommand(f.pool, { partition: effect.receipt.partition }, async (tx) => {
      await store().admitHomeEffect(tx, { ...effect, job: other.job });
      return noEffect(null);
    }),
  ).rejects.toMatchObject({ code: 'identity_effect_stale' });
  await f.admin.query("UPDATE core.partition SET write_state='moved',moved_to='receiving-test' WHERE partition_no=$1", [
    effect.receipt.partition,
  ]);
  try {
    await expect(
      runCommand(f.pool, { partition: effect.receipt.partition }, async (tx) => {
        await store().admitHomeEffect(tx, effect);
        return noEffect(null);
      }),
    ).rejects.toThrow();
  } finally {
    await f.admin.query("UPDATE core.partition SET write_state='active',moved_to=NULL WHERE partition_no=$1", [
      effect.receipt.partition,
    ]);
  }
  expect((await store().readJob(f.pool, input.job))?.participants['library-private-follow-counts']).toBeNull();
});

test('a crash after the physical receiving effect and before control custody never publishes early', async () => {
  const { interruptNativeStatement } = await import('./support/identity-epoch-cutover.ts');
  const input = await admittedReceivingJob(f);
  const before = await input.members();
  await interruptNativeStatement(f, /UPDATE semantic.identity_epoch_effect_receipt SET native_partition/, () =>
    completeReceivingParticipant(f, input.job),
  );
  expect(
    (
      await f.admin.query(
        `SELECT 1 FROM semantic.identity_epoch_receiving_effect
    WHERE partition_no=$1 AND job_id=$2 LIMIT 1`,
        [home(input.library.collection.id), input.job.jobId],
      )
    ).rows,
  ).toHaveLength(1);
  expect((await store().readJob(f.pool, input.job))?.participants['library-private-follow-counts']).toBeNull();
  await expect(
    runCommand(f.pool, { partition: home(input.job.jobId) }, (tx) => store().publish(tx, input.job)),
  ).rejects.toMatchObject({ code: 'identity_participants_incomplete' });
  const progress = await completeReceivingParticipant(f, input.job);
  expect(await store().reconcileStepReceipt(f.pool, progress.receipt)).toEqual(progress);
  expect(await store().reconcileStepReceipt(f.pool, progress.receipt)).toEqual(progress);
  expect(await input.members()).toEqual(before);
});

test('Independent Library owner effects bind the actual native Source capture and held receiving provenance without invented Source callbacks', async () => {
  const input = await admittedReceivingJob(f);
  const progress = await completeReceivingParticipant(f, input.job);
  await store().reconcileStepReceipt(f.pool, progress.receipt);
  const effects = (
    await f.admin.query(
      `SELECT r.binding,r.plan,r.source_hold,r.transaction_id AS accepted_transaction,
        c.epoch AS accepted_epoch,c.position AS accepted_position,
        e.transaction_id AS effect_transaction,s.frontier,s.scope_digest
      FROM semantic.identity_epoch_receiving_record r
      JOIN semantic.identity_epoch_native_commit c
        ON (c.partition_no,c.transaction_id)=(r.partition_no,r.transaction_id) AND c.xmin=r.xmin
      JOIN semantic.identity_epoch_receiving_effect e
        ON (e.partition_no,e.job_id,e.effect_key)=(r.partition_no,r.job_id,r.effect_key)
      JOIN semantic.identity_epoch_step s
        ON (s.partition_no,s.transaction_id)=(e.partition_no,e.transaction_id) AND s.xmin=e.xmin
      WHERE r.partition_no=$1 AND r.job_id=$2 AND r.job_epoch=$3`,
      [home(input.library.collection.id), input.job.jobId, input.job.epoch.toString()],
    )
  ).rows;
  expect(effects.length).toBeGreaterThan(0);
  for (const effect of effects) {
    const binding = effect.binding;
    expect(binding.job).toEqual({ jobId: input.job.jobId, epoch: input.job.epoch.toString() });
    expect(binding.step).toBe('library-private-follow-counts');
    expect(binding.version).toBe(1);
    expect(binding.scopeDigest).toBe(effect.scope_digest);
    expect(effect.source_hold).toEqual({
      partition: home(binding.owner),
      transactionId: effect.accepted_transaction,
      epoch: effect.accepted_epoch,
      position: effect.accepted_position,
    });
    const { identity, captureId, holdId } = binding.source.native;
    const native = (
      await f.admin.query(
        `SELECT c.collection_id,c.account_id,c.incarnation,c.generation::text,c.scope,
          c.owner_epoch,c.receiving_epoch::text,c.effect_key,c.complete,
          r.transaction_id,r.position::text,h.released,
          jsonb_build_object('captureId',c.capture_id,'driver',c.driver,'after',c.after_key,
            'tie',c.tie,'sessionId',c.session_id,'scanned',c.scanned::text,'version',c.version) AS frontier
        FROM library.native_source_capture c
        JOIN library.native_source_receipt r ON (r.route,r.capture_id)=(c.route,c.capture_id) AND r.xmin=c.xmin
        JOIN library.native_source_hold h ON (h.route,h.capture_id,h.transaction_id)=(c.route,c.capture_id,r.transaction_id)
        WHERE c.route=$1 AND c.capture_id=$2 AND h.hold_id=$3`,
        [identity.route, captureId, holdId],
      )
    ).rows;
    expect(native).toHaveLength(1);
    const { frontier, ...custody } = native[0]!;
    expect(custody).toEqual({
      collection_id: identity.collectionId,
      account_id: identity.accountId,
      incarnation: identity.incarnation,
      generation: identity.generation,
      scope: identity.scope,
      owner_epoch: identity.ownerEpoch,
      receiving_epoch: input.job.epoch.toString(),
      effect_key: identity.effectKey,
      complete: true,
      transaction_id: binding.source.provenance.transactionId,
      position: binding.source.provenance.position,
      released: true,
    });
    expect(identity.effectKey).toMatch(/^[0-9a-f]{64}$/);
    expect(identity.effectKey).not.toBe(binding.effectKey);
    const { prepareIdentityReceivingEffect } = await import('../../src/semantic/identity-receiving-effects.ts');
    const selection = {
      job: input.job,
      original: binding.original,
      owner: binding.owner,
      sourceId: binding.source.id,
      scope: binding.source.scope,
      disposition: binding.source.disposition,
      effectKey: binding.effectKey,
      capture: { identity, frontier },
    };
    const replayed = await prepareIdentityReceivingEffect(f.pool, selection);
    expect(replayed.receipt).toEqual({ ...effect.source_hold, position: BigInt(effect.source_hold.position) });
    for (const changed of [
      { ...selection, effectKey: `${selection.effectKey}-different` },
      { ...selection, disposition: selection.disposition === 'OLD' ? ('NEW' as const) : ('OLD' as const) },
    ])
      await expect(prepareIdentityReceivingEffect(f.pool, changed)).rejects.toMatchObject({
        code: 'identity_effect_stale',
      });
  }
});

test('receiving admission revalidates a retained native hold after live Source generation changes while fresh holds stay strict', async () => {
  const { captureIdentityReceivingSource, prepareIdentityReceivingEffect, lookupIdentityReceivingEffect } =
    await import('../../src/semantic/identity-receiving-effects.ts');
  const { createNativeLibrarySourceCustody } = await import('../../src/library/native-source-custody.ts');
  const { currentCommand } = await import('../../src/command/command.ts');
  const { routeOf } = await import('../../src/route/route.ts');
  const input = await admittedReceivingJob(f);
  const route = routeOf(input.library.collection.id)!;
  // These are lookup hints only; the real Source capture and receiving preparation validate them.
  const source = (
    await f.admin.query(
      `SELECT curator_account_id::text AS "accountId",
        collection_id::text || ':' || extract(epoch FROM created_at)::text AS incarnation,
        source_generation::text AS generation
      FROM library.collection WHERE route=$1 AND collection_id=$2`,
      [route, input.library.collection.id],
    )
  ).rows[0]!;
  const partition = (
    await f.admin.query('SELECT epoch FROM core.partition WHERE partition_no=$1', [home(input.library.collection.id)])
  ).rows[0]!;
  const selection = {
    job: input.job,
    original: input.original,
    owner: input.library.collection.id,
    sourceId: input.library.collection.id,
    scope: input.original,
    effectKey: 'retained-native-generation',
    disposition: 'NEW' as const,
  };
  const work = () => ({
    allowance: {
      reservationId: randomUUID(),
      remaining: {
        candidateKeys: 100,
        identityMetadataRows: 0,
        nativeRows: 4096,
        nativePoints: 64,
        witnessKeys: 0,
        statements: 32,
        bytes: 1048576,
        emptySeeks: 4,
      },
    },
    deadline: Date.now() + 5000,
  });
  const identity = {
    route,
    collectionId: input.library.collection.id,
    ...source,
    scope: 'curated' as const,
    ownerEpoch: partition.epoch,
    receivingEpoch: input.job.epoch.toString(),
    effectKey: '',
  };
  let capture = await captureIdentityReceivingSource(f.pool, selection, {
    identity,
    frontier: null,
    limit: 100,
    ...work(),
  });
  for (let page = 0; capture.status === 'pending' && page < 32; page++) {
    // The adapter derives the same fixed native identity key on every continuation.
    capture = await captureIdentityReceivingSource(f.pool, selection, {
      identity,
      frontier: capture.frontier,
      limit: 100,
      ...work(),
    });
  }
  expect(capture.status).toBe('complete');
  if (capture.status !== 'complete') throw new Error('Finite native Source capture did not complete');
  const frontier = (
    await f.admin.query(
      `SELECT capture_id AS "captureId",driver,after_key AS after,tie,session_id AS "sessionId",
        scanned::text,version FROM library.native_source_capture WHERE route=$1 AND capture_id=$2`,
      [route, capture.capture.captureId],
    )
  ).rows[0]!;
  const effect = await prepareIdentityReceivingEffect(f.pool, {
    ...selection,
    capture: { identity: capture.capture.identity, frontier },
  });
  const accepted = await runCommand(f.pool, { partition: effect.receipt.partition }, async (tx) =>
    noEffect(await lookupIdentityReceivingEffect(tx, effect)),
  );
  const record = accepted.value!;
  // Perturb only the business generation, never a capture, receipt, hold or receiving grant.
  await f.admin.query(
    'UPDATE library.collection SET source_generation=source_generation+1 WHERE route=$1 AND collection_id=$2',
    [route, input.library.collection.id],
  );
  const fresh = await runCommand(f.pool, { partition: effect.receipt.partition }, async (tx) =>
    noEffect(
      await createNativeLibrarySourceCustody({ pool: f.pool }).readAndHold({
        client: tx,
        at: currentCommand(tx).time,
        ...record.source.native,
        ...work(),
      }),
    ),
  );
  expect(fresh.value).toMatchObject({ status: 'unavailable', reason: 'binding' });
  const rollback = new Error('retained receiving admission reached; roll back before any effect');
  await expect(
    runCommand(f.pool, { partition: effect.receipt.partition }, async (tx) => {
      await store().admitHomeEffect(tx, effect);
      throw rollback;
    }),
  ).rejects.toBe(rollback);
  expect((await store().readJob(f.pool, input.job))?.participants['library-private-follow-counts']).toBeNull();
  expect(
    (
      await f.admin.query(
        'SELECT released FROM library.native_source_hold WHERE route=$1 AND capture_id=$2 AND hold_id=$3',
        [route, record.source.native.captureId, record.source.native.holdId],
      )
    ).rows,
  ).toEqual([{ released: false }]);
});
