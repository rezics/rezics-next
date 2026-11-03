import { afterAll, afterEach, expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, createContext, useContext, useMemo, type ReactNode } from 'react';
import type { Root } from 'react-dom/client';
import * as start from '../.storybook/react-start';
import type { SpacePageData } from '../src/community/space';
import { searchLoaderDeps, searchParams } from '../src/search/search-params';

const { Window } = await import(Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir))));
const window = new Window({ url: 'https://site.test/en/spaces/reading' });
const globals = {
  window, document: window.document, navigator: window.navigator, location: window.location,
  HTMLElement: window.HTMLElement, HTMLInputElement: window.HTMLInputElement, HTMLButtonElement: window.HTMLButtonElement,
  HTMLFormElement: window.HTMLFormElement, Element: window.Element, Node: window.Node,
  Document: window.Document, DocumentFragment: window.DocumentFragment, MutationObserver: window.MutationObserver,
  ResizeObserver: window.ResizeObserver, getComputedStyle: window.getComputedStyle.bind(window),
  requestAnimationFrame: window.requestAnimationFrame.bind(window), cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
  matchMedia: window.matchMedia.bind(window), IS_REACT_ACT_ENVIRONMENT: true,
};
const descriptors = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);
mock.module('cloudflare:workers', () => ({ env: {} }));
// These independent controls are outside the handoff. Keep the actual page/header/shelves/lifetime and Search parser.
mock.module('../src/accounts/resource-access/link', () => ({ ResourceAccessLink: () => null }));
mock.module('../src/library/follow-target-control', () => ({ FollowTargetControl: () => null }));
mock.module('../src/community/realm-membership', () => ({ RealmMembership: () => null }));
mock.module('../src/community/realm-bans-panel', () => ({ RealmBansPanel: () => null }));
mock.module('../src/community/realm-presentation-panel', () => ({ RealmAppearancePanel: () => null }));
mock.module('../src/community/space-setup-page', () => ({ SpaceSetupEntry: () => null, useSpaceSetupRead: () => null }));
let claimRead: ((read: unknown) => void) | undefined;
mock.module('../src/community/realm-claim-panel', () => ({ RealmClaimPanel: (props: { onRead: typeof claimRead }) => { claimRead = props.onRead; return null; } }));
const restrictions = new Map<string, (state: 'removed' | 'orphaned') => void>();
mock.module('../src/community/container-lifecycle-controls', () => ({
  ContainerLifecyclePanel: (props: { target: { kind: string }; onRestriction: (state: 'removed' | 'orphaned') => void }) => {
    restrictions.set(props.target.kind, props.onRestriction); return null;
  },
}));
const { createRoot } = await import('react-dom/client');
const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
const { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider } = await import('@tanstack/react-router');
const { sessionQuery } = await import('../src/session/query');
const { SpacePage } = await import('../src/community/space-page');
const { SpacePageLifetimeHost, captureSpacePageAdmission, bindSpacePageResult } = await import('../src/community/space-page-lifetime');
const { m } = await import('../src/paraglide/messages.js');
const { setLocale } = await import('../src/paraglide/runtime.js');

const id = (n: number) => `0192f3a0-6c1e-7b2a-9d4e-${String(n).padStart(12, '0')}`;
const actor = { state: 'signed-in' as const, subject: id(8), csrfToken: 'credential-one' };
function page(size = 1, realmId = id(2)): SpacePageData {
  return {
    space: { id: id(1), title: 'A stable Space', summary: 'An independent address' },
    realm: { id: realmId, title: 'Reading community', summary: 'Read together', visibility: 'public', credentialMode: 'anonymous',
      viewer: { state: 'member', idempotencyKey: 'membership-is-not-authority' }, boards: [],
      published: Array.from({ length: size }, (_, index) => ({ id: id(index + 20), label: `Selected ${index}`, labels: { en: `Selected ${index}` }, types: ['schema:Book'], cover: null })),
      publicationNext: 'native-continuation',
    },
  };
}
let client: InstanceType<typeof QueryClient>;
let root: Root | undefined;
let host: HTMLElement;
let current: { page: SpacePageData; locale: 'en' | 'de'; epoch: number };
const Context = createContext<typeof current | null>(null);
function Community() {
  const value = useContext(Context)!;
  const admission = useMemo(() => {
    const captured = captureSpacePageAdmission(client, { target: { kind: 'space', address: 'reading' }, locale: value.locale, credentialMode: value.page.realm?.credentialMode ?? 'anonymous' });
    const bound = bindSpacePageResult(value.page, captured, value.page.realm?.credentialMode === 'session' ? { kind: 'signed-in', subject: actor.subject } : { kind: 'anonymous' });
    if (!bound) throw new Error('Test source was not admitted');
    return bound;
  }, [value.page, value.locale, value.epoch]);
  return <SpacePageLifetimeHost page={value.page} admission={admission} target={{ kind: 'space', address: 'reading' }} locale={value.locale} credentialMode={value.page.realm?.credentialMode ?? 'anonymous'}><SpacePage page={value.page} /></SpacePageLifetimeHost>;
}
const rootRoute = createRootRoute({ component: Outlet });
const communityRoute = createRoute({ getParentRoute: () => rootRoute, path: '/en/spaces/$address', component: Community });
const searchRoute = createRoute({ getParentRoute: () => rootRoute, path: '/en/search', validateSearch: searchParams, component: () => <output data-search-admission>{JSON.stringify(searchLoaderDeps(searchRoute.useSearch()))}</output> });
const routeTree = rootRoute.addChildren([communityRoute, searchRoute]);
let router: ReturnType<typeof makeRouter>;
function makeRouter() { return createRouter({ routeTree, history: createMemoryHistory({ initialEntries: ['/en/spaces/reading'] }), defaultPendingMinMs: 0 }); }
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
function render() {
  root!.render(<Context.Provider value={current}><QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider></Context.Provider>);
}
async function mount(value = page(), signedIn = false) {
  setLocale('en', { reload: false });
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(sessionQuery.queryKey, signedIn ? actor : { state: 'signed-out', subject: null, csrfToken: null });
  current = { page: value, locale: 'en', epoch: 1 };
  router = makeRouter();
  await router.load();
  host = window.document.createElement('main') as unknown as HTMLElement;
  window.document.body.append(host);
  root = createRoot(host);
  await act(async () => { render(); await tick(); });
}
async function replace(value: SpacePageData, locale: 'en' | 'de' = 'en') {
  setLocale(locale, { reload: false });
  current = { page: value, locale, epoch: current.epoch + 1 };
  await act(async () => { render(); await tick(); });
}
const region = () => host.querySelector<HTMLElement>('[data-slot="realm-catalogue-navigation"]')!;
const field = () => region().querySelector<HTMLInputElement>('input[name="q"]')!;
const form = () => region().querySelector<HTMLFormElement>('form')!;
const browse = () => region().querySelector<HTMLAnchorElement>('a')!;
async function click(element: Element) { await act(async () => { element.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }) as unknown as MouseEvent); await tick(); }); }
async function query(value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(field(), value);
    field().dispatchEvent(new window.Event('input', { bubbles: true }) as unknown as Event);
    await tick();
  });
}
async function expand() { await click(region().querySelector('button[aria-expanded]')!); }
function formHref() {
  const values = new window.FormData(form() as never);
  const params = new URLSearchParams(Array.from(values.entries(), ([key, value]) => [key, String(value)]));
  return `${form().getAttribute('action')}?${params}`;
}
function cancelled(element: Element, type = 'click') { return !element.dispatchEvent(new window.Event(type, { bubbles: true, cancelable: true }) as unknown as Event); }
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined; client?.clear(); host?.remove(); restrictions.clear(); claimRead = undefined;
  setLocale('en', { reload: false });
});
afterAll(() => {
  mock.restore(); window.happyDOM.abort();
  for (const [key, descriptor] of descriptors) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
});

test('production composition distinguishes the full population, shelf and rating meaning, and submits through actual Search admission and history', async () => {
  await mount();
  expect(host.querySelectorAll('h1')).toHaveLength(1);
  expect(host.textContent).toContain(m.realm_catalogue_publications_context());
  expect(region().textContent).toContain(m.realm_catalogue_ratings_context());
  expect(region().querySelectorAll('a')).toHaveLength(2);
  expect(region().querySelectorAll('a')[1]!.href).toBe(browse().href);
  expect(new URL(browse().href).searchParams.has('ratingPopulation')).toBe(false);
  expect(region().querySelector('[hidden]')).not.toBeNull();
  await expand();
  await query('  雪 & + ?  ');
  expect(region().textContent).toContain('  雪 & + ?  ');
  expect(form().getAttribute('method')).toBe('get');
  expect(form().querySelectorAll('input[type="hidden"]')).toHaveLength(1);
  const href = formHref();
  await act(async () => { await router.navigate({ href }); await tick(); });
  const deps = JSON.parse(host.querySelector('[data-search-admission]')!.textContent!);
  expect(deps).toMatchObject({ query: '  雪 & + ?  ', resourceScope: { kind: 'realm', id: id(2) } });
  expect(deps.ratingPopulation).toBeUndefined();
  expect(deps.cursor).toBeUndefined();
  await act(async () => { router.history.back(); await tick(); });
  expect(browse().href).toContain(encodeURIComponent(id(2)));
  expect(field().value).toBe('');
  await expand(); await query('deliberate replacement');
  await act(async () => { form().dispatchEvent(new window.Event('reset', { bubbles: true, cancelable: true }) as unknown as Event); });
  expect(field().value).toBe(''); expect(window.document.activeElement).toBe(field() as never);
});

test('bounded navigation is independent of 1/6/12 supplied publications and admits 1/128/512 query bytes without any new reads', async () => {
  const previousFetch = globalThis.fetch;
  const reads = mock(async () => { throw new Error('Catalogue navigation must not request data'); });
  globalThis.fetch = Object.assign(reads, { preconnect: previousFetch.preconnect }) as typeof fetch;
  try {
    await mount(page(1));
    const href = browse().href;
    for (const size of [1, 6, 12]) {
      await replace(page(size));
      expect(host.querySelectorAll('a[href*="/subjects/"]')).toHaveLength(size);
      expect(browse().href).toBe(href);
      expect(host.textContent).toContain(m.realm_publications_more());
      await expand();
      for (const bytes of [1, 128, 512]) {
        await query('x'.repeat(bytes));
        expect(new URL(formHref(), 'https://site.test').searchParams.get('q')).toBe('x'.repeat(bytes));
        expect(region().querySelectorAll('a')).toHaveLength(2);
      }
    }
    expect(reads).not.toHaveBeenCalled();
  } finally { globalThis.fetch = previousFetch; }
});

test('multibyte overflow refuses the whole edit and submit; clear restores an empty scoped query', async () => {
  await mount(); await expand(); await query('accepted'); await query('界'.repeat(171));
  expect(field().value).toBe('accepted');
  expect(field().getAttribute('aria-invalid')).toBe('true');
  expect(region().querySelector('[role="alert"]')!.textContent).toContain('512');
  expect(region().querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(true);
  expect(cancelled(form(), 'submit')).toBe(true);
  await act(async () => { form().dispatchEvent(new window.Event('reset', { bubbles: true, cancelable: true }) as unknown as Event); });
  expect(field().getAttribute('aria-invalid')).toBe('false'); expect(field().value).toBe('');
  expect(new URL(formHref(), 'https://site.test').searchParams.get('filter')).toContain(id(2));
  await query('界'.repeat(170) + 'ab'); expect(field().getAttribute('aria-invalid')).toBe('false');
});

test('read, Realm, route and locale replacement retire detached targets, drafts and expansion synchronously', async () => {
  await mount();
  for (const replacement of ['read', 'realm', 'route', 'locale'] as const) {
    await expand(); await query('private local draft');
    const oldLink = browse(), oldForm = form();
    if (replacement === 'route') await act(async () => { await router.navigate({ to: '/en/spaces/$address', params: { address: 'different' } }); await tick(); });
    else await replace(page(1, replacement === 'realm' ? id(3) : id(2)), replacement === 'locale' ? 'de' : 'en');
    expect(cancelled(oldLink)).toBe(true); expect(cancelled(oldLink, 'auxclick')).toBe(true);
    expect(cancelled(oldForm, 'submit')).toBe(true); expect(cancelled(oldForm, 'reset')).toBe(true);
    expect(field().value).toBe(''); expect(region().querySelector('button[aria-expanded]')!.getAttribute('aria-expanded')).toBe('false');
  }
  expect(browse().getAttribute('href')).toStartWith('/de/search?');
});

test('null or malformed Realm never uses a Space id; removed, orphaned and denied current reads expose honest absence', async () => {
  await mount();
  for (const state of ['space', 'realm', 'orphaned', 'denied', 'null', 'malformed'] as const) {
    await replace(page()); await expand(); await query('retired'); const oldLink = browse();
    await act(async () => {
      if (state === 'space' || state === 'realm') restrictions.get(state)!('removed');
      if (state === 'orphaned') restrictions.get('realm')!('orphaned');
      if (state === 'denied') claimRead!({ kind: 'denied' });
      if (state === 'null') await replace({ ...page(), realm: null });
      if (state === 'malformed') await replace(page(1, 'space-address'));
      await tick();
    });
    expect(region().querySelector('a, form, input')).toBeNull();
    expect(region().textContent).toContain(m.realm_catalogue_unavailable());
    expect(region().textContent).not.toContain('Reading community');
    expect(cancelled(oldLink)).toBe(true);
  }
});

test('observed account, same-account credential, readiness and equal session replacements cannot revive private destinations', async () => {
  const privatePage = () => { const value = page(); value.realm!.credentialMode = 'session'; value.realm!.visibility = 'protected'; return value; };
  await mount(privatePage(), true);
  for (const observation of [ { ...actor, subject: id(9) }, { ...actor, csrfToken: 'credential-two' }, { state: 'unknown', subject: null, csrfToken: null }, actor ]) {
    if (!region()) {
      await act(async () => { client.setQueryData(sessionQuery.queryKey, actor); });
      await replace(privatePage());
    }
    await expand(); await query('protected draft'); const oldLink = browse(), oldForm = form();
    await act(async () => { client.setQueryData(sessionQuery.queryKey, observation); await tick(); });
    expect(host.querySelector('[data-slot="realm-catalogue-navigation"]')).toBeNull();
    expect(cancelled(oldLink)).toBe(true); expect(cancelled(oldForm, 'submit')).toBe(true);
    await act(async () => { client.setQueryData(sessionQuery.queryKey, actor); });
    expect(host.querySelector('[data-slot="realm-catalogue-navigation"]')).toBeNull();
  }
});

test('long localized community names stay in wrapping context with labelled controls and no copied result list', async () => {
  const value = page(); value.realm!.title = 'LongUnbrokenCommunityName'.repeat(40);
  await mount(value); await replace(value, 'de'); await expand();
  expect(region().textContent).toContain(value.realm!.title);
  expect(region().className).toContain('[overflow-wrap:anywhere]');
  expect(region().querySelector('label')!.htmlFor).toBe(field().id);
  expect(region().querySelector('ul, [role="list"], [role="listbox"]')).toBeNull();
  for (const element of region().querySelectorAll('a, button, input[type="search"]')) expect(element.className).toContain('min-h-11');
  expect(region().querySelector('button[aria-expanded]')!.getAttribute('aria-controls')).toBe(region().querySelector('[inert]')?.id ?? region().querySelector('form')!.parentElement!.id);
});
