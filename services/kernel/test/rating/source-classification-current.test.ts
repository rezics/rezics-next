import { expect, test } from 'bun:test';
import type { SourceFence } from '../../src/content/source-fences.ts';
import { classificationObservation, type ClassificationAssociation } from '../../src/rating/source-classification-contract.ts';
import { currentClassificationRead } from '../../src/rating/source-classification-read.ts';
import type { ClassificationAssociationResolution } from '../../src/rating/source-classification-semantic.ts';

const association: ClassificationAssociation = {
  subjectId: '00000000-0000-8000-8000-000000000001',
  candidateId: '00000000-0000-8000-0000-000000000002',
  contextId: '00000000-0000-8000-8000-000000000000',
  targetId: '00000000-0000-8000-8000-000000000003',
  property: 'schema:keywords', revision: 1, release: `sha256:${'a'.repeat(64)}`, qualifiersDigest: 'b'.repeat(64),
};
const payload = {
  sourceAlias: 'vndb', sourceRecordId: 'v17', sourceAssociationId: 'g123',
  asOf: '2026-11-03T00:00:00.000Z', lie: false, lieCount: 0,
  sourceVersion: { kind: 'revision' as const, revision: 'original' }, attribution: 'Authorized fixture', licence: 'Fixture',
};
const head = { association, ...classificationObservation(association, payload) };
const authority: ClassificationAssociationResolution = {
  state: 'available', evidence: { stamp: 'original', source: { source: 'vndb', external_id: 'v17', field_group: 'facts' } },
};
const fence: SourceFence = { route: 0, source: 'vndb', external_id: 'v17', field_group: 'facts', takenDown: false, securityRevision: null };
const input = { association, before: authority, after: authority, first: head, last: head, fenceBefore: fence, fenceAfter: fence, now: new Date(payload.asOf) };
const changed = { state: 'unavailable', reason: 'changed' };

test('an admitted source read preserves optional indicators, source identity and provenance', () => {
  expect(currentClassificationRead(input)).toMatchObject({ state: 'available', value: {
    association, observation: { digest: head.digest, sourceVersion: payload.sourceVersion },
    sourceAlias: 'vndb', sourceRecordId: 'v17', sourceAssociationId: 'g123', asOf: payload.asOf,
    confidence: { state: 'unavailable', reason: 'not_supplied' }, lie: { state: 'available', value: false, unit: 'boolean' },
    lieCount: 0, attribution: payload.attribution, licence: payload.licence,
  } });
});

test('empty and cleared heads are observed again before returning not_observed', () => {
  const clear = { association, ...classificationObservation(association, { sourceAlias: 'vndb', sourceRecordId: 'v17', sourceAssociationId: 'g123', asOf: payload.asOf, cleared: true }) };
  for (const first of [undefined, clear]) {
    expect(currentClassificationRead({ ...input, first, last: first })).toEqual({ state: 'unavailable', reason: 'not_observed' });
    expect(currentClassificationRead({ ...input, first })).toEqual(changed);
  }
  expect(currentClassificationRead({ ...input, last: clear })).toEqual(changed);
});

test('changed identity, association, source record, fences and observation withhold retained figures', () => {
  expect(currentClassificationRead({ ...input, after: { state: 'available', evidence: { ...authority.evidence, stamp: 'replaced' } } })).toEqual(changed);
  expect(currentClassificationRead({ ...input, last: undefined })).toEqual(changed);
  expect(currentClassificationRead({ ...input, before: { state: 'available', evidence: { stamp: 'original', source: { source: 'vndb', external_id: 'v18', field_group: 'facts' } } } })).toEqual({ state: 'unavailable', reason: 'provenance_unavailable' });
  for (const fenceAfter of [undefined, { ...fence, takenDown: true }, { ...fence, securityRevision: '2' }])
    expect(currentClassificationRead({ ...input, fenceAfter })).toEqual({ state: 'unavailable', reason: 'not_found' });
  for (const reason of ['not_found', 'provenance_unavailable', 'authority_unavailable'] as const)
    expect(currentClassificationRead({ ...input, after: { state: 'unavailable', reason } })).toEqual({ state: 'unavailable', reason });
});
