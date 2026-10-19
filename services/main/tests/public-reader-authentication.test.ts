import { expect, test } from 'bun:test';
import { createMainApp, type MainWorkDependencies } from '../src/app.ts';
import { FusekiClient } from '../src/infrastructure/fuseki.ts';
import { AccountAssertionDenied } from '../src/modules/account/verify-assertion.ts';
import { RATE_LIMIT_V1 } from '../src/modules/rate-limit/budgets.ts';

const uuid = '00000000-0000-4000-8000-000000000001', resource = `https://rezics.com/id/${uuid}`;
const term = (value: string) => ({ type: 'literal', value });
const surfaces = [
  ['header', `/v1/works/${uuid}`], ['contents', `/v1/works/${uuid}/contents`],
  ['chapter', `/v1/chapters/${uuid}`], ['exact', `/v1/content-revisions/${uuid}`],
  ['default', `/v1/main-versions/${uuid}/selection`],
  ['search', '/v1/queries'], ['search-page', '/v1/queries/page'],
] as const;

for (const installedBudget of [false, true]) {
  for (const [surface, path] of surfaces) {
    test(`optional invalid bearer is refused on ${surface}, request budget installed=${installedBudget}`, async () => {
      let verifies = 0;
      const graph = new FusekiClient('http://unused.invalid');
      graph.query = async query => ({ boolean: true, results: { bindings: query.includes('SELECT DISTINCT ?type')
        ? [{ type: { type: 'uri', value: 'https://rezics.com/vocab/Post' } }]
        : query.includes('SELECT ?epoch ?sequence') ? [{ epoch: term('reader'), sequence: term('1') }] : [] } });
      const deps = { environment: { fuseki: graph, lineage: { dataEpoch: 'reader', routingEpoch: 'reader' },
        objectDirectory: '.temp/public-reader-authentication' },
      account: { verify: async () => { verifies++; throw new AccountAssertionDenied('invalid assertion'); } },
      access: { assertRecoveryOpen: async () => undefined },
      content: { owningResourceForRevision: async () => resource },
      contentProjection: { content: {}, cursor: {}, consumer: 'reader' },
      ...(installedBudget ? { rateLimit: {
        budgets: RATE_LIMIT_V1, options: { secret: 'reader-test-secret', serviceClientIds: new Set(),
          trustedProxyPeers: new Set(), clientIpHeader: 'x-forwarded-for' },
        store: { classify: async () => 'member', consume: async () => ({ allowed: true, retryAfter: 0 }) },
      } } : {}),
      } as unknown as MainWorkDependencies;
      const app = createMainApp(graph, deps);
      const body = surface === 'search' ? { profile: 'public-content-phrase-v1', phrase: 'garden', language: 'en' }
        : surface === 'search-page' ? { profile: 'public-content-phrase-page-v1', phrase: 'garden', language: 'en', pageSize: 1 } : undefined;
      const response = await app.handle(new Request(`http://main.test${path}`, {
        method: body ? 'POST' : 'GET', headers: { authorization: 'Bearer invalid',
          ...(body ? { 'content-type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      }));
      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({ code: 'account_assertion_denied' });
      expect(response.headers.get('cache-control')).toContain('no-store');
      expect(verifies).toBe(1);
    });
  }
}
