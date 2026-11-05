import { expect, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, createElement as h } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
  useRouterState,
} from '@tanstack/react-router';
import { WorkNamesEntry } from '../src/features/catalogue/work-names/entry';
import { namesReturn } from '../src/features/catalogue/work-names/navigation';
import { contextHref } from '../src/features/pages/context-navigation';
import { subjectVisitReturn } from '../src/features/pages/subject-visit-navigation';
import definitions from '../src/kernel/recorded/definitions-release.json';
import { work } from './work-title-variants.test';

const realm = '00000000-0000-4000-8000-000000000777';
const admitted = (revision = 1, variants = true) => {
  const value = { ...work(), type: 'schema:Book', context: 'global', revision, release: definitions.digest };
  value.aliases = { ...value.aliases, en: variants ? Array.from({ length: 40 }, (_, i) => `Variant ${i}`) : ['Current name'] };
  return value;
};

async function mounted(run: (host: HTMLDivElement, draw: (node: React.ReactNode) => Promise<void>) => Promise<void>) {
  const { Window } = await import(Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir))));
  const window = new Window({ url: 'https://rezics.invalid/' });
  const globals = { window, document: window.document, navigator: window.navigator, HTMLElement: window.HTMLElement,
    HTMLAnchorElement: window.HTMLAnchorElement, Element: window.Element, Node: window.Node, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value });
  const { createRoot } = await import('react-dom/client');
  const host = document.createElement('div'), root = createRoot(host);
  document.body.append(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(['session'], { state: 'signed-in', subject: 'reader', csrfToken: 'original' });
  try { await run(host, (node) => act(async () => root.render(h(QueryClientProvider, { client }, node)))); }
  finally {
    await act(async () => root.unmount());
    client.clear();
    for (const [key, descriptor] of previous) descriptor
      ? Object.defineProperty(globalThis, key, descriptor)
      : Reflect.deleteProperty(globalThis, key);
    await window.happyDOM.close();
  }
}

test('Sources returns to a fresh names reading and rejects stale or missing local history', async () => {
  await mounted(async (host, draw) => {
    let current = admitted();
    const href = `/en/subjects/${current.id}/title?realm=${realm}`;
    const history = createMemoryHistory({ initialEntries: [href] });
    const root = createRootRoute({ component: Outlet });
    const route = createRoute({ getParentRoute: () => root, path: '/$', component: Visit });
    const router = createRouter({ routeTree: root.addChildren([route]), history });
    function Visit() {
      const location = useRouterState({ select: (state) => state.location });
      if (location.pathname.endsWith('/sources')) return h('p', {}, 'Sources unavailable');
      const Link = ({ href: target, children, ...props }: { href: string; children: React.ReactNode }) =>
        h('a', { ...props, href: contextHref(target, realm) }, children);
      return h(WorkNamesEntry, { subject: current as never, source: current, locale: 'en', context: 'global',
        release: definitions.release as never, releaseDigest: definitions.digest,
        sourcesHref: `${href.split('?')[0]}/sources?realm=${realm}`,
        termsAuthority: { viewer: 'signed-in', actions: { state: 'ready', actions: [] } }, link: Link });
    }
    await act(async () => router.load());
    await draw(h(RouterProvider, { router }));
    host.querySelector('details')!.open = true;
    const filter = host.querySelector<HTMLInputElement>('input[type="search"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(Object.getPrototypeOf(filter), 'value')!.set!.call(filter, 'Variant');
      filter.dispatchEvent(new window.Event('input', { bubbles: true }));
    });
    const group = host.querySelector<HTMLDetailsElement>('[data-name-language="en"]')!;
    group.open = true;
    await act(async () => [...group.querySelectorAll('button')].find((button) => button.textContent === 'More names')!.click());
    const sources = host.querySelector<HTMLAnchorElement>('[data-names-sources] a')!;
    const newTab = new window.MouseEvent('click', { bubbles: true, cancelable: true, button: 0, metaKey: true });
    await act(async () => sources.dispatchEvent(newTab));
    expect(newTab.defaultPrevented).toBe(false);
    expect(sources.href).toContain(`/sources?realm=${realm}&via=`);
    await act(async () => sources.click());
    await act(async () => router.load());
    expect(history.location.pathname).toEndWith('/sources');
    expect(host.textContent).toContain('Sources unavailable');
    const via = new URLSearchParams(history.location.search).get('via')!;
    expect(subjectVisitReturn(via, 'en')).toBe(via);
    expect(new URL(via, 'https://rezics.invalid').searchParams.get('realm')).toBe(realm);
    expect(history.location.search).not.toContain('Variant');
    let saved = namesReturn(Reflect.get(history.location.state, 'namesReturn'), 'en')!;
    expect(saved.focus).toBe('sources');
    expect(saved.window.query).toBe('Variant');
    expect(saved.window.groups.some((item) => item.page === 1 && item.open)).toBe(true);
    current = admitted();
    await act(async () => { history.back(); await router.load(); });
    await draw(h(RouterProvider, { router }));
    expect(host.querySelector<HTMLInputElement>('input[type="search"]')?.value).toBe('Variant');
    expect(host.textContent).toContain('Variant 39');
    expect(document.activeElement).toBe(host.querySelector('[data-names-sources] a'));

    await act(async () => host.querySelector<HTMLAnchorElement>('[data-names-sources] a')!.click());
    await act(async () => router.load());
    const changedVia = new URLSearchParams(history.location.search).get('via')!;
    saved = namesReturn(Reflect.get(history.location.state, 'namesReturn'), 'en')!;
    current = admitted(2, false);
    history.push(changedVia, { namesReturn: saved });
    await act(async () => router.load());
    await draw(h(RouterProvider, { router }));
    expect(host.textContent).toContain('The names reading changed');
    expect(host.textContent).not.toContain('Variant 39');
    expect(host.querySelector<HTMLInputElement>('input[type="search"]')?.value).toBe('');
    expect(document.activeElement?.tagName).toBe('SUMMARY');

    await act(async () => host.querySelector<HTMLAnchorElement>('[data-names-sources] a')!.click());
    await act(async () => router.load());
    history.push(new URLSearchParams(history.location.search).get('via')!, {});
    await act(async () => router.load());
    await draw(h(RouterProvider, { router }));
    expect(host.textContent).toContain('The saved names view is unavailable');
    expect(host.querySelector<HTMLInputElement>('input[type="search"]')?.value).toBe('');
    expect(host.textContent).toContain('Current name');
    history.destroy();
  });
});
