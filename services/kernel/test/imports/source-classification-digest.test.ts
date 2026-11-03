import { expect, test } from 'bun:test';
import { projectSourceClassification } from '../../../../packages/conversion/src/index.ts';
import { classificationObservation } from '../../src/rating/source-classification-contract.ts';
import {
  classificationOperationDigest,
  classificationPayload,
  intendedFromProjection,
} from '../../../importer/src/source-classification.ts';

const association = {
  subjectId: '00000000-0000-4000-8000-000000000001',
  candidateId: '00000000-0000-4000-8000-000000000002',
  contextId: '00000000-0000-4000-8000-000000000000',
  targetId: '00000000-0000-4000-8000-000000000003',
  property: 'schema:keywords',
  revision: 1,
  release: 'a'.repeat(64),
  qualifiersDigest: 'b'.repeat(64),
};

test('importer classification digests are the mounted classificationObservation helper', () => {
  const projection = projectSourceClassification({
    sourceAlias: 'trusted-fixture',
    sourceRecordId: 'v17',
    sourceAssociationId: 'g12',
    sourceRevision: 'revision-4',
    converterRevision: 'fixture@1',
    observedAt: '2026-11-03T00:00:00.000Z',
    coverage: { kind: 'unknown' },
    attribution: 'Example classification provider',
    licence: { id: 'Fixture-1.0', url: 'https://example.test/licence' },
    value: { kind: 'observation', confidence: 2.4, lie: false },
  });
  const intended = intendedFromProjection(projection, association);
  if (!intended) throw new Error('admitted projection must bind');
  expect(classificationOperationDigest(intended)).toBe(
    classificationObservation(association, classificationPayload(intended)).digest,
  );
});
