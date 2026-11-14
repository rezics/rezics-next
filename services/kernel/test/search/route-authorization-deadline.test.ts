import { expect, test } from 'bun:test';
import type { Pool, PoolClient } from 'pg';
import { createApp } from '../../src/http/app.ts';
import { ProblemError } from '../../src/http/problem-error.ts';
import type { Access } from '../../src/request/access.ts';
import { searchRoutes } from '../../src/search/http/routes.ts';
import type { SearchService } from '../../src/search/service-scope.ts';

function fixture(options: { allowed?: boolean; lateCheckout?: boolean; stalledCheck?: boolean } = {}) {
  let checkouts = 0;
  let checks = 0;
  let serviceCalls = 0;
  let released = 0;
  let finishCheckout: (() => void) | undefined;
  let finishCheck: (() => void) | undefined;
  const client = () =>
    ({
      async query(input: string | { text: string }) {
        const sql = typeof input === 'string' ? input : input.text;
        return {
          rows: sql.includes('exposure_opening') ? [{ open: true, at: new Date().toISOString() }] : [],
        };
      },
      release() {
        released++;
      },
    }) as unknown as PoolClient;
  const pool = {
    options: {},
    connect() {
      checkouts++;
      if (options.lateCheckout && checkouts === 2)
        return new Promise<PoolClient>((resolve) => (finishCheckout = () => resolve(client())));
      return Promise.resolve(client());
    },
    async query() {
      throw new Error('Unexpected pool query');
    },
  } as unknown as Pool;
  const access: Access = {
    async authenticate() {
      throw new Error('Unexpected authentication');
    },
    async authorize() {
      checks++;
      if (options.stalledCheck) return new Promise<boolean>((resolve) => (finishCheck = () => resolve(false)));
      return options.allowed ?? true;
    },
  };
  const search = {
    async facets() {
      serviceCalls++;
      throw new ProblemError('index_not_ready');
    },
  } as unknown as SearchService;
  const tokens = { current: 1, keys: new Map([[1, new Uint8Array(32)]]) };
  const app = searchRoutes(createApp({ pool, access, tokens, requestDeadlineMs: 100 }), {
    pool,
    access,
    tokens,
    routeKey: new Uint8Array(32),
    search,
  });
  app.compile();
  async function request() {
    const response = await app.handle(
      new Request('http://kernel.test/v1/subjects:facets', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ facets: [{ property: 'schema:author' }] }),
      }),
    );
    return { status: response.status, body: (await response.json()) as { code: string } };
  }
  return {
    request,
    get checks() {
      return checks;
    },
    get serviceCalls() {
      return serviceCalls;
    },
    get released() {
      return released;
    },
    finishCheckout: () => finishCheckout?.(),
    finishCheck: () => finishCheck?.(),
  };
}

test('a late authorization checkout expires, then releases without scheduling check or Search work', async () => {
  const route = fixture({ lateCheckout: true });
  const result = await route.request();
  expect(result).toEqual({ status: 503, body: expect.objectContaining({ code: 'deadline_exceeded' }) });
  route.finishCheckout();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect([route.checks, route.serviceCalls, route.released]).toEqual([0, 0, 2]);
});

test('an expired current check remains deadline_exceeded; current true and false grants keep their decisions', async () => {
  const stalled = fixture({ stalledCheck: true });
  expect(await stalled.request()).toMatchObject({ status: 503, body: { code: 'deadline_exceeded' } });
  stalled.finishCheck();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect([stalled.checks, stalled.serviceCalls]).toEqual([1, 0]);

  const allowed = fixture({ allowed: true });
  expect(await allowed.request()).toMatchObject({ status: 503, body: { code: 'index_not_ready' } });
  expect([allowed.checks, allowed.serviceCalls]).toEqual([1, 1]);

  const denied = fixture({ allowed: false });
  expect(await denied.request()).toMatchObject({ status: 403, body: { code: 'forbidden' } });
  expect([denied.checks, denied.serviceCalls]).toEqual([1, 0]);
});
