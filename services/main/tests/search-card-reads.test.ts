import { expect, test } from 'bun:test';
import type { MainWorkDependencies } from '../src/routes/dependencies.ts';
import { FusekiQueryResponseTooLarge, type SparqlResult } from '../src/infrastructure/fuseki.ts';
import { searchCardReadDependencies } from '../src/modules/search/card-reads.ts';
import { searchGraphSnapshot } from '../src/modules/search/snapshot-state.ts';
import { withSearchGraphSnapshot } from '../src/modules/search/snapshot.ts';
import { RecoveryHold } from '../src/modules/work/restore-lineage.ts';

const field = (value: string) => ({ type: 'literal', value });
const position = { dataEpoch: 'epoch', sequence: '1', generation: 'generation',
  population: 2, serverInstanceId: 'instance', publicSearchWriteEpoch: '0' };

test('card fact batching isolates branches, enforces response bounds and never reuses facts across requests', async () => {
  const queries: string[] = [];
  const deps = { environment: { lineage: { dataEpoch: 'epoch', routingEpoch: 'route' },
    fuseki: { query: async (query: string): Promise<SparqlResult> => {
      queries.push(query);
      return { results: { bindings: query.includes('?searchCardRead') ? [
        { searchCardRead: field('1'), value: field('second') },
        { searchCardRead: field('0'), value: field('first') },
      ] : [{ value: field('fresh') }] } };
    } },
  } } as unknown as MainWorkDependencies;
  const state = () => ({ clients: new Set([deps.environment.fuseki]), lineage: deps.environment.lineage, position });
  let client = deps.environment.fuseki;
  const one = 'PREFIX rv: <https://rezics.com/vocab/> SELECT ?value WHERE { BIND("PREFIX rv: <literal>" AS ?value) } LIMIT 1';
  const two = 'PREFIX rv: <https://rezics.com/vocab/> SELECT ?value WHERE { BIND("two" AS ?value) } LIMIT 2';
  await searchGraphSnapshot.run(state(), async () => {
    client = searchCardReadDependencies(deps).environment.fuseki;
    const [first, second] = await Promise.all([client.query(one), client.query(two)]);
    expect(queries).toHaveLength(1);
    expect(queries[0]).toContain('"PREFIX rv: <literal>"');
    expect(queries[0]).toContain('LIMIT 1');
    expect(queries[0]).toContain('LIMIT 2');
    expect(first.results?.bindings).toEqual([{ value: field('first') }]);
    expect(second.results?.bindings).toEqual([{ value: field('second') }]);
    first.results!.bindings[0]!.value = field('mutated');
    expect((await client.query(one)).results?.bindings).toEqual([{ value: field('first') }]);
    await expect(client.query(one, 1)).rejects.toBeInstanceOf(FusekiQueryResponseTooLarge);
    expect(queries).toHaveLength(1);
  });
  expect((await client.query(one)).results?.bindings).toEqual([{ value: field('fresh') }]);
  await searchGraphSnapshot.run(state(), async () => {
    expect((await client.query(one)).results?.bindings).toEqual([{ value: field('fresh') }]);
  });
  expect(queries).toHaveLength(3);
});

test('a damaged card batch rejects every fact family instead of delivering a partial page', async () => {
  const deps = { environment: { lineage: { dataEpoch: 'epoch', routingEpoch: 'route' },
    fuseki: { query: async () => ({ results: { bindings: [{ searchCardRead: field('3') }] } }) },
  } } as unknown as MainWorkDependencies;
  await searchGraphSnapshot.run({ clients: new Set([deps.environment.fuseki]),
    lineage: deps.environment.lineage, position }, async () => {
    const client = searchCardReadDependencies(deps).environment.fuseki;
    const results = await Promise.allSettled([
      client.query('SELECT ?one WHERE {}'), client.query('SELECT ?two WHERE {}'),
    ]);
    expect(results.map(result => result.status)).toEqual(['rejected', 'rejected']);
  });
});

test('a search snapshot preserves the recovery hold outcome before any card can be returned', async () => {
  const deps = { environment: { lineage: { dataEpoch: 'epoch', routingEpoch: 'route' },
    fuseki: { query: async () => ({ boolean: false }),
      commandHealth: async () => ({ instanceId: '00000000-0000-4000-8000-000000000000',
        publicSearchWriteEpoch: '0', publicSearchWriteActive: false }) },
  } } as unknown as MainWorkDependencies;
  let read = false;
  await expect(withSearchGraphSnapshot(deps.environment, async () => { read = true; }))
    .rejects.toBeInstanceOf(RecoveryHold);
  expect(read).toBe(false);
});
