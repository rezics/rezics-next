import { expect, expectTypeOf, test } from 'bun:test';
import type { KernelClient } from '@rezics/client';
import {
  classificationObservation as importedObservation,
  classificationPayload,
  type IntendedClassification,
} from '../../../importer/src/source-classification.ts';
import { classificationObservation } from '../../src/rating/source-classification-contract.ts';

const association = {
  subjectId: '00000000-0000-4000-8000-000000000101',
  candidateId: '00000000-0000-4000-8000-000000000201',
  contextId: '00000000-0000-4000-8000-000000000202',
  targetId: '00000000-0000-4000-8000-000000000203',
  property: 'wdt:P136',
  revision: 1,
  release: 'a'.repeat(64),
  qualifiersDigest: 'b'.repeat(64),
};
const intended: IntendedClassification = {
  family: 'classification',
  kind: 'write',
  association,
  sourceAlias: 'trusted-fixture',
  sourceRecordId: 'v123',
  sourceAssociationId: 'g12',
  asOf: '2026-11-03T00:00:00.000Z',
  sourceVersion: { kind: 'revision', revision: '7' },
  attribution: 'Example classification provider',
  licence: 'Fixture-1.0',
  confidence: 2.4,
  lie: false,
};

test('importer classification digests are the mounted classificationObservation helper', () => {
  const payload = classificationPayload(intended);
  expect(importedObservation(association, payload).digest).toBe(classificationObservation(association, payload).digest);
});

test('generated KernelClient mounts source-classifications read, put and clear', () => {
  type Client = ReturnType<KernelClient['subjects']>['source-classifications'];
  expectTypeOf<keyof Client>().toEqualTypeOf<'$read' | '$put' | '$clear'>();
  expectTypeOf<Parameters<Client['$put']['post']>[0]['expectedObservation']>().toEqualTypeOf<string | null>();
});
