// real generated-client/default BFF composition with constructed wire responses.
// These cases establish no native authorization or browser acceptance.
import { describe, expect, mock, spyOn, test } from 'bun:test';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import type { CreatorSalesData } from '../src/checkout/creator-sales';
import { creatorSaleFixture, creatorSalesPersonas } from '../src/kernel/fake/creator-sales';
import * as start from '../.storybook/react-start';

let currentRequest = new Request('https://site.test/en/creator/sales');
let responseHeaders = new Headers();
let sessionActive = true;
let sessionSubject = 'creator';
let preparations = 0;
let sessionAccessToken = 'current-creator';
mock.module('cloudflare:workers', () => ({
  env: {
    KERNEL_ORIGIN: 'https://kernel.test',
    AUTH_ISSUER: 'https://auth.test',
    API_RESOURCE: 'https://kernel.test',
    WEBSITE_SCOPES: 'openid commerce_sale:list',
    WEBSITE_CLIENT_ID: 'web',
    WEBSITE_CLIENT_KEY: '{}',
    SESSIONS: {
      idFromName: (id: string) => id,
      get: () => ({
        credential: async () => {
          preparations++;
          return sessionActive
            ? { status: 'active', subject: sessionSubject, accessToken: sessionAccessToken, csrfToken: 'private-csrf' }
            : { status: 'absent' };
        },
      }),
    },
  },
}));
mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => ({
  getRequest: () => currentRequest,
  setResponseHeader: (name: string, value: string) => responseHeaders.set(name, value),
}));
const { readCreatorSales, readCreatorSalesCurrent, creatorSalesSearch } = await import('../src/checkout/creator-sales');
const { CreatorSalesPage } = await import('../src/checkout/creator-sales-page');
const { setLocale } = await import('../src/paraglide/runtime.js');
const request = (credential = 'creator') =>
  new Request('https://site.test/en/creator/sales', {
    headers: { authorization: `Bearer ${credential}` },
  });
const page = (sales: unknown[] = [creatorSaleFixture]) => ({ sales, next: null, projectionState: 'ready' });
const render = (data: CreatorSalesData, cursor?: string) =>
  renderToString(
    createElement(CreatorSalesPage, {
      page: data,
      locale: 'en',
      cursor,
    }),
  );

describe("Creator's real private sales history page and statement navigation", () => {
  test('served default uses the generated native endpoint, fresh session credentials and private bounded continuation', async () => {
    const calls: Request[] = [];
    // Illustrative wire responses exercise the real default composition, not native authorization proof.
    const fetcher = spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const call = new Request(input, init);
      calls.push(call);
      return Response.json(
        calls.length === 1 ? { ...page(), next: 'signed+next/=' } : page(creatorSalesPersonas.otherCreator.sales),
      );
    });
    try {
      const sessionRequest = () =>
        new Request('https://site.test/en/creator/sales', {
          headers: { cookie: `__Host-rezics_session=${'a'.repeat(43)}` },
        });
      currentRequest = sessionRequest();
      responseHeaders = new Headers();
      const first = await readCreatorSales({
        data: creatorSalesSearch({ cursor: 'signed+current/=', creatorAccountId: 'foreign', limit: 100 }),
      });
      expect(first).toEqual({ kind: 'ready', ...page(), next: 'signed+next/=' });
      expect(responseHeaders.get('cache-control')).toBe('private, no-store');
      expect(responseHeaders.get('x-robots-tag')).toBe('noindex, nofollow');
      if (first.kind !== 'ready' || first.next === null) throw new Error('Expected signed continuation');
      sessionAccessToken = 'other-current-creator';
      currentRequest = sessionRequest();
      const second = await readCreatorSales({ data: { cursor: first.next } });
      expect(second).toEqual({ kind: 'ready', ...page(creatorSalesPersonas.otherCreator.sales) });
      expect(calls.map((call) => new URL(call.url).pathname)).toEqual(['/v1/commerceSales', '/v1/commerceSales']);
      expect(calls.map((call) => Object.fromEntries(new URL(call.url).searchParams))).toEqual([
        { limit: '20', cursor: 'signed+current/=' },
        { limit: '20', cursor: 'signed+next/=' },
      ]);
      expect(calls.map((call) => call.headers.get('authorization'))).toEqual([
        'Bearer current-creator',
        'Bearer other-current-creator',
      ]);
      for (const call of calls) {
        expect(call.method).toBe('GET');
        expect(call.cache).toBe('no-store');
        expect(call.redirect).toBe('manual');
        expect(call.headers.get('cookie')).toBeNull();
      }
      expect(JSON.stringify([first, second])).not.toMatch(/Bearer|private-csrf|current-creator/);
    } finally {
      sessionAccessToken = 'current-creator';
      fetcher.mockRestore();
    }
  });

  test('default retries preserve native denial, unavailable, malformed and genuinely preparing results', async () => {
    let status = 503;
    let body: unknown = null;
    const calls: Request[] = [];
    const fetcher = spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      calls.push(new Request(input, init));
      return Response.json(body, { status, headers: { location: 'https://elsewhere.test/private' } });
    });
    const cases = [
      { status: 401, body: null, expected: { kind: 'denied' } },
      { status: 403, body: null, expected: { kind: 'denied' } },
      { status: 403, body: { code: 'platform_closed' }, expected: { kind: 'denied' } },
      { status: 404, body: null, expected: { kind: 'denied' } },
      { status: 400, body: null, expected: { kind: 'error' } },
      { status: 409, body: null, expected: { kind: 'stale' } },
      { status: 503, body: page([]), expected: { kind: 'unavailable' } },
      { status: 302, body: null, expected: { kind: 'unavailable' } },
      { status: 200, body: { ...page(), next: '' }, expected: { kind: 'unavailable' } },
      { status: 202, body: page([]), expected: { kind: 'unavailable' } },
      {
        status: 202,
        body: { ...page([]), projectionState: 'preparing' },
        expected: { kind: 'ready', ...page([]), projectionState: 'preparing' },
      },
    ];
    try {
      currentRequest = request();
      for (const result of cases) {
        status = result.status;
        body = result.body;
        const data = await readCreatorSales({ data: { cursor: 'signed+retry/=' } });
        expect(data).toEqual(result.expected);
        if (data.kind === 'ready') {
          const html = render(data);
          expect(html).toContain('still being prepared');
          expect(html).not.toContain('No sales recorded yet');
          expect(html).not.toContain('No sales on this page');
        }
      }
      expect(calls).toHaveLength(cases.length);
      for (const call of calls) {
        expect(call.url).toBe('https://kernel.test/v1/commerceSales?limit=20&cursor=signed%2Bretry%2F%3D');
        expect(call.cache).toBe('no-store');
        expect(call.redirect).toBe('manual');
      }
    } finally {
      fetcher.mockRestore();
    }
  });

  test('default never calls native with missing credentials or an expired server session', async () => {
    const fetcher = spyOn(globalThis, 'fetch').mockImplementation(async () => {
      throw new Error('Native must not receive an unauthenticated read');
    });
    try {
      currentRequest = new Request('https://site.test/en/creator/sales');
      expect(await readCreatorSales({ data: {} })).toEqual({ kind: 'denied' });
      sessionActive = false;
      currentRequest = new Request('https://site.test/en/creator/sales', {
        headers: { cookie: `__Host-rezics_session=${'a'.repeat(43)}` },
      });
      expect(await readCreatorSales({ data: {} })).toEqual({ kind: 'denied' });
      expect(fetcher).not.toHaveBeenCalled();
    } finally {
      sessionActive = true;
      fetcher.mockRestore();
    }
  });
});

test('served current sales binds one session preparation, gate, empty page and signed address to that exact viewer', async () => {
  const calls: Request[] = [];
  let admitted = ['selling', 'commerce_sale.list'];
  const fetcher = spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const call = new Request(input, init);
    calls.push(call);
    return Response.json(
      new URL(call.url).pathname === '/v1/platform/exposure'
        ? { admitted }
        : { sales: [], next: null, projectionState: 'preparing' },
    );
  });
  const sessionRequest = () =>
    new Request('https://site.test/en/creator/sales', {
      headers: { cookie: `__Host-rezics_session=${'a'.repeat(43)}` },
    });
  try {
    const before = preparations;
    currentRequest = sessionRequest();
    const first = await readCreatorSalesCurrent({ data: { cursor: 'signed-A+/=' } });
    expect(first).toEqual({
      sessionSubject: 'creator',
      requested: { cursor: 'signed-A+/=' },
      selling: true,
      page: { kind: 'ready', sales: [], next: null, projectionState: 'preparing' },
    });
    expect(preparations - before).toBe(1);
    expect(calls.map((call) => new URL(call.url).pathname)).toEqual(['/v1/platform/exposure', '/v1/commerceSales']);
    expect(
      calls.every(
        (call) =>
          call.headers.get('authorization') === 'Bearer current-creator' &&
          call.cache === 'no-store' &&
          call.redirect === 'manual',
      ),
    ).toBe(true);
    sessionSubject = 'other';
    sessionAccessToken = 'credential-other';
    // Reusing the framework Request must not reuse a prepared viewer credential.
    const second = await readCreatorSalesCurrent({ data: {} });
    expect(second.sessionSubject).toBe('other');
    expect(preparations - before).toBe(2);
    expect(calls.at(-1)!.headers.get('authorization')).toBe('Bearer credential-other');
    admitted = ['selling'];
    const count = calls.length;
    const closed = await readCreatorSalesCurrent({ data: {} });
    expect(closed).toEqual({
      sessionSubject: 'other',
      requested: { cursor: null },
      selling: false,
      page: { kind: 'denied' },
    });
    expect(calls.length - count).toBe(1);
    expect(JSON.stringify([first, second, closed])).not.toMatch(/credential-other|private-csrf|Bearer/);
    currentRequest = request();
    const explicit = await readCreatorSalesCurrent({ data: {} });
    expect(explicit.sessionSubject).toBeNull();
    expect(explicit.page).toEqual({ kind: 'denied' });
  } finally {
    sessionSubject = 'creator';
    sessionAccessToken = 'current-creator';
    fetcher.mockRestore();
  }
});
