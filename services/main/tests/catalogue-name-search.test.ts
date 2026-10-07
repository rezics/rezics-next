import { expect, test } from 'bun:test';
import type { WorkActivationEnvironment } from '../src/modules/work/activate.ts';
import type { PublicTextPosition } from '../src/modules/work/search-readiness.ts';
import { searchGraphSnapshot } from '../src/modules/search/snapshot-state.ts';
import { readRankedCatalogue } from '../src/modules/search/ranked.ts';
import { queryPublicMainTitleBody } from '../src/modules/work/search-multifield.ts';
import { TEXT_INDEX_PROBE_TITLE, TEXT_INDEX_PROBE_GRAPH } from '../src/modules/work/activate.ts';
const id = (n: number) =>
  `https://rezics.com/id/00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const b = (value: string) => ({ type: 'literal', value });
const position: PublicTextPosition = {
  dataEpoch: 'epoch',
  sequence: '9',
  generation: 'urn:rezics:text-index-generation:11111111-1111-4111-8111-111111111111',
  population: 1,
  serverInstanceId: '11111111-1111-4111-8111-111111111111',
  publicSearchWriteEpoch: '0',
};
test('Complete name catalogue hits keep their cursor while hydrating the selected body unit', async () => {
  const name = 'urn:rezics:search:name:work:' + id(1).split('/').at(-1);
  const unit = 'urn:rezics:unit:selected-body';
  const queries: string[] = [];
  const env = {
    lineage: { dataEpoch: 'epoch', routingEpoch: 'route' },
    fuseki: {
      query: async (query: string) => {
        queries.push(query);
        if (query.includes('rv:rankedText'))
          return {
            results: {
              bindings: [
                {
                  epoch: b('epoch'),
                  sequence: b('9'),
                  generation: b(position.generation),
                  page: b(
                    JSON.stringify({
                      hits: [{ id: name, unit, key: id(2), score: '2000000', document: 5 }],
                      more: false,
                      commit: '7',
                    }),
                  ),
                },
              ],
            },
          };
        expect(query).toContain(`VALUES ?unit { <${unit}> }`);
        expect(query).not.toContain(`VALUES ?unit { <${name}> }`);
        return {
          results: {
            bindings: [
              {
                unit: b(unit),
                work: b(id(1)),
                main: b(id(2)),
                contribution: b(id(3)),
                revision: b(id(4)),
                selection: b(id(5)),
                language: b('en'),
              },
            ],
          },
        };
      },
    },
  } as unknown as WorkActivationEnvironment;
  const result = await searchGraphSnapshot.run(
    { clients: new Set([env.fuseki]), lineage: env.lineage, position },
    () =>
      readRankedCatalogue(env, { phrase: 'Alias beyond body cache', language: null, pageSize: 1 }),
  );
  expect(result.results).toEqual([
    {
      matchUnit: unit,
      work: id(1),
      mainVersion: id(2),
      contribution: id(3),
      revision: id(4),
      selection: id(5),
      language: 'en',
      score: 2000000,
    },
  ]);
  expect(result.count).toEqual({ value: 1, precision: 'exact' });
  expect(queries).toHaveLength(2);
});
test('Title and body matching binds complete names to each admitted body candidate', async () => {
  const queries: string[] = [];
  const env = {
    lineage: { dataEpoch: 'epoch', routingEpoch: 'route' },
    fuseki: {
      commandHealth: async () => ({
        instanceId: position.serverInstanceId,
        publicSearchWriteEpoch: '0',
        publicSearchWriteActive: false,
      }),
      query: async (query: string) => {
        if (query.includes('SELECT ?literal ?graph'))
          return {
            results: {
              bindings: [{ literal: b(TEXT_INDEX_PROBE_TITLE), graph: b(TEXT_INDEX_PROBE_GRAPH) }],
            },
          };
        queries.push(query);
        expect(query).toContain('rv:rankedText(rv:publicTitle');
        expect(query).not.toContain('text:query (rv:publicTitle');
        expect(query).toContain('text:query (rv:searchBody');
        expect(query).toContain('STR(?work)');
        return {
          results: {
            bindings: [
              {
                epoch: b('epoch'),
                sequence: b('9'),
                indexGeneration: b(position.generation),
                titleCount: b('0'),
                bodyCount: b('1'),
                unit: b('urn:rezics:unit:body'),
                titleScore: b('1000000'),
                bodyScore: b('1'),
                work: b(id(1)),
                main: b(id(2)),
                contribution: b(id(3)),
                revision: b(id(4)),
                selection: b(id(5)),
                language: b('en'),
              },
            ],
          },
        };
      },
    },
  } as unknown as WorkActivationEnvironment;
  const result = await searchGraphSnapshot.run(
    { clients: new Set([env.fuseki]), lineage: env.lineage, position },
    () =>
      queryPublicMainTitleBody(env, {
        titleTerm: 'Alias beyond body cache',
        bodyTerm: 'Body phrase',
        language: null,
      }),
  );
  expect(result.total).toBe(1);
  expect(result.results[0]?.work).toBe(id(1));
  expect(queries).toHaveLength(1);
});
