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
  async savedCatalogueMembers() {
    throw new Error('saved membership is not used by this fixture');
  },
  async search(_principal, _request, _now, _release, context) {
    executions++;
    const page = { subjects: [], next: null, as_of: new Date().toISOString() };
    await context?.complete(page);
    return page;
  },
  async facets() {
    return { facets: [], as_of: new Date().toISOString() };
  },
  async suggest() {
    return { subjects: [], as_of: new Date().toISOString() };
  },
  async savedCatalogueMembers() {
    throw new Error('saved catalogue members is not used by this fixture');
  },
};
const app = createKernel({ pool, access, routeKey: new Uint8Array(32), receiptKeys: testReceiptKeys(), search });
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
