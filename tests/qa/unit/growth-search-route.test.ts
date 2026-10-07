import { expect, test } from 'bun:test';
import { FusekiClient } from '../../../services/main/src/infrastructure/fuseki.ts';
import { searchRoutes } from '../../../services/main/src/routes/search.ts';

const id = (number: number) =>
  `https://rezics.com/id/${String(number).padStart(8, '0')}-1111-4111-8111-111111111111`;
const grouped = {
  profile: 'public-grouped-statement-phrase-v1',
  actingSubject: id(1),
  context: { kind: 'realm-local', id: id(2) },
  phrase: 'budget term',
  language: 'en',
  relation: { definition: id(3), workRole: 'work', participantRole: 'lead' },
  conditions: [
    {
      predicate: id(4),
      relationDefinition: id(5),
      value: id(6),
      context: id(7),
      semanticRevision: id(8),
      applicability: [],
    },
  ],
  countGrain: 'work',
  facetMode: 'fully-filtered',
};

function request(fuseki: FusekiClient) {
  const work = {
    environment: {
      fuseki,
      lineage: { dataEpoch: 'epoch', routingEpoch: 'routing' },
      objectDirectory: '/unused',
    },
    account: { verify: async () => ({ issuer: 'qa', subject: 'viewer' }) },
    access: {
      assertRecoveryOpen: async () => undefined,
      canReadReferences: async (
        _principal: unknown,
        _actor: string,
        resources: readonly string[],
      ) => new Set(resources),
    },
    judgments: { protectionChecks: async () => [] },
  };
  const app = searchRoutes(fuseki, work as unknown as Parameters<typeof searchRoutes>[1]);
  return app.handle(
    new Request('http://main.local/v1/queries', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(grouped),
    }),
  );
}

test('SEARCH10: grouped route byte exhaustion returns budget without exact count or facets', async () => {
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: () => Response.json({ results: { bindings: [] }, padding: 'x'.repeat(1_100_000) }),
  });
  try {
    const response = await request(new FusekiClient(`http://127.0.0.1:${server.port}/rezics`));
    expect(response.status).toBe(422);
    const result = (await response.json()) as Record<string, unknown>;
    expect(result).toMatchObject({ status: 422, code: 'query_budget_exceeded' });
    for (const key of ['total', 'countPrecision', 'facetPrecision', 'facets']) {
      expect(result).not.toHaveProperty(key);
    }
  } finally {
    await server.stop(true);
  }
});

test('SEARCH10: grouped route wall exhaustion returns unavailable without exact count or facets', async () => {
  const fuseki = { query: async () => new Promise<never>(() => {}) } as unknown as FusekiClient;
  const response = await request(fuseki);
  expect(response.status).toBe(503);
  const result = (await response.json()) as Record<string, unknown>;
  expect(result).toMatchObject({ status: 503, code: 'search_index_unavailable' });
  for (const key of ['total', 'countPrecision', 'facetPrecision', 'facets']) {
    expect(result).not.toHaveProperty(key);
  }
}, 5_000);
