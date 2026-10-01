import { expect, test } from 'bun:test';
import { candidateItems, candidatePropertyLabels, readCandidateNameRecords } from '../src/modules/wiki/candidates.ts';
import { propertyRevelationRecord } from '../src/modules/reading-position/store.ts';

const id = (n: number) => `https://rezics.com/id/00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

test('G931-M2: property names use exact revelation identities before matching across languages and predicates', async () => {
  const properties = ['https://schema.org/name', 'https://schema.org/alternateName',
    'http://www.w3.org/2004/02/skos/core#prefLabel', 'http://www.w3.org/2004/02/skos/core#altLabel']
    .flatMap(predicate => ['en', 'fr'].map(language => ({ predicate,
      value: { kind: 'language-string', lexical: 'Shared alias', language } })));
  const early = propertyRevelationRecord(id(1), properties[0]!.predicate, properties[0]!.value);
  const requested: string[][] = [];
  const boundary = { visible: async (records: readonly string[]) => {
    requested.push([...records]);
    return new Set(records.filter(record => record === early));
  } };
  expect(await candidatePropertyLabels(boundary, id(1), properties)).toEqual(['Shared alias']);
  expect(new Set(requested[0]).size).toBe(8);
  expect(await candidatePropertyLabels(boundary, id(2), properties)).toEqual([]);
  const matches = [new Set([id(1)])];
  expect(candidateItems(matches, new Map([[id(1), true]]))[0]?.status).toBe('matched');
});

test('G931-M2: separate name records are position filtered before collisions affect status or identities', async () => {
  const session = { query: async (query: string, limit: number) => {
    expect(query).toContain('SELECT ?resource ?label ?name');
    expect(limit).toBe(128);
    return [1, 2].map(n => ({ resource: { type: 'uri', value: id(n) },
      name: { type: 'uri', value: id(n + 10) }, label: { type: 'literal', value: 'Shared alias' } }));
  } };
  const boundary = { visible: async (records: readonly string[]) => new Set(records.filter(record => record === id(11))) };
  const labels = await readCandidateNameRecords(session, [id(1), id(2)], boundary);
  expect(labels).toEqual(new Map([[id(1), ['Shared alias']], [id(2), []]]));
  const matching = new Set([...labels].filter(([, names]) => names.includes('Shared alias')).map(([resource]) => resource));
  expect(candidateItems([matching], new Map([[id(1), true], [id(2), true]])))
    .toEqual([{ index: 0, status: 'matched', candidates: [id(1)] }]);
  expect(await readCandidateNameRecords(session, [id(1), id(2)], { visible: async () => new Set() }))
    .toEqual(new Map([[id(1), []], [id(2), []]]));
});

test('G931-M2: filtered name records preserve complete-query bounds and fail closed on missing identity', async () => {
  const boundary = { visible: async () => new Set<string>() };
  const row = { resource: { type: 'uri', value: id(1) }, name: { type: 'uri', value: id(11) },
    label: { type: 'literal', value: 'Hidden alias' } };
  await expect(readCandidateNameRecords({ query: async () => Array(65).fill(row) }, [id(1)], boundary))
    .rejects.toThrow('wiki_query_budget');
  await expect(readCandidateNameRecords({ query: async () => [{ resource: row.resource, label: row.label }] }, [id(1)], boundary))
    .rejects.toThrow('wiki_unavailable');
  await expect(candidatePropertyLabels(boundary, id(1), Array(65).fill({
    predicate: 'https://schema.org/alternateName', value: { kind: 'string', lexical: 'Hidden alias' },
  }))).rejects.toThrow('wiki_query_budget');
});
