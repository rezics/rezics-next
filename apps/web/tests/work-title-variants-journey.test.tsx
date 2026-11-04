import { expect, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, createElement as h } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createRootRoute,
  createRoute,
  createRouter,
  createMemoryHistory,
  RouterProvider,
  Outlet,
  useRouterState,
} from '@tanstack/react-router';
import { WorkNamesEntry } from '../src/features/catalogue/work-names/entry';
import { PeopleNamesEntry } from '../src/features/catalogue/people-names/entry';
import { NamesTermsReturn, namesReturn } from '../src/features/catalogue/work-names/navigation';
import { subjectVisitReturn } from '../src/features/pages/subject-visit-navigation';
import { supportsReleasedWorkNames } from '../src/features/catalogue/work-names/model';
import { contextHref } from '../src/features/pages/context-navigation';
import type { TermsPageAuthority } from '../src/features/catalogue/subject-terms';
import definitions from '../src/kernel/recorded/definitions-release.json';
import { work } from './work-title-variants.test';

const denied: TermsPageAuthority = { viewer: 'signed-in', actions: { state: 'ready', actions: [] } };
const realm = '00000000-0000-4000-8000-000000000777';
const subject = () => ({ ...work(), type: 'schema:Book', context: 'global', revision: 1, release: definitions.digest });

async function mounted(
  run: (host: HTMLDivElement, draw: (node: React.ReactNode) => Promise<void>, client: QueryClient) => Promise<void>,
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
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(['session'], { state: 'signed-in', subject: 'reader', csrfToken: 'original' });
  try {
    await run(host, (node) => act(async () => root.render(h(QueryClientProvider, { client }, node))), client);
  } finally {
    await act(async () => root.unmount());
    client.clear();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    await window.happyDOM.close();
  }
}

test('current release ancestry is required; failed advice, refusal and retired copy completions preserve their boundaries', async () => {
  expect(supportsReleasedWorkNames('schema:Book')).toBe(false);
  const release = {
    types: {
      ...definitions.release.types,
      'custom:Novel': { ...definitions.release.types['schema:Book'], bases: ['schema:Book'] },
    },
  };
  expect(supportsReleasedWorkNames('custom:Novel', release as never)).toBe(true);
  expect(supportsReleasedWorkNames('schema:Person', release as never)).toBe(false);
  await mounted(async (host, draw, client) => {
    let calls = 0;
    let fail = true;
    const loader = async () => {
      calls++;
      if (fail) throw Error('offline');
      return denied;
    };
    const A = {};
    const B = {};
    const s = subject();
    const visit = (source: object, locale = 'en') =>
      h(WorkNamesEntry, {
        subject: s as never,
        source,
        locale,
        context: 'global',
        release: definitions.release as never,
        releaseDigest: definitions.digest,
        expectedReader: 'reader',
        sourcesHref: `/en/subjects/${s.id}/title/sources`,
        adviceLoader: loader,
      });
    await draw(visit(A));
    expect(calls).toBe(1);
    expect(host.textContent).toContain('advice is unavailable');
    expect(host.textContent).toContain('海の物語');
    fail = false;
    await act(async () =>
      [...host.querySelectorAll('button')].find((n) => n.textContent === 'Retry Terms advice')!.click(),
    );
    expect(calls).toBe(2);
    expect(host.textContent).toContain('does not allow');
    expect(host.textContent).toContain('海の物語');
    let finish!: () => void;
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: () =>
          new Promise<void>((resolve) => {
            finish = resolve;
          }),
      },
    });
    const copy = [...host.querySelectorAll('button')].find((n) => n.textContent === 'Copy')!;
    copy.focus();
    await act(async () => copy.click());
    await draw(visit(B));
    await draw(visit(A));
    await act(async () => finish());
    expect(host.textContent).toContain('retired');
    expect(host.textContent).not.toContain('Copied');
    expect(document.activeElement?.tagName).toBe('SUMMARY');
    const C = {};
    await draw(visit(C));
    await draw(visit(C, 'ja'));
    await draw(visit(C));
    expect(host.textContent).toContain('retired');
    await draw(visit({}));
    await act(async () =>
      client.setQueryData(['session'], { state: 'signed-in', subject: 'reader', csrfToken: 'replacement' }),
    );
    expect(host.textContent).toContain('retired');
    await draw(visit({}));
    expect(host.textContent).toContain('海の物語');
  });
});

test('both actual consumers return through Terms to the original Realm, expanded language window, filter and focus', async () => {
  for (const people of [false, true])
    await mounted(async (host, draw) => {
      const s = subject();
      s.aliases.en = Array.from({ length: 40 }, (_, i) => `Variant ${i}`);
      const href = `/en/subjects/${s.id}/title?realm=${realm}`;
      const history = createMemoryHistory({ initialEntries: [href] });
      const rootRoute = createRootRoute({ component: Outlet });
      const route = createRoute({ getParentRoute: () => rootRoute, path: '/$', component: Visit });
      const router = createRouter({ routeTree: rootRoute.addChildren([route]), history });
      function Visit() {
        const location = useRouterState({ select: (state) => state.location });
        if (location.pathname.endsWith('/terms'))
          return h(NamesTermsReturn, {
            id: s.id,
            locale: 'en',
            via: new URLSearchParams(history.location.search).get('via') ?? undefined,
          });
        const Link = (props: { href: string; children: React.ReactNode }) =>
          h('a', { ...props, href: contextHref(props.href, realm) });
        return people
          ? h(PeopleNamesEntry, {
              reading: {
                public: { subject: s, related: {} } as never,
                locale: 'en',
                release: definitions.release,
                link: Link,
              },
              adviceLoader: async () => denied,
            })
          : h(WorkNamesEntry, {
              subject: s as never,
              source: s,
              locale: 'en',
              context: 'global',
              release: definitions.release as never,
              releaseDigest: definitions.digest,
              sourcesHref: `${href.split('?')[0]}/sources?realm=${realm}`,
              termsAuthority: denied,
              link: Link,
            });
      }
      await act(async () => router.load());
      await draw(h(RouterProvider, { router }));
      host.querySelector('details')!.open = true;
      const filter = host.querySelector('input')!;
      await act(async () => {
        Object.getOwnPropertyDescriptor(Object.getPrototypeOf(filter), 'value')!.set!.call(filter, 'Variant');
        filter.dispatchEvent(new window.Event('input', { bubbles: true }));
      });
      const group = host.querySelector<HTMLDetailsElement>('[data-name-language="en"]')!;
      group.open = true;
      await act(async () => [...group.querySelectorAll('button')].find((n) => n.textContent === 'More names')!.click());
      const terms = host.querySelector<HTMLAnchorElement>('[data-names-terms] a')!;
      terms.focus();
      await act(async () => terms.click());
      expect(history.location.pathname).toEndWith('/terms');
      const via = new URLSearchParams(history.location.search).get('via');
      expect(via).toContain(`realm=${realm}`);
      expect(via).toEndWith('#supplied-names');
      expect(history.location.search).not.toContain('Variant');
      expect(
        namesReturn(
          (history.location.state as never as { namesReturn: unknown }).namesReturn,
          'en',
        )?.window.groups.some((g) => g.page === 1 && g.open),
      ).toBe(true);
      await act(async () => host.querySelector('a')!.click());
      expect(history.location.pathname).not.toEndWith('/terms');
      expect(host.querySelector('details')?.open).toBe(true);
      expect(host.querySelector<HTMLDetailsElement>('[data-name-language="en"]')?.open).toBe(true);
      expect(host.textContent).toContain('Variant 39');
      expect(host.querySelector('input')?.value).toBe('Variant');
      expect(document.activeElement).toBe(host.querySelector('[data-names-terms] a'));
      expect(subjectVisitReturn(via, 'ja')).toBeUndefined();
      expect(
        namesReturn(
          { ...(history.location.state as never as { namesReturn: object }).namesReturn, href: '//elsewhere.invalid/' },
          'en',
        ),
      ).toBeUndefined();
      history.destroy();
    });
});
