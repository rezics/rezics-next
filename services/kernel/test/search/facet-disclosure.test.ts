import { expect, test } from 'bun:test';
import type { FilterRelease } from '@rezics/filter';
import { ProblemError } from '../../src/http/problem.ts';
import type { PublicFilterCost } from '../../src/semantic/public-filter-source-contract.ts';
import type { FacetDiscoveryProvider, FacetNativePlan } from '../../src/search/facet-discovery-native.ts';
import { readFacetDiscovery, type FacetDiscoveryInput } from '../../src/search/facet-discovery-runtime.ts';
import type { KeyRing } from '../../src/tokens/seal.ts';

const ring: KeyRing = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(9)]]) };
const digest = 'a'.repeat(64);
const release: FilterRelease = {
  types: { 'schema:Book': { facets: ['schema:version', 'schema:category'] } },
  properties: {
    'schema:version': { datatype: 'string', value: { pattern: '^v[0-9]+$' } },
    'schema:category': { datatype: 'string', value: { pattern: '^c[0-9]+$' } },
  },
};
const cost: PublicFilterCost = {
  inputKeys: 0,
  candidates: 0,
  accessPoints: 0,
  dependencyPoints: 0,
  engineSearches: 0,
  engineIteratorSteps: 0,
  outputSlots: 0,
  resultWrites: 0,
  frontierWrites: 0,
};

function fixture(finalStatus: 'current' | 'changed') {
  const captures: string[] = [];
  const queries: string[] = [];
  let finalizations = 0;
  const provider: FacetDiscoveryProvider = {
    source: 'subjects-g1',
    generation: 1,
    meaning: { digest, release, type: 'schema:Book' } as FacetDiscoveryProvider['meaning'],
    operations: {
      async captureFacet({ plan }: { plan: FacetNativePlan }) {
        captures.push(plan.property);
        const queried = {
          consumer: {
            physicalTarget: 'subjects-g1',
            incarnation: 'index-1',
            consumerGeneration: '1',
            projectionGeneration: '1',
            meaningDigest: digest,
            readDefinition: 'definition-1',
          },
          snapshot: {
            kind: 'prepared' as const,
            observation: plan.property,
            build: `build-${plan.property}`,
            generation: 1n,
          },
        };
        return { status: 'captured' as const, queried, repair: { consumer: queried.consumer, job: 'job' }, cost };
      },
      async pageFacets({ reads }) {
        queries.push(...reads.map(({ plan }) => plan.property));
        return {
          status: 'ready' as const,
          facets: reads.map(({ plan }) => ({
            property: plan.property,
            values: [{ value: plan.property === 'schema:version' ? 'v1' : 'c1', labels: {} }],
            after: plan.property === 'schema:version' ? 'v1' : 'c1',
            hasMore: true,
          })),
          asOf: '2026-11-05T00:00:00.000Z',
          cost,
          async finalize() {
            finalizations++;
            return { status: finalStatus, cost };
          },
        };
      },
      async repairStep() {
        throw new Error('unused');
      },
    },
  };
  const now = Date.now();
  const input: FacetDiscoveryInput = {
    principal: 'anonymous',
    text: undefined,
    filter: undefined,
    originalFilter: undefined,
    release,
    facets: [
      { property: 'schema:version', size: 1 },
      { property: 'schema:category', size: 1 },
    ],
    languages: ['en'],
    now,
    context: { deadline: now + 10_000 },
  };
  return { provider, input, captures, queries, finalizations };
}

test('changed final facet disclosure withholds every sibling and its cursors', async () => {
  const state = fixture('changed');
  const error = await readFacetDiscovery(ring, state.provider, state.input, [undefined, undefined]).then(
    () => undefined,
    (caught: unknown) => caught,
  );

  expect(error).toBeInstanceOf(ProblemError);
  expect((error as ProblemError).code).toBe('index_not_ready');
  expect(state.captures).toEqual(['schema:version', 'schema:category']);
  expect(state.queries).toEqual(['schema:version', 'schema:category']);
  expect(state.finalizations).toBe(1);
});

test('current final facet disclosure releases the complete sibling page after cursor construction', async () => {
  const state = fixture('current');
  const page = await readFacetDiscovery(ring, state.provider, state.input, [undefined, undefined]);

  expect(page.facets.map(({ next }) => next)).toEqual([expect.any(String), expect.any(String)]);
  expect(state.finalizations).toBe(1);
});
