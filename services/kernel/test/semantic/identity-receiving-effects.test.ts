import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { noEffect, runCommand } from '../../src/command/command.ts';
import { IDENTITY_EPOCH_ADMITTED } from '../../src/events/contracts/semantic.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import {
  captureIdentityReceivingSource,
  lookupIdentityReceivingEffect,
  prepareIdentityReceivingEffect,
  readIdentityReceivingSelection,
  type IdentityReceivingSelection,
} from '../../src/semantic/identity-receiving-effects.ts';
import { admittedReceivingJob } from './support/identity-receiving-effects.ts';
import { duringNativeSQL, observeCutoverSQL } from './support/identity-epoch-cutover.ts';
import { epochFixture, home, type EpochFixture } from './support/identity-epoch.ts';

let f: EpochFixture;
beforeAll(async () => {
  f = await epochFixture();
});
afterAll(async () => {
  await f?.close();
});
const context = () => ({ deadline: Date.now() + 5000 });

/** The existing receiving fixture's real Source capture and preparation, without fixture-written proof. */
async function capturedSelection() {
  const input = await admittedReceivingJob(f);
  const route = routeOf(input.library.collection.id)!;
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
    effectKey: 'expected-native-selection',
    disposition: 'NEW' as const,
  };
  const identity = {
    route,
    collectionId: input.library.collection.id,
    ...source,
    scope: 'curated' as const,
    ownerEpoch: partition.epoch,
    receivingEpoch: input.job.epoch.toString(),
    effectKey: '',
  };
  const work = () => ({
    ...context(),
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
  });
  let capture = await captureIdentityReceivingSource(f.pool, selection, {
    identity,
    frontier: null,
    limit: 100,
    ...work(),
  });
  for (let page = 0; capture.status === 'pending' && page < 32; page++) {
    capture = await captureIdentityReceivingSource(f.pool, selection, {
      identity,
      frontier: capture.frontier,
      limit: 100,
      ...work(),
    });
  }
  if (capture.status !== 'complete') throw new Error('Finite native Source capture did not complete');
  const frontier = (
    await f.admin.query(
      `SELECT capture_id AS "captureId",driver,after_key AS after,tie,session_id AS "sessionId",
        scanned::text,version FROM library.native_source_capture WHERE route=$1 AND capture_id=$2`,
      [route, capture.capture.captureId],
    )
  ).rows[0]!;
  return { ...input, selection: { ...selection, capture: { identity: capture.capture.identity, frontier } } };
}

test('A native expected Source selection resolves its actual committed receiving record by full scope binding without caller receipt proof or new admission', async () => {
  const { selection, members } = await capturedSelection();
  expect(await readIdentityReceivingSelection(f.pool, selection, context())).toBeNull();
  const effect = await prepareIdentityReceivingEffect(f.pool, selection);
  const expected = await runCommand(f.pool, { partition: effect.receipt.partition }, async (tx) =>
    noEffect(await lookupIdentityReceivingEffect(tx, effect)),
  );
  const before = await members();
  const observed = await observeCutoverSQL(f, () => readIdentityReceivingSelection(f.pool, selection, context()));
  expect(observed.value).toEqual(expected.value);
  expect(observed.value?.receipt).toEqual(effect.receipt);
  expect(observed.value?.applied).toBeNull();
  expect(observed.queries.some(({ sql }) => /^\s*(INSERT|UPDATE|DELETE)\b/i.test(sql))).toBe(false);
  expect(observed.queries.some(({ sql }) => /native_source_hold/.test(sql))).toBe(true);
  const native = selection.capture.identity;
  const invalid: IdentityReceivingSelection[] = [
    { ...selection, job: { ...selection.job, jobId: newId(routeOf(selection.job.jobId)!) } },
    { ...selection, job: { ...selection.job, epoch: selection.job.epoch + 1n } },
    { ...selection, original: newId(routeOf(selection.original)!) },
    { ...selection, effectKey: `${selection.effectKey}-other` },
    { ...selection, owner: newId(routeOf(selection.owner)!) },
    { ...selection, sourceId: newId(routeOf(selection.sourceId)!) },
    { ...selection, scope: `${selection.scope}-other` },
    { ...selection, disposition: 'OLD' },
    {
      ...selection,
      capture: { ...selection.capture, frontier: { ...selection.capture.frontier, captureId: randomUUID() } },
    },
    ...[
      { incarnation: `${native.incarnation}-other` },
      { generation: (BigInt(native.generation) + 1n).toString() },
      { ownerEpoch: native.ownerEpoch + 1 },
      { receivingEpoch: (selection.job.epoch + 1n).toString() },
      { accountId: newId(routeOf(native.accountId)!) },
      { effectKey: 'uncommitted-native-key' },
      { route: native.route + 1 },
    ].map((change) => ({ ...selection, capture: { ...selection.capture, identity: { ...native, ...change } } })),
  ];
  for (const changed of invalid) expect(await readIdentityReceivingSelection(f.pool, changed, context())).toBeNull();
  // A supplied count grants nothing; the retained native rows remain the proof.
  expect(
    await readIdentityReceivingSelection(
      f.pool,
      {
        ...selection,
        capture: { ...selection.capture, frontier: { ...selection.capture.frontier, scanned: '999999999' } },
      },
      context(),
    ),
  ).toEqual(expected.value);
  // Revalidation retains the original capture generation rather than acquiring fresh Source custody.
  await f.admin.query(
    'UPDATE library.collection SET source_generation=source_generation+1 WHERE route=$1 AND collection_id=$2',
    [native.route, native.collectionId],
  );
  expect(await readIdentityReceivingSelection(f.pool, selection, context())).toEqual(expected.value);
  expect(await members()).toEqual(before);
  expect(f.pool.totalCount - f.pool.idleCount).toBe(0);
});

test('an uncommitted native receiving preparation supplies no selection proof and a committed retry resolves its original receipt', async () => {
  const { selection } = await capturedSelection();
  const effect = await duringNativeSQL(
    f,
    /INSERT INTO semantic.identity_epoch_receiving_record/,
    () => prepareIdentityReceivingEffect(f.pool, selection),
    async () => {
      // The pending writer owns the partition fence. Its uncommitted native receipt is unavailable.
      await expect(
        readIdentityReceivingSelection(f.pool, selection, { deadline: Date.now() + 50 }),
      ).rejects.toMatchObject({ code: 'identity_epoch_unavailable' });
    },
  );
  expect((await readIdentityReceivingSelection(f.pool, selection, context()))?.receipt).toEqual(effect.receipt);
});

test('missing native capture and released retained custody stay unavailable without fabricating receiving records', async () => {
  const { selection } = await capturedSelection();
  const { capture: _capture, ...withoutCapture } = selection;
  await expect(readIdentityReceivingSelection(f.pool, withoutCapture, context())).rejects.toMatchObject({
    code: 'identity_epoch_unavailable',
  });
  await prepareIdentityReceivingEffect(f.pool, selection);
  const record = await readIdentityReceivingSelection(f.pool, selection, context());
  expect(record).not.toBeNull();
  const { createNativeLibrarySourceCustody } = await import('../../src/library/native-source-custody.ts');
  const { currentCommand, currentCommandResources } = await import('../../src/command/command.ts');
  await runCommand(f.pool, { partition: record!.receipt.partition }, async (tx) => {
    const released = await createNativeLibrarySourceCustody({ pool: f.pool }).releaseHold({
      client: tx,
      at: currentCommand(tx).time,
      ...record!.source.native,
      deadline: currentCommandResources(tx).deadline,
      allowance: {
        reservationId: randomUUID(),
        remaining: {
          candidateKeys: 0,
          identityMetadataRows: 0,
          nativeRows: 512,
          nativePoints: 32,
          witnessKeys: 0,
          statements: 16,
          bytes: 262144,
          emptySeeks: 0,
        },
      },
    });
    expect(released.status).toBe('released');
    return {
      value: null,
      events: [
        {
          type: IDENTITY_EPOCH_ADMITTED,
          data: {
            jobId: selection.job.jobId,
            epoch: selection.job.epoch.toString(),
            partition: home(selection.job.jobId),
          },
        },
      ],
    };
  });
  await expect(readIdentityReceivingSelection(f.pool, selection, context())).rejects.toMatchObject({
    code: 'identity_epoch_unavailable',
  });
});
