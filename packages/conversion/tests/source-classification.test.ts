import { describe, expect, test } from 'bun:test';
import { projectSourceClassification } from '../src/index.ts';

const provenance = {
  sourceAlias: 'trusted-fixture',
  sourceRecordId: 'record-17',
  sourceRevision: 'revision-4',
  converterRevision: 'fixture@1',
  observedAt: null,
  coverage: { kind: 'unknown' },
  attribution: 'Example classification provider',
  licence: { id: 'Fixture-1.0', url: 'https://example.test/licence' },
};

describe('source classification projection', () => {
  test('keeps lie-only, omitted counts, and supplied zero counts distinct', () => {
    const lieOnly = projectSourceClassification({ ...provenance, value: { kind: 'observation', lie: false } });
    const zeroCount = projectSourceClassification({
      ...provenance,
      sourceRevision: null,
      sourceDigest: 'a'.repeat(64),
      value: { kind: 'observation', confidence: 1.5, confidenceCount: 0 },
    });

    expect(lieOnly).toMatchObject({ state: 'available', value: { kind: 'observation', lie: false } });
    expect(lieOnly.state === 'available' && lieOnly.value.kind === 'observation' && 'lieCount' in lieOnly.value).toBe(false);
    expect(zeroCount).toMatchObject({ state: 'available', value: { kind: 'observation', confidence: 1.5, confidenceCount: 0 } });
  });

  test('preserves explicit clear and never turns absent values into clear', () => {
    expect(projectSourceClassification({ ...provenance, value: { kind: 'clear' } })).toMatchObject({
      state: 'available', value: { kind: 'clear' },
    });
    expect(projectSourceClassification(provenance)).toEqual({ state: 'unavailable', reason: 'incomplete-input' });
    expect(projectSourceClassification({ ...provenance, value: { kind: 'observation', confidence: 0 } })).toEqual({
      state: 'unavailable', reason: 'invalid-observation',
    });
  });

  test('requires truthful provenance for unversioned records and drops unsupported provider fields', () => {
    expect(projectSourceClassification({ ...provenance, sourceRevision: null, value: { kind: 'observation', lie: true } })).toEqual({
      state: 'unavailable', reason: 'incomplete-input',
    });
    expect(projectSourceClassification({ ...provenance, tags: ['rating'], value: { kind: 'observation', lie: true } })).toEqual({
      state: 'unavailable', reason: 'unsupported-record',
    });
  });
});
