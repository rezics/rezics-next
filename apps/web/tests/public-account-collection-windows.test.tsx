import { afterAll, expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act } from 'react';
import { createKernelClient } from '@rezics/client';
import { createMemoryHistory, createRootRouteWithContext, createRouter, RouterProvider } from '@tanstack/react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as start from '../.storybook/react-start';
import { CollectionVisit, collectionWindowHref } from '../src/accounts/public-profile/collection-windows/visit';

const { Window } = await import(Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir))));
const window = new Window({ url: 'https://site.test/@mira/collections' });
const globals = { window, document: window.document, navigator: window.navigator, HTMLElement: window.HTMLElement,
  Element: window.Element, Node: window.Node, Document: window.Document, DocumentFragment: window.DocumentFragment,
  MutationObserver: window.MutationObserver, ResizeObserver: window.ResizeObserver,
  getComputedStyle: window.getComputedStyle.bind(window), IS_REACT_ACT_ENVIRONMENT: true };
const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value, writable: true });
afterAll(() => { for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); } });
mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);
mock.module('cloudflare:workers', () => ({ env: { PUBLIC_ORIGIN: 'https://site.test' } }));
mock.module('../src/accounts/public-profile/reader-presentation/adapter', () => ({ useProfileReading: () => undefined }));
mock.module('../src/kernel/exposure', () => ({ useOperation: () => true }));
const { contributionPage } = await import('../src/stories/pages/accounts-public-profile/fixtures');
const { loadPublicAccountJourney } = await import('../src/accounts/public-profile/page-read');
const requests: URL[] = [];
let fail = false;
const native = createKernelClient('https://kernel.test', { fetch: (async (input, init) => {
  const request = new Request(input, init);
  expect(request.headers.has('authorization')).toBe(false);
  if (request.method === 'POST') {
    const page = contributionPage('collections');
    for (const read of Object.values(page.reads)) {
      const body = read.body as { collections?: unknown[]; next?: string };
      if (body.collections) body.next = 'second+/=';
    }
    return Response.json({ ...page, account: page.account!.id });
  }
  const url = new URL(request.url); requests.push(url);
  expect(url.pathname).toEndWith('/collections');
  expect(url.searchParams.get('view')).toBe('BASIC');
  expect(url.searchParams.get('limit')).toBe('24');
  if (fail) { fail = false; return Response.json({}, { status: 503 }); }
  return Response.json({ collections: [], next: url.searchParams.get('cursor') === 'second+/=' ? 'final' : null });
}) as typeof fetch });
mock.module('../src/features/pages/agent-actions', () => ({
  readAgentPage: ({ data }: { data: Parameters<typeof loadPublicAccountJourney>[1] }) => loadPublicAccountJourney(native, data),
  readAgentReader: () => { throw new Error('Unexpected private read'); },
}));
const { Route } = await import('../src/routes/@{$handle}_.$view');
const { createRoot } = await import('react-dom/client');
const { overwriteGetLocale } = await import('../src/paraglide/runtime.js');
overwriteGetLocale(() => 'en');

test('served named Collections route replaces sparse/empty windows, survives cursor remount, retries exact failure and browses back/first', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const rootRoute = createRootRouteWithContext<{ queryClient: QueryClient }>()();
  const route = Route.update({ getParentRoute: () => rootRoute, path: '/@{$handle}/$view', id: undefined } as never);
  const router = createRouter({ routeTree: rootRoute.addChildren([route]), context: { queryClient: client },
    history: createMemoryHistory({ initialEntries: ['/@mira/collections?keep=a%2fb&keep=2#anchor'] }) });
  const host = window.document.createElement('div'); window.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  const settle = async () => { await new Promise((resolve) => setTimeout(resolve, 30)); };
  await act(async () => { await router.load(); root.render(<QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider>); await settle(); });
  const link = (slot: string) => host.querySelector<HTMLAnchorElement>(`[data-slot="account-collections"] [data-slot="${slot}"]`);
  const click = async (slot: string) => { expect(link(slot)).not.toBeNull(); await act(async () => { link(slot)!.focus(); link(slot)!.click(); await settle(); }); };
  try {
    expect(link('previous')).toBeNull();
    await click('continuation');
    expect(requests.at(-1)!.searchParams.get('cursor')).toBe('second+/=');
    expect(link('previous')).not.toBeNull();
    fail = true; await click('continuation');
    expect(link('retry')).not.toBeNull();
    await click('retry');
    expect(requests.slice(-2).map((url) => url.searchParams.get('cursor'))).toEqual(['final', 'final']);
    expect(link('continuation')).toBeNull();
    expect(link('previous')).not.toBeNull();
    await click('previous');
    expect(requests.at(-1)!.searchParams.get('cursor')).toBe('second+/=');
    await click('first');
    expect(router.state.location.searchStr).toBe('?keep=a%2fb&keep=2');
    expect(router.state.location.hash).toBe('anchor');
    expect(link('previous')).toBeNull();
  } finally { await act(async () => root.unmount()); client.clear(); host.remove(); }
});

test('admitted coordinates are bounded, direct later entry invents none, failed First retains target, retirement is permanent', () => {
  const visit = new CollectionVisit();
  const activator = window.document.createElement('a') as unknown as HTMLElement;
  visit.receive('direct', true); expect(visit.previous).toBeUndefined();
  for (let index = 0; index < 12; index++) {
    visit.begin('next', String(index), activator); visit.receive(String(index), true);
  }
  expect(visit.coordinates).toHaveLength(9);
  const admitted = [...visit.coordinates];
  visit.begin('first', null, activator); visit.receive(null, false);
  expect(visit.coordinates).toEqual(admitted); expect(visit.target).toEqual({ movement: 'first', cursor: null });
  visit.begin('first', null, activator); visit.receive(null, true); expect(visit.coordinates).toEqual([null]);
  visit.retire(); expect(visit.begin('next', 'old', activator)).toBe(false);
  visit.receive('old', true); expect(visit.coordinates).toEqual([]);
  expect(collectionWindowHref('?keep=a%2fb&%63ursor=x&cursor=y', 'hash', null)).toBe('?keep=a%2fb#hash');
});
