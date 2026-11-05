import { expect, test } from 'bun:test';
import { createCommandWorkAssociation, withCommandWorkAssociation } from '../../src/library/command-work.ts';
import type { WorkDimensions } from '../../src/library/collection-source.ts';
import { NativeCollectionWork } from '../../src/library/collection-source-work.ts';
import { EMPTY_ACCESS_WORK } from '../../src/work/access-work.ts';

const bound: WorkDimensions = Object.freeze({
  candidateKeys: 5,
  nativeRows: 10,
  identityMetadataRows: 0,
  emptySeeks: 4,
  nativePoints: 4,
  witnessKeys: 2,
  statements: 5,
  bytes: 2048,
});

function association(capacity: WorkDimensions) {
  const deadline = Date.now() + 10_000;
  const work = new NativeCollectionWork({ reservationId: 'source-ledger-test', remaining: capacity }, deadline);
  return createCommandWorkAssociation(work, deadline, capacity);
}

test('Kind command Access work reserves against the same Source frame', async () => {
  const frame = association(bound);
  const accessBound = { keys: 2, rows: 3, points: 1, witnesses: 1, emptySeeks: 1, bytes: 128 };
  const accessActual = { ...accessBound };

  await withCommandWorkAssociation(frame, async () => {
    await frame.access.run(
      'kind audience access',
      accessBound,
      async () => 'captured',
      () => accessActual,
    );
    const source = frame.reserve('kind origin bind', {
      candidateKeys: 1,
      nativeRows: 2,
      identityMetadataRows: 0,
      emptySeeks: 0,
      nativePoints: 1,
      witnessKeys: 0,
      statements: 1,
      bytes: 256,
    });
    source.settle();
  });

  expect(frame.receipt().used).toEqual({
    candidateKeys: 3,
    // The parent Source ledger cannot refund the dispatched outer row plan.
    nativeRows: bound.nativeRows,
    identityMetadataRows: 0,
    emptySeeks: 1,
    nativePoints: 2,
    witnessKeys: 1,
    statements: 1,
    bytes: 384,
  });
  expect(frame.access.usage()).toEqual(accessActual);
  expect(EMPTY_ACCESS_WORK).toEqual({ keys: 0, points: 0, witnesses: 0, rows: 0, bytes: 0, emptySeeks: 0 });
});

test('Kind command work refuses an undeclared child before its dispatch', async () => {
  const frame = association(bound);
  let dispatched = false;
  await expect(
    withCommandWorkAssociation(frame, () =>
      frame.access.run(
        'oversized kind audience access',
        { keys: 6, rows: 0, points: 0, witnesses: 0, bytes: 0, emptySeeks: 0 },
        async () => {
          dispatched = true;
          return true;
        },
      ),
    ),
  ).rejects.toThrow();
  expect(dispatched).toBe(false);
  expect(frame.receipt().used).toEqual({
    candidateKeys: 0,
    nativeRows: bound.nativeRows,
    identityMetadataRows: 0,
    emptySeeks: 0,
    nativePoints: 0,
    witnessKeys: 0,
    statements: 0,
    bytes: 0,
  });
});

test('Access owner receipts do not refund Source plan rows after dispatch', async () => {
  const frame = association(bound);
  const accessBound = { keys: 1, rows: 4, points: 1, witnesses: 0, emptySeeks: 0, bytes: 64 };
  await withCommandWorkAssociation(frame, () =>
    frame.access.run(
      'kind owner branch',
      accessBound,
      async () => undefined,
      () => ({ ...accessBound, rows: 1 }),
      'owner',
    ),
  );

  expect(frame.access.usage()).toEqual({ ...accessBound, rows: 1 });
  expect(frame.receipt().used).toEqual({
    candidateKeys: 1,
    nativeRows: bound.nativeRows,
    identityMetadataRows: 0,
    emptySeeks: 0,
    nativePoints: 1,
    witnessKeys: 0,
    statements: 0,
    bytes: 64,
  });
});

test('Kind command work refuses before reserving when the producer has no initial envelope', () => {
  const deadline = Date.now() + 10_000;
  const work = new NativeCollectionWork({ reservationId: 'source-ledger-test', remaining: bound }, deadline);
  expect(() => createCommandWorkAssociation(work, deadline, undefined)).toThrow();
});

test('the request frame settles only after awaited work finishes and rejects later dispatches', async () => {
  const frame = association(bound);
  const result = await withCommandWorkAssociation(frame, async () => {
    await frame.run(
      'kind request operation',
      { ...bound, nativeRows: 1 },
      async () => 'done',
      () => ({ ...bound, nativeRows: 1 }),
    );
    return 'complete';
  });

  expect(result).toBe('complete');
  await expect(
    Promise.resolve().then(() => frame.run('late operation', { ...bound, nativeRows: 1 }, async () => 'late')),
  ).rejects.toThrow();
});

test('Kind command work rejects structural funding and an extended native deadline', () => {
  const deadline = Date.now() + 10_000;
  const work = new NativeCollectionWork({ reservationId: 'source-ledger-test', remaining: bound }, deadline);
  expect(() => createCommandWorkAssociation(work, deadline + 1, bound)).toThrow();
  expect(() => createCommandWorkAssociation({ ...work } as NativeCollectionWork, deadline, bound)).toThrow();
  expect(work.receipt().used.nativeRows).toBe(0);
});
