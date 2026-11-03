import { expect, test } from 'bun:test';
import { matchCharacterPersonWitnesses } from '../../src/search/character-person-voice.ts';
import { holdsCurrentStatements } from '../../src/search/current-leaf.ts';
import { checkHits } from '../../src/search/disclosure/check.ts';
import type { IndexedStatement, IndexedSubject, RelationFacetProbe, SubjectSource } from '../../src/search/source.ts';

const id = (n: number) => `018f0000-0000-7000-8000-00a0${String(n).padStart(8, '0')}`;
const credit = (character?: string, role = id(8)) => ({
  subject: id(1),
  statement: {
    property: 'wdt:P725',
    value: id(2),
    qualifiers: [
      { property: 'wdt:P3831', value: role },
      ...(character ? [{ property: 'wdt:P453', value: character }] : []),
    ],
  },
});
const probe = (threshold?: 0 | 1 | 2, character?: string): RelationFacetProbe => ({
  subject: id(1),
  property: 'wdt:P725',
  value: id(2),
  ...(threshold === undefined ? {} : { spoilerThreshold: threshold }),
  ...(character ? { qualifiers: [{ property: 'wdt:P453', in: [character] }] } : {}),
});

test('each repeated voice credit needs its own current permitted appearance at thresholds 0/1/2', async () => {
  const rows = [credit(id(3)), credit(id(4)), credit(undefined)];
  let appearances: IndexedStatement[] = [3, 4].map((n) => ({
    property: 'schema:character',
    value: id(n),
    qualifiers: [{ property: 'rezics:spoilerLevel', value: String(n - 2) }],
  }));
  const match = async (probes: readonly RelationFacetProbe[]) =>
    probes.map((p) =>
      holdsCurrentStatements(appearances, {
        facet: 'statement',
        property: p.property,
        values: [p.value],
        qualifiers: p.qualifiers,
      })
        ? true
        : ('not_proven' as const),
    );
  for (const threshold of [0, 1, 2] as const) {
    expect(
      await matchCharacterPersonWitnesses([probe(threshold, id(3)), probe(threshold, id(4))], rows, match),
    ).toEqual([threshold >= 1 ? true : 'not_proven', threshold >= 2 ? true : 'not_proven']);
  }
  // One multi-character credit cannot disclose its hidden second character through the first.
  const combined = credit(id(3));
  combined.statement.qualifiers.push({ property: 'wdt:P453', value: id(4) });
  expect(await matchCharacterPersonWitnesses([probe(1)], [combined], match)).toEqual(['not_proven']);
  expect(await matchCharacterPersonWitnesses([probe(2)], [credit(undefined)], match)).toEqual(['not_proven']);
  expect(await matchCharacterPersonWitnesses([probe()], [credit(undefined)], match)).toEqual([true]);
  appearances[0]!.qualifiers!.push({ property: 'rezics:spoilerLevel', value: '0' });
  expect(await matchCharacterPersonWitnesses([probe(2, id(3))], rows, match)).toEqual(['not_proven']);
  appearances = [];
  expect(await matchCharacterPersonWitnesses([probe(2)], rows, match)).toEqual(['not_proven']);
});

test('appearance batches include sparse late witnesses and reanchor credits after foreign reads', async () => {
  const rows = Array.from({ length: 257 }, (_, n) => credit(id(n + 10)));
  const sizes: number[] = [];
  const match = async (probes: readonly RelationFacetProbe[]) => {
    sizes.push(probes.length);
    return probes.map((p) => (p.value === id(266) ? true : ('not_proven' as const)));
  };
  expect(await matchCharacterPersonWitnesses([probe(0)], rows, match)).toEqual([true]);
  expect(sizes).toEqual([256, 1]);
  expect(await matchCharacterPersonWitnesses([probe(0)], rows, match, async () => [])).toEqual(['not_proven']);
  expect(await matchCharacterPersonWitnesses([probe(0)], rows, match, async () => [credit(id(999))])).toEqual([
    'not_proven',
  ]);
  await expect(matchCharacterPersonWitnesses([probe(0)], rows, async () => [])).rejects.toThrow(
    'Malformed appearance probe results',
  );
});

test('inverse Boolean checks forward the threshold and unavailable appearances remain unknown under NOT', async () => {
  const actor: IndexedSubject = {
    id: id(2),
    type: 'schema:Person',
    visibility: 'visible',
    redirect: null,
    securityRevision: 1,
    labels: [],
    aliases: [],
    descriptions: [],
    statements: [],
  };
  const seen: RelationFacetProbe[] = [];
  const source: SubjectSource = {
    read: async () => ({ partition: 10, position: 1n, subjects: [actor] }),
    count: async () => ({ position: 1n, count: 1 }),
    matchRelationFacets: async (_, probes) => {
      seen.push(...probes);
      return matchCharacterPersonWitnesses(probes, [credit(id(3))], async (ps) => ps.map(() => 'not_proven'));
    },
  };
  const leaf = { statement: { property: 'wdt:P725', inverse: true as const, in: [id(1)] } };
  for (const filter of [leaf, { not: leaf }]) {
    const result = await checkHits(
      source,
      [{ id: actor.id, partition: 10, securityRevision: 1, matched: [] }],
      new Map(),
      {
        filter,
        spoilerThreshold: 0,
        relationProperties: ['wdt:P725'],
        observeRelationRelease: async () => ({ digest: 'release', head: 1, release: { types: {}, properties: {} } }),
      },
    );
    expect(result.passed).toEqual([]);
    expect(result.relationRejected).toBe(true);
  }
  expect(seen).toEqual([probe(0), probe(0)]);
});
