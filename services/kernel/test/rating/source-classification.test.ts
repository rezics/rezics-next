import { expect, test } from 'bun:test';
import {
  classificationObservation,
  validateClassificationObservation,
  type ClassificationAssociation,
} from '../../src/rating/source-classification-contract.ts';
import { admitClassificationObservation } from '../../src/rating/source-classification.ts';

const association: ClassificationAssociation = {
  subjectId: '00000000-0000-8000-8000-000000000001',
  candidateId: '00000000-0000-8000-8000-000000000002',
  contextId: '00000000-0000-8000-8000-000000000000',
  targetId: '00000000-0000-8000-8000-000000000003',
  property: 'wdt:P136',
  revision: 1,
  release: 'a'.repeat(64),
  qualifiersDigest: 'b'.repeat(64),
};
const value = {
  sourceAlias: 'vndb',
  sourceRecordId: 'v17',
  sourceAssociationId: 'g123',
  confidence: 2.4,
  lie: false,
  asOf: '2026-11-03T00:00:00.000Z',
  sourceVersion: { kind: 'unversioned' as const, digest: 'c'.repeat(64) },
  attribution: 'VNDB',
  licence: 'permitted-fixture',
};

test('imported confidence and lie retain exact provenance without inventing voters or counts', () => {
  validateClassificationObservation(value);
  const observation = classificationObservation(association, value);
  expect(observation.payload).toEqual(value);
  expect(observation.payload).not.toHaveProperty('count');
  expect(classificationObservation({ ...association, revision: 2 }, value).digest).not.toBe(observation.digest);
  expect(classificationObservation({ ...association, contextId: association.targetId }, value).digest).not.toBe(
    observation.digest,
  );
  for (const extra of [{ voterId: association.targetId }, { probability: 0.8 }, { stars: 3 }, { count: 0 }])
    expect(() => validateClassificationObservation({ ...value, ...extra })).toThrow();
  for (const invalid of [{ confidence: 0 }, { confidence: 3.1 }, { lie: 1 }, { confidenceCount: -1 }])
    expect(() => validateClassificationObservation({ ...value, ...invalid })).toThrow();
});

test('immutable replay, explicit CAS, stale and rebound observations use independent source heads', () => {
  const first = classificationObservation(association, value);
  expect(admitClassificationObservation(first, null, null)).toBe('changed');
  expect(admitClassificationObservation(first, first, null)).toBe('identical');
  const correction = classificationObservation(association, { ...value, confidence: 1.2 });
  expect(() => admitClassificationObservation(correction, first, null)).toThrow();
  expect(admitClassificationObservation(correction, first, first.digest)).toBe('changed');
  const older = classificationObservation(association, { ...value, asOf: '2026-11-02T00:00:00.000Z' });
  expect(() => admitClassificationObservation(older, first, first.digest)).toThrow();
  const cleared = classificationObservation(association, {
    sourceAlias: value.sourceAlias,
    sourceRecordId: value.sourceRecordId,
    sourceAssociationId: value.sourceAssociationId,
    asOf: '2026-11-04T00:00:00.000Z',
    cleared: true,
  });
  expect(() => admitClassificationObservation(first, cleared, cleared.digest)).toThrow();
});
