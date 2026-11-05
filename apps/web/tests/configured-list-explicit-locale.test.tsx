import { expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, createContext, createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { queryOptions } from '@tanstack/react-query';
import { planReads, platformRegistry, type CompositionDocument } from '@rezics/composition';
import type { SubjectPageData } from '../src/features/pages/subject';
import { m } from '../src/paraglide/messages.js';
import { getLocale, setLocale } from '../src/paraglide/runtime.js';

const reads: Array<{ locale: string; node: string; page: string }> = [];
const sessionQuery = queryOptions({
  queryKey: ['session', 'configured-list-explicit-locale'] as const,
  queryFn: async () => ({ state: 'signed-in' as const, subject: 'reader-a', csrfToken: 'csrf' }),
  staleTime: Infinity,
  retry: false,
});

mock.module('../src/session/query', () => ({
  AnonymousSessionContext: createContext(false),
  sessionQuery,
  useSession: () => ({ state: 'unknown' as const, csrfToken: null }),
}));
mock.module('../src/features/pages/type-list-query', () => ({
  typeListQuery: (locale: string, node: string, page: string) =>
    queryOptions({
      queryKey: ['configured-list-explicit-locale', locale, node, page],
      queryFn: () => {
        reads.push({ locale, node, page });
        return Promise.reject(new Error('native list unavailable'));
      },
      retry: false,
      refetchOnMount: false,
    }),
}));

const node = 'books';
const labelled = '0192f3a0-6c1e-7b2a-9d4e-000000000101';
const blank = '0192f3a0-6c1e-7b2a-9d4e-000000000102';
const authoredTitle = '本と物語';
const authoredLabel = 'こころ';
const options = {
  en: { locale: 'en' as const },
  ja: { locale: 'ja' as const },
  'zh-Hans': { locale: 'zh-Hans' as const },
};
const realmPage = JSON.stringify({
  subject: '0192f3a0-6c1e-7b2a-9d4e-000000000201',
  realm: '0192f3a0-6c1e-7b2a-9d4e-000000000202',
});
const publicPage = JSON.stringify({ route: '/' });

function listPage(): SubjectPageData {
  const document: CompositionDocument = {
    root: { props: {} },
    content: [{ type: 'TypeList', props: { id: node, title: { ja: authoredTitle }, types: ['schema:Book'] } }],
  };
  const plan = planReads(platformRegistry, document, { subject: null });
  return {
    subject: null,
    profile: 'sha256:test',
    template: { scope: 'route', key: '/' },
    document,
    reads: {
      [plan.nodes[node]!]: {
        status: 200,
        body: {
          subjects: [
            { id: labelled, type: 'schema:Book', labels: { ja: authoredLabel }, summary: null },
            { id: blank, type: 'schema:Book', labels: {}, summary: null },
          ],
          next: null,
        },
      },
    },
  };
}

test('a configured list with an explicit non-English locale keeps recovery and composed fallbacks in that locale', async () => {
  const previous = getLocale();
  setLocale('en', { reload: false });
  try {
    const { TypeListPage } = await import('../src/features/pages/type-list-page');
    const page = listPage();
    const chinese = renderToStaticMarkup(
      createElement(TypeListPage, { page, target: { route: '/' }, node, locale: 'zh-Hans' }),
    );
    expect(chinese).toContain(authoredTitle);
    expect(chinese).toContain(authoredLabel);
    expect(chinese).toContain(m.subject_value_unlabelled({}, options['zh-Hans']));
    expect(chinese).not.toContain(m.subject_value_unlabelled({}, options.en));
    expect(getLocale()).toBe('en');

    const replaced = renderToStaticMarkup(
      createElement(TypeListPage, { page, target: { route: '/' }, node, locale: 'ja' }),
    );
    expect(replaced).toContain(authoredTitle);
    expect(replaced).toContain(authoredLabel);
    expect(replaced).toContain(m.subject_value_unlabelled({}, options.ja));
    expect(replaced).not.toContain(m.subject_value_unlabelled({}, options['zh-Hans']));
    expect(getLocale()).toBe('en');

    const { Window } = await import(
      Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
    );
    const window = new Window({ url: 'https://rezics.test/en/list' });
    const globals = {
      window,
      document: window.document,
      navigator: window.navigator,
      HTMLElement: window.HTMLElement,
      HTMLButtonElement: window.HTMLButtonElement,
      Element: window.Element,
      Node: window.Node,
      Document: window.Document,
      DocumentFragment: window.DocumentFragment,
      MutationObserver: window.MutationObserver,
      ResizeObserver: window.ResizeObserver,
      getComputedStyle: window.getComputedStyle.bind(window),
      requestAnimationFrame: window.requestAnimationFrame.bind(window),
      cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
      IS_REACT_ACT_ENVIRONMENT: true,
    };
    const previousGlobals = new Map(
      Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
    );
    for (const [key, value] of Object.entries(globals))
      Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });

    const [{ createRoot }, { QueryClient, QueryClientProvider }, sessionModule, { ConfiguredList }] = await Promise.all(
      [
        import('react-dom/client'),
        import('@tanstack/react-query'),
        import('../src/session/query'),
        import('../src/features/pages/type-list-page'),
      ],
    );
    const host = window.document.createElement('div');
    window.document.body.append(host);
    const root = createRoot(host as unknown as HTMLElement);

    async function until(predicate: () => boolean) {
      for (let turn = 0; turn < 100 && !predicate(); turn++)
        await act(async () => new Promise<void>((resolve) => setTimeout(resolve, 0)));
      expect(predicate()).toBe(true);
    }

    function render(client: InstanceType<typeof QueryClient>, children: ReturnType<typeof createElement>) {
      return act(async () => root.render(createElement(QueryClientProvider, { client }, children)));
    }

    try {
      const pendingClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      await render(
        pendingClient,
        createElement(
          'div',
          null,
          createElement(ConfiguredList, { list: node, page: realmPage, locale: 'zh-Hans' }),
          createElement(ConfiguredList, { list: node, page: realmPage, locale: 'ja' }),
        ),
      );
      expect(host.textContent).toContain(m.configured_list_recovery_pending({}, options['zh-Hans']));
      expect(host.textContent).toContain(m.configured_list_recovery_pending({}, options.ja));
      expect(host.textContent).not.toContain(m.configured_list_recovery_pending({}, options.en));
      expect(reads).toHaveLength(0);
      expect(getLocale()).toBe('en');
      pendingClient.clear();

      const unavailableClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      unavailableClient.setQueryData(sessionModule.sessionQuery.queryKey, {
        state: 'unavailable',
        csrfToken: null,
      });
      await render(
        unavailableClient,
        createElement(ConfiguredList, { list: node, page: realmPage, locale: 'zh-Hans' }),
      );
      expect(host.textContent).toContain(m.configured_list_recovery_unavailable({}, options['zh-Hans']));
      expect(host.textContent).toContain(m.configured_list_recovery_retry({}, options['zh-Hans']));
      expect(host.textContent).not.toContain(m.configured_list_recovery_unavailable({}, options.en));
      expect(host.textContent).not.toContain(m.configured_list_recovery_retry({}, options.en));
      expect(reads).toHaveLength(0);
      expect(getLocale()).toBe('en');
      unavailableClient.clear();

      const failedClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      await render(failedClient, createElement(ConfiguredList, { list: node, page: publicPage, locale: 'zh-Hans' }));
      await until(
        () =>
          !!host.textContent?.includes(m.configured_list_recovery_unavailable({}, options['zh-Hans'])) &&
          !!host.querySelector('button'),
      );
      expect(host.textContent).toContain(m.configured_list_recovery_retry({}, options['zh-Hans']));
      expect(host.textContent).not.toContain(m.configured_list_recovery_unavailable({}, options.en));
      expect(reads).toEqual([{ locale: 'zh-Hans', node, page: publicPage }]);
      expect(getLocale()).toBe('en');
      failedClient.clear();
    } finally {
      await act(async () => root.unmount());
      for (const [key, descriptor] of previousGlobals) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
      window.happyDOM.abort();
    }
  } finally {
    setLocale(previous, { reload: false });
  }
});
