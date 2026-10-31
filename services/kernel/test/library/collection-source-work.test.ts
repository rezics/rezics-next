import { expect, test } from 'bun:test';
import { NativeCollectionWork } from '../../src/library/collection-source-work.ts';
import type { WorkDimensions } from '../../src/library/collection-source.ts';
const footprint: WorkDimensions = {
  candidateKeys: 2,
  identityMetadataRows: 3,
  nativeRows: 19,
  nativePoints: 5,
  witnessKeys: 7,
  statements: 11,
  bytes: 13,
  emptySeeks: 17,
};
const ledger = (remaining = footprint) =>
  new NativeCollectionWork({ reservationId: 'native-reservation', remaining }, Date.now() + 30000);
test('native reservations independently admit every axis before dispatch and settle failed work bounds', () => {
  for (const axis of Object.keys(footprint) as (keyof WorkDimensions)[]) {
    const work = ledger({ ...footprint, [axis]: footprint[axis] - 1 });
    expect(() => work.reserve(footprint)).toThrow();
    expect(Object.values(work.receipt().used).every((value) => value === 0)).toBe(true);
  }
  const work = ledger();
  const reserved = work.reserve(footprint);
  expect(() => work.reserve(footprint)).toThrow();
  reserved.cancel();
  const dispatched = work.reserve(footprint);
  dispatched.dispatch();
  expect(() => dispatched.cancel()).toThrow();
  expect(() => dispatched.settle({ nativeRows: 0 })).toThrow();
  dispatched.settle();
  expect(work.receipt().used).toEqual(footprint);
  expect(() => dispatched.settle()).toThrow();
});
test('unknown native footprints and expired admissions cannot dispatch or consume work', () => {
  const work = ledger();
  expect(() => work.reserve(undefined)).toThrow();
  expect(work.available('nativeRows')).toBe(19);
  const expired = new NativeCollectionWork({ reservationId: 'expired', remaining: footprint }, Date.now() - 1);
  expect(() => expired.reserve(footprint)).toThrow();
  expect(Object.values(expired.receipt().used).every((value) => value === 0)).toBe(true);
});

test('a later invalid compose ceiling leaves every parent axis available without dispatch', async () => {
  const work = ledger();
  let dispatched = false;
  await expect(
    work.compose(
      async (allowance) => {
        dispatched = true;
        return { work: { reservationId: allowance.reservationId, used: allowance.remaining } };
      },
      { ...footprint, emptySeeks: -1 },
    ),
  ).rejects.toThrow('Invalid composed source work ceiling');
  expect(dispatched).toBe(false);
  for (const axis of Object.keys(footprint) as (keyof WorkDimensions)[]) {
    expect(work.available(axis)).toBe(footprint[axis]);
    expect(work.receipt().used[axis]).toBe(0);
  }
  // Validation failure must also leave the parent usable for its original reservation.
  const reservation = work.reserve(footprint);
  reservation.dispatch();
  reservation.settle();
  expect(work.receipt().used).toEqual(footprint);
});

test('compose snapshots each child ceiling once and retains failed child charges in the same reservation', async () => {
  const work = ledger();
  const reads = new Map<string, number>();
  const ceiling = Object.defineProperties(
    {},
    Object.fromEntries(
      Object.entries(footprint).map(([axis, value]) => [
        axis,
        {
          enumerable: true,
          get: () => {
            reads.set(axis, (reads.get(axis) ?? 0) + 1);
            return Math.floor(value / 2);
          },
        },
      ]),
    ),
  ) as WorkDimensions;
  const childBound = { ...footprint };
  for (const axis of Object.keys(footprint) as (keyof WorkDimensions)[])
    childBound[axis] = Math.floor(childBound[axis] / 2);
  const failure = new Error('child unavailable before returning its receipt');
  await expect(
    work.compose(async (allowance) => {
      expect(allowance.reservationId).toBe('native-reservation');
      expect(allowance.remaining).toEqual(childBound);
      for (const axis of Object.keys(footprint) as (keyof WorkDimensions)[])
        expect(work.available(axis)).toBe(footprint[axis] - childBound[axis]);
      throw failure;
    }, ceiling),
  ).rejects.toBe(failure);
  expect([...reads.values()]).toEqual(Object.keys(footprint).map(() => 1));
  expect(work.receipt()).toEqual({ reservationId: 'native-reservation', used: childBound });
  expect(() => work.assertReady()).toThrow(failure.message);
});
