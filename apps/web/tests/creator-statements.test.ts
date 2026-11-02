import { describe, expect, mock, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { createElement, type ReactElement } from 'react';
import { renderToString } from 'react-dom/server';
import { readFile } from 'node:fs/promises';
import { formatMinorAmount } from '../src/checkout/money';
import {
  creatorLineFixture,
  creatorStatementFixture,
  paidCreatorStatementFixture,
} from '../src/kernel/fake/creator-statements';

mock.module('cloudflare:workers', () => ({ env: {} }));
mock.module('@tanstack/react-start/server', () => ({
  getRequest: () => new Request('https://site.test'),
  setResponseHeader: () => {},
}));
const { loadCreatorStatement, loadCreatorStatements, statementSearch, statementDetailSearch } =
  await import('../src/checkout/creator-statements');
const { CreatorStatementPage } = await import('../src/checkout/creator-statement-page');
const { CreatorStatementsPage, StatementAmount, StatementPayment } =
  await import('../src/checkout/creator-statements-page');
const { isSignedInPath } = await import('../src/session/guard');
const { isPublicCacheRoute } = await import('../src/security/page-cache');

const statement = creatorStatementFixture;
const line = creatorLineFixture;
const request = () =>
  new Request('https://site.test/en/creator/statements', { headers: { authorization: 'Bearer exact-current-viewer' } });
function fixture(respond: (request: Request) => Response | Promise<Response>) {
  const calls: Request[] = [];
  const client = createKernelClient('https://kernel.test', {
    fetch: (async (input, init) => {
      const call = new Request(input, init);
      calls.push(call);
      return respond(call);
    }) as typeof fetch,
  });
  return { client, calls };
}

async function render(page: ReactElement): Promise<string> {
  const root = createRootRoute({ component: () => page });
  const router = createRouter({ routeTree: root, history: createMemoryHistory({ initialEntries: ['/'] }) });
  await router.load();
  return renderToString(createElement(RouterProvider, { router }));
}

describe('Creators can inspect private royalty statements, source lines and external-payment meaning', () => {
  test('Creator statements display exact signed native minor-unit amounts as localized currency with correct currency exponent and distinguish royalties from external paid statements', () => {
    for (const locale of ['en', 'de', 'ar-EG']) {
      for (const [currency, minor, major] of [
        ['usd', -315, -3.15],
        ['eur', 675, 6.75],
        ['jpy', 675, 675],
        ['kwd', 675, 0.675],
        ['kwd', -1, -0.001],
        ['usd', -1, -0.01],
        ['usd', 0, 0],
      ] as const) {
        expect(formatMinorAmount(locale, currency, minor)).toBe(
          new Intl.NumberFormat(locale, { style: 'currency', currency }).format(major),
        );
      }
    }
    expect(formatMinorAmount('en', 'usd', Number.MAX_SAFE_INTEGER)).toBe('$90,071,992,547,409.91');
    expect(formatMinorAmount('en', 'usd', -Number.MAX_SAFE_INTEGER)).toBe('-$90,071,992,547,409.91');
    const open = renderToString(createElement(StatementPayment, { statement, locale: 'en' }));
    expect(open).toContain('No external payment recorded');
    expect(open).not.toContain('External payment recorded');
    expect(open).toContain('Whether royalties are payable or funds are available is unknown');
    const paid = renderToString(
      createElement(StatementPayment, { statement: paidCreatorStatementFixture, locale: 'en' }),
    );
    expect(paid).toContain('External payment recorded');
    expect(paid).toContain('does not confirm that you received the payment');
  });

  test('unsafe or unknown money shows unavailable rather than a guessed amount', () => {
    for (const [currency, value] of [
      ['zzz', 675],
      ['us', 675],
      ['usd', Number.MAX_SAFE_INTEGER + 1],
      ['usd', 1.5],
      ['usd', NaN],
    ] as const) {
      expect(formatMinorAmount('en', currency, value)).toBeNull();
      expect(renderToString(createElement(StatementAmount, { currency, value, locale: 'en' }))).toContain(
        'Amount unavailable',
      );
    }
  });

  test('owner-self list and selected detail use exact typed routes, current credentials and bounded signed pages', async () => {
    const api = fixture((call) => {
      const url = new URL(call.url);
      if (url.pathname.endsWith('/lines')) return Response.json({ lines: [line], next: 'signed-lines' });
      if (url.pathname.endsWith(statement.id)) return Response.json({ statement });
      return Response.json({
        payoutStatements: [statement, { ...statement, currency: 'jpy' }],
        next: 'signed-statements',
      });
    });
    const list = await loadCreatorStatements(
      api.client,
      request(),
      {},
      statementSearch({ cursor: 'signed/page+1', creatorAccountId: 'another-account' }),
    );
    expect(list.kind).toBe('ready');
    const detail = await loadCreatorStatement(api.client, request(), {}, { id: statement.id, cursor: 'signed/line+2' });
    expect(detail).toEqual({ kind: 'ready', statement, lines: { kind: 'ready', lines: [line], next: 'signed-lines' } });
    expect(api.calls.map((call) => new URL(call.url).pathname)).toEqual([
      '/v1/payoutStatements',
      `/v1/payoutStatements/${statement.id}`,
      `/v1/payoutStatements/${statement.id}/lines`,
    ]);
    expect(api.calls.map((call) => Object.fromEntries(new URL(call.url).searchParams))).toEqual([
      { limit: '20', cursor: 'signed/page+1' },
      {},
      { limit: '20', cursor: 'signed/line+2' },
    ]);
    expect(
      api.calls.every(
        (call) => call.method === 'GET' && call.headers.get('authorization') === 'Bearer exact-current-viewer',
      ),
    ).toBe(true);
    expect(JSON.stringify(detail)).not.toContain('Bearer');
  });

  test('a server session supplies its current credential and never serializes it into statement data', async () => {
    let credentials = 0;
    const sessionEnv = {
      AUTH_ISSUER: 'https://auth.test',
      API_RESOURCE: 'https://api.test',
      WEBSITE_SCOPES: 'openid',
      WEBSITE_CLIENT_ID: 'web',
      WEBSITE_CLIENT_KEY: 'server-only',
      SESSIONS: {
        idFromName: (id: string) => id,
        get: () => ({
          credential: async () => {
            credentials++;
            return {
              status: 'active',
              subject: statement.creatorAccountId,
              accessToken: 'private-token',
              csrfToken: 'private-csrf',
            };
          },
        }),
      },
    };
    const api = fixture(() => Response.json({ payoutStatements: [statement], next: null }));
    const data = await loadCreatorStatements(
      api.client,
      new Request('https://site.test/en/creator/statements', {
        headers: { cookie: `__Host-rezics_session=${'a'.repeat(43)}` },
      }),
      sessionEnv as never,
      {},
    );
    expect(credentials).toBe(1);
    expect(api.calls[0]!.headers.get('authorization')).toBe('Bearer private-token');
    expect(data.kind).toBe('ready');
    expect(JSON.stringify(data)).not.toMatch(/private-token|private-csrf|server-only/);
  });

  test('missing credentials and native same-route another-account denials disclose no statement or source rows', async () => {
    const api = fixture(() => Response.json({ code: 'not_found' }, { status: 404 }));
    expect(await loadCreatorStatements(api.client, new Request('https://site.test'), {}, {})).toEqual({
      kind: 'denied',
    });
    expect(api.calls).toHaveLength(0);
    expect(await loadCreatorStatement(api.client, request(), {}, { id: statement.id })).toEqual({ kind: 'denied' });
    expect(api.calls).toHaveLength(1);
    const changedPermission = fixture((call) =>
      new URL(call.url).pathname.endsWith('/lines')
        ? Response.json({ code: 'not_found' }, { status: 404 })
        : Response.json({ statement }),
    );
    expect(await loadCreatorStatement(changedPermission.client, request(), {}, { id: statement.id })).toEqual({
      kind: 'denied',
    });
  });

  test('empty, stale, invalid, unavailable and incomplete evidence stay distinct without fabricated zero amounts', async () => {
    for (const [status, kind] of [
      [400, 'error'],
      [409, 'stale'],
      [503, 'unavailable'],
    ] as const) {
      const code = status === 400 ? 'invalid_cursor' : status === 409 ? 'stale_cursor' : 'overloaded';
      const api = fixture(() => Response.json({ code }, { status }));
      expect(await loadCreatorStatements(api.client, request(), {}, {})).toEqual({ kind });
    }
    const empty = fixture(() => Response.json({ payoutStatements: [], next: null }));
    expect(await loadCreatorStatements(empty.client, request(), {}, {})).toEqual({
      kind: 'ready',
      payoutStatements: [],
      next: null,
    });
    const invalid = fixture(() =>
      Response.json({ payoutStatements: [{ ...statement, creatorShareMinor: null }], next: null }),
    );
    expect(await loadCreatorStatements(invalid.client, request(), {}, {})).toEqual({ kind: 'unavailable' });
    const failedLines = fixture((call) =>
      new URL(call.url).pathname.endsWith('/lines')
        ? Response.json({ code: 'overloaded' }, { status: 503 })
        : Response.json({ statement }),
    );
    expect(await loadCreatorStatement(failedLines.client, request(), {}, { id: statement.id })).toEqual({
      kind: 'ready',
      statement,
      lines: { kind: 'unavailable' },
    });
    const mixedLines = fixture((call) =>
      new URL(call.url).pathname.endsWith('/lines')
        ? Response.json({ lines: [{ ...line, currency: 'eur' }], next: null })
        : Response.json({ statement }),
    );
    expect(await loadCreatorStatement(mixedLines.client, request(), {}, { id: statement.id })).toEqual({
      kind: 'ready',
      statement,
      lines: { kind: 'unavailable' },
    });
    expect(statementSearch({ cursor: 'x'.repeat(4097) })).toEqual({ cursorMalformed: true });
    expect(statementDetailSearch({ from: ['untrusted'], cursor: 'signed/line+/=' })).toEqual({
      cursor: 'signed/line+/=',
      fromMalformed: true,
    });
  });

  test('malformed statement positions do not prepare or issue a native read', async () => {
    const api = fixture(() => Response.json({}));
    expect(await loadCreatorStatements(api.client, request(), {}, { cursor: 'x'.repeat(4097) })).toEqual({
      kind: 'unavailable',
    });
    expect(await loadCreatorStatement(api.client, request(), {}, { id: statement.id, cursor: 'x'.repeat(4097) })).toEqual({
      kind: 'unavailable',
    });
    expect(api.calls).toHaveLength(0);
  });

  test('pages preserve currencies, negative adjustments, exact provenance and external payment meaning', async () => {
    const html = await render(
      createElement(CreatorStatementPage, {
        id: statement.id,
        locale: 'en',
        from: 'signed/list+page',
        cursor: 'signed/line+page',
        page: {
          kind: 'ready',
          statement,
          lines: {
            kind: 'ready',
            lines: [{ ...line, kind: 'refund', grossMinor: -1200, netReceiptsMinor: -1100 }],
            next: 'next/line+page',
          },
        },
      }),
    );
    expect(html).toContain('-$3.15');
    expect(html).toContain('-$11.00');
    expect(html).toContain('No external payment recorded');
    expect(html).not.toContain('minor units</span>');
    expect(html).toContain(statement.weightedNetMinor);
    expect(html).toContain(line.balanceTransactionId);
    expect(html).toContain(line.created);
    expect(html).toContain(line.recordedAt);
    expect(html).toContain('cursor=signed%2Flist%2Bpage');
    expect(html).toContain('from=signed%2Flist%2Bpage');
    expect(html).not.toMatch(/buyer.*email|markPaid|payout button/i);
    const paid = renderToString(
      createElement(StatementPayment, { statement: paidCreatorStatementFixture, locale: 'en' }),
    );
    expect(paid).toContain(paidCreatorStatementFixture.paidReference!);
    expect(paid).toContain('External payment recorded');
    expect(paid).toContain('does not confirm that you received the payment');
    expect(paid).toContain('Whether royalties are payable or funds are available is unknown');
    expect(paid).not.toContain('Stripe');
    const missing = renderToString(
      createElement(StatementPayment, {
        statement: { ...paidCreatorStatementFixture, paidReference: null, paidAt: null },
        locale: 'en',
      }),
    );
    expect(missing).toContain('Unknown / evidence unavailable');
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
    expect(list).toContain('External payment recorded');
    expect(list).not.toContain('Stripe');
    const euroDetail = await render(
      createElement(CreatorStatementPage, {
        id: paidCreatorStatementFixture.id,
        locale: 'en',
        page: {
          kind: 'ready',
          statement: { ...paidCreatorStatementFixture, currency: 'eur' },
          lines: { kind: 'ready', lines: [], next: null },
        },
      }),
    );
    expect(euroDetail).toContain('€6.75');
  });

  test('private routes require sign-in, never opt into public cache and carry noindex/no-store on BFF reads', async () => {
    for (const path of [
      '/creator/statements',
      `/creator/statements/${statement.id}`,
      `/fr/creator/statements/${statement.id}`,
    ]) {
      expect(isSignedInPath(path)).toBe(true);
    }
    const list = await readFile(new URL('../src/routes/creator/statements/index.tsx', import.meta.url), 'utf8');
    const detail = await readFile(new URL('../src/routes/creator/statements/$id.tsx', import.meta.url), 'utf8');
    const bff = await readFile(new URL('../src/checkout/creator-statements.ts', import.meta.url), 'utf8');
    for (const route of [list, detail]) {
      expect(route).toContain('beforeLoad: requireSignedIn');
      expect(route).toContain("robots: 'noindex, nofollow'");
      expect(route).not.toContain('publicCache: true');
    }
    expect(isPublicCacheRoute([{}])).toBe(false);
    expect(bff).toContain("setResponseHeader('cache-control', 'private, no-store')");
    expect(bff).not.toContain('markPaid');
  });
});
