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

test('Realm name continuation advances across empty candidate windows and reaches every adoption', async () => {
  const realm = id(88888);
  const raw = Array.from({ length: 2100 }, (_, n) => ({
    id:
      'urn:rezics:search:name:work:' +
      id(n + 10000)
        .split('/')
        .at(-1),
    key: null as string | null,
    score: '2000000',
    document: n,
  })).concat(
    Array.from({ length: 3 }, (_, n) => ({
      id:
        'urn:rezics:search:name:work:' +
        id(n + 6000)
          .split('/')
          .at(-1),
      key: id(n + 7000),
      score: '2000000',
      document: 2100 + n,
    })),
  );
  const queries: string[] = [];
  let nativeReads = 0;
  const env = {
    lineage: { dataEpoch: 'epoch', routingEpoch: 'route' },
    fuseki: {
      query: async (query: string) => {
        queries.push(query);
        if (query.includes('SELECT ?space'))
          return { results: { bindings: [{ space: b(id(88889)) }] } };
        if (query.includes('rv:rankedText')) {
          nativeReads++;
          const args =
            /rv:rankedText\(rv:searchBody, "(?:[^"\\]|\\.)*", (\d+), ("(?:[^"\\]|\\.)*"),/u.exec(
              query,
            )!;
          expect(args).not.toBeNull();
          const cursor = JSON.parse(args[2]!) as string;
          const after = cursor ? (JSON.parse(cursor) as { document: number }) : null;
          const offset = after ? after.document + 1 : 0;
          const selected = raw
            .slice(offset, offset + Number(args[1]))
            .map((hit) => ({
              ...hit,
              ...(hit.key ? { unit: `urn:rezics:unit:realm:${hit.document - 2100}` } : {}),
            }));
          return {
            results: {
              bindings: [
                {
                  epoch: b('epoch'),
                  sequence: b('9'),
                  generation: b(position.generation),
                  page: b(
                    JSON.stringify({
                      hits: selected,
                      more: offset + selected.length < raw.length,
                      commit: '7',
                    }),
                  ),
                },
              ],
            },
          };
        }
        expect(query).toContain(`rv:realm <${realm}>`);
        const units = [...query.matchAll(/<urn:rezics:unit:realm:(\d+)>/gu)].map((match) =>
          Number(match[1]),
        );
        return {
          results: {
            bindings: units.map((n) => ({
              unit: b(`urn:rezics:unit:realm:${n}`),
              work: b(id(6000 + n)),
              main: b(id(7000 + n)),
              contribution: b(id(8000 + n)),
              revision: b(id(8100 + n)),
              selection: b(id(8200 + n)),
              language: b('zh-Hant'),
            })),
          },
        };
      },
    },
  } as unknown as WorkActivationEnvironment;
  let continuation: string | undefined;
  let emptyPages = 0;
  const works: string[] = [];
  for (let page = 0; page < 10; page++) {
    const before = nativeReads;
    const result = await searchGraphSnapshot.run(
      { clients: new Set([env.fuseki]), lineage: env.lineage, position },
      () =>
        readRankedCatalogue(env, {
          phrase: 'Maintained realm alias',
          realm,
          language: 'zh-Hant',
          pageSize: 2,
          continuation,
        }),
    );
    expect(nativeReads - before).toBeLessThanOrEqual(8);
    works.push(...result.results.map((row) => row.work));
    if (!result.results.length) {
      emptyPages++;
      expect(result.count.precision).toBe('lower-bound');
      expect(result.next).not.toBeNull();
    }
    if (!result.next) {
      expect(result.count).toEqual({ value: 3, precision: 'exact' });
      break;
    }
    expect(result.next).not.toBe(continuation);
    continuation = result.next;
  }
  expect(emptyPages).toBeGreaterThanOrEqual(4);
  expect(works).toEqual([id(6000), id(6001), id(6002)]);
  expect(new Set(works).size).toBe(works.length);
  expect(queries.some((query) => query.includes('VALUES ?unit'))).toBe(true);
});
