import { expect, test } from 'bun:test';
import { observationDigest } from '../../../importer/src/source-observation.ts';
import { sourceObservation } from '../../src/rating/source-provider.ts';

const subjectId = '00000000-0000-4000-8000-000000000101';
const value = {
  sourceRecordId: 'v123',
  scale: { min: 1, max: 10 },
  mean: 7.35,
  count: 20,
  asOf: '2026-10-25',
  licence: 'ODbL-1.0',
  attribution: 'VNDB',
};

test('importer observation digests are the mounted sourceObservation helper', () => {
  expect(observationDigest(subjectId, value)).toBe(sourceObservation(subjectId, 'vndb', value).digest);
  expect(observationDigest(subjectId, { ...value, expectedObservation: 'a'.repeat(64) } as typeof value)).toBe(
    sourceObservation(subjectId, 'vndb', { ...value, expectedObservation: 'a'.repeat(64) }).digest,
  );
});
