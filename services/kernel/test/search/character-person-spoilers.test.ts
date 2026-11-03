import { expect, test } from 'bun:test';
import { bundledRelease } from '@rezics/definitions/bundled';
import { readNativeSpoilerLevel, type FilterDocument } from '@rezics/filter';
import { normalizeSourceStatement } from '../../src/semantic/scope-leaf-selection.ts';
import { holdsCurrentStatements } from '../../src/search/current-leaf.ts';
import { checkHits } from '../../src/search/disclosure/check.ts';
import type { IndexedSubject, SubjectSource } from '../../src/search/source.ts';

const id = (n: number) => `018f0000-0000-7000-8000-00a0${String(n).padStart(8, '0')}`;
const property = 'schema:character';
const spoiler = 'rezics:spoilerLevel';
const statement = (amount: string) =>
  normalizeSourceStatement(
    property,
    {
      value: { type: 'value', content: id(2) },
      qualifiers: [{ property: spoiler, value: { type: 'value', content: { amount, unit: '1' } } }],
    },
    bundledRelease.properties,
  )!;

test('native spoiler quantities preserve exact levels and never manufacture a missing value', () => {
  for (const level of [0, 1, 2])
    expect(statement(`+${level}.00`).qualifiers).toEqual([{ property: spoiler, value: String(level) }]);
  for (const content of [
    null,
    { amount: '+1', unit: 'unit:ONE' },
    { amount: '+1.000000000000000001', unit: '1' },
    { amount: '+1', unit: '1', upperBound: '+2' },
    { amount: '+3', unit: '1' },
    { amount: '1e0', unit: '1' },
  ])
    expect(readNativeSpoilerLevel(content)).toBeNull();
  expect(
    normalizeSourceStatement(property, { value: { type: 'value', content: id(2) } }, bundledRelease.properties)
      ?.qualifiers,
  ).toBeUndefined();
});

test('current raised or removed spoiler evidence retires a stale hit and stays unknown through NOT', async () => {
  const subject: IndexedSubject = {
    id: id(1),
    type: 'schema:Movie',
    visibility: 'visible',
    redirect: null,
    securityRevision: 1,
    labels: [],
    aliases: [],
    descriptions: [],
    statements: [statement('+0')],
    relationFacetOverflow: [property],
  };
  let current = [statement('+0')];
  const source: SubjectSource = {
    read: async () => ({ partition: 10, position: 1n, subjects: [subject] }),
    count: async () => ({ position: 1n, count: 1 }),
    matchRelationFacets: async (_, probes) =>
      probes.map((probe) =>
        holdsCurrentStatements(current, {
          facet: 'statement',
          property: probe.property,
          values: [probe.value],
          qualifiers: probe.qualifiers,
        })
          ? true
          : 'not_proven',
      ),
  };
  const hit = { id: subject.id, partition: 10, securityRevision: 1, matched: [] };
  const leaf = { statement: { property, in: [id(2)], qualifiers: [{ property: spoiler, in: ['0', '1'] }] } };
  const read = (filter: FilterDocument) =>
    checkHits(source, [hit], new Map(), { filter, relationProperties: [property] });
  expect((await read(leaf)).passed).toHaveLength(1);
  for (const replacement of [[statement('+2')], []]) {
    current = replacement;
    expect((await read(leaf)).passed).toEqual([]);
    expect((await read({ not: leaf })).passed).toEqual([]);
  }
});
