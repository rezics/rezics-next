import { expect, test } from 'bun:test';
import { relationshipNavigationSource } from '../features/relationships/list.ts';

interface Item {
  id: string;
  name: string;
}
const page = (items: Item[]) => ({ items, complete: true, nextCursor: null });
const identity = (item: Item) => item.id;
const label = (item: Item) => item.name;

test('G-1000: a drawer mounted after Pin reads the current owner instead of its empty server snapshot', async () => {
  const pinned = { id: 'space', name: '中文社群' };
  const calls: unknown[] = [];
  const source = relationshipNavigationSource(
    page([]),
    async (q, cursor) => {
      calls.push({ q, cursor });
      return page([pinned]);
    },
    identity,
    label,
  );
  await source.search('');
  expect(source.getSnapshot().items.map((item) => item.id)).toEqual(['space']);
  expect(calls).toEqual([{ q: '', cursor: null }]);
});

test('G-1000: a newly opened drawer cannot resurrect an unfollowed resource from a server snapshot', async () => {
  const source = relationshipNavigationSource(
    page([{ id: 'gone', name: 'Old follow' }]),
    async () => page([]),
    identity,
    label,
  );
  await source.search('');
  expect(source.getSnapshot().items).toEqual([]);
  expect(source.getSnapshot().complete).toBe(true);
});

test('G-1000: a fresh mount preserves owner pagination, searching and one row per Space', async () => {
  const calls: unknown[] = [];
  const source = relationshipNavigationSource(
    page([]),
    async (q, cursor) => {
      calls.push({ q, cursor });
      return cursor
        ? page([
            { id: 'same', name: '社群' },
            { id: 'tail', name: '社群續頁' },
          ])
        : { items: [{ id: 'same', name: '社群' }], complete: false, nextCursor: 'next' };
    },
    identity,
    label,
  );
  await source.search('社群');
  await source.more();
  expect(source.getSnapshot().items.map((item) => item.id)).toEqual(['same', 'tail']);
  expect(calls).toEqual([
    { q: '社群', cursor: null },
    { q: '社群', cursor: 'next' },
  ]);
});

test('G-1000: a failed live read stays unavailable instead of presenting an obsolete pin as current', async () => {
  let unavailable = true;
  const source = relationshipNavigationSource(
    page([{ id: 'stale', name: 'Stale pin' }]),
    async () => {
      if (unavailable) throw new Error('offline');
      return page([{ id: 'current', name: 'Current pin' }]);
    },
    identity,
    label,
  );
  await source.search('');
  expect(source.getSnapshot().error).toBe(true);
  expect(source.getSnapshot().items).toEqual([]);
  unavailable = false;
  await source.retry();
  expect(source.getSnapshot().items.map((item) => item.id)).toEqual(['current']);
});

test('G-1000: static official and legacy navigation still uses its complete snapshot without a live API', async () => {
  const source = relationshipNavigationSource(
    page([
      { id: 'official', name: 'Fiction' },
      { id: 'other', name: 'Kitchen' },
    ]),
    undefined,
    identity,
    label,
  );
  await source.search('fiction');
  expect(source.getSnapshot().items.map((item) => item.id)).toEqual(['official']);
  expect(source.getSnapshot().complete).toBe(true);
});
