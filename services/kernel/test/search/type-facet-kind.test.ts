import { expect, test } from 'bun:test';
import { bundledRelease } from '@rezics/definitions/bundled';
import {
  attachKindCountMetadata,
  nativeTypeFacetLabels,
  proveCurrentKindCounts,
  typeFacetLabels,
} from '../../src/search/type-facet.ts';

test('whole-predicate kind proof counts distinct current rows and never infers a zero', () => {
  const counts = proveCurrentKindCounts({
    subjects: [
      { id: 'a', type: 'schema:Book' },
      { id: 'a', type: 'schema:Book' },
      { id: 'b', type: 'schema:Book' },
      { id: 'c', type: 'schema:Movie' },
    ],
    directory: ['schema:Book', 'schema:Movie', 'schema:Person'],
    complete: true,
  });
  expect(counts.get('schema:Book')).toEqual({ kind: 'schema:Book', value: 2, exact: true });
  expect(counts.get('schema:Movie')).toEqual({ kind: 'schema:Movie', value: 1, exact: true });
  expect(counts.get('schema:Person')).toEqual({ kind: 'schema:Person', unavailable: true });
  const attached = attachKindCountMetadata(
    [
      { kind: 'schema:Person', metadata: { id: 'schema:Person', labels: { en: 'Person' }, icon: 'person' } },
      { kind: 'schema:Book', metadata: { id: 'schema:Book', labels: { en: 'Book' }, icon: 'book' } },
    ],
    counts,
  );
  expect(attached[0]?.count).toEqual({ kind: 'schema:Person', unavailable: true });
  expect(attached[1]?.count).toEqual({ kind: 'schema:Book', value: 2, exact: true });
});

test('type labels come from the released definition owner, not a Search fixture map', () => {
  const book = typeFacetLabels(bundledRelease, 'schema:Book');
  expect(book?.en ?? book?.['zh-Hant'] ?? Object.values(book ?? {})[0]).toBeTruthy();
  expect(nativeTypeFacetLabels(bundledRelease, 'schema:Book', ['en']).en).toBe(book?.en ?? book?.['en']);
  const chinese = nativeTypeFacetLabels(bundledRelease, 'schema:Book', ['zh-Hans', 'zh', 'en']);
  expect(Object.keys(chinese)).toHaveLength(1);
  expect(chinese['zh-Hans'] ?? chinese.en).toBeTruthy();
  expect(typeFacetLabels(bundledRelease, 'schema:UnknownType')).toBeUndefined();
});
