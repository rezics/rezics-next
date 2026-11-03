import { describe, expect, test } from 'bun:test';
import {
  classificationObservedInstant,
  classificationSourceVersion,
  projectSourceClassification,
} from '../src/index.ts';

const provenance = {
  sourceAlias: 'trusted-fixture',
  sourceRecordId: 'record-17',
  sourceRevision: 'revision-4',
  converterRevision: 'fixture@1',
  observedAt: null,
  coverage: { kind: 'unknown' as const },
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
    expect(lieOnly.state === 'available' && lieOnly.value.kind === 'observation' && 'lieCount' in lieOnly.value).toBe(
      false,
    );
    expect(zeroCount).toMatchObject({
      state: 'available',
      value: { kind: 'observation', confidence: 1.5, confidenceCount: 0 },
    });
  });

  test('preserves explicit clear and never turns absent values into clear', () => {
    expect(projectSourceClassification({ ...provenance, value: { kind: 'clear' } })).toMatchObject({
      state: 'available',
      value: { kind: 'clear' },
    });
    expect(projectSourceClassification(provenance)).toEqual({ state: 'unavailable', reason: 'incomplete-input' });
    expect(projectSourceClassification({ ...provenance, value: { kind: 'observation', confidence: 0 } })).toEqual({
      state: 'unavailable',
      reason: 'invalid-observation',
    });
  });

  test('maps admitted provenance onto native source version and observed instant', () => {
    expect(classificationSourceVersion(provenance)).toEqual({ kind: 'revision', revision: 'revision-4' });
    expect(
      classificationSourceVersion({ ...provenance, sourceRevision: null, sourceDigest: 'a'.repeat(64) }),
    ).toEqual({ kind: 'unversioned', digest: 'a'.repeat(64) });
    expect(classificationObservedInstant(null)).toBeNull();
    expect(classificationObservedInstant('2026-11-03T00:00:00Z')).toBe('2026-11-03T00:00:00.000Z');
  });

  test('requires truthful provenance for unversioned records and drops unsupported provider fields', () => {
    expect(
      projectSourceClassification({ ...provenance, sourceRevision: null, value: { kind: 'observation', lie: true } }),
    ).toEqual({
      state: 'unavailable',
      reason: 'incomplete-input',
    });
    expect(
      projectSourceClassification({ ...provenance, tags: ['rating'], value: { kind: 'observation', lie: true } }),
    ).toEqual({
      state: 'unavailable',
      reason: 'unsupported-record',
    });
  });

  test('keeps public VNDB dump licences unadmitted and retains an optional source association member', () => {
    expect(
      projectSourceClassification({
        ...provenance,
        licence: { id: 'ODbL-1.0', url: 'https://opendatacommons.org/licenses/odbl/1-0/' },
        value: { kind: 'observation', confidence: 2.4 },
      }),
    ).toEqual({ state: 'unavailable', reason: 'unadmitted' });
    expect(
      projectSourceClassification({
        ...provenance,
        licence: { id: 'LicenseRef-DbCL-1.0', url: 'https://opendatacommons.org/licenses/dbcl/1-0/' },
        value: { kind: 'observation', lie: true },
      }),
    ).toEqual({ state: 'unavailable', reason: 'unadmitted' });
    expect(
      projectSourceClassification({
        ...provenance,
        sourceAssociationId: 'g12',
        value: { kind: 'observation', confidence: 2.4, lie: false },
      }),
    ).toMatchObject({
      state: 'available',
      provenance: { sourceAssociationId: 'g12' },
      value: { kind: 'observation', confidence: 2.4, lie: false },
    });
  });
});
