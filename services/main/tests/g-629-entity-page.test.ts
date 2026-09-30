import { expect, test } from 'bun:test';
import { Value } from 'typebox/value';
import { mkdtempSync, rmSync } from 'node:fs';
import {
  entityPage,
  entitySection,
  ENTITY_PAGE_COST,
} from '../src/modules/entity-page/contract.ts';
import {
  baseSections,
  pageRegistry,
  pageSections,
  visibleResourceReferences,
} from '../src/modules/entity-page/read.ts';
import { admittedTypes } from '../src/modules/types/registry.ts';
import type { Base, ResolvedTarget } from '../src/modules/target/contract.ts';
import {
  checkedComponentState,
  readCurrentComponent,
  ownedTriples,
  term,
  type ResourceState,
} from '../src/modules/semantic/change.ts';
import { PROFILES } from '../src/modules/semantic/schema.ts';
import {
  acceptedStatementPattern,
  SUBJECT_STATEMENT_COST,
} from '../src/modules/statement/subject-read.ts';
import { FusekiClient } from '../src/infrastructure/fuseki.ts';
import { prepareComponent, RV } from '../src/modules/work/activate.ts';
import { openApiOperations } from '../src/routes/entity-pages.ts';
import { WorkReadSession } from '../src/modules/work/read-session.ts';
import type { MainWorkDependencies } from '../src/routes/dependencies.ts';

const id = (n: number) =>
  `https://rezics.com/id/00000000-0000-4000-8000-${n.toString().padStart(12, '0')}`;
const target = (base: Base, types: string[]): ResolvedTarget => ({
  resource: id(1),
  base,
  types,
  work: base === 'resource' ? null : id(1),
  revision: id(2),
  disclosure: 'public',
});

test('G-629: base × registry presentation matrix admits only bound sections and never falls back to books', () => {
  const expected: Record<Base, string[]> = {
    work: [
      'statements',
      'releases',
      'contents',
      'relations',
      'credits',
      'ratings',
      'reviews',
      'discussion',
      'lists',
    ],
    release: ['statements', 'relations', 'credits', 'ratings', 'reviews', 'discussion', 'lists'],
    realization: ['statements', 'relations', 'discussion', 'lists'],
    occurrence: ['statements', 'relations', 'discussion', 'lists'],
    resource: ['statements', 'relations', 'discussion', 'lists'],
  };
  for (const base of Object.keys(expected) as Base[]) {
    for (const entry of [
      ...admittedTypes,
      { type: 'https://example.org/Unregistered', presentation: 'default', base },
    ]) {
      const resolved = target(base, [entry.type]);
      const registry = pageRegistry(resolved);
      const sections = pageSections(resolved);
      const typeSection =
        base === 'work' &&
        entry.base === base &&
        ['recipe', 'prompt', 'skill'].includes(entry.presentation)
          ? entry.presentation
          : null;
      expect(sections.map((section) => section.id) as string[]).toEqual(
        typeSection ? [expected[base][0], typeSection, ...expected[base].slice(1)] : expected[base],
      );
      expect(sections.every((section) => Value.Check(entitySection, section))).toBe(true);
      expect(new Set(sections.map((section) => section.id)).size).toBe(sections.length);
      expect(
        sections.every((section) => section.actions.length === 0 && section.count === undefined),
      ).toBe(true);
      const registryBase = base === 'work' || base === 'resource' ? base : 'record';
      if (entry.base !== registryBase || entry.type.endsWith('/Unregistered'))
        expect(registry.default).toBe(true);
      if (entry.type.endsWith('/Unregistered')) expect(registry.presentation).toBe('default');
      expect(sections.length).toBeLessThanOrEqual(ENTITY_PAGE_COST.maxSections);
    }
    expect([...baseSections[base]] as string[]).toEqual(expected[base]);
  }
});

test('G-629: registry precedence and component types cannot retarget a Work or grant book presentation', () => {
  const game = target('work', ['https://schema.org/VideoGame', 'https://example.org/Unknown']);
  expect(pageRegistry(game).presentation).toBe('game');
  expect(pageRegistry(target('resource', ['https://schema.org/Book'])).presentation).toBe(
    'default',
  );
  const prompt = target('work', [
    'https://schema.org/Book',
    'https://rezics.com/vocab/PromptTemplate',
  ]);
  expect(pageSections(prompt).find((section) => section.id === 'prompt')?.href).toBe(
    `/v1/hub/works/${id(1).slice(-36)}`,
  );
  expect(
    pageSections(target('work', ['https://schema.org/Recipe'])).find(
      (section) => section.id === 'recipe',
    )?.href,
  ).toBe(`/v1/recipes/works/${id(1).slice(-36)}`);
  expect(
    pageSections(target('resource', ['https://example.org/Unknown'])).map(
      (section) => section.href,
    ),
  ).toEqual([
    `/v1/resources/${id(1).slice(-36)}/statements`,
    `/v1/resources/${id(1).slice(-36)}/relations`,
    `/v1/resources/${id(1).slice(-36)}/discussion`,
    `/v1/resources/${id(1).slice(-36)}/collection-member`,
  ]);
});

test('G-629: read contracts expose optional bearer, fixed projection profile and bounded traversal cost', () => {
  expect(entityPage.properties.profile.const).toBe('entity-page-v1');
  expect(openApiOperations).toEqual({
    '/v1/resources/{id}/page': { get: { bearer: false } },
    '/v1/resources/{id}/statements': { get: { bearer: false } },
  });
  expect(SUBJECT_STATEMENT_COST.inventoryQueries).toBe(2);
  expect(Number(SUBJECT_STATEMENT_COST.candidates)).toBe(SUBJECT_STATEMENT_COST.pageSize + 1);
  const inherited = acceptedStatementPattern(id(10), true);
  expect(inherited).toContain('rv:Withdrawn');
  expect(inherited).toContain('rv:QualifiedFactTarget');
  expect(inherited).toContain('rv:support ?support');
  expect(inherited).toContain('rv:statementState rv:Active');
  expect(acceptedStatementPattern(id(10), false)).not.toContain('inherited-global');
  expect(checkedComponentState({ component: 'resource', types: [], properties: [] })).toEqual({
    component: 'resource',
    types: [],
    properties: [],
    lifecycle: 'active',
  });
});

test('G-629: 500 native value/qualifier/source references use eight owner batches and withhold denied identities', async () => {
  const resources = Array.from({ length: 500 }, (_, index) => id(index + 1));
  const hidden = new Set(resources.filter((_, index) => index % 64 === 0));
  const graph = new FusekiClient('http://graph.invalid');
  const batches: string[][] = [];
  graph.query = async (query) => {
    const requested = resources.filter((resource) => query.includes(`<${resource}>`));
    batches.push(requested);
    return {
      results: {
        bindings: requested.map((resource) => ({
          epoch: { type: 'literal' as const, value: 'epoch' },
          sequence: { type: 'literal' as const, value: '1' },
          r: { type: 'uri' as const, value: resource },
          type: { type: 'literal' as const, value: 'work' },
          work: { type: 'uri' as const, value: resource },
          head: { type: 'uri' as const, value: id(600) },
          public: { type: 'literal' as const, value: 'false' },
          erased: { type: 'literal' as const, value: 'false' },
          label: { type: 'literal' as const, value: 'Qualified target', 'xml:lang': 'en' },
        })),
      },
    };
  };
  let accessBatches = 0;
  const deps: MainWorkDependencies = {
    environment: {
      fuseki: graph,
      objectDirectory: '.temp/g-629-batch',
      lineage: { dataEpoch: 'epoch', routingEpoch: 'routing' },
    },
    access: {} as never,
    account: {} as never,
    mediaAccess: {
      canReadWorks: async (_principal, _actor, values) => {
        accessBatches++;
        return new Set(values.filter((value) => !hidden.has(value)));
      },
      canReadSemantics: async () => new Set(),
      canReadPrivateContexts: async () => new Set(),
    },
  };
  const session = new WorkReadSession(
    deps,
    new Request('http://main.local/v1/resources'),
    { actingSubject: id(999) },
    { dataEpoch: 'epoch', sequence: '1' },
  );
  session.principal = { issuer: 'https://account.test', subject: 'reader' };
  const visible = await visibleResourceReferences(session, resources);
  expect([...visible]).toEqual(resources.filter((resource) => !hidden.has(resource)));
  expect(batches).toHaveLength(8);
  expect(accessBatches).toBe(8);
  expect(batches.every((batch) => batch.length <= 64)).toBe(true);
});

test('G-629: semantic component projection checks preserve structural Work types and detect owned corruption', async () => {
  const directory = mkdtempSync('.temp/g-629-projection-');
  try {
    const state: ResourceState = {
      component: 'resource',
      lifecycle: 'active',
      types: ['https://example.org/Component'],
      properties: [
        { predicate: 'https://example.org/fact', value: { kind: 'integer', lexical: '0' } },
      ],
    };
    const manifest = `urn:rezics:sha256:${prepareComponent(directory, id(1), state, PROFILES.resource)}`;
    const graph = new FusekiClient('http://graph.invalid');
    let corrupt = false;
    graph.query = async (query) => {
      if (query.includes('SELECT ?head ?manifest'))
        return {
          results: {
            bindings: [
              {
                head: { type: 'uri', value: id(2) },
                manifest: { type: 'uri', value: manifest },
              },
            ],
          },
        };
      expect(query).toContain(
        `FILTER(?p != <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> || ?o IN (`,
      );
      expect(query).not.toContain('schema.org/CreativeWork');
      const rows = ownedTriples(id(1), state, id(2)).map((triple) => {
        const split = triple.indexOf('> ');
        const value = triple.slice(split + 2);
        return {
          p: { type: 'uri' as const, value: triple.slice(1, split) },
          o: value.startsWith('<')
            ? { type: 'uri' as const, value: value.slice(1, -1) }
            : {
                type: 'literal' as const,
                value: '0',
                datatype: 'http://www.w3.org/2001/XMLSchema#integer',
              },
        };
      });
      if (corrupt) rows.pop();
      return { results: { bindings: rows } };
    };
    const env = {
      fuseki: graph,
      objectDirectory: directory,
      lineage: { dataEpoch: 'epoch', routingEpoch: 'routing' },
    };
    expect((await readCurrentComponent(env, id(1), 'resource'))?.state).toEqual(state);
    corrupt = true;
    await expect(readCurrentComponent(env, id(1), 'resource')).rejects.toThrow(
      'semantic projection differs',
    );
    expect(
      term({ type: 'literal', value: 'unfamiliar', datatype: 'https://example.org/ExactDatatype' }),
    ).toBe('"unfamiliar"^^<https://example.org/ExactDatatype>');
    expect(RV).toBe('https://rezics.com/vocab/');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
