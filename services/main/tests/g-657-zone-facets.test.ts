import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { Value } from 'typebox/value';
import { resolveFacet } from '../src/modules/facets/registry.ts';
import { compileQuery, QueryRejected, type QueryRefusal } from '../src/modules/query/compile.ts';
import { browseWindow, compileZoneBrowse, filterDocument } from '../src/modules/zone-modules/browse.ts';
import { zoneBrowsePage, zoneBrowseQuery, zoneWork } from '../src/modules/zone-modules/contract.ts';

const realm = 'https://rezics.com/id/00000000-0000-4000-8000-000000000001';
const concept = realm.replace(/1$/, '2');
const base = { profile: 'filter-document-v2' as const, context: { realm },
  scope: { kind: 'realm' as const, realm }, sort: 'newest' as const, page: { size: 20 } };

function refused(filter: NonNullable<Parameters<typeof compileQuery>[0]['filter']>,
  refusal: QueryRefusal = 'unsupported_query_shape') {
  try { compileQuery({ ...base, filter }); throw new Error('Condition was admitted'); }
  catch (error) {
    expect(error).toBeInstanceOf(QueryRejected);
    expect((error as QueryRejected).refusal).toBe(refusal);
  }
}

test('G657: every browse parameter and response Facet resolves through the admitted registry', () => {
  const controls = ['language', 'limit', 'cursor', 'q', 'sort'];
  for (const parameter of Object.keys(zoneBrowseQuery.properties)) {
    if (controls.includes(parameter)) continue;
    const facet = resolveFacet(parameter === 'excludeConcept' ? 'concept' : parameter);
    expect(facet).toBeDefined();
    expect(facet!.appliesTo).toBe('resource');
  }
  const counts = browseWindow([], {}, null, 'newest').facets;
  expect(Object.keys(counts).sort()).toEqual(Object.keys(zoneBrowsePage.properties.facets.properties).sort());
  for (const name of Object.keys(counts)) expect(resolveFacet(name)).toBeDefined();
  expect(zoneWork.properties).not.toHaveProperty('mod');
  for (const file of ['contract', 'browse', 'read']) {
    const source = readFileSync(new URL(`../src/modules/zone-modules/${file}.ts`, import.meta.url), 'utf8');
    expect(source).not.toMatch(/modules\/package|\.\.\/package|zoneModCard|zoneBrowseFacets|Minecraft/);
  }
  for (const parameter of ['loader', 'gameVersion', 'environment', 'requiredDependency']) {
    expect(Value.Check(zoneBrowseQuery, { [parameter]: ['Fabric'] })).toBe(false);
  }
});

test('G657: GET and POST share status, concept any/none and arbitrary length range admission', () => {
  const query = { type: ['https://schema.org/Book'], concept: [concept], excludeConcept: [realm],
    status: ['completed' as const], length: '100-200', limit: 20 };
  const get = compileZoneBrowse(realm, query);
  expect(get).toEqual(compileQuery({ ...base, filter: filterDocument({ type: query.type,
    concept: query.concept, conceptExclude: query.excludeConcept, status: query.status,
    length: { min: '100', max: '200' } }) }));
  expect(get).toMatchObject({ template: 'zone-browse', request: query, graphReads: 5 });
  expect(get.facets).toHaveLength(4);
  for (const name of ['concept', 'status']) {
    const value = name === 'concept' ? concept : 'hiatus';
    const compiled = compileQuery({ ...base, filter: { all: [
      { facet: resolveFacet(name)!.id, none: [value] },
    ] } });
    expect(compiled).toMatchObject({ template: 'zone-browse', request: {
      [name === 'concept' ? 'excludeConcept' : 'excludeStatus']: [value],
    } });
  }
  for (const range of [{ min: '0' }, { max: '0' }, { min: '123', max: '456' }]) {
    const compiled = compileQuery({ ...base, filter: { all: [{ facet: 'length', range }] } });
    expect(compiled.template).toBe('zone-browse');
    if (compiled.template !== 'zone-browse') throw new Error('Wrong template');
    expect(compileZoneBrowse(realm, compiled.request)).toEqual(compiled);
  }
});

test('G657: unadmitted and unsupported Facets, operators and duplicate Conditions refuse', () => {
  refused({ all: [{ facet: 'modLoader', any: ['Fabric'] }] }, 'invalid_query');
  refused({ all: [{ facet: 'language', any: ['en'] }] });
  refused({ all: [{ facet: 'type', none: ['https://schema.org/Book'] }] });
  refused({ all: [{ facet: 'concept', all: [concept] }] });
  refused({ all: [{ facet: 'status', any: ['ongoing'] }, { facet: 'status', any: ['completed'] }] });
  refused({ all: [{ facet: 'length', range: { min: '10' } }, { facet: 'length', range: { max: '20' } }] });
});

test('G657: status values use registry admission, and unknown Facets have the same refusal in every scope', () => {
  expect(Value.Check(zoneBrowseQuery, { status: ['unregistered-status'] })).toBe(true);
  expect(zoneBrowseQuery.properties.status.items).not.toHaveProperty('anyOf');
  expect(zoneBrowseQuery.properties.status.items).not.toHaveProperty('pattern');
  for (const scope of [{ kind: 'all' as const }, base.scope]) {
    try {
      compileQuery({ ...base, scope, filter: { all: [{ facet: 'unregistered-facet', any: ['x'] }] } });
      throw new Error('Unknown Facet was admitted');
    } catch (error) {
      expect(error).toBeInstanceOf(QueryRejected);
      expect((error as QueryRejected).refusal).toBe('invalid_query');
    }
  }
  expect(() => compileZoneBrowse(realm, { status: ['unregistered-status'] })).toThrow(QueryRejected);
});
