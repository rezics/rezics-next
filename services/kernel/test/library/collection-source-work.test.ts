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
