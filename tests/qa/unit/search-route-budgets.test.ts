import { expect, test } from 'bun:test';
import { FusekiQueryResponseTooLarge, FusekiReadBudgetExceeded,
  type FusekiClient } from '../../../services/main/src/infrastructure/fuseki.ts';
import { createMainApp, type MainWorkDependencies } from '../../../services/main/src/app.ts';
import { SearchRequestTimedOut }
  from '../../../services/main/src/modules/work/search-readiness.ts';

const body = { profile: 'public-main-phrase-v1', phrase: 'exact phrase', language: null };

async function request(error: Error, extra: Record<string, unknown> = {}) {
  const fuseki = { query: async () => { throw error; } } as unknown as FusekiClient;
  const work = { environment: { fuseki,
    lineage: { dataEpoch: 'epoch', routingEpoch: 'routing' } } } as MainWorkDependencies;
  return createMainApp(fuseki, work).handle(new Request('http://main.local/v1/queries', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...body, ...extra }),
  }));
}

test('SEARCH10: query call and response-memory ceilings have typed HTTP budget outcomes', async () => {
  for (const error of [new FusekiReadBudgetExceeded('calls exhausted'),
    new FusekiQueryResponseTooLarge('response exhausted')]) {
    const response = await request(error);
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ status: 422, code: 'query_budget_exceeded' });
  }
});

test('SEARCH10: a request deadline has a typed unavailable outcome', async () => {
  const response = await request(new SearchRequestTimedOut('deadline exceeded'));
  expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({ status: 503, code: 'search_index_unavailable' });
});

test('SEARCH10: unimplemented facets cannot imply exact counts', async () => {
  for (const selector of [{ facets: ['language'] }, { facetMode: 'self-filter-excluding' }]) {
    const response = await request(new Error('native index must not be read'), selector);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ status: 400, code: 'invalid_request' });
  }
});
