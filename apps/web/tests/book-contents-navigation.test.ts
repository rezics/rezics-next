import { expect, test } from 'bun:test';
import { createBookContentsNavigation } from '../src/books/reader/contents-navigation';
import { createBookReader } from '../src/books/reader/reader-state';
import type { BookContentsAddress } from '../src/books/reader/source';

const address = (cursor: string | null, parentOccurrenceId: string | null = 'part'): BookContentsAddress => ({
  kind: 'contents',
  publication: { id: 'book', structureRevisionId: 'structure', releaseRevisionId: 'release' },
  selection: null,
  parentOccurrenceId,
  cursor,
});

test('Previous contains only eight successfully observed coordinates and direct entry never invents one', () => {
  const contents = createBookContentsNavigation();
  contents.observe(address('page-10'));
  expect(contents.previous(address('page-10'))).toBeNull();
  for (let page = 11; page <= 20; page++) {
    const target = address(`page-${page}`);
    contents.stage(target);
    contents.observe(target);
  }
  expect(contents.getSnapshot().predecessors).toHaveLength(8);
  expect(contents.getSnapshot().predecessors[0]?.cursor).toBe('page-12');
  for (let page = 20; page > 12; page--) {
    const previous = contents.previous(address(`page-${page}`))!;
    expect(previous.cursor).toBe(`page-${page - 1}`);
    contents.stage(previous);
    contents.observe(previous);
  }
  expect(contents.previous(address('page-12'))).toBeNull();
  expect(Object.keys(contents.getSnapshot().current!)).toEqual(['parentOccurrenceId', 'cursor']);
  contents.retire();
  expect(contents.getSnapshot()).toEqual({ predecessors: [], current: null, staged: null });
});

test('failed Previous keeps its target staged and First explicitly drops this level history only on success', () => {
  const contents = createBookContentsNavigation();
  for (const cursor of [null, 'opaque/+two', 'opaque/+three']) contents.observe(address(cursor));
  const previous = contents.previous(address('opaque/+three'))!;
  contents.stage(previous);
  expect(contents.getSnapshot().current?.cursor).toBe('opaque/+three');
  expect(contents.getSnapshot().staged?.cursor).toBe('opaque/+two');
  expect(contents.previous(address('opaque/+three'))).toEqual(previous);
  // Retry uses the same staged operands; a failed observation never commits the staged movement.
  contents.observe(previous);
  expect(contents.previous(previous)).toEqual(address(null));
  contents.observe(address('opaque/+three'));
  contents.stage(address(null), 'first');
  expect(contents.getSnapshot().current?.cursor).toBe('opaque/+three');
  contents.observe(address(null));
  expect(contents.previous(address(null))).toBeNull();
});

test('nested levels restore their own last observed cursor without borrowing another parent cursor', () => {
  const contents = createBookContentsNavigation();
  contents.observe(address(null, null));
  contents.observe(address('root-page', null));
  contents.observe(address(null, 'part'));
  contents.observe(address('part-page', 'part'));
  contents.observe(address(null, 'nested'));
  contents.observe(address('nested-page', 'nested'));
  expect(contents.previous(address('nested-page', 'nested'))).toEqual(address(null, 'nested'));
  expect(contents.resolve(address(null, 'part'), 'level')).toEqual(address('part-page', 'part'));
  expect(contents.resolve(address(null, null), 'level')).toEqual(address('root-page', null));
  expect(contents.resolve(address(null, 'unobserved'), 'level')).toEqual(address(null, 'unobserved'));
  expect(contents.resolve(address(null, 'part'), 'first')).toEqual(address(null, 'part'));
  contents.observe(address('part-page', 'part'));
  expect(contents.previous(address('part-page', 'part'))).toEqual(address(null, 'part'));
  contents.observe(address('root-page', null));
  expect(contents.previous(address('root-page', null))).toEqual(address(null, null));
});

test('a retired reader cannot erase coordinates admitted by the next route incarnation', () => {
  const contents = createBookContentsNavigation();
  let current = true;
  const observation = { state: 'current' } as const;
  const reader = createBookReader(
    {
      getSnapshot: () => observation,
      subscribe: () => () => {},
      read: async () => ({ state: 'unavailable' }),
    },
    address(null),
    'en',
    () => current,
    { contentsNavigation: contents },
  );
  reader.retire();
  current = false;
  contents.observe(address(null));
  contents.observe(address('next-route-page'));
  expect(reader.current()).toBe(false);
  expect(contents.previous(address('next-route-page'))).toEqual(address(null));
});
