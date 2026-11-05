import { expect, test } from 'bun:test';
import { BOUND_AXES } from '@rezics/bounds';
import { ordinaryCollectionPagePlan, ordinaryPageWorkDimensions } from '../../src/library/ordinary-read-bounds.ts';

test('ordinary Collection page declarations stay fixed while legacy remaining arithmetic changes', () => {
  const first = ordinaryCollectionPagePlan(20);
  const misleadingLegacyRemaining = { candidateKeys: 0, nativeRows: 1 };
  expect(misleadingLegacyRemaining.candidateKeys).toBe(0);
  expect(ordinaryCollectionPagePlan(20)).toEqual(first);
  expect(first).toMatchObject({ rounds: 3, prefixGroupLimit: 41, driverCount: 6, aliasLimit: 100 });
  expect(first.candidateLimit).toBe(Math.min(600, 6 * 20 + 3));
  expect(Object.keys(first.total).sort()).toEqual([...BOUND_AXES].sort());
  expect(ordinaryPageWorkDimensions(first.total)).toEqual({
    candidateKeys: first.total.candidateKeys,
    nativeRows: first.total.nativeRows,
    identityMetadataRows: first.total.identityMetadataRows,
    emptySeeks: first.total.emptySeeks,
    nativePoints: first.total.nativePoints,
    witnessKeys: first.total.witnessKeys,
    statements: first.total.statements,
    bytes: first.total.bytes,
  });
});

test('FULL facts add a bounded per-member declaration and still fit the finite maximum', () => {
  const basic = ordinaryCollectionPagePlan(100);
  const full = ordinaryCollectionPagePlan(100, 'FULL');
  expect(full.total.candidateKeys).toBe(basic.total.candidateKeys + 100);
  expect(full.total.engineRequests).toBe(0);
  expect(() => ordinaryCollectionPagePlan(101)).toThrow(RangeError);
  expect(() => ordinaryPageWorkDimensions({ ...full.total, engineRequests: 1 })).toThrow(
    'Ordinary Collection page cannot map engine requests to the native SQL observer',
  );
});
