import { expect, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, createElement as h, type ReactNode } from 'react';
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
import { PeopleNamesEntry, type PeopleNamesReading } from '../src/features/catalogue/people-names/entry';
import { namesReturn } from '../src/features/catalogue/work-names/navigation';
import { contextHref } from '../src/features/pages/context-navigation';
import { SubjectSourcesPage } from '../src/features/catalogue/subject-sources-page';
import { personReaderExample } from '../src/features/catalogue/person-reader/examples';
import { characterRelationshipsFixture } from '../src/kernel/fake/character-relationships';

const realm = '00000000-0000-4000-8000-000000000777';
const otherContext = '00000000-0000-4000-8000-000000000778';
async function mounted(
  run: (host: HTMLDivElement, draw: (node: ReactNode) => Promise<void>, client: QueryClient) => Promise<void>,
) {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://rezics.invalid/' });
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    HTMLAnchorElement: window.HTMLAnchorElement,
    Element: window.Element,
    Node: window.Node,
    scrollTo: () => {},
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, value });
  const { createRoot } = await import('react-dom/client');
  const host = document.createElement('div'),
    root = createRoot(host);
  document.body.append(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(['session'], { state: 'signed-in', subject: 'reader', csrfToken: 'one' });
  try {
    await run(host, (node) => act(async () => root.render(h(QueryClientProvider, { client }, node))), client);
  } finally {
    await act(async () => root.unmount());
    client.clear();
    for (const [key, descriptor] of previous)
      descriptor ? Object.defineProperty(globalThis, key, descriptor) : Reflect.deleteProperty(globalThis, key);
    await window.happyDOM.close();
  }
}

for (const kind of ['Person', 'Character'] as const)
  test(`${kind} Sources visit retains actual Context/Realm and fresh finite view; changed or missing returns recover`, async () => {
    await mounted(async (host, draw) => {
      let current = kind === 'Person' ? personReaderExample().read : characterRelationshipsFixture().character;
      current.subject.labels = { en: 'Selected', ja: '旅人' };
      current.subject.aliases = { en: Array.from({ length: 40 }, (_, i) => `Mél—旅人 ${i} ${'عَلِيّ/'.repeat(10)}`) };
      const history = createMemoryHistory({
        initialEntries: [`/en/subjects/${current.subject.id}/selected?realm=${realm}`],
      });
      const root = createRootRoute({ component: Outlet });
      const route = createRoute({ getParentRoute: () => root, path: '/$', component: Visit });
      const router = createRouter({ routeTree: root.addChildren([route]), history });
      function Visit() {
        const location = useRouterState({ select: (state) => state.location });
        if (location.pathname.endsWith('/sources'))
          return h(SubjectSourcesPage, {
            result: { kind: kind === 'Person' ? 'unavailable' : 'missing' },
            locale: 'en',
            returnTo: new URLSearchParams(location.searchStr).get('via')!,
          });
        return h(PeopleNamesEntry, {
          reading: {
            public: current,
            locale: 'en',
            link: ({ href, ...props }) => h('a', { ...props, href: contextHref(href, realm) }),
          },
          adviceLoader: async () => ({ viewer: 'signed-in', actions: { state: 'ready', actions: [] } }),
        });
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
      await act(async () =>
        [...group.querySelectorAll('button')].find((button) => button.textContent === 'More names')!.click(),
      );
      let copied = '',
        failCopy = false;
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: {
          writeText: async (text: string) => {
            if (failCopy) throw new Error('clipboard refused');
            copied = text;
          },
        },
      });
      const copy = group.querySelector<HTMLButtonElement>('button')!;
      await act(async () => copy.click());
      expect(copied).toBe(current.subject.aliases.en![24]!);
      failCopy = true;
      await act(async () => copy.click());
      expect(copy.parentElement?.textContent).toContain('Could not copy');
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
      if (kind === 'Person') expect(host.textContent).toContain('unavailable');
      expect(host.querySelector('input')).toBeNull();
      const saved = namesReturn(Reflect.get(history.location.state, 'namesReturn'), 'en')!;
      expect(saved.window).toMatchObject({ query: 'Mél', expanded: true, groups: [{ index: 0, page: 1, open: true }] });
      expect(saved.focus).toBe('sources');
      expect(JSON.stringify(saved)).not.toContain('Mél—旅人 39');
      expect(new TextEncoder().encode(JSON.stringify(saved)).length).toBeLessThanOrEqual(8192);
      current = structuredClone(current);
      await act(async () => {
        history.back();
        await router.load();
      });
      await draw(h(RouterProvider, { router }));
      expect(host.querySelector<HTMLInputElement>('input')?.value).toBe('Mél');
      expect(host.textContent).toContain('Mél—旅人 39');
      expect(document.activeElement === host.querySelector('[data-names-sources] a')).toBe(true);
      await act(async () => {
        history.forward();
        await router.load();
      });
      expect(host.querySelector('input')).toBeNull();
      expect(namesReturn(Reflect.get(history.location.state, 'namesReturn'), 'en')?.window.query).toBe('Mél');
      current = structuredClone(current);
      await act(async () => host.querySelector<HTMLAnchorElement>('a')!.click());
      await act(async () => router.load());
      expect(host.querySelector<HTMLInputElement>('input')?.value).toBe('Mél');
      expect(host.textContent).toContain('Mél—旅人 39');
      expect(document.activeElement?.textContent).toBe(host.querySelector('[data-names-sources] a')?.textContent);
      expect(document.activeElement === host.querySelector('[data-names-sources] a')).toBe(true);
      await act(async () => host.querySelector<HTMLAnchorElement>('[data-names-sources] a')!.click());
      await act(async () => router.load());
      const nextSaved = namesReturn(Reflect.get(history.location.state, 'namesReturn'), 'en')!;
      current = structuredClone(current);
      current.subject.revision++;
      current.subject.aliases = { en: ['Current spelling'] };
      await act(async () => {
        history.push(nextSaved.href, { namesReturn: nextSaved });
        await router.load();
      });
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
      await act(async () => {
        history.push(returnTo, {});
        await router.load();
      });
      await draw(h(RouterProvider, { router }));
      expect(host.textContent).toContain('The saved names view is unavailable');
      expect(host.textContent).toContain('Current spelling');
      current = structuredClone(current);
      current.subject.context = otherContext;
      await act(async () => {
        history.push(`/en/subjects/${current.subject.id}/selected?context=${otherContext}&realm=${realm}`, {});
        await router.load();
      });
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
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: () =>
          new Promise<void>((resolve) => {
            finishCopy = resolve;
          }),
      },
    });
    const adviceLoader = () =>
      new Promise<never>((resolve) => {
        calls.push('advice');
        finishAdvice = resolve;
      });
    const render = (reading: PeopleNamesReading) => draw(h(PeopleNamesEntry, { reading, adviceLoader }));
    await render(A);
    const oldAdvice = finishAdvice;
    const copy = host.querySelector<HTMLButtonElement>('button')!;
    await act(async () => copy.click());
    await render({ ...A, public: { ...A.public, subject: { ...A.public.subject, context: otherContext } } });
    expect(host.textContent).toContain('do not support this selected Context');
    expect(calls).toHaveLength(2);
    await render(A);
    expect(host.textContent).toContain('retired');
    await act(async () => {
      finishCopy();
      oldAdvice({ viewer: 'signed-in', actions: { state: 'ready', actions: [] } } as never);
    });
    expect(host.textContent).not.toContain('Copied');
    expect(copy.isConnected).toBe(false);
    const fresh = { ...A, public: structuredClone(A.public) };
    await render(fresh);
    await render({ ...fresh, release: {} });
    await render(fresh);
    expect(host.textContent).toContain('retired');
  });
});

for (const outcome of ['surviving', 'removed', 'language', 'role', 'window', 'connected', 'budget'] as const)
  test(`fresh exact-name Sources return: ${outcome}`, async () => {
    await mounted(async (host, draw) => {
      let current = personReaderExample().read;
      const spelling = 'Exact—Mél/旅 24';
      const language = outcome === 'budget' ? 'en-' + 'a-'.repeat(4500) + 'a' : 'en';
      current.subject.labels = { en: 'Selected', ja: '旅人' };
      current.subject.aliases = { [language]: Array.from({ length: 48 }, (_, i) => `Exact—Mél/旅 ${i}`) };
      let returning = false;
      const history = createMemoryHistory({
        initialEntries: [`/en/subjects/${current.subject.id}/selected?realm=${realm}`],
      });
      const root = createRootRoute({ component: Outlet });
      const route = createRoute({ getParentRoute: () => root, path: '/$', component: Visit });
      const router = createRouter({ routeTree: root.addChildren([route]), history });
      function Visit() {
        const location = useRouterState({ select: (state) => state.location });
        if (location.pathname.endsWith('/sources'))
          return h(SubjectSourcesPage, {
            result: { kind: 'unavailable' },
            locale: 'en',
            returnTo: new URLSearchParams(location.searchStr).get('via')!,
          });
        return h(
          'div',
          {},
          returning && outcome === 'connected' && h('button', { autoFocus: true, id: 'visitor-focus' }, 'Keep focus'),
          h(PeopleNamesEntry, {
            reading: {
              public: current,
              locale: 'en',
              link: ({ href, ...props }) => h('a', { ...props, href: contextHref(href, realm) }),
            },
            adviceLoader: async () => ({ viewer: 'signed-in', actions: { state: 'ready', actions: [] } }),
          }),
        );
      }
      await act(async () => router.load());
      await draw(h(RouterProvider, { router }));
      host.querySelector('details')!.open = true;
      const group = host.querySelector<HTMLDetailsElement>(`[data-name-language="${language}"]`)!;
      group.open = true;
      await act(async () => [...group.querySelectorAll('button')].find((b) => b.textContent === 'More names')!.click());
      const copy = [...group.querySelectorAll('li')]
        .find((row) => row.querySelector('[data-supplied-name]')?.textContent === spelling)!
        .querySelector<HTMLButtonElement>('button')!;
      expect(copy.closest('li')?.textContent).toContain(spelling);
      await act(async () => copy.focus());
      await act(async () => host.querySelector<HTMLAnchorElement>('[data-names-sources] a')!.click());
      await act(async () => router.load());
      const saved = namesReturn(Reflect.get(history.location.state, 'namesReturn'), 'en')!;
      if (outcome === 'budget') {
        expect(saved).toBeUndefined();
        current = structuredClone(current);
        await act(async () => host.querySelector<HTMLAnchorElement>('a')!.click());
        await act(async () => router.load());
        expect(host.textContent).toContain('The saved names view is unavailable');
        expect(document.activeElement?.tagName).toBe('SUMMARY');
        history.destroy();
        return;
      }
      expect(saved.focus).toMatchObject({
        kind: 'name',
        language: 'en',
        role: 'alias',
        identity: expect.stringMatching(/^[a-f0-9]{64}$/),
      });
      expect(JSON.stringify(saved)).not.toContain(spelling);
      current = structuredClone(current);
      if (outcome === 'surviving')
        current.subject.aliases.en!.splice(24, 2, ...current.subject.aliases.en!.slice(24, 26).reverse());
      if (outcome === 'removed' || outcome === 'language' || outcome === 'role')
        current.subject.aliases.en = current.subject.aliases.en!.filter((text) => text !== spelling);
      if (outcome === 'language') current.subject.aliases.ja = [spelling];
      if (outcome === 'role') current.subject.labels.en = spelling;
      if (outcome === 'window')
        current.subject.aliases.en!.unshift(...Array.from({ length: 24 }, (_, i) => `New ${i}`));
      returning = true;
      // Exercise the actual Sources return adapter, with the same history value as Back/Forward.
      await act(async () => host.querySelector<HTMLAnchorElement>('a')!.click());
      await act(async () => router.load());
      await draw(h(RouterProvider, { router }));
      if (outcome === 'connected') expect(document.activeElement?.id).toBe('visitor-focus');
      else if (outcome === 'surviving') {
        expect(document.activeElement?.closest('li')?.querySelector('[data-supplied-name]')?.textContent).toBe(
          spelling,
        );
        expect(host.textContent).not.toContain('The names reading changed');
      } else {
        expect(document.activeElement).toBe(host.querySelector('[data-name-language="en"] summary'));
        expect(host.textContent).toContain('The names reading changed');
      }
      expect(copy.isConnected).toBe(false);
      history.destroy();
    });
  });

test('history focus accepts only a bounded language, role and opaque identity', () => {
  const base = {
    binding: 'current',
    href: `/en/subjects/${personReaderExample().read.subject.id}/selected#supplied-names`,
    window: { query: '', page: 0, expanded: true, groups: [] },
  };
  const focus = { kind: 'name', language: 'ja', role: 'alias', identity: 'a'.repeat(64) };
  expect(namesReturn({ ...base, focus: { ...focus, spelling: 'not carried' } }, 'en')?.focus).toEqual(focus);
  for (const patch of [
    { language: 'bad_tag' },
    { language: 'en-' + 'a-'.repeat(4096) + 'a' },
    { role: 'legal' },
    { identity: 'copied spelling' },
    { kind: 'row' },
  ])
    expect(namesReturn({ ...base, focus: { ...focus, ...patch } }, 'en')).toBeUndefined();
});
