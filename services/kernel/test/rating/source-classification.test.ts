import { expect, test } from 'bun:test';
import {
  classificationObservation,
  validateClassificationObservation,
  type ClassificationAssociation,
} from '../../src/rating/source-classification-contract.ts';
import { admitClassificationObservation } from '../../src/rating/source-classification.ts';
import { Compile } from 'typebox/compile';
import {
  SourceClassificationPutInputSchema,
  SourceClassificationClearInputSchema,
  SourceClassificationPutSchema,
  SourceClassificationClearResultSchema,
} from '../../src/rating/source-classification-http.ts';

const association: ClassificationAssociation = {
  subjectId: '00000000-0000-8000-8000-000000000001',
  candidateId: '00000000-0000-8000-8000-000000000002',
  contextId: '00000000-0000-8000-8000-000000000000',
  targetId: '00000000-0000-8000-8000-000000000003',
  property: 'wdt:P136',
  revision: 1,
  release: `sha256:${'a'.repeat(64)}`,
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

test('mounted commands retain canonical release identities, exact CAS and both source mutation states', () => {
  const put = Compile(SourceClassificationPutInputSchema);
  const clear = Compile(SourceClassificationClearInputSchema);
  const input = { association, value, expectedObservation: null };
  expect(put.Check(input)).toBe(true);
  expect(put.Check({ ...input, association: { ...association, release: 'a'.repeat(64) } })).toBe(false);
  for (const expectedObservation of ['', 'a'.repeat(63), 'a'.repeat(65), undefined])
    expect(put.Check({ ...input, expectedObservation })).toBe(false);
  expect(put.Check({ ...input, expectedObservation: 'a'.repeat(64) })).toBe(true);
  const observation = classificationObservation(association, { ...value, confidenceCount: 0, lieCount: 0 });
  expect(observation.payload).toMatchObject({ confidenceCount: 0, lieCount: 0, lie: false });
  const cleared = { sourceAlias: 'vndb', sourceRecordId: 'v17', sourceAssociationId: 'g123', asOf: value.asOf, cleared: true };
  expect(clear.Check({ ...input, value: cleared })).toBe(true);
  const mutation = Compile(SourceClassificationClearResultSchema);
  const states = SourceClassificationPutSchema.properties.state;
  for (const state of ['published', 'cleared']) {
    expect(mutation.Check({ state, observationDigest: observation.digest })).toBe(true);
    expect(Compile(states).Check(state)).toBe(true);
  }
});
