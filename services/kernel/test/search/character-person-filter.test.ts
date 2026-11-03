import { expect, test } from 'bun:test';
import { admitFilter, parseFilter, type FilterRelease } from '@rezics/filter';
import { compileCurrentFilter } from '../../src/search/current-filter-plan.ts';
import { holdsCurrentStatements } from '../../src/search/current-leaf.ts';
import { checkHits } from '../../src/search/disclosure/check.ts';
import { compileFilter } from '../../src/search/filter.ts';
import type { IndexedSubject, SubjectSource } from '../../src/search/source.ts';

const id = (n: number) => `018f0000-0000-7000-8000-00a0${String(n).padStart(8, '0')}`;
const property = 'wdt:P725';
const role = 'wdt:P3831';
const character = 'wdt:P453';
const release: FilterRelease = {
  types: { 'schema:Person': {}, 'schema:Movie': { facets: [property] } },
  properties: {
    [property]: { datatype: 'wikibase-item', relation: { group: 'credit' }, qualifiers: [role, character] },
    [role]: { datatype: 'wikibase-item' },
    [character]: { datatype: 'wikibase-item' },
  },
};
const selected = (portrayed: string) => ({
  statement: {
    property,
    inverse: true,
    in: [id(2)],
    qualifiers: [
      { property: role, in: [id(3)] },
      { property: character, in: [portrayed] },
    ],
  },
});
const actor: IndexedSubject = {
  id: id(1),
  type: 'schema:Person',
  visibility: 'visible',
  redirect: null,
  securityRevision: 1,
  labels: [],
  aliases: [],
  descriptions: [],
  statements: [],
};
const hit = { id: actor.id, partition: 10, securityRevision: 1, matched: [] };
const type = { type: { in: [actor.type] } };

function fixture() {
  let position = 1n;
  let head = 1;
  let current = actor;
  let available = true;
  const calls: string[] = [];
  const source: SubjectSource = {
    read: async () => ({ partition: 10, position, subjects: [current] }),
    count: async () => ({ position, count: 1 }),
    matchRelationFacets: async (_, probes) => {
      const statements = [id(4), id(5)].map((portrayed) => ({
        property,
        value: actor.id,
        qualifiers: [
          { property: role, value: id(3) },
          { property: character, value: portrayed },
        ],
      }));
      return probes.map((probe) => {
        calls.push(probe.subject);
        return (
          available &&
          probe.subject === id(2) &&
          holdsCurrentStatements(statements, {
            facet: 'statement',
            property: probe.property,
            values: [probe.value],
            qualifiers: probe.qualifiers,
          })
        );
      });
    },
  };
  return {
    source,
    calls,
    observeRelationRelease: async () => ({ digest: 'release', head, release }),
    hideWork: () => {
      available = false;
    },
    mutate: () => {
      position++;
      current = { ...current, securityRevision: 2 };
    },
    replaceRelease: () => {
      head++;
    },
  };
}
async function lookup(f: ReturnType<typeof fixture>, input: unknown) {
  const filter = admitFilter(parseFilter(input), release, { inverse: true });
  const compiled = compileFilter(filter, { prefix: 'f', relationOverflow: true });
  return checkHits(f.source, [hit], new Map(compiled.leaves.map((leaf) => [leaf.name, leaf])), {
    filter,
    relationProperties: [property],
    observeRelationRelease: f.observeRelationRelease,
  });
}

test('inverse filters retain both polarities and repeated credits through the current Boolean matcher', async () => {
  const f = fixture();
  expect((await lookup(f, { and: [type, selected(id(4)), selected(id(5))] })).passed).toHaveLength(1);
  expect(f.calls).toEqual([id(2), id(2)]);
  const filter = parseFilter({ and: [type, { not: selected(id(6)) }] });
  const compiled = compileFilter(filter, { prefix: 'f' });
  expect(compiled.query).toEqual({
    bool: { filter: [{ terms: { type: [actor.type], _name: 'f0' } }, { match_all: { _name: 'f1' } }] },
  });
  expect((await lookup(f, filter)).passed).toEqual([]);
  f.hideWork();
  expect((await lookup(f, { and: [type, { not: selected(id(4)) }] })).passed).toEqual([]);
  expect((await lookup(f, { or: [type, { not: selected(id(4)) }] })).passed).toHaveLength(1);
  const forward = { statement: { property, in: [id(2)], qualifiers: selected(id(4)).statement.qualifiers } };
  expect(compileCurrentFilter({ and: [parseFilter(selected(id(4))), parseFilter(forward)] }).leaves).toHaveLength(2);
});

test('candidate and release changes retire the complete inverse disclosure window', async () => {
  for (const mutation of ['mutate', 'replaceRelease'] as const) {
    const f = fixture();
    const match = f.source.matchRelationFacets!;
    f.source.matchRelationFacets = async (partition, probes) => {
      const results = await match(partition, probes);
      f[mutation]();
      return results;
    };
    const result = await lookup(f, { and: [type, selected(id(4))] });
    expect(result.passed).toEqual([]);
    expect(result.relationRejected).toBe(true);
  }
});
