import { expect, test } from 'bun:test';
import { sourceDigest } from '@rezics/conversion/support';
import {
  emptyCrossMediaPlan,
  showcaseDigest,
  showcaseLimits,
  showcasePlanRecordDigest,
} from '../src/showcase-contract.ts';
import { showcasePlanDigest } from '../src/showcase-manifest.ts';

test('selected publication digest and empty plan load from the owner-local contract', () => {
  const plan = emptyCrossMediaPlan();
  expect(plan.records.bangumi).toEqual([]);
  expect(plan.entities.vndb).toEqual([]);
  expect(showcaseLimits.records).toBe(768);
  const digest = showcaseDigest({ records: plan.records, entities: plan.entities });
  expect(digest).toBe(showcaseDigest({ records: plan.records, entities: plan.entities }));
  expect(digest).not.toBe(sourceDigest({ records: plan.records, entities: plan.entities }));
  expect(showcasePlanRecordDigest(plan)).toEqual({
    records: { bangumi: [], vndb: [] },
    entities: { bangumi: [], vndb: [] },
  });
  expect(showcasePlanDigest(plan).length).toBe(64);
});
