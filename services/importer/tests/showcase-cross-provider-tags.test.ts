import { expect, test } from 'bun:test';
import { projectShowcaseTagTables } from '../src/showcase-tags.ts';
import { parseAuthoredVndbCopy } from '../src/vndb-public-tags.ts';
import type { CrossMediaTables } from '../src/cross-media-seed.ts';

function tables(parents: string[], categories: Record<string, string>): CrossMediaTables {
  const records: Record<string, Record<string, unknown>[]> = {
    'tags_vn': [{ tag: 'g1', vid: 'v2002', vote: '3', spoiler: '1', ignore: 'f', lie: 'f' }],
    tags: parseAuthoredVndbCopy('tags',
      'id\tcat\tdefaultspoil\tsearchable\tapplicable\tname\talias\tdescription',
      Object.entries(categories).map(([id, cat]) => `${id}\t${cat}\t0\tt\tt\tSame label\t\\N\t\\N`)),
    tags_parents: parseAuthoredVndbCopy('tags_parents', 'id\tparent\tmain', parents),
  };
  return { async *rows(provider, table) { if (provider === 'vndb') yield* records[table] ?? []; } };
}

// These are imported-row controls, not native hierarchy or shared-binding acceptance.
test('selected parent evidence preserves exact source keys and preferred-parent meaning on changed input', async () => {
  const source = tables(['g1\tg2\tf'], { g1: 'cont', g2: 'cont' });
  const first = await projectShowcaseTagTables(source, ['v2002']);
  expect(first.sourceParents).toEqual([
    { child: 'g1', parent: 'g2', main: false, category: 'cont', path: '/tags_parents/g1/g2' },
  ]);
  expect((await projectShowcaseTagTables(source, ['v2002'])).sourceParents).toEqual(first.sourceParents);
  const changed = await projectShowcaseTagTables(tables(['g1\tg3\tt'], { g1: 'cont', g3: 'cont' }), ['v2002']);
  expect(changed.sourceParents).toEqual([
    { child: 'g1', parent: 'g3', main: true, category: 'cont', path: '/tags_parents/g1/g3' },
  ]);
  // Source evidence alone never enables native parent writes.
  expect(first.gaps.some((gap) => gap.reason.includes('not admitted for native writes'))).toBe(true);
  expect([...await Array.fromAsync(first.tables.rows('vndb', 'tags_parents'))]).toEqual([]);
});

test('a missing ancestor, category crossing or cycle withholds dependent parent evidence despite matching labels', async () => {
  for (const [parents, categories, reason] of [
    [['g1\tg2\tt'], { g1: 'cont' }, 'Missing source tag parent'],
    [['g1\tg2\tt'], { g1: 'cont', g2: 'ero' }, 'crosses Scheme'],
    [['g1\tg2\tt', 'g2\tg3\tt', 'g3\tg2\tf'], { g1: 'cont', g2: 'cont', g3: 'cont' }, 'Cyclic'],
  ] as const) {
    const result = await projectShowcaseTagTables(tables([...parents], categories), ['v2002']);
    expect(result.sourceParents).toEqual([]);
    expect(result.gaps.some((gap) => gap.reason.includes(reason))).toBe(true);
    expect(result.dictionary.has('g1')).toBe(true);
  }
});

test('parent closure stays bounded and excludes ancestry beyond the retained dictionary', async () => {
  const ids = Array.from({ length: 10 }, (_, i) => `g${i + 1}`);
  const result = await projectShowcaseTagTables(tables(
    ids.slice(0, -1).map((id, i) => `${id}\t${ids[i + 1]}\tt`),
    Object.fromEntries(ids.map((id) => [id, 'cont'])),
  ), ['v2002']);
  expect(result.dictionary.size).toBe(9);
  expect(result.sourceParents).toEqual([]);
  expect(result.gaps.some((gap) => gap.reason.includes('Missing source tag parent'))).toBe(true);
});
