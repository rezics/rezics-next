import { expect, test } from 'bun:test';
import type { SubjectCanonicalNames } from '../../src/semantic/subject-source-key-pages.ts';
import {
  observeReleaseSearchNames,
  readReleaseSearchNames,
  type ReleaseSearchNameReservation,
} from '../../src/search/release-search-name-stream.ts';
import {
  ReleaseGroupingRestartRequired,
  ReleaseGroupingUnavailable,
} from '../../src/search/release-search-grouping.ts';

function fixture() {
  const reservations: ReleaseSearchNameReservation[] = [];
  const context = {
    deadline: Date.now() + 10_000,
    reserve: (value: ReleaseSearchNameReservation) => reservations.push(value),
  };
  const id = (partition: number, index: number) =>
    `00000000-0000-8000-8000-${(partition * 16).toString(16).padStart(4, '0')}${index.toString(16).padStart(8, '0')}`;
  const homes = [0, 1, 2].map((partition) => ({ partition, generation: '1', epoch: 1, position: '0' }));
  const rows = [
    [
      { name: 'A', id: id(0, 1), securityRevision: 0 },
      { name: '\u{10000}', id: id(0, 2), securityRevision: 0 },
    ],
    [
      { name: 'A', id: id(1, 1), securityRevision: 0 },
      { name: '\ue000', id: id(1, 2), securityRevision: 0 },
    ],
    [{ name: null, id: id(2, 1), securityRevision: 0 }],
  ];
  const compare = (left: { name: string | null; id: string }, right: { name: string | null; id: string }) =>
    Number(left.name === null) - Number(right.name === null) ||
    Buffer.compare(Buffer.from(left.name ?? ''), Buffer.from(right.name ?? '')) ||
    left.id.localeCompare(right.id);
  const pools = homes.map((home, index) => {
    const names: SubjectCanonicalNames = {
      observe: async () => ({ generation: home.position, homes: [home] }),
      read: async ({ after, limit }) => ({
        home,
        candidates: rows[index]!.filter((row) => after === null || compare(row, after) > 0).slice(0, limit),
      }),
    };
    return { id: `pool-${index}`, names };
  });
  return { pools, homes, rows, reservations, context };
}

test('all-pool name pages preserve native order, replay lookahead, and prove final and empty pages', async () => {
  const f = fixture();
  const cut = await observeReleaseSearchNames(f.pools, f.context);
  const read = (after: string | null) => readReleaseSearchNames({ ...f, cut, after, size: 2 });
  const first = await read(null);
  expect(first.keys.map(({ pool, name }) => [pool, name])).toEqual([
    ['pool-0', 'A'],
    ['pool-1', 'A'],
  ]);
  expect(first.exhausted).toBe(false);
  expect(await read(null)).toEqual(first);
  const next = await read(first.after);
  expect(next.keys.map(({ name }) => name)).toEqual(['\ue000', '\u{10000}']);
  expect(next.exhausted).toBe(false);
  const final = await read(next.after);
  expect(final.keys.map(({ name }) => name)).toEqual([null]);
  expect(final.exhausted).toBe(true);
  const empty = await read(final.after);
  expect(empty.keys).toEqual([]);
  expect(empty.exhausted).toBe(true);
  // Each read reserves all three homes, including empty seeks and replayed lookahead.
  expect(f.reservations.filter(({ nameSeeks }) => nameSeeks).map(({ pool, keys }) => [pool, keys])).toEqual(
    Array.from({ length: 5 }, () => f.pools.map(({ id }) => [id, 2])).flat(),
  );
});

test('a retained cut retires progress for any pool, including an empty pool and concurrent changes', async () => {
  for (const concurrent of [false, true]) {
    const f = fixture();
    f.rows[2] = [];
    const cut = await observeReleaseSearchNames(f.pools, f.context);
    const first = await readReleaseSearchNames({ ...f, cut, after: null, size: 1 });
    if (concurrent) {
      const original = f.pools[0]!.names.read;
      f.pools[0]!.names.read = async (...args) => {
        const result = await original(...args);
        f.homes[2]!.position = '1';
        return result;
      };
    } else f.homes[2]!.position = '1';
    await expect(readReleaseSearchNames({ ...f, cut, after: first.after, size: 1 })).rejects.toBeInstanceOf(
      ReleaseGroupingRestartRequired,
    );
    const fresh = await observeReleaseSearchNames(f.pools, f.context);
    await expect(readReleaseSearchNames({ ...f, cut: fresh, after: first.after, size: 1 })).rejects.toBeInstanceOf(
      ReleaseGroupingRestartRequired,
    );
  }
});

test('overlapping owners and malformed or unordered native keys fail closed', async () => {
  const f = fixture();
  const cut = await observeReleaseSearchNames(f.pools, f.context);
  f.rows[0]!.reverse();
  await expect(readReleaseSearchNames({ ...f, cut, after: null, size: 2 })).rejects.toBeInstanceOf(
    ReleaseGroupingUnavailable,
  );
  f.homes[1]!.partition = 0;
  await expect(observeReleaseSearchNames(f.pools, f.context)).rejects.toBeInstanceOf(ReleaseGroupingUnavailable);
});
