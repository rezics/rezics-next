import { expect, test } from 'bun:test';
import { projectSourceClassification, type SourceClassificationProjection } from '@rezics/conversion';
import { RunStore, type SourceProjection } from '../src/run-store.ts';

test('staging retains only bounded, validated converter classification output', () => {
  const store = new RunStore<SourceProjection>(':memory:', { projectionMode: 'source-record' });
  try {
    const run = store.begin('fixture');
    if (run === 'busy') throw new Error('Unexpected active run');
    const classification = projectSourceClassification({
      sourceAlias: 'fixture',
      sourceRecordId: 'authored-1',
      sourceRevision: 'r1',
      converterRevision: 'fixture-1',
      observedAt: '2026-01-01T00:00:00Z',
      coverage: { kind: 'unknown' },
      attribution: 'Authored fixture by REZICS tests',
      licence: { id: 'CC0', url: 'https://example.org/fixture-licence' },
      value: { kind: 'observation', confidence: 1 },
    });
    expect(classification.state).toBe('available');
    const stage = (recordKey: string, sourceClassification: SourceClassificationProjection) =>
      store.stage(run, {
        row: {
          source: 'fixture',
          recordKey,
          recordRevision: 'r1',
          converter_revision: 'fixture-1',
          digest: 'a'.repeat(64),
          state: 'present',
        },
        projection: { sourceKind: 'wikidata', normalizedRecord: { id: recordKey }, sourceClassification },
      });
    stage('authored-1', classification);
    stage('authored-2', { state: 'unavailable', reason: 'unadmitted' });
    const read = (recordKey: string) => {
      const entry = store.stagedIdentity(run, recordKey);
      if (!entry) throw new Error('Staged record disappeared');
      return JSON.parse(entry.projection).sourceClassification;
    };
    expect(read('authored-1')).toEqual(classification);
    expect(read('authored-2')).toEqual({ state: 'unavailable', reason: 'unadmitted' });
    expect(() =>
      stage('authored-3', { state: 'available', provenance: {}, value: { kind: 'clear' } } as SourceClassificationProjection),
    ).toThrow('Invalid source classification projection');
  } finally {
    store.close();
  }
});
