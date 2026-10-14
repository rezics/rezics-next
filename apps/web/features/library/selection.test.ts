import { expect, test } from 'bun:test';
import { libraryItems } from './fixtures.ts';
import { libraryRowKey, selectedLibraryRows, selectedWorks } from './selection.ts';

test('repeated collection members are selected and removed by their own occurrence', () => {
  const rows = ['first', 'repeat'].map(occurrence => ({ ...libraryItems[0]!, occurrence }));
  expect(rows.map(libraryRowKey)).toEqual(['first', 'repeat']);
  expect(selectedLibraryRows(rows, new Set(['repeat'])).map(row => row.occurrence)).toEqual(['repeat']);
  expect(selectedLibraryRows(rows, new Set(rows.map(libraryRowKey)))).toHaveLength(2);
  expect(selectedWorks(rows)).toEqual([rows[0]!.work.id]);
});

test('a status shelf still selects Works, retaining the API order', () => {
  const rows = libraryItems.slice(0, 3);
  expect(rows.map(libraryRowKey)).toEqual(rows.map(row => row.work.id));
  expect(selectedWorks(selectedLibraryRows(rows, new Set([rows[2]!.work.id, rows[0]!.work.id]))))
    .toEqual([rows[0]!.work.id, rows[2]!.work.id]);
});
