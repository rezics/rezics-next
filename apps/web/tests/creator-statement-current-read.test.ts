import { expect, mock, spyOn, test } from 'bun:test';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { createElement, type ReactElement } from 'react';
import { renderToString } from 'react-dom/server';
import * as start from '../.storybook/react-start';
import {
  creatorLineFixture as line,
  creatorStatementFixture as statement,
  historicalCreatorLineFixture,
  historicalCreatorStatementFixture,
  paidCreatorStatementFixture,
} from '../src/kernel/fake/creator-statements';

const request = () =>
  new Request('https://site.test/en/creator/statements', {
    headers: { cookie: `__Host-rezics_session=${'a'.repeat(43)}` },
  });
let currentRequest = request();
let token = 'current-list-viewer';
let preparation: 'active' | 'absent' | 'unavailable' = 'active';
let preparations = 0;
const responseHeaders = new Headers();
mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => ({
  getRequest: () => currentRequest,
  setResponseHeader: (name: string, value: string) => responseHeaders.set(name, value),
}));
mock.module('cloudflare:workers', () => ({
  env: {
    KERNEL_ORIGIN: 'https://kernel.test',
    AUTH_ISSUER: 'https://auth.test',
    API_RESOURCE: 'https://kernel.test',
    WEBSITE_SCOPES: 'openid',
    WEBSITE_CLIENT_ID: 'web',
    WEBSITE_CLIENT_KEY: '{}',
    SESSIONS: {
      idFromName: (id: string) => id,
      get: () => ({
        credential: async () => {
          preparations++;
          return preparation === 'active'
            ? { status: 'active', accessToken: token, subject: statement.creatorAccountId, csrfToken: 'private-csrf' }
            : { status: preparation };
        },
      }),
    },
  },
}));
const { readCreatorStatements, readCreatorStatement } = await import('../src/checkout/creator-statements');
const { viewerCredential } = await import('../src/session/request');
const { CreatorStatementsPage, StatementAmount } = await import('../src/checkout/creator-statements-page');
const { CreatorStatementPage } = await import('../src/checkout/creator-statement-page');

test('default private statement reads use current credentials without caching or redirects and conceal refused preparation and native denial', async () => {
  const calls: Request[] = [];
  const healthy = (call: Request) => {
    const path = new URL(call.url).pathname;
    if (path.endsWith('/lines')) return Response.json({ lines: [line], next: 'next-line' });
    if (path.endsWith(statement.id)) return Response.json({ statement });
    return Response.json({ payoutStatements: [statement], next: 'next-statement' });
  };
  let respond = healthy;
  // Retain the served server functions, kernelClient, generated callers and real session preparation.
  const transport = spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const call = new Request(input, init);
    calls.push(call);
    return respond(call);
  });
  try {
    expect(await readCreatorStatements({ data: { cursor: 'signed/list+page' } })).toEqual({
      kind: 'ready',
      payoutStatements: [statement],
      next: 'next-statement',
    });
    currentRequest = request();
    token = 'current-detail-viewer';
    expect(await readCreatorStatement({ data: { id: statement.id, cursor: 'signed/line+page' } })).toEqual({
      kind: 'ready',
      statement,
      lines: { kind: 'ready', lines: [line], next: 'next-line' },
    });
    expect(preparations).toBe(2);
    expect(
      calls.map((call) => [new URL(call.url).pathname, Object.fromEntries(new URL(call.url).searchParams)]),
    ).toEqual([
      ['/v1/payoutStatements', { limit: '20', cursor: 'signed/list+page' }],
      [`/v1/payoutStatements/${statement.id}`, {}],
      [`/v1/payoutStatements/${statement.id}/lines`, { limit: '20', cursor: 'signed/line+page' }],
    ]);
    expect(calls.map((call) => call.headers.get('authorization'))).toEqual([
      'Bearer current-list-viewer',
      'Bearer current-detail-viewer',
      'Bearer current-detail-viewer',
    ]);

    respond = () => Response.json({ code: 'not_found' }, { status: 404 });
    expect(await readCreatorStatement({ data: { id: statement.id } })).toEqual({ kind: 'denied' });
    expect(calls).toHaveLength(4); // A denied point read never starts a line read.
    respond = (call) =>
      new URL(call.url).pathname.endsWith('/lines')
        ? Response.json({ code: 'forbidden' }, { status: 403 })
        : healthy(call);
    expect(await readCreatorStatement({ data: { id: statement.id } })).toEqual({ kind: 'denied' });
    expect(calls).toHaveLength(6); // A line denial also conceals the already-read statement.

    // The same Request still retains its old token; a refused preparation must win over it.
    expect(viewerCredential(currentRequest)).toBe('Bearer current-detail-viewer');
    preparation = 'absent';
    expect(await readCreatorStatements({ data: {} })).toEqual({ kind: 'denied' });
    expect(await readCreatorStatement({ data: { id: statement.id } })).toEqual({ kind: 'denied' });
    preparation = 'unavailable';
    expect(await readCreatorStatements({ data: {} })).toEqual({ kind: 'unavailable' });
    expect(await readCreatorStatement({ data: { id: statement.id } })).toEqual({ kind: 'unavailable' });
    expect(calls).toHaveLength(6);
    expect(preparations).toBe(8);

    preparation = 'active';
    currentRequest = request();
    token = 'fresh-viewer';
    respond = () =>
      Response.json(
        { payoutStatements: [statement], next: null },
        {
          status: 302,
          headers: { location: 'https://another-principal.test/private' },
        },
      );
    expect(await readCreatorStatements({ data: {} })).toEqual({ kind: 'unavailable' });
    expect(calls).toHaveLength(7);
    respond = (call) =>
      new URL(call.url).pathname.endsWith('/lines')
        ? Response.json({ code: 'overloaded' }, { status: 503 })
        : healthy(call);
    expect(await readCreatorStatement({ data: { id: statement.id } })).toEqual({
      kind: 'ready',
      statement,
      lines: { kind: 'unavailable' },
    });
    expect(calls).toHaveLength(9);
    expect(calls.slice(6).every((call) => call.headers.get('authorization') === 'Bearer fresh-viewer')).toBe(true);
    expect(
      calls.every((call) => call.method === 'GET' && call.cache === 'no-store' && call.redirect === 'manual'),
    ).toBe(true);
    expect(calls.every((call) => new URL(call.url).origin === 'https://kernel.test')).toBe(true);
    expect(responseHeaders.get('cache-control')).toBe('private, no-store');
    expect(responseHeaders.get('x-robots-tag')).toBe('noindex, nofollow');
    for (const [status, code, kind] of [
      [400, 'invalid_cursor', 'error'],
      [409, 'stale_cursor', 'stale'],
    ] as const) {
      respond = () => Response.json({ code }, { status });
      const point = await readCreatorStatement({ data: { id: statement.id, cursor: 'signed/line+page' } });
      expect(point).toEqual({ kind: 'unavailable' });
      const html = await render(
        createElement(CreatorStatementPage, {
          page: point,
          id: statement.id,
          locale: 'en',
          cursor: 'signed/line+page',
          from: 'signed/list+page',
        }),
      );
      expect(html).toContain(
        `href="/en/creator/statements/${statement.id}?cursor=signed%2Fline%2Bpage&amp;from=signed%2Flist%2Bpage"`,
      );
      respond = (call) =>
        new URL(call.url).pathname.endsWith('/lines') ? Response.json({ code }, { status }) : healthy(call);
      expect(await readCreatorStatement({ data: { id: statement.id, cursor: 'signed/line+page' } })).toEqual({
        kind: 'ready',
        statement,
        lines: { kind },
      });
    }
  } finally {
    transport.mockRestore();
  }
});

async function render(page: ReactElement): Promise<string> {
  const root = createRootRoute({ component: () => page });
  const router = createRouter({ routeTree: root, history: createMemoryHistory({ initialEntries: ['/'] }) });
  await router.load();
  return renderToString(createElement(RouterProvider, { router }));
}

test('pending detail keeps the requested statement and exact list return page', async () => {
  const { Route } = await import('../src/routes/creator/statements/$id');
  const search = spyOn(Route, 'useSearch').mockReturnValue({ cursor: 'signed/line+page', from: 'signed/list+page' });
  const params = spyOn(Route, 'useParams').mockReturnValue({ id: statement.id });
  try {
    const html = await render(createElement(Route.options.pendingComponent!));
    expect(html).toContain('href="/en/creator/statements?cursor=signed%2Flist%2Bpage"');
    expect(html).not.toContain('signed/line+page');
  } finally {
    search.mockRestore();
    params.mockRestore();
  }
});

test('healthy captured USD/EUR and negative lines format while historical money stays unavailable with external-payment evidence intact', async () => {
  const list = await render(
    createElement(CreatorStatementsPage, {
      locale: 'en',
      page: {
        kind: 'ready',
        payoutStatements: [statement, { ...paidCreatorStatementFixture, currency: 'eur' }],
        next: null,
      },
    }),
  );
  expect(list).toContain('-$3.15');
  expect(list).toContain('€6.75');
  expect(list).toContain('No external payment recorded');
  expect(list).toContain('External payment recorded');
  expect(list).not.toContain('Amount unavailable');
  const detail = await render(
    createElement(CreatorStatementPage, {
      id: statement.id,
      locale: 'en',
      page: {
        kind: 'ready',
        statement,
        lines: {
          kind: 'ready',
          lines: [{ ...line, kind: 'refund', grossMinor: -1200, netReceiptsMinor: -1100 }],
          next: null,
        },
      },
    }),
  );
  expect(detail).toContain('-$3.15');
  expect(detail).toContain('-$11.00');
  expect(detail).not.toContain('Amount unavailable');
  const historicalList = await render(
    createElement(CreatorStatementsPage, {
      locale: 'en',
      page: { kind: 'ready', payoutStatements: [historicalCreatorStatementFixture], next: null },
    }),
  );
  const historical = await render(
    createElement(CreatorStatementPage, {
      id: historicalCreatorStatementFixture.id,
      locale: 'en',
      page: {
        kind: 'ready',
        statement: historicalCreatorStatementFixture,
        lines: { kind: 'ready', lines: [historicalCreatorLineFixture], next: null },
      },
    }),
  );
  expect(historicalList).toContain('Amount unavailable');
  expect(historicalList).not.toContain('$6.75');
  expect(historical).toContain('Amount unavailable');
  expect(historical).not.toContain('$6.75');
  expect(historical).not.toContain('$7.50');
  expect(historical).toContain(historicalCreatorStatementFixture.paidReference!);
  expect(historical).toContain(historicalCreatorLineFixture.balanceTransactionId);
  expect(historical).toContain('does not confirm that you received the payment');
  expect(renderToString(createElement(StatementAmount, { value: 675, currency: 'usd', locale: 'en' }))).toContain(
    'Amount unavailable',
  );
});
