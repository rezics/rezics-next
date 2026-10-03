import { afterEach, expect, spyOn, test } from 'bun:test';
import { createServer, type Server, type ServerResponse } from 'node:http';
import {
  workAsyncStorage,
  type WorkStore,
} from 'next/dist/server/app-render/work-async-storage.external.js';
import {
  workUnitAsyncStorage,
  type RequestStore,
} from 'next/dist/server/app-render/work-unit-async-storage.external.js';
import {
  serverFetch,
  SERVER_DEADLINE_HEADER,
  type FetchSender,
} from '../features/api/server-fetch.ts';
import { mainApiWithToken } from '../features/api/main.ts';
import { forwardToMain } from '../features/api/bff.ts';
import { readAddress, type ResolvedAddress } from '../features/address/client.ts';
import { refreshTokens } from '../features/auth/account.ts';
import { forgetServedTypes, readTypes } from '../features/catalogue/types-read.ts';
import { servedTypes } from '../features/catalogue/type-fixtures.ts';
import { readHomeView, readHomePosts } from '../features/home/server.ts';
import { loadDiscoverState } from '../features/discover/load.ts';
import { parseBrowseState } from '../features/discover/browse-state.ts';
import { readCommunityNavigation } from '../features/shell/communities-read.ts';
import { createElement, Suspense } from 'react';
import { renderToReadableStream } from 'react-dom/server.browser';
import {
  AppRouterContext,
  type AppRouterInstance,
} from 'next/dist/shared/lib/app-router-context.shared-runtime.js';
import { SearchParamsContext } from 'next/dist/shared/lib/hooks-client-context.shared-runtime.js';
import Home from '../app/[locale]/page.tsx';
import Discover from '../app/[locale]/discover/page.tsx';
import { Providers } from '../features/shell/providers.tsx';
import { page as feedPage } from '../features/feed/fixtures.ts';
import { NextRequest } from 'next/server';
import { proxy } from '../proxy.ts';
import { mainBodyRead } from '../features/api/main-read-operation.ts';

const nativeFetch = globalThis.fetch;
const mainOrigin = process.env.MAIN_ORIGIN;
afterEach(() => {
  globalThis.fetch = nativeFetch;
  if (mainOrigin === undefined) delete process.env.MAIN_ORIGIN;
  else process.env.MAIN_ORIGIN = mainOrigin;
  forgetServedTypes();
});

async function pageRequest<T>(run: () => Promise<T>, budget = 150, signedIn = false): Promise<T> {
  const headers = new Headers({
    [SERVER_DEADLINE_HEADER]: String(Date.now() + budget),
    'cf-connecting-ip': '203.0.113.17',
    'x-rezics-page-url': 'https://web.test/en/discover',
  });
  const cookies = {
    get: (name: string) =>
      signedIn && name === 'rezics_access'
        ? { value: 'reader-token' }
        : signedIn && name === 'rezics_session_key'
          ? { value: '10280000-0000-4000-8000-000000000001' }
          : undefined,
  };
  const work = spyOn(workAsyncStorage, 'getStore').mockReturnValue({
    route: '/en/discover',
  } as WorkStore);
  const request = spyOn(workUnitAsyncStorage, 'getStore').mockReturnValue({
    type: 'request',
    phase: 'render',
    headers,
    cookies,
  } as RequestStore);
  try {
    return await run();
  } finally {
    work.mockRestore();
    request.mockRestore();
  }
}

function neverClosing(cancelled: () => void = () => {}): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"items":'));
      },
      cancel: cancelled,
    }),
    { headers: { 'content-type': 'application/json' } },
  );
}

test('G1028: a fetch that ignores abort still settles at its deadline and cancels a late body', async () => {
  let resolveFetch: (response: Response) => void = () => {};
  let signal: AbortSignal | null | undefined;
  let cancelled = false;
  const send: FetchSender = (_input, init) => {
    signal = init?.signal;
    return new Promise((resolve) => {
      resolveFetch = resolve;
    });
  };
  const started = performance.now();
  await expect(
    serverFetch('https://main.test/v1/feed', {}, { fetch: send, timeoutMs: 40 }),
  ).rejects.toMatchObject({ name: 'TimeoutError' });
  expect(performance.now() - started).toBeLessThan(1000);
  expect(signal?.aborted).toBe(true);
  resolveFetch(
    neverClosing(() => {
      cancelled = true;
    }),
  );
  await Promise.resolve();
  expect(cancelled).toBe(true);
});

test('G1028: a partial JSON body times out, is cancelled and cannot escape as successful data', async () => {
  let cancelled = false;
  await expect(
    serverFetch(
      'https://main.test/v1/feed',
      {},
      {
        fetch: async () =>
          neverClosing(() => {
            cancelled = true;
          }),
        timeoutMs: 40,
      },
    ),
  ).rejects.toMatchObject({ name: 'TimeoutError' });
  expect(cancelled).toBe(true);
});

test('G1028: one fresh read retry retains credentials, validators and the original deadline', async () => {
  const attempts: RequestInit[] = [];
  const send: FetchSender = async (_input, init) => {
    attempts.push(init!);
    if (attempts.length === 1)
      throw Object.assign(new Error('Network connection lost.'), { retryable: true });
    return Response.json({ recovered: true });
  };
  const result = await serverFetch(
    'https://main.test/v1/feed',
    {
      headers: {
        authorization: 'Bearer private',
        'if-none-match': '"revision"',
        [SERVER_DEADLINE_HEADER]: String(Date.now() + 500),
      },
    },
    { fetch: send },
  );
  expect(await result.json()).toEqual({ recovered: true });
  expect(attempts).toHaveLength(2);
  for (const attempt of attempts) {
    const headers = new Headers(attempt.headers);
    expect(headers.get('authorization')).toBe('Bearer private');
    expect(headers.get('if-none-match')).toBe('"revision"');
    expect(headers.has(SERVER_DEADLINE_HEADER)).toBe(false);
  }
  expect(attempts[0]!.signal?.aborted).toBe(true);
  expect(new Headers(attempts[1]!.headers).get('connection')).toBe('close');
  expect(attempts[1]!.keepalive).toBe(false);
});

test('G1028: writes, refused reads and caller cancellation are never replayed', async () => {
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    let calls = 0;
    await expect(
      serverFetch(
        'https://account.test/token',
        { method },
        {
          fetch: async () => {
            calls++;
            throw new Error('Network connection lost.');
          },
        },
      ),
    ).rejects.toThrow('Network connection lost');
    expect(calls).toBe(1);
  }
  let calls = 0;
  const refused = await serverFetch(
    'https://main.test/v1/feed',
    {},
    {
      fetch: async () => {
        calls++;
        return Response.json({ error: 'unavailable' }, { status: 503 });
      },
    },
  );
  expect(refused.status).toBe(503);
  expect(calls).toBe(1);
  const controller = new AbortController();
  controller.abort();
  await expect(
    serverFetch(
      'https://main.test/v1/feed',
      { signal: controller.signal },
      {
        fetch: async () => {
          calls++;
          return Response.json({});
        },
      },
    ),
  ).rejects.toMatchObject({ name: 'AbortError' });
  expect(calls).toBe(1);
});

test('G1028: only Main operations declared as reads may replay a POST', () => {
  for (const path of [
    '/v1/query',
    '/v1/resources/summaries',
    '/v1/governance/rule-queries',
    '/v1/media/metadata',
    '/v1/suitability/reads',
  ]) {
    expect(mainBodyRead(path, 'POST')).toBe(true);
    expect(mainBodyRead(path, 'PUT')).toBe(false);
  }
  for (const path of [
    '/v1/works',
    '/v1/follows',
    '/v1/media/uploads',
    '/v1/resources/summaries/extra',
    '/v1/reports',
    '/api/auth/oauth2/token',
  ])
    expect(mainBodyRead(path, 'POST')).toBe(false);
});

test('G1028: retry and sequential reads cannot restart the caller budget', async () => {
  let calls = 0;
  const deadlineAt = Date.now() + 60;
  await expect(
    serverFetch(
      'https://main.test/v1/feed',
      {},
      {
        deadlineAt,
        fetch: async () => {
          calls++;
          if (calls === 1) {
            await Bun.sleep(20);
            throw new Error('Network connection lost.');
          }
          return neverClosing();
        },
      },
    ),
  ).rejects.toMatchObject({ name: 'TimeoutError' });
  expect(calls).toBe(2);
  await expect(
    serverFetch(
      'https://main.test/v1/trending',
      {},
      {
        deadlineAt,
        fetch: async () => {
          calls++;
          return Response.json({});
        },
      },
    ),
  ).rejects.toMatchObject({ name: 'TimeoutError' });
  expect(calls).toBe(2);
});

test('G1028: a media stream fails by its absolute deadline even when its consumer pauses', async () => {
  let cancelled = false;
  const result = await serverFetch(
    'https://main.test/v1/media/bytes',
    {},
    {
      stream: true,
      timeoutMs: 40,
      fetch: async () =>
        neverClosing(() => {
          cancelled = true;
        }),
    },
  );
  await Bun.sleep(70);
  await expect(result.text()).rejects.toMatchObject({ name: 'TimeoutError' });
  expect(cancelled).toBe(true);
});

test('G1028: session refresh shares one bounded rotation, evicts failure and recovers without a web restart', async () => {
  let calls = 0;
  let recover = false;
  const client = {
    accountOrigin: 'https://g1028-account.test',
    clientId: 'web',
    resource: 'main',
    deadlineAt: Date.now() + 70,
    fetch: (async () => {
      calls++;
      return recover
        ? Response.json({ access_token: 'recovered', refresh_token: 'rotated' })
        : neverClosing();
    }) as unknown as typeof fetch,
  };
  const failed = await Promise.all(
    Array.from({ length: 5 }, () => refreshTokens(client, 'g1028-pending')),
  );
  expect(failed).toEqual(Array(5).fill({ status: 'unavailable' }));
  expect(calls).toBe(1);
  // Let the shared exchange's failure handler evict it before the next request.
  await Bun.sleep(10);
  recover = true;
  expect(
    await refreshTokens({ ...client, deadlineAt: Date.now() + 500 }, 'g1028-pending'),
  ).toMatchObject({ status: 'issued', tokens: { accessToken: 'recovered' } });
  expect(calls).toBe(2);
});

test('G1028: joining a refresh has its own remaining budget without replaying the rotation', async () => {
  let calls = 0;
  let finish: (response: Response) => void = () => {};
  const client = {
    accountOrigin: 'https://g1028-waiter.test',
    clientId: 'web',
    resource: 'main',
    deadlineAt: Date.now() + 500,
    fetch: (() => {
      calls++;
      return new Promise<Response>((resolve) => {
        finish = resolve;
      });
    }) as unknown as typeof fetch,
  };
  const first = refreshTokens(client, 'waiter');
  expect(await refreshTokens({ ...client, deadlineAt: Date.now() + 40 }, 'waiter')).toEqual({
    status: 'unavailable',
  });
  finish(Response.json({ access_token: 'issued-once' }));
  expect(await first).toMatchObject({ status: 'issued' });
  expect(calls).toBe(1);
});

test('G1028: address revalidation never holds a failed body as data and the next request recovers', async () => {
  const value: ResolvedAddress = {
    profile: 'address-resolution-v1',
    status: 'resolved',
    scope: 'agent',
    key: 'reader',
    holder: 'https://rezics.com/id/10280000-0000-4000-8000-000000000002',
    state: 'current',
    canonical: { prefix: '/a/', key: 'reader', suffixSource: 'Reader' },
  };
  let calls = 0;
  let stalled = false;
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    calls++;
    if (stalled) return neverClosing();
    if (calls === 3) expect(new Headers(init?.headers).has('if-none-match')).toBe(false);
    return Response.json(value, {
      headers: { 'cache-control': 'public, max-age=0', etag: '"g1028"' },
    });
  }) as unknown as typeof fetch;
  const read = () =>
    readAddress({ scope: 'agent', key: 'reader' }, 'en', 'https://g1028-address.test');
  expect((await pageRequest(read)).kind).toBe('resolved');
  stalled = true;
  expect((await pageRequest(read, 40)).kind).toBe('unavailable');
  stalled = false;
  expect((await pageRequest(read)).kind).toBe('resolved');
  expect(calls).toBe(3);
});

test('G1028: a registry dedupe releases a timed-out body and later revalidation recovers', async () => {
  let calls = 0;
  let recover = false;
  let now = Date.now();
  const fetcher = (async () => {
    calls++;
    return recover ? Response.json(servedTypes) : neverClosing();
  }) as unknown as typeof fetch;
  expect(
    await pageRequest(
      () => Promise.all([readTypes(fetcher, () => now), readTypes(fetcher, () => now)]),
      40,
    ),
  ).toEqual([null, null]);
  expect(calls).toBe(1);
  now += 10_001;
  recover = true;
  expect(await pageRequest(() => readTypes(fetcher, () => now))).toEqual(servedTypes);
  expect(calls).toBe(2);
});

test('G1028: a registry waiter spends its remaining budget without cancelling the shared read', async () => {
  let finish: (response: Response) => void = () => {};
  let calls = 0;
  const fetcher = (() => {
    calls++;
    return new Promise<Response>((resolve) => {
      finish = resolve;
    });
  }) as unknown as typeof fetch;
  const first = readTypes(fetcher);
  expect(await pageRequest(() => readTypes(fetcher), 40)).toBeNull();
  finish(Response.json(servedTypes));
  expect(await first).toEqual(servedTypes);
  expect(calls).toBe(1);
});

async function standIn(
  respond: (response: ServerResponse, path: string) => void,
): Promise<{ server: Server; origin: string }> {
  const server = createServer((request, response) =>
    respond(response, new URL(request.url!, 'http://main.test').pathname),
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Stand-in has no TCP address');
  return { server, origin: `http://127.0.0.1:${address.port}` };
}
async function stop(server: Server): Promise<void> {
  const closed = new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  server.closeAllConnections();
  await closed;
}

test('G1028: killing Main mid-response retries the read once on a new TCP connection', async () => {
  let calls = 0;
  const ports: number[] = [];
  const { server, origin } = await standIn((response) => {
    calls++;
    ports.push(response.socket!.remotePort!);
    response.writeHead(200, { 'content-type': 'application/json' });
    if (calls === 1) {
      response.write('{"recovered":');
      setTimeout(() => response.destroy(), 20);
    } else response.end('{"recovered":true}');
  });
  try {
    const read = await serverFetch(`${origin}/v1/feed`, {}, { timeoutMs: 1000 });
    expect(await read.json()).toEqual({ recovered: true });
    expect(calls).toBe(2);
    expect(ports[1]).not.toBe(ports[0]);
  } finally {
    await stop(server);
  }
});

test('G1028: home, discover and shell loaders finish after Main resets and recover in the same web process', async () => {
  let mode: 'reset' | 'stall' | 'ready' = 'reset';
  let resets = 0;
  const { server, origin } = await standIn((response, path) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    if (mode !== 'ready') {
      response.write('{"items":');
      if (mode === 'reset') {
        resets++;
        setTimeout(() => response.destroy(), 10);
      }
      return;
    }
    const page = {
      items: [],
      nextCursor: null,
      complete: true,
      count: { value: 0, kind: 'exact' },
    };
    if (path === '/v1/query')
      response.end(JSON.stringify({ result: { profile: 'resource-list-v1', ...page } }));
    else if (path === '/v1/discovery/sections')
      response.end(JSON.stringify({ profile: 'discovery-sections-v1', ...page }));
    else if (path === '/v1/discovery/concepts')
      response.end(JSON.stringify({ profile: 'concept-search-v1', ...page }));
    else if (path === '/v1/me/session-agent')
      response.end(JSON.stringify({ sessionAgent: { eligible: false }, mainAgent: {} }));
    else response.end(JSON.stringify(page));
  });
  process.env.MAIN_ORIGIN = origin;
  const load = () =>
    pageRequest(async () => {
      const home = await readHomeView({}, 'en');
      return Promise.all([
        readHomePosts(home, 'en'),
        loadDiscoverState(parseBrowseState({}), 'en'),
        readCommunityNavigation('en'),
      ]);
    }, 250);
  try {
    for (const failedMode of ['reset', 'stall'] as const) {
      mode = failedMode;
      const started = performance.now();
      const [home, discover, shell] = await load();
      expect(performance.now() - started).toBeLessThan(1500);
      expect(home.page).toEqual({ ok: false, failure: 'unavailable' });
      expect(discover.results).toEqual({ ok: false, moved: false });
      expect(discover.sections).toEqual({ ok: false, moved: false });
      expect(shell.official).toEqual([]);
    }
    expect(resets).toBeGreaterThan(0);
    mode = 'ready';
    const [home, discover] = await load();
    expect(home.page.ok).toBe(true);
    expect(discover.results?.ok).toBe(true);
    expect(discover.sections?.ok).toBe(true);
  } finally {
    await stop(server);
  }
});

test('G1028: Eden header preference reads spend the page budget before the final read', async () => {
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return neverClosing();
  }) as unknown as typeof fetch;
  const read = await pageRequest(
    () => mainApiWithToken('reader-token').v1.feed.get({ query: {} }),
    40,
    true,
  );
  expect(read.status).toBe(503);
  expect(calls).toBe(1);
});

test('G1028: Main body-bearing Query reads retry once with the identical body', async () => {
  const bodies: unknown[] = [];
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    bodies.push(init?.body);
    if (bodies.length === 1) throw new Error('Network connection lost.');
    return Response.json({ result: { items: [] } });
  }) as unknown as typeof fetch;
  const result = await pageRequest(() =>
    mainApiWithToken(undefined).v1.query.post({
      profile: 'resource-list-v1',
      context: 'global',
      scope: { kind: 'all' },
      limit: 20,
      sort: 'newest',
    }),
  );
  expect(result.status).toBe(200);
  expect(bodies).toHaveLength(2);
  expect(bodies[1]).toBe(bodies[0]);
});

test('G1028: BFF JSON failure returns unavailable and later calls recover', async () => {
  let ready = false;
  const send = (async () =>
    ready ? Response.json({ items: [] }) : neverClosing()) as unknown as typeof fetch;
  const call = () =>
    forwardToMain(
      new Request('https://web.test/api/main/v1/feed', {
        headers: {
          [SERVER_DEADLINE_HEADER]: String(Date.now() + 40),
        },
      }),
      ['v1', 'feed'],
      { mainOrigin: 'https://main.test', accessToken: undefined, fetch: send },
    );
  expect((await call()).status).toBe(503);
  ready = true;
  const recovered = await call();
  expect(recovered.status).toBe(200);
  expect(await recovered.json()).toEqual({ items: [] });
});

test('G1028: BFF Query reads retry once and a stalled inbound read body has a deadline too', async () => {
  const bodies: unknown[] = [];
  const send = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    bodies.push(init?.body);
    if (bodies.length === 1) throw new Error('Network connection lost.');
    return Response.json({ result: {} });
  }) as unknown as typeof fetch;
  const request = new Request('https://web.test/api/main/v1/query', {
    method: 'POST',
    body: '{"profile":"resource-list-v1"}',
  });
  expect(
    (
      await forwardToMain(request, ['v1', 'query'], {
        mainOrigin: 'https://main.test',
        accessToken: undefined,
        fetch: send,
      })
    ).status,
  ).toBe(200);
  expect(bodies).toEqual(['{"profile":"resource-list-v1"}', '{"profile":"resource-list-v1"}']);
  const stalled = new Request(request.url, {
    method: 'POST',
    headers: {
      [SERVER_DEADLINE_HEADER]: String(Date.now() + 40),
    },
    body: neverClosing().body,
    duplex: 'half',
  } as RequestInit);
  expect(
    (
      await forwardToMain(stalled, ['v1', 'query'], {
        mainOrigin: 'https://main.test',
        accessToken: undefined,
        fetch: send,
      })
    ).status,
  ).toBe(503);
  expect(bodies).toHaveLength(2);
});

test('G1028: real home and discover page streams close with unavailable sections after Main is killed', async () => {
  let ready = false;
  const { server, origin } = await standIn((response, path) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    if (ready) {
      const page = {
        items: [],
        nextCursor: null,
        complete: true,
        count: { value: 0, kind: 'exact' },
      };
      if (path === '/v1/types') response.end(JSON.stringify(servedTypes));
      else if (path === '/v1/feed') response.end(JSON.stringify(feedPage([], { scope: 'all' })));
      else if (path === '/v1/query')
        response.end(JSON.stringify({ result: { profile: 'resource-list-v1', ...page } }));
      else if (path === '/v1/discovery/sections')
        response.end(JSON.stringify({ profile: 'discovery-sections-v1', ...page }));
      else if (path === '/v1/discovery/concepts')
        response.end(JSON.stringify({ profile: 'concept-search-v1', ...page }));
      else response.end(JSON.stringify(page));
      return;
    }
    response.write('{"items":');
    setTimeout(() => response.destroy(), 10);
  });
  process.env.MAIN_ORIGIN = origin;
  const router: AppRouterInstance = {
    bfcacheId: '',
    refresh() {},
    push() {},
    replace() {},
    back() {},
    forward() {},
    prefetch() {},
  };
  try {
    for (const recovered of [false, true]) {
      ready = recovered;
      for (const page of [
        createElement(Home, {
          params: Promise.resolve({ locale: 'en' }),
          searchParams: Promise.resolve({}),
        }),
        createElement(Discover, { searchParams: Promise.resolve({}) }),
      ]) {
        const errors: unknown[] = [];
        const started = performance.now();
        const html = await pageRequest(async () => {
          const stream = await renderToReadableStream(
            createElement(
              AppRouterContext.Provider,
              { value: router },
              createElement(
                SearchParamsContext.Provider,
                { value: new URLSearchParams() },
                createElement(
                  Providers,
                  null,
                  createElement(Suspense, { fallback: createElement('p', null, 'Loading…') }, page),
                ),
              ),
            ),
            {
              onError: (error) => {
                errors.push(error);
              },
            },
          );
          return new Response(stream).text();
        }, 250);
        expect(errors).toEqual([]);
        expect(performance.now() - started).toBeLessThan(2000);
        expect(html.includes('role="alert"')).toBe(!recovered);
        expect(/unavailable|couldn(?:’|'|&#x27;)t|could not|can(?:’|'|&#x27;)t/i.test(html)).toBe(
          !recovered,
        );
      }
    }
  } finally {
    await stop(server);
  }
});

test('G1028: proxy replaces a forged deadline and passes one remaining budget to the page', async () => {
  const before = Date.now();
  const result = await proxy(
    new NextRequest('https://web.test/en', {
      headers: {
        [SERVER_DEADLINE_HEADER]: String(before + 3_600_000),
      },
    }),
  );
  const deadline = Number(result.headers.get(`x-middleware-request-${SERVER_DEADLINE_HEADER}`));
  expect(deadline).toBeGreaterThanOrEqual(before + 15_000);
  expect(deadline).toBeLessThanOrEqual(Date.now() + 15_000);
});
