import { expect, test } from 'bun:test';
import fidelity from '../../../scripts/qa/cases/outcomes/catalogue/import-fidelity.ts';
import coverage from '../../../scripts/qa/cases/outcomes/catalogue/source-coverage.ts';
import { personas } from '../../../scripts/qa/cases/outcome-cells.ts';
import type { DatasetRecord } from '../../../scripts/datasets/types.ts';
import { assertDispositionConservation, assertMatrix, exactRecords, matrix } from '../support/import-outcomes.ts';

test('both import rows retain six pending cells and the accepted inventory partition', () => {
  assertMatrix();
  for (const row of [fidelity, coverage]) {
    expect(Object.keys(row.cells).sort()).toEqual([...personas].sort());
    for (const cell of Object.values(row.cells)) expect(cell?.state).toBe('pending');
  }
  expect(matrix.relations.filter(row => row.sourceKey === 'vndb:vn:v11')).toHaveLength(50);
  expect(matrix.music.trackMilliseconds).not.toBe(matrix.music.recordingMilliseconds);
});

const original = (key: string): DatasetRecord => ({ key, provider: 'bangumi', kind: 'subject',
  externalId: key, title: 'Original unit fixture identity', language: 'ja', sourceUrl: 'https://example.invalid/source',
  data: {}, native: 'work' });

test('selection is order independent and refuses missing or duplicate original identities', () => {
  const a = original('a'), b = original('b'), excluded = original('excluded');
  expect(exactRecords([excluded, b, a], ['b', 'a'])).toEqual([a, b]);
  expect(exactRecords([a, excluded, b], ['a', 'b'])).toEqual([a, b]);
  expect(() => exactRecords([a], ['b'])).toThrow('Missing frozen source identity');
  expect(() => exactRecords([a, a], ['a'])).toThrow('Duplicate frozen source identity');
  expect(() => exactRecords([a], ['a', 'a'])).toThrow('Duplicate frozen source identity');
});

const expected = [
  { key: 'native-fact', sourceKey: 'retained-original', valueDigest: 'one', disposition: 'adopted' },
  { key: 'private-activity', sourceKey: 'retained-original', valueDigest: 'two', disposition: 'source-only' },
];
const actual = () => expected.map(row => ({ ...row,
  native: row.disposition === 'adopted' ? [{ resource: 'unit-native-fact', revision: 'unit-revision' }] : [],
  reason: row.disposition === 'adopted' ? null : 'Retain private source activity without native voters.' }));

test('the specification rejects blanket source-only and empty native positives', () => {
  expect(() => assertDispositionConservation(actual(), expected)).not.toThrow();
  const blanket = actual().map(row => ({ ...row, disposition: 'source-only', native: [], reason: 'Unsupported' }));
  expect(() => assertDispositionConservation(blanket, expected)).toThrow();
  const empty = actual(); empty[0]!.native = [];
  expect(() => assertDispositionConservation(empty, expected)).toThrow();
});

test('the specification rejects dropped, duplicated, extra, changed and falsely adopted evidence', () => {
  expect(() => assertDispositionConservation(actual().slice(0, 1), expected)).toThrow();
  expect(() => assertDispositionConservation([...actual(), actual()[0]!], expected)).toThrow();
  expect(() => assertDispositionConservation([...actual(), { ...actual()[0]!, key: 'unselected' }], expected)).toThrow();
  const changed = actual(); changed[0]!.valueDigest = 'different source value';
  expect(() => assertDispositionConservation(changed, expected)).toThrow();
  const published = actual(); published[1]!.native = [...published[0]!.native];
  expect(() => assertDispositionConservation(published, expected)).toThrow();
});
