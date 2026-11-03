import { expect, test } from 'bun:test';
import type { FilterDocument } from '@rezics/filter';
import { holdsCurrentStatements } from '../../src/search/current-leaf.ts';
import { checkHits } from '../../src/search/disclosure/check.ts';
import type { IndexedStatement, IndexedSubject, RelationFacetProbe, SubjectSource } from '../../src/search/source.ts';

const id = (n: number) => `018f0000-0000-7000-8000-00a0${String(n).padStart(8, '0')}`;
const property = 'wdt:P725';
const qualifier = (property: string, value: string) => ({ property, value });
const credit = (role: string, character: string): IndexedStatement => ({
  property,
  value: id(2),
  qualifiers: [qualifier('wdt:P3831', role), qualifier('wdt:P453', character)],
});
const selected = credit(id(3), id(4));
const qualified = {
  statement: {
    property,
    in: [id(2)],
    qualifiers: selected.qualifiers!.map(({ property, value }) => ({ property, in: [value] })),
  },
};
const subject: IndexedSubject = {
  id: id(1),
  type: 'schema:Movie',
  visibility: 'visible',
  redirect: null,
  securityRevision: 1,
  labels: [],
  aliases: [],
  descriptions: [],
  statements: [selected],
  relationFacetOverflow: [property],
};
const hit = { id: subject.id, partition: 10, securityRevision: 1, matched: [] };
const options = (filter: FilterDocument) => ({ filter, relationProperties: [property] });

test('overflow credits forward all qualifiers and never pool repeated actor/character credits', async () => {
  let statements = [credit(id(3), id(5)), credit(id(6), id(4))];
  const calls: RelationFacetProbe[][] = [];
  const source: SubjectSource = {
    read: async () => ({ partition: 10, position: 1n, subjects: [subject] }),
    count: async () => ({ position: 1n, count: 1 }),
    async matchRelationFacets(_, probes) {
      calls.push([...probes]);
      return probes.map((probe) =>
        holdsCurrentStatements(statements, {
          facet: 'statement',
          property: probe.property,
          values: [probe.value],
          qualifiers: probe.qualifiers,
        })
          ? true
          : 'not_proven',
      );
    },
  };
  const filter = { and: [qualified, qualified] };
  expect((await checkHits(source, [hit], new Map(), options(filter))).passed).toEqual([]);
  expect(calls).toEqual([
    [{ subject: subject.id, property, value: id(2), qualifiers: qualified.statement.qualifiers }],
  ]);
  statements = [...statements, selected];
  expect((await checkHits(source, [hit], new Map(), options(filter))).passed.map(({ hit }) => hit.id)).toEqual([
    subject.id,
  ]);
});

test('uncertain qualified credits remain unknown under NOT even without a sample overflow', async () => {
  let calls = 0;
  const source: SubjectSource = {
    read: async () => ({
      partition: 10,
      position: 1n,
      subjects: [{ ...subject, statements: [], relationFacetOverflow: [] }],
    }),
    count: async () => ({ position: 1n, count: 1 }),
    async matchRelationFacets(_, probes) {
      calls++;
      return probes.map(() => 'not_proven');
    },
  };
  const type = { type: { in: [subject.type] } };
  for (const filter of [{ and: [type, { not: qualified }] }, { and: [type, qualified] }]) {
    const result = await checkHits(source, [hit], new Map(), options(filter));
    expect(result.passed).toEqual([]);
    expect(result.relationRejected).toBe(true);
  }
  const filter = { or: [type, { not: qualified }] };
  expect((await checkHits(source, [hit], new Map(), options(filter))).passed).toHaveLength(1);
  expect(calls).toBe(3);
});
