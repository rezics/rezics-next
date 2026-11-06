import { testReceiptKeys } from '../support/receipt-keys.ts';
import { readExposure } from '../../src/access/gates/catalogue.ts';
import { expect, test } from 'bun:test';
import { prepareQueryShare } from '../../src/search/query-share.ts';

test('portable projection preserves raw text and branches while excluding cursor and authority', () => {
  const filter = {
    and: [
      { or: [{ type: { in: ['rezics:Book'] } }, { not: { type: { in: ['rezics:Film'] } } }] },
      { kind: { in: ['book'] } },
    ],
  };
  const request = {
    text: '  "a phrase" | -other ',
    filter,
    languages: ['ja', 'en'],
    cursor: 'secret',
    principal: 'private',
  };
  const result = prepareQueryShare(request, { book: { en: 'Book', ja: '本' } });
  expect(result.action).toBe('allowed');
  expect(result.document?.text).toBe(request.text);
  expect(JSON.parse(result.document!.filter!)).toEqual(filter);
  expect(result.selections).toContainEqual({ value: '本', language: 'ja' });
  const params = new URLSearchParams(result.parameters!);
  expect(params.getAll('language')).toEqual(['ja', 'en']);
  expect(params.getAll('kinds')).toEqual(['book']);
  expect(JSON.stringify(result)).not.toContain('secret');
  expect(JSON.stringify(result)).not.toContain('principal');
  const replay = prepareQueryShare({
    text: params.get('q')!,
    languages: params.getAll('language'),
    filter: { and: [JSON.parse(params.get('condition')!), { kind: { in: params.getAll('kinds') } }] },
  });
  expect(replay.parameters).toBe(result.parameters);
});

test('private, unknown and oversized queries never emit partial portable documents', () => {
  for (const filter of [
    { owner: { presence: true } },
    { future: {} },
    { collection: { id: '00000000-0000-4000-8000-000000000001' } },
  ]) {
    const result = prepareQueryShare({ filter });
    expect(result.action).toBe('disabled');
    expect(result.document).toBeNull();
    expect(result.parameters).toBeNull();
  }
  expect(prepareQueryShare({ filter: { type: { in: ['x'.repeat(17000)] } } }).reason).toBe('oversized');
  expect(prepareQueryShare({ filter: { type: { in: ['rezics:Book'] } } }).action).toBe('allowed');
});

test('credited work shares preserve the executed name, same-credit role, kinds, languages and threshold', () => {
  const role = '0196a000-0000-7000-8000-000000000001';
  const result = prepareQueryShare(
    {
      representation: 'discovery-v1',
      text: '  Aki  ',
      textField: 'credited_creator',
      creditQualifiers: [{ property: 'wdt:P3831', value: role }],
      filter: { kind: { in: ['schema:Book', 'wd:Q123'] } },
      languages: ['ja', 'en'],
      spoilerThreshold: 1,
      sort: 'relevance',
    },
    {},
  );
  expect(result.action).toBe('allowed');
  expect(result.document).toMatchObject({
    text: '  Aki  ',
    textField: 'credited_creator',
    creditQualifiers: [{ property: 'wdt:P3831', value: role }],
    spoilerThreshold: 1,
  });
  const parameters = new URLSearchParams(result.parameters!);
  expect(parameters.get('mode')).toBe('works');
  expect(parameters.get('name')).toBe('  Aki  ');
  expect(parameters.get('role')).toBe(role);
  expect(parameters.getAll('kinds')).toEqual(['schema:Book', 'wd:Q123']);
  expect(parameters.getAll('language')).toEqual(['ja', 'en']);
  expect(parameters.get('threshold')).toBe('1');
  expect(parameters.get('sort')).toBe('relevance');
  expect(
    prepareQueryShare({
      representation: 'discovery-v1',
      text: 'Aki',
      textField: 'credited_creator',
      filter: { and: [{ kind: { in: ['schema:Book'] } }, { type: { in: ['schema:Book'] } }] },
    }).action,
  ).toBe('disabled');
});

// Exercise the mounted contract and its ordinary current-reader authorization, not a second share authority.
import { afterAll, beforeAll } from 'bun:test';
import { createPool } from '../../src/database/pool.ts';
import { createKernel } from '../../src/http/kernel.ts';
import type { Access } from '../../src/request/access.ts';
import type { SearchService } from '../../src/search/service-scope.ts';
const pool = createPool(process.env.DATABASE_URL!);
const opening = Bun.randomUUIDv7();
beforeAll(async () => {
  for (const group of ['search', 'search_advanced'])
    if (!(await readExposure(pool, group, new Date(), Date.now() + 10000)).open)
      await pool.query(
        `INSERT INTO access.exposure_opening ("group", valid, transaction_id) VALUES ($1, tstzrange('2000-01-01', NULL, '[)'), $2)`,
        [group, opening],
      );
});
afterAll(async () => {
  await pool.query('DELETE FROM access.exposure_opening WHERE transaction_id = $1', [opening]);
  await pool.end();
});
let permitted = true;
let executions = 0;
let facetRequest: unknown;
let discoveryRequest: unknown;
let discoveries = 0;
const access: Access = {
  async authenticate() {
    throw new Error('not used');
  },
  async authorize() {
    return permitted;
  },
};
const search: SearchService = {
  async releaseGroups() {
    throw new Error('grouped release search is not used by this fixture');
  },
  savedCatalogueMembers: async () => {
    throw new Error('saved membership is not used by this fixture');
  },
  async search(_principal, _request, _now, _release, context) {
    executions++;
    const page = { subjects: [], next: null, as_of: new Date().toISOString() };
    await context?.complete(page);
    return page;
  },
  async facets(_principal, request) {
    facetRequest = request;
    return {
      facets: request.facets.map(({ property }) => ({ property, values: [], next: null })),
      as_of: new Date().toISOString(),
    };
  },
  async suggest() {
    return { subjects: [], as_of: new Date().toISOString() };
  },
};
const app = createKernel({
  pool,
  access,
  routeKey: new Uint8Array(32),
  receiptKeys: testReceiptKeys(),
  search,
  discovery: async (_principal, request) => {
    discoveries++;
    discoveryRequest = request;
    return { hits: [], kinds: { values: [], next: null, omitted: [] }, next: null, as_of: new Date().toISOString() };
  },
});
test('the mounted credited share executes the request and returns a portable works URL', async () => {
  permitted = true;
  const role = '0196a000-0000-7000-8000-000000000001';
  const response = await app.handle(
    new Request('http://kernel.test/v1/subjects:search', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        representation: 'discovery-v1',
        text: 'Aki',
        textField: 'credited_creator',
        creditQualifiers: [{ property: 'wdt:P3831', value: role }],
        filter: { kind: { in: ['schema:Book'] } },
        languages: ['ja'],
        spoilerThreshold: 1,
        sort: 'relevance',
        prepareShare: true,
      }),
    }),
  );
  expect(response.status).toBe(200);
  const share = await response.json();
  expect(share).toMatchObject({
    action: 'allowed',
    document: {
      text: 'Aki',
      textField: 'credited_creator',
      creditQualifiers: [{ property: 'wdt:P3831', value: role }],
      spoilerThreshold: 1,
    },
  });
  const parameters = new URLSearchParams(share.parameters);
  expect(parameters.get('mode')).toBe('works');
  expect(parameters.get('name')).toBe('Aki');
  expect(parameters.get('role')).toBe(role);
  expect(parameters.get('kinds')).toBe('schema:Book');
  expect(discoveryRequest).toMatchObject({
    textField: 'credited_creator',
    creditQualifiers: [{ property: 'wdt:P3831', value: role }],
    filter: { kind: { in: ['schema:Book'] } },
  });
  expect(discoveries).toBe(1);
});

test('the mounted facet route accepts and returns credited work refinements', async () => {
  permitted = true;
  const response = await app.handle(
    new Request('http://kernel.test/v1/subjects:facets', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        text: 'Aki',
        textField: 'credited_creator',
        creditQualifiers: [{ property: 'wdt:P3831', value: '0196a000-0000-7000-8000-000000000001' }],
        facets: [{ property: 'type', size: 8 }],
      }),
    }),
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    facets: [{ property: 'type', values: [], next: null }],
    as_of: expect.any(String),
  });
  expect(facetRequest).toMatchObject({
    text: 'Aki',
    textField: 'credited_creator',
    creditQualifiers: [{ property: 'wdt:P3831', value: '0196a000-0000-7000-8000-000000000001' }],
    facets: [{ property: 'type', size: 8 }],
  });
});

test('mounted preparation executes native admission and a recipient denial cannot acquire a portable query', async () => {
  const send = () =>
    app.handle(
      new Request('http://kernel.test/v1/subjects:search', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'reader', languages: ['en'], prepareShare: true }),
      }),
    );
  const response = await send();
  expect(response.status).toBe(200);
  expect((await response.json()).action).toBe('disabled');
  expect(executions).toBe(1);
  permitted = false;
  const denied = await send();
  expect(denied.status).toBe(403);
  expect(executions).toBe(1);
});
