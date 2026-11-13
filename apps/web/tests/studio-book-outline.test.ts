import { expect, test } from 'bun:test';
import {
  bookMoveDestinations,
  bookMovePositions,
  bookTocIndex,
  moveBookOccurrence,
  moveBookOccurrenceTo,
} from '../src/studio/book-toc';
import type { BookPlacement, BookStructure } from '../src/studio/contract';

const part = (occurrenceId: string, parentOccurrenceId: string | null = null): BookPlacement => ({
  occurrenceId,
  parentOccurrenceId,
  title: 'Same title',
  target: { kind: 'part' },
});
const exact = { postId: 'draft-post', revisionId: 'saved-revision', sha256: 'a'.repeat(64) };
const chapter = (occurrenceId: string, parentOccurrenceId: string | null): BookPlacement => ({
  occurrenceId,
  parentOccurrenceId,
  title: 'Chapter',
  target: { kind: 'chapter', document: exact },
});
function structure(placements: readonly BookPlacement[], maxDepth = 16): BookStructure {
  return {
    catalogueId: 'book',
    revision: 'exact-structure',
    placements,
    canOrganize: true,
    limits: { maxDepth, maxPlacements: 512 },
  };
}
function deepOutline() {
  return structure([
    part('previous'),
    part('branch'),
    part('following'),
    chapter('root-chapter', null),
    ...Array.from({ length: 14 }, (_, i) => part(`draft-${i}`, i ? `draft-${i - 1}` : 'branch')),
    chapter('deep-chapter', 'draft-13'),
  ]);
}

test('outline lookups retain preorder, draft identities, sibling order and exact chapter versions', () => {
  const book = deepOutline();
  const outline = bookTocIndex(book);
  const ids = (rows = outline.rows) => rows.map((row) => row.placement.occurrenceId);
  expect(ids()).toEqual([
    'previous',
    'branch',
    ...Array.from({ length: 14 }, (_, i) => `draft-${i}`),
    'deep-chapter',
    'following',
    'root-chapter',
  ]);
  expect(ids(outline.children.get(null))).toEqual(['previous', 'branch', 'following', 'root-chapter']);
  expect(ids(outline.children.get('draft-13'))).toEqual(['deep-chapter']);
  expect(outline.byId.get('branch')!.placement).toBe(book.placements[1]!);
  expect(outline.byId.get('deep-chapter')!.placement.target).toEqual({ kind: 'chapter', document: exact });
  expect(outline.maxDescendantDepth.get('branch')).toBe(15);
  expect(outline.maxDescendantDepth.get('previous')).toBe(0);
  expect(outline.maxDescendantDepth.get('deep-chapter')).toBe(15);
  const move = (id: string, direction: 'up' | 'down' | 'in' | 'out', index = outline) =>
    moveBookOccurrence(index.byId.get(id)!, direction, index);
  const change = (occurrenceId: string, parentOccurrenceId: string | null, beforeOccurrenceId: string | null) => ({
    kind: 'move',
    occurrenceId,
    parentOccurrenceId,
    beforeOccurrenceId,
  });
  expect(move('branch', 'in')).toBeNull();
  expect(move('following', 'in')).toEqual(change('following', 'branch', null));
  expect(move('branch', 'up')).toEqual(change('branch', null, 'previous'));
  expect(move('branch', 'down')).toEqual(change('branch', null, 'root-chapter'));
  expect(move('draft-0', 'out')).toEqual(change('draft-0', null, 'following'));
  expect(move('deep-chapter', 'out')).toEqual(change('deep-chapter', 'draft-12', null));
  expect(move('previous', 'up')).toBeNull();
  expect(move('branch', 'out')).toBeNull();
  expect(move('root-chapter', 'down')).toBeNull();
  const atBoundary = bookTocIndex(structure([part('parent'), part('subtree'), chapter('leaf', 'subtree')], 3));
  expect(move('subtree', 'in', atBoundary)).toEqual(change('subtree', 'parent', null));
});

test('indexing retains the admitted nesting and placement bounds, including the empty outline', () => {
  const empty = bookTocIndex(structure([]));
  expect(empty.rows).toEqual([]);
  expect(empty.children.get(null)).toEqual([]);
  expect(empty.byId.size).toBe(0);
  const deep = deepOutline();
  expect(() => bookTocIndex({ ...deep, limits: { ...deep.limits, maxDepth: 15 } })).toThrow('nesting limit');
  expect(() => bookTocIndex({ ...deep, limits: { ...deep.limits, maxPlacements: 1 } })).toThrow('bounds');
});

test('direct moves offer exact effective destinations and insertion points for the entire subtree', () => {
  const outline = bookTocIndex(
    structure(
      [
        part('source'),
        part('nested', 'source'),
        chapter('leaf', 'nested'),
        part('distant'),
        chapter('first', 'distant'),
        chapter('last', 'distant'),
        part('deep-parent', 'distant'),
        part('empty'),
      ],
      4,
    ),
  );
  const move = (parent: string | null, before: string | null, id = 'source', index = outline) =>
    moveBookOccurrenceTo(id, parent, before, index);
  expect(bookMoveDestinations('source', outline)).toEqual([null, 'distant', 'empty']);
  expect(bookMovePositions('source', null, outline)).toEqual(['empty', null]);
  expect(bookMovePositions('source', 'distant', outline)).toEqual(['first', 'last', 'deep-parent', null]);
  expect(bookMovePositions('source', 'empty', outline)).toEqual([null]);
  expect(move('distant', 'last')).toEqual({
    kind: 'move',
    occurrenceId: 'source',
    parentOccurrenceId: 'distant',
    beforeOccurrenceId: 'last',
  });
  for (const parent of ['source', 'nested', 'leaf', 'deep-parent', 'missing']) expect(move(parent, null)).toBeNull();
  for (const before of ['source', 'nested', 'first', 'missing', 'distant']) expect(move(null, before)).toBeNull();
  expect(move(null, null, 'empty')).toBeNull();
  expect(bookMoveDestinations('missing', outline)).toEqual([]);
  expect(bookMoveDestinations('only', bookTocIndex(structure([part('only')])))).toEqual([]);
  const refreshed = bookTocIndex(structure([part('source'), part('distant'), part('last', 'source')]));
  expect(move('distant', 'last', 'source', refreshed)).toBeNull();
  expect(move(null, 'distant', 'leaf')).toEqual({
    kind: 'move',
    occurrenceId: 'leaf',
    parentOccurrenceId: null,
    beforeOccurrenceId: 'distant',
  });
  expect(outline.byId.get('leaf')!.placement.target).toEqual({ kind: 'chapter', document: exact });
});
