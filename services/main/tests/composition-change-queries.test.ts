import { expect, test } from 'bun:test';
import { derivedId, placementIri, readPlacements } from '../src/modules/structure/graph.ts';
import type { WorkActivationEnvironment } from '../src/modules/work/activate.ts';

test('a composition placement read seeks the placement subject', async () => {
  const generation = derivedId('query-generation');
  const occurrence = derivedId('query-occurrence');
  let sparql = '';
  const env = { fuseki: { query: async (query: string) => {
    sparql = query;
    return { results: { bindings: [] } };
  } } } as unknown as WorkActivationEnvironment;
  expect(await readPlacements(env, generation, { occurrences: [occurrence] })).toEqual([]);
  expect(sparql).toContain(`<${placementIri(generation, occurrence)}>`);
  expect(sparql).toContain('VALUES (?occurrence ?placement)');
  expect(sparql).not.toContain('VALUES ?occurrence {');
});
