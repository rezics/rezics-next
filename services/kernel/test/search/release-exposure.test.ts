import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createKernel } from '../../src/http/kernel.ts';
import { createOpenSearch, type OpenSearch } from '../../src/search/opensearch.ts';
import { createSearchService } from '../../src/search/service.ts';
import { subjectSource } from '../../src/semantic/search-source.ts';
import { createSemanticDriver, type SemanticOutcomeDriver } from '../semantic/outcome-driver.ts';

let driver: SemanticOutcomeDriver;
let native: OpenSearch;
const calls = { engine: 0, source: 0 };
const prefix = `release-exposure-${crypto.randomUUID().slice(0, 8)}-`;
beforeAll(async () => {
  const url = process.env.OPENSEARCH_URL;
  if (!url) throw new Error('OPENSEARCH_URL must name the check node');
  native = createOpenSearch(url);
  driver = await createSemanticDriver((config) => {
    if (!config.tokens) throw new Error('Native fixture did not supply session keys');
    const source = subjectSource(config.pool, config.routeKey);
    const observed = new Proxy(source, {
      get(target, key) {
        const value = Reflect.get(target, key);
        return typeof value === 'function'
          ? (...args: unknown[]) => {
              calls.source++;
              return value.apply(target, args);
            }
          : value;
      },
    });
    return createKernel({
      ...config,
      search: createSearchService({
        pool: config.pool,
        prefix,
        cursors: config.tokens,
        source: observed,
        client: {
          bulk: native.bulk,
          request(...args) {
            calls.engine++;
            return native.request(...args);
          },
        },
      }),
    });
  });
}, 240_000);
afterAll(async () => {
  try {
    await driver?.close();
  } finally {
    if (native)
      for (const name of ['subjects-hits-v1', 'subjects-search-v2', 'subjects-suggest-v1', 'subjects-facets-v1'])
        await native.request('DELETE', `/_scripts/${prefix}${name}`).catch(() => undefined);
  }
}, 240_000);

const request = (body: Record<string, unknown>, persona: 'anonymous' | 'editor' = 'anonymous') =>
  driver.request(persona, 'POST', '/v1/subjects:search', body);
function closed(response: Awaited<ReturnType<typeof request>>) {
  expect(response.status, JSON.stringify(response.body)).toBe(403);
  expect(response.body.code).toBe('platform_closed');
  for (const field of ['subjects', 'kinds', 'total']) expect(response.body).not.toHaveProperty(field);
}

test('real platform admission keeps basic and advanced closed before engine or Source and preserves Auth precedence', async () => {
  const initial = { ...calls };
  closed(await request({ text: 'Example Volume' }));
  closed(await driver.request('anonymous', 'GET', '/v1/subjects:suggest?q=Example'));
  closed(await driver.request('anonymous', 'POST', '/v1/subjects:facets', { facets: [{ property: 'type' }] }));
  const invalid = await driver.request(
    'anonymous',
    'POST',
    '/v1/subjects:search',
    { text: 'Example' },
    { authorization: 'Bearer malformed' },
  );
  expect(invalid.status).toBe(401);
  expect(invalid.body.code).toBe('invalid_credentials');
  expect(invalid.headers.get('www-authenticate')).toContain('invalid_token');
  expect(calls).toEqual(initial);
  await driver.fixtures.openFeatures(['search']);
  // The real engine has no projection in this namespace: readiness proves admission,
  // while the separate released-data journey proves successful search results.
  for (const body of [
    { text: 'Example Volume' },
    { text: '"Example Volume" | Other' },
    { filter: { or: [{ type: { in: ['schema:Book'] } }, { and: [{ type: { in: ['schema:Person'] } }] }] } },
  ]) {
    const answer = await request(body);
    expect(answer.status, JSON.stringify(answer.body)).toBe(503);
    expect(answer.body.code).toBe('index_not_ready');
  }
  const admitted = { ...calls };
  expect(admitted.engine + admitted.source).toBeGreaterThan(initial.engine + initial.source);
  for (const persona of ['anonymous', 'editor'] as const) {
    for (const body of [
      { text: 'Example -Volume' },
      { text: 'Example', filter: { not: { type: { in: ['schema:Recipe'] } } } },
      { text: 'Example', sort: 'rating' },
      { text: 'Example', sort: 'collections' },
      { filter: { statement: { property: 'schema:author', in: [driver.globalContext] } } },
    ])
      closed(await request(body, persona));
    closed(await driver.request(persona, 'POST', '/v1/subjects:facets', { facets: [{ property: 'type' }] }));
  }
  expect(calls).toEqual(admitted);
}, 120_000);
