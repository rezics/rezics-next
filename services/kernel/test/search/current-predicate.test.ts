import { expect, test } from 'bun:test';
import {
  currentPredicateFacetHits,
  kindWitnessCounts,
  predicateIdentity,
  selectCurrentPredicatePage,
} from '../../src/search/current-predicate.ts';

const key = (kind: string, n: number) => ({
  owner: 'semantic' as const,
  kind,
  id: `018f0000-0000-7000-8000-00a00000000${n}`,
});
const hit = (kind: string, n: number) => ({ key: key(kind, n) });

test('current disclosure drops hidden and taken-down engine rows while keeping remaining order', () => {
  const visible = [hit('schema:Book', 1), hit('schema:Book', 3)];
  const examined = [0, 1, 2, 3];
  const disclosed = new Map<number, (typeof visible)[number]>([
    [0, visible[0]!],
    [3, visible[1]!],
  ]);
  const page = selectCurrentPredicatePage(examined, disclosed, { limit: 2, exhausted: false });
  expect(page.hits.map((row) => row.key.id)).toEqual([visible[0]!.key.id, visible[1]!.key.id]);
  expect(page.dropped).toBe(2);
  expect(page.useful).toBe(true);
  expect([...kindWitnessCounts(page.witnesses)]).toEqual([['schema:Book', 2]]);
});

test('a public-to-private change during paused indexing excludes the stale positive without reordering survivors', () => {
  const publicBook = hit('schema:Book', 1);
  const privateBook = hit('schema:Book', 2);
  const later = hit('schema:Recipe', 3);
  const examined = [publicBook, privateBook, later];
  const disclosed = new Map([
    [publicBook, publicBook],
    [later, later],
  ]);
  const page = selectCurrentPredicatePage(examined, disclosed, { limit: 2, exhausted: true });
  expect(page.hits).toEqual([publicBook, later]);
  expect(page.dropped).toBe(1);
  expect(page.exhausted).toBe(true);
  expect(predicateIdentity(privateBook.key).includes(privateBook.key.id)).toBe(true);
});

test('facet consumers reuse the same disclosed identities as the hit page', () => {
  const first = hit('schema:Book', 1);
  const second = hit('schema:Book', 2);
  const page = selectCurrentPredicatePage([first, second, first], new Map([[first, first], [second, second]]), {
    limit: 2,
    exhausted: true,
  });
  expect(currentPredicateFacetHits(page)).toBe(page.hits);
  expect(page.dropped).toBe(1);
  expect([...page.witnesses.get('schema:Book')!]).toEqual([first.key.id, second.key.id]);
});

test('an unfilled window without exhaustion is not a useful page', () => {
  const only = hit('schema:Book', 1);
  const page = selectCurrentPredicatePage([only], new Map([[only, only]]), { limit: 2, exhausted: false });
  expect(page.hits).toHaveLength(1);
  expect(page.useful).toBe(false);
  expect(page.consumed).toBe(1);
});

test('a filled page consumes trailing rejects and duplicates but not unused useful lookahead', () => {
  const first = hit('schema:Book', 1);
  const hidden = hit('schema:Book', 2);
  const second = hit('schema:Book', 3);
  const alias = hit('schema:Book', 1);
  const later = hit('schema:Recipe', 4);
  const examined = [first, hidden, second, alias, later];
  const page = selectCurrentPredicatePage(
    examined,
    new Map([
      [first, first],
      [second, second],
      [alias, first],
      [later, later],
    ]),
    { limit: 2, exhausted: false },
  );
  expect(page.hits).toEqual([first, second]);
  expect(page.consumed).toBe(4);
  expect(page.dropped).toBe(2);
});
