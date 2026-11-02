import { expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, useCallback, useLayoutEffect } from 'react';
import * as start from '../.storybook/react-start';
import type { BrowserSession } from '../src/session/browser-state';
import type { HeaderSuggestionLoader } from '../src/search/header-search/suggestions';
import type { SearchScope } from '../src/search/header-search/types';
import type { SuggestionResult } from '../src/search/suggestions';

mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);
const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
);

const viewer = (): BrowserSession => ({ state: 'signed-in', subject: 'reader', csrfToken: 'csrf' });
const result = (label: string): SuggestionResult => ({
  as_of: '2026-11-03T00:00:00Z',
  subjects: [
    {
      id: '01a17dfd-5dbf-738a-9405-9dfa9a8ec069',
      type: 'schema:Book',
      labels: { en: label },
      summary: null,
    },
  ],
  types: {},
});

type Props = {
  locale: string;
  boundary: number;
  globalLoader: HeaderSuggestionLoader;
  scopedLoader?: HeaderSuggestionLoader;
  scope?: SearchScope;
};

async function mountSearch() {
  const window = new Window({ url: 'https://site.test/en/search', width: 1280 });
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    HTMLInputElement: window.HTMLInputElement,
    Node: window.Node,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, value });

  const { createRoot } = await import('react-dom/client');
  const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
  const { sessionQuery, useSession } = await import('../src/session/query');
  const { currentHeaderSearchSession, observeHeaderSearchSession } =
    await import('../src/search/header-search/session-key');
  const { HeaderSearch } = await import('../src/search/header-search/header-search');
  const client = new QueryClient();
  client.setQueryData(sessionQuery.queryKey, viewer());
  const host = window.document.createElement('div');
  window.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  const requests: {
    producer: string;
    query: string;
    locale: string;
    signal: AbortSignal;
    scope?: SearchScope;
    resolve: (value: SuggestionResult) => void;
    reject: (error: unknown) => void;
  }[] = [];
  const visits: string[] = [];
  const history = {
    entries: [],
    persistence: 'memory',
    sync: 'local-only',
    remember() {},
    remove() {},
    retry() {},
  } as const;

  function loader(producer: string): HeaderSuggestionLoader {
    return (query, locale, signal, scope) =>
      new Promise((resolve, reject) => requests.push({ producer, query, locale, signal, scope, resolve, reject }));
  }

  function Owner(props: Props) {
    const session = useSession();
    const readSession = useCallback(() => currentHeaderSearchSession(client), []);
    const observeSession = useCallback((retire: () => void) => observeHeaderSearchSession(client, retire), []);
    useLayoutEffect(() => {
      if (!props.boundary) return;
      host
        .querySelector<HTMLInputElement>('input[role="combobox"]')
        ?.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    }, [props.boundary]);
    return (
      <HeaderSearch
        locale={props.locale}
        scope={props.scope}
        session={session}
        readSession={readSession}
        observeSession={observeSession}
        history={history}
        initialQuery="Prince"
        loadSuggestions={props.globalLoader}
        loadScopedSuggestions={props.scopedLoader}
        onNavigate={(href) => visits.push(href)}
      />
    );
  }

  const input = () => host.querySelector<HTMLInputElement>('input[role="combobox"]')!;
  const options = () => [...host.querySelectorAll<HTMLElement>('[role="option"]')];
  const key = (value: string) =>
    input().dispatchEvent(new window.KeyboardEvent('keydown', { key: value, bubbles: true }));
  const render = async (props: Props) =>
    act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <Owner {...props} />
        </QueryClientProvider>,
      ),
    );
  const pause = () => act(async () => new Promise((resolve) => setTimeout(resolve, 230)));
  const editQuery = async (value: string) => {
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(input(), value);
      input().dispatchEvent(new window.Event('input', { bubbles: true }));
    });
  };
  const close = async () => {
    await act(async () => root.unmount());
    client.clear();
    await window.happyDOM.abort();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  };
  return { host, requests, visits, loader, render, pause, input, options, key, editQuery, close };
}

const selectCurrent = async (app: Awaited<ReturnType<typeof mountSearch>>) => {
  await act(async () => app.key('ArrowDown'));
  const href = app.options()[0]!.querySelector('a')!.getAttribute('href');
  await act(async () => app.key('Enter'));
  expect(app.visits).toEqual([href]);
  app.visits.length = 0;
};

test('header suggestions retire at locale, scope and loader owner transitions', async () => {
  const app = await mountSearch();
  const oldGlobal = app.loader('global-old');
  const scoped = app.loader('scoped');
  const scopeA: SearchScope = {
    kind: 'Collection',
    id: 'collection-a',
    name: 'Collection A',
    searchAction: '/en/search?collection=collection-a',
  };
  const scopeB: SearchScope = {
    kind: 'Collection',
    id: 'collection-b',
    name: 'Collection B',
    searchAction: '/en/search?collection=collection-b',
  };
  let props: Props = { locale: 'en', boundary: 0, globalLoader: oldGlobal, scopedLoader: scoped };
  let draft = 'Prince';
  const transition = async (update: Partial<Props>) => {
    props = { ...props, ...update, boundary: props.boundary + 1 };
    await app.render(props);
    expect(app.visits).toEqual([]);
    expect(app.options()).toHaveLength(0);
    expect(app.input().value).toBe(draft);
    expect(app.host.querySelector('[data-header-search]')?.getAttribute('data-expanded')).toBe('true');
    expect(app.host.ownerDocument.activeElement).toBe(app.input());
  };

  try {
    await app.render(props);
    await act(async () => app.input().focus());
    await app.pause();
    const initial = app.requests.at(-1)!;
    expect(initial.producer).toBe('global-old');
    await act(async () => initial.resolve(result('Old locale result')));
    await act(async () => app.key('ArrowDown'));

    await transition({ locale: 'zh-Hant' });
    expect(initial.signal.aborted).toBe(true);
    await app.pause();
    const localized = app.requests.at(-1)!;
    expect(localized.locale).toBe('zh-Hant');
    await act(async () => localized.resolve(result('Current locale result')));
    await selectCurrent(app);

    await transition({ scope: scopeA });
    expect(localized.signal.aborted).toBe(true);
    await app.pause();
    const pendingA = app.requests.at(-1)!;
    expect(pendingA.scope?.id).toBe(scopeA.id);

    await transition({ scope: scopeB });
    expect(pendingA.signal.aborted).toBe(true);
    await act(async () => pendingA.resolve(result('Late scope A result')));
    expect(app.options()).toHaveLength(0);
    await app.pause();
    const currentB = app.requests.at(-1)!;
    expect(currentB.scope?.id).toBe(scopeB.id);
    await act(async () => currentB.resolve(result('Current scope B result')));
    await selectCurrent(app);

    const stableRequestCount = app.requests.length;
    props = { ...props, scope: { ...scopeB } };
    await app.render(props);
    await app.pause();
    expect(app.requests).toHaveLength(stableRequestCount);
    expect(currentB.signal.aborted).toBe(false);
    expect(app.options()[0]?.textContent).toContain('Current scope B result');

    await transition({ scope: undefined });
    expect(currentB.signal.aborted).toBe(true);
    await app.pause();
    const afterSuppliedRemoval = app.requests.at(-1)!;
    expect(afterSuppliedRemoval.scope).toBeUndefined();
    await act(async () => afterSuppliedRemoval.resolve(result('Global after scope removal')));

    await transition({ scope: scopeB });
    await app.pause();
    const scopedAgain = app.requests.at(-1)!;
    await act(async () => scopedAgain.resolve(result('Scoped before local removal')));
    const removeButton = [...app.host.querySelectorAll<HTMLButtonElement>('button[aria-label]')].find((button) =>
      button.getAttribute('aria-label')?.includes(scopeB.name),
    );
    expect(removeButton).toBeTruthy();
    await act(async () => removeButton!.click());
    expect(app.host.textContent).not.toContain(scopeB.name);
    await app.pause();
    const afterLocalRemoval = app.requests.at(-1)!;
    expect(afterLocalRemoval.scope).toBeUndefined();
    await act(async () => afterLocalRemoval.resolve(result('Global after local removal')));

    await app.editQuery('Catherine');
    draft = 'Catherine';
    expect(app.input().value).toBe('Catherine');
    await app.pause();
    const pendingOldProducer = app.requests.at(-1)!;
    expect(pendingOldProducer.producer).toBe('global-old');
    expect(pendingOldProducer.query).toBe('Catherine');

    const replacement = app.loader('global-replacement');
    await transition({ globalLoader: replacement });
    expect(afterLocalRemoval.signal.aborted).toBe(true);
    expect(pendingOldProducer.signal.aborted).toBe(true);
    await act(async () => pendingOldProducer.reject(new Error('late old failure')));
    expect(app.options()).toHaveLength(0);
    await app.pause();
    const replacementRequest = app.requests.at(-1)!;
    expect(replacementRequest.producer).toBe('global-replacement');
    expect(replacementRequest.query).toBe('Catherine');
    await act(async () => replacementRequest.resolve(result('Current replacement result')));
    await selectCurrent(app);
  } finally {
    await app.close();
  }
});

test('unavailable scoped suggestions stay unavailable until the user removes scope', async () => {
  const app = await mountSearch();
  const global = app.loader('global');
  const scope: SearchScope = {
    kind: 'Library',
    id: 'library-a',
    name: 'Private library',
    searchAction: '/en/search?library=library-a',
  };
  try {
    await app.render({ locale: 'en', boundary: 0, globalLoader: global, scope });
    await act(async () => app.input().focus());
    await app.pause();
    expect(app.requests).toHaveLength(0);
    expect(app.options()).toHaveLength(0);

    const removeButton = [...app.host.querySelectorAll<HTMLButtonElement>('button[aria-label]')].find((button) =>
      button.getAttribute('aria-label')?.includes(scope.name),
    );
    expect(removeButton).toBeTruthy();
    await act(async () => removeButton!.click());
    await app.pause();
    expect(app.requests).toHaveLength(1);
    const globalRequest = app.requests[0]!;
    expect(globalRequest.producer).toBe('global');
    expect(globalRequest.scope).toBeUndefined();
    await act(async () => globalRequest.resolve(result('Global after explicit removal')));
    expect(app.options()[0]?.textContent).toContain('Global after explicit removal');
  } finally {
    await app.close();
  }
});
