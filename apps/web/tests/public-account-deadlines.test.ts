import { afterAll, expect, mock, spyOn, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import { contributionPage, profilePage } from '../src/stories/pages/accounts-public-profile/fixtures';
mock.module('cloudflare:workers', () => ({ env: {} }));
const { loadPublicAccountJourney, pageProfile } = await import('../src/accounts/public-profile/page-read');

const schedule = globalThis.setTimeout;
const timer = spyOn(globalThis, 'setTimeout').mockImplementation(((fn, ms, ...args) =>
  schedule(fn, ms === 10_000 || ms === 2_000 ? 5 : ms, ...args)) as typeof setTimeout);
afterAll(() => timer.mockRestore());
const stalled = (body: boolean): Promise<Response> =>
  body
    ? Promise.resolve(new Response(new ReadableStream(), { headers: { 'content-type': 'application/json' } }))
    : new Promise(() => {});

for (const body of [false, true])
  for (const phase of [
    'primary',
    'overview',
    'former',
    'operator',
    'continuation',
    'directory',
    'hydration',
  ] as const) {
    test(`public account recovers stalled ${body ? 'body' : 'headers'} in ${phase}`, async () => {
      const page =
        phase === 'continuation'
          ? contributionPage('posts')
          : profilePage({
              profile: { automated: true, operatorId: 'operator', publicViews: { posts: true, realms: true } },
            });
      const requests: Request[] = [];
      let stopped!: Request;
      const client = createKernelClient('https://kernel.test', {
        fetch: (async (input, init) => {
          const request = new Request(input, init);
          requests.push(request);
          expect(request.headers.has('authorization')).toBe(false);
          const url = new URL(request.url);
          const stop = () => {
            stopped = request;
            return stalled(body);
          };
          if (request.method === 'POST') {
            const { target } = (await request.json()) as { target: { view?: string } };
            if (phase === 'primary' || (phase === 'overview' && !target.view)) return stop();
            return phase === 'former'
              ? Response.json({}, { status: 404 })
              : Response.json({ ...page, account: page.account!.id });
          }
          if (url.pathname === '/v1/accounts')
            return phase === 'operator' || phase === 'former' ? stop() : Response.json({ accounts: [] });
          expect(url.pathname).toContain(phase === 'hydration' ? '/realms' : `/accounts/${page.account!.id}/`);
          if (url.pathname.endsWith('/realms') && phase !== 'directory') {
            expect(url.searchParams.get('cursor')).toBe('signed+/=cursor');
            expect(url.searchParams.get('limit')).toBe('20');
            return Response.json({ realms: [{ id: 'realm', role: 'member' }], next: 'next' });
          }
          return stop();
        }) as typeof fetch,
      });
      const result = await loadPublicAccountJourney(client, {
        handle: page.account!.handle,
        locale: 'en',
        cursor: 'signed+/=cursor',
        view:
          phase === 'overview' || phase === 'continuation'
            ? 'posts'
            : phase === 'directory' || phase === 'hydration'
              ? 'realms'
              : undefined,
      });
      expect(stopped.signal.aborted).toBe(true);
      expect(requests.every((request) => request.method === 'GET' || request.url.endsWith('/pages:read'))).toBe(true);
      if (phase === 'operator') {
        expect(result.kind).toBe('page');
        if (result.kind === 'page') {
          expect(pageProfile(result.page)?.automated).toBe(true);
          expect(result).not.toHaveProperty('operator');
        }
      } else if (phase === 'directory' || phase === 'hydration') {
        expect(result.kind === 'page' && result.realms).toEqual({ state: 'unavailable' });
      } else expect(result).toEqual({ kind: 'state', state: 'unavailable' });
    });
  }

test('caller cancellation releases a stalled read, removes its listener and prevents later dispatch', async () => {
  const caller = new AbortController();
  const add = spyOn(caller.signal, 'addEventListener');
  const remove = spyOn(caller.signal, 'removeEventListener');
  let calls = 0;
  let request!: Request;
  const client = createKernelClient('https://kernel.test', {
    fetch: ((input, init) => {
      calls++;
      request = new Request(input, init);
      caller.abort();
      return stalled(false);
    }) as typeof fetch,
  });
  expect(await loadPublicAccountJourney(client, { handle: 'reader', locale: 'en' }, caller.signal)).toEqual({
    kind: 'state',
    state: 'unavailable',
  });
  expect(request.signal.aborted).toBe(true);
  expect(remove.mock.calls[0]).toEqual(add.mock.calls[0]);
  expect(await loadPublicAccountJourney(client, { handle: 'reader', locale: 'en' }, caller.signal)).toEqual({
    kind: 'state',
    state: 'unavailable',
  });
  expect(calls).toBe(1);
});
