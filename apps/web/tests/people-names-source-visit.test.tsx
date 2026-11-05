import { expect, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, createElement as h, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider, useRouterState } from '@tanstack/react-router';
import { PeopleNamesEntry, type PeopleNamesReading } from '../src/features/catalogue/people-names/entry';
import { namesReturn } from '../src/features/catalogue/work-names/navigation';
import { contextHref } from '../src/features/pages/context-navigation';
import { SubjectSourcesPage } from '../src/features/catalogue/subject-sources-page';
import { personReaderExample } from '../src/features/catalogue/person-reader/examples';
import { characterRelationshipsFixture } from '../src/kernel/fake/character-relationships';

const realm = '00000000-0000-4000-8000-000000000777';
const otherContext = '00000000-0000-4000-8000-000000000778';
async function mounted(run: (host: HTMLDivElement, draw: (node: ReactNode) => Promise<void>, client: QueryClient) => Promise<void>) {
  const { Window } = await import(Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir))));
  const window = new Window({ url: 'https://rezics.invalid/' });
  const globals = { window, document: window.document, navigator: window.navigator, HTMLElement: window.HTMLElement,
    HTMLAnchorElement: window.HTMLAnchorElement, Element: window.Element, Node: window.Node, scrollTo: () => {}, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value });
  const { createRoot } = await import('react-dom/client');
  const host = document.createElement('div'), root = createRoot(host);
  document.body.append(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(['session'], { state: 'signed-in', subject: 'reader', csrfToken: 'one' });
  try {
    await run(host, (node) => act(async () => root.render(h(QueryClientProvider, { client }, node))), client);
  } finally {
    await act(async () => root.unmount());
    client.clear();
    for (const [key, descriptor] of previous) descriptor ? Object.defineProperty(globalThis, key, descriptor) : Reflect.deleteProperty(globalThis, key);
    await window.happyDOM.close();
  }
}

for (const kind of ['Person', 'Character'] as const) test(`${kind} Sources visit retains actual Context/Realm and fresh finite view; changed or missing returns recover`, async () => {
  await mounted(async (host, draw) => {
    let current = kind === 'Person' ? personReaderExample().read : characterRelationshipsFixture().character;
    current.subject.labels = { en: 'Selected', ja: '旅人' };
    current.subject.aliases = { en: Array.from({ length: 40 }, (_, i) => `Mél—旅人 ${i}`) };
    const history = createMemoryHistory({ initialEntries: [`/en/subjects/${current.subject.id}/selected?realm=${realm}`] });
    const root = createRootRoute({ component: Outlet });
    const route = createRoute({ getParentRoute: () => root, path: '/$', component: Visit });
    const router = createRouter({ routeTree: root.addChildren([route]), history });
    function Visit() {
      const location = useRouterState({ select: (state) => state.location });
      if (location.pathname.endsWith('/sources')) return h(SubjectSourcesPage, {
        result: { kind: 'unavailable' }, locale: 'en', returnTo: new URLSearchParams(location.searchStr).get('via')!,
      });
      return h(PeopleNamesEntry, { reading: { public: current, locale: 'en', link: ({ href, ...props }) => h('a', { ...props, href: contextHref(href, realm) }) },
        adviceLoader: async () => ({ viewer: 'signed-in', actions: { state: 'ready', actions: [] } }) });
    }
    await act(async () => router.load());
    await draw(h(RouterProvider, { router }));
    host.querySelector('details')!.open = true;
    const input = host.querySelector<HTMLInputElement>('input')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value')!.set!.call(input, 'Mél');
      input.dispatchEvent(new window.Event('input', { bubbles: true }));
    });
    const group = host.querySelector<HTMLDetailsElement>('[data-name-language="en"]')!;
    group.open = true;
    await act(async () => [...group.querySelectorAll('button')].find((button) => button.textContent === 'More names')!.click());
    const sources = host.querySelector<HTMLAnchorElement>('[data-names-sources] a')!;
    const address = new URL(sources.href);
    const via = new URL(address.searchParams.get('via')!, 'https://rezics.invalid');
    expect(address.searchParams.get('realm')).toBe(realm);
    expect(via.searchParams.get('realm')).toBe(realm);
    expect(via.searchParams.get('context')).toBe(current.subject.context);
    expect(via.hash).toBe('#supplied-names');
    const modified = new window.MouseEvent('click', { bubbles: true, cancelable: true, metaKey: true });
    await act(async () => sources.dispatchEvent(modified));
    expect(modified.defaultPrevented).toBe(false);
    await act(async () => sources.click());
    await act(async () => router.load());
    expect(host.textContent).toContain('unavailable');
    const saved = namesReturn(Reflect.get(history.location.state, 'namesReturn'), 'en')!;
    expect(saved.window).toMatchObject({ query: 'Mél', expanded: true, groups: [{ index: 0, page: 1, open: true }] });
    expect(saved.focus).toBe('sources');
    expect(JSON.stringify(saved)).not.toContain('Mél—旅人 39');
    expect(new TextEncoder().encode(JSON.stringify(saved)).length).toBeLessThanOrEqual(8192);
    current = structuredClone(current);
    await act(async () => { history.back(); await router.load(); });
    await draw(h(RouterProvider, { router }));
    expect(host.querySelector<HTMLInputElement>('input')?.value).toBe('Mél');
    expect(host.textContent).toContain('Mél—旅人 39');
    expect(document.activeElement).toBe(host.querySelector('[data-names-sources] a'));
    await act(async () => host.querySelector<HTMLAnchorElement>('[data-names-sources] a')!.click());
    await act(async () => router.load());
    const nextSaved = namesReturn(Reflect.get(history.location.state, 'namesReturn'), 'en')!;
    current = structuredClone(current);
    current.subject.revision++;
    current.subject.aliases = { en: ['Current spelling'] };
    await act(async () => { history.push(nextSaved.href, { namesReturn: nextSaved }); await router.load(); });
    await draw(h(RouterProvider, { router }));
    expect(host.textContent).toContain('The names reading changed');
    expect(host.textContent).toContain('Current spelling');
    expect(host.textContent).not.toContain('Mél—旅人 39');
    expect(host.querySelector<HTMLInputElement>('input')?.value).toBe('');
    expect(document.activeElement?.tagName).toBe('SUMMARY');
    await act(async () => host.querySelector<HTMLAnchorElement>('[data-names-sources] a')!.click());
    await act(async () => router.load());
    const returnTo = host.querySelector<HTMLAnchorElement>('a')!.getAttribute('href')!;
    current = structuredClone(current);
    await act(async () => { history.push(returnTo, {}); await router.load(); });
    await draw(h(RouterProvider, { router }));
    expect(host.textContent).toContain('The saved names view is unavailable');
    expect(host.textContent).toContain('Current spelling');
    current = structuredClone(current);
    current.subject.context = otherContext;
    await act(async () => { history.push(`/en/subjects/${current.subject.id}/selected?context=${otherContext}&realm=${realm}`, {}); await router.load(); });
    await draw(h(RouterProvider, { router }));
    expect(host.textContent).toContain('do not support this selected Context');
    expect(host.textContent).toContain('Current spelling');
    expect(host.querySelector('a')).toBeNull();
    history.destroy();
  });
});

test('Context and release replacement permanently retire actions and late copy/advice success', async () => {
  await mounted(async (host, draw) => {
    const A: PeopleNamesReading = { public: personReaderExample().read, locale: 'en', release: {} };
    const calls: string[] = [];
    let finishCopy!: () => void, finishAdvice!: (value: never) => void;
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: () => new Promise<void>((resolve) => { finishCopy = resolve; }) } });
    const adviceLoader = () => new Promise<never>((resolve) => { calls.push('advice'); finishAdvice = resolve; });
    const render = (reading: PeopleNamesReading) => draw(h(PeopleNamesEntry, { reading, adviceLoader }));
    await render(A);
    const oldAdvice = finishAdvice;
    const copy = host.querySelector<HTMLButtonElement>('button')!;
    await act(async () => copy.click());
    await render({ ...A, public: { ...A.public, subject: { ...A.public.subject, context: otherContext } } });
    expect(host.textContent).toContain('do not support this selected Context');
    expect(calls).toHaveLength(1);
    await render(A);
    expect(host.textContent).toContain('retired');
    await act(async () => { finishCopy(); oldAdvice({ viewer: 'signed-in', actions: { state: 'ready', actions: [] } } as never); });
    expect(host.textContent).not.toContain('Copied');
    expect(copy.isConnected).toBe(false);
    const fresh = { ...A, public: structuredClone(A.public) };
    await render(fresh);
    await render({ ...fresh, release: {} });
    await render(fresh);
    expect(host.textContent).toContain('retired');
  });
});
