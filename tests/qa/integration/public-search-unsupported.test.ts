import { expect, test } from 'bun:test';
import { createMainApp, type MainWorkDependencies } from '../../../services/main/src/app.ts';
import { FusekiClient } from '../../../services/main/src/infrastructure/fuseki.ts';

const id = 'https://rezics.com/id/11111111-1111-4111-8111-111111111111';
const native = new Proxy(new FusekiClient('http://127.0.0.1:1/rezics'), {
  get() { throw new Error('unsupported search reached the native index'); },
});
const app = createMainApp(native, {} as MainWorkDependencies);
const shared = { phrase: 'literal phrase', language: null };
const current = [
  { path: '/v1/queries', body: { profile: 'public-content-phrase-v1', ...shared } },
  { path: '/v1/queries', body: { profile: 'public-main-phrase-v1', ...shared } },
  { path: '/v1/queries', body: { profile: 'public-realm-phrase-v1',
    context: { kind: 'realm-local', id }, ...shared } },
  { path: '/v1/queries', body: { profile: 'public-main-classified-phrase-v1',
    sense: id, ...shared } },
  { path: '/v1/queries', body: { profile: 'public-realm-classified-phrase-v1',
    context: { kind: 'realm-local', id }, sense: id, ...shared } },
  { path: '/v1/queries', body: { profile: 'public-realm-classified-rated-phrase-v1',
    context: { kind: 'realm-local', id }, sense: id, ratingContext: id,
    minimumMeanTimes10: 70, ...shared } },
  { path: '/v1/queries/page', body: { profile: 'public-content-phrase-page-v1',
    pageSize: 10, ...shared } },
  { path: '/v1/queries/page', body: { profile: 'public-main-phrase-page-v1',
    pageSize: 10, ...shared } },
  { path: '/v1/queries/page', body: { profile: 'public-realm-phrase-page-v1',
    context: { kind: 'realm-local', id }, pageSize: 10, ...shared } },
  { path: '/v1/queries/page', body: { profile: 'public-main-classified-phrase-page-v1',
    sense: id, pageSize: 10, ...shared } },
  { path: '/v1/queries/page', body: { profile: 'public-realm-classified-phrase-page-v1',
    context: { kind: 'realm-local', id }, sense: id, pageSize: 10, ...shared } },
  { path: '/v1/queries/page', body: { profile: 'public-realm-classified-rated-phrase-page-v1',
    context: { kind: 'realm-local', id }, sense: id, ratingContext: id,
    minimumMeanTimes10: 70, pageSize: 10, ...shared } },
] as const;

async function send(path: string, body: unknown) {
  return app.handle(new Request(`http://localhost${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }));
}

test('SEARCH05: every public phrase lane rejects declared multi-dataset policy before native index access', async () => {
  for (const { path, body } of current) {
    const response = await send(path, { ...body, sourcePolicy: {
      kind: 'multi-dataset', datasetIds: ['urn:rezics:dataset:product',
        'urn:rezics:dataset:archive'],
    } });
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ status: 422,
      code: 'search_source_policy_unsupported' });
  }
});

test('SEARCH09: every current-only public phrase lane rejects an as-of source position', async () => {
  for (const { path, body } of current) {
    const response = await send(path, { ...body, asOf: {
      datasetId: 'product', dataEpoch: 'prior-epoch', sequence: '1',
    } });
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ status: 422,
      code: 'historical_search_unsupported' });
  }
});

test('SEARCH05/SEARCH09: unknown and malformed selectors retain strict request validation', async () => {
  for (const { path, body } of current) {
    for (const selector of [
      { sourcePolicy: { kind: 'multi-dataset', datasetIds: ['one'] } },
      { asOf: { datasetId: 'product', dataEpoch: 'prior-epoch', sequence: '-1' } },
      { policy: 'any-source' },
    ]) {
      const response = await send(path, { ...body, ...selector });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ status: 400, code: 'invalid_request' });
    }
  }
});
