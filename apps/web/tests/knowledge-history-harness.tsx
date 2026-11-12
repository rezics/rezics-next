import { expect, mock } from 'bun:test';
import { useState } from 'react';
import { dirname } from 'node:path';
import * as start from '../.storybook/react-start';
import { knowledgeSubjectId } from '../src/stories/knowledge-document-fixtures';
import type {
  KnowledgePrivateOperations,
  KnowledgePrivatePageAccess,
  KnowledgePrivatePageAddress,
} from '../src/knowledge/private-page';
mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);
mock.module('cloudflare:workers', () => ({ env: {} }));
export const viewer = '0192f3a0-6c1e-7b2a-9d4e-000000000099';
export const csrfToken = 'private-story-session';
export const credential = 'private-story-credential';
export const access: Extract<KnowledgePrivatePageAccess, { state: 'ready' }> = {
  state: 'ready',
  viewer,
  csrfToken,
  owner: 'session-1/exposure-1',
  read: 'available',
  createNotebook: 'available',
  listNotebooks: 'available',
  readOutline: 'available',
  createDocument: 'available',
  revise: 'available',
  publication: 'available',
  history: 'available',
  compare: 'available',
};
export async function harness(editors = 1) {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://site.test/knowledge/new', width: 390, height: 844 });
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    HTMLFormElement: window.HTMLFormElement,
    Element: window.Element,
    Node: window.Node,
    MutationObserver: window.MutationObserver,
    ResizeObserver: window.ResizeObserver,
    getComputedStyle: window.getComputedStyle.bind(window),
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    matchMedia: window.matchMedia.bind(window),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(
    [...Object.keys(globals)].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
  );
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });

  const { act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
  const { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider } =
    await import('@tanstack/react-router');
  const { sessionQuery } = await import('../src/session/query');
  const { KnowledgePrivateAccessEntry } = await import('../src/knowledge/private-page');
  const { default: userEvent } = await import('@testing-library/user-event');
  const user = userEvent.setup({ document: window.document });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(sessionQuery.queryKey, { state: 'signed-in', subject: viewer, csrfToken });
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  type Entry = {
    address: KnowledgePrivatePageAddress;
    operations: KnowledgePrivateOperations;
    access: Extract<KnowledgePrivatePageAccess, { state: 'ready' }>;
    locale: string;
  };
  let entry: Entry = {
    address: { kind: 'create', subjectId: knowledgeSubjectId },
    operations: {
      selectPublication: async () => ({ state: 'unavailable', status: 503 }),
      prepare: async () => ({ state: 'ready', viewer, csrfToken, credential }),
      read: async () => ({ state: 'unavailable', status: 503 }),
      createNotebook: async () => ({ state: 'unavailable', status: 503 }),
      listNotebooks: async () => ({ state: 'unavailable', status: 503 }),
      readOutline: async () => ({ state: 'unavailable', status: 503 }),
      createDocument: async () => ({ state: 'unavailable', status: 503 }),
      revise: async () => ({ state: 'unavailable', status: 503 }),
    },
    access,
    locale: 'en',
  };
  let setEntry!: (value: Entry) => void;
  let router: ReturnType<typeof createRouter>;
  function Visit() {
    const [current, update] = useState(entry);
    setEntry = update;
    return (
      <>
        {Array.from({ length: editors }, (_, index) => (
          <section data-editor={index} key={index}>
            <KnowledgePrivateAccessEntry
              address={current.address}
              access={current.access}
              locale={current.locale}
              operations={current.operations}
            />
          </section>
        ))}
      </>
    );
  }
  const rootRoute = createRootRoute({ component: Outlet });
  const visitRoute = createRoute({ getParentRoute: () => rootRoute, path: '/knowledge/new', component: Visit });
  router = createRouter({
    routeTree: rootRoute.addChildren([visitRoute]),
    history: createMemoryHistory({ initialEntries: ['/knowledge/new'] }),
  });

  const render = async (
    address: KnowledgePrivatePageAddress,
    operations: KnowledgePrivateOperations,
    nextAccess = access,
    locale = 'en',
  ) => {
    entry = { address, operations, access: nextAccess, locale };
    const { setLocale } = await import('../src/paraglide/runtime.js');
    setLocale(locale as never, { reload: false });
    if (setEntry) await act(async () => setEntry(entry));
    else
      await act(async () =>
        root.render(
          <QueryClientProvider client={client}>
            <RouterProvider router={router} />
          </QueryClientProvider>,
        ),
      );
    return api();
  };
  function api(scope: HTMLElement = document.body) {
    const findText = async (text: string) => {
      for (let attempt = 0; attempt < 120; attempt++) {
        if (scope.textContent?.includes(text)) return;
        await act(async () => new Promise((resolve) => window.setTimeout(resolve, 5)));
      }
      throw new Error(`Text not found: ${text}`);
    };
    const button = (label: string) => {
      const found = [...scope.querySelectorAll<HTMLButtonElement>('button')].find(
        (node) => node.textContent?.trim() === label,
      );
      if (!found) throw new Error(`Button not found: ${label}`);
      return found;
    };
    return {
      findText,
      radio: (side: 'left' | 'right', revisionId: string) => {
        const found = [...scope.querySelectorAll<HTMLInputElement>('input[type="radio"]')].find(
          (node) => node.name.endsWith(`-${side}`) && node.value === revisionId,
        );
        if (!found) throw new Error(`Radio not found: ${side} ${revisionId}`);
        return found;
      },
      activeElement: () => document.activeElement,
      button,
      click: (node: HTMLElement) => act(async () => user.click(node)),
      findInput: async (label: string) => {
        await findText(label);
        const found = [...scope.querySelectorAll<HTMLInputElement>('input')].find(
          (node) => node.labels?.[0]?.textContent?.trim() === label,
        );
        if (!found) throw new Error(`Input not found: ${label}`);
        return found;
      },
      setInput: (node: HTMLInputElement, value: string) =>
        act(async () => {
          await user.clear(node);
          await user.type(node, value);
        }),
      expectText: (text: string) => expect(scope.textContent).toContain(text),
      expectMissingText: (text: string) => expect(scope.textContent).not.toContain(text),
      expectLink: (href: string) =>
        expect([...scope.querySelectorAll('a')].some((node) => node.getAttribute('href') === href)).toBe(true),
    };
  }
  return {
    mount: render,
    editor: (index: number) => api(host.querySelector<HTMLElement>(`[data-editor="${index}"]`)!),
    replace: render,
    flush: () => act(async () => new Promise((resolve) => window.setTimeout(resolve, 0))),
    cachedValues: () =>
      client
        .getQueryCache()
        .getAll()
        .map((query) => query.state.data),
    close: async () => {
      await act(async () => root.unmount());
      client.clear();
      window.happyDOM.abort();
      for (const [key, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    },
  };
}
