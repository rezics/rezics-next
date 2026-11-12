import { expect, mock, test } from 'bun:test';
import { useState } from 'react';
import { dirname } from 'node:path';
import * as start from '../.storybook/react-start';
import {
  knowledgeBody,
  knowledgeDocumentId,
  knowledgeRevisionId,
  knowledgeSubjectId,
} from '../src/stories/knowledge-document-fixtures';
import type { KnowledgePrivateHead } from '../src/knowledge/private-knowledge';
import type {
  KnowledgePrivateOperations,
  KnowledgePrivatePageAccess,
  KnowledgePrivatePageAddress,
} from '../src/knowledge/private-page';
import type { KnowledgePublicationIntent, KnowledgePublicationResult } from '../src/knowledge/publication';

mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);
mock.module('cloudflare:workers', () => ({ env: {} }));
const notebookId = '0192f3a0-6c1e-7b2a-9d4e-000000000010';
const revisionB = '0192f3a0-6c1e-7b2a-9d4e-000000000011';
const publicationA = '0192f3a0-6c1e-7b2a-9d4e-000000000020';
const publicationB = '0192f3a0-6c1e-7b2a-9d4e-000000000021';
const viewer = '0192f3a0-6c1e-7b2a-9d4e-000000000099';
const csrfToken = 'publication-session';
const credential = 'original-captured-credential';
const access: Extract<KnowledgePrivatePageAccess, { state: 'ready' }> = {
  state: 'ready',
  viewer,
  csrfToken,
  owner: 'session-1/exposure-1',
  read: 'available',
  createNotebook: 'available',
  createDocument: 'available',
  revise: 'available',
  publication: 'available',
};
const address: KnowledgePrivatePageAddress = { kind: 'resume', notebookId, documentId: knowledgeDocumentId };
const exact = (revisionId: string) => `/en/knowledge/documents/${knowledgeDocumentId}?revisionId=${revisionId}`;
const initialHead = (): KnowledgePrivateHead => ({
  accountId: viewer,
  notebookId,
  documentId: knowledgeDocumentId,
  revisionId: knowledgeRevisionId,
  publicationId: null,
  title: 'Saved version A',
  language: 'en',
  licence: 'CC-BY-SA-4.0',
  subjectIds: [knowledgeSubjectId],
  body: knowledgeBody('Only saved A belongs in publication review.'),
});
function fixture(select?: KnowledgePrivateOperations['selectPublication']) {
  let head = initialHead();
  let reads = 0;
  const calls: KnowledgePublicationIntent[] = [];
  const operations: KnowledgePrivateOperations = {
    prepare: async () => ({ state: 'ready', viewer, csrfToken, credential }),
    read: async () => ({
      state: 'ready',
      viewer,
      csrfToken,
      credential: `${credential}-${++reads}`,
      head: structuredClone(head),
    }),
    createNotebook: async () => ({ state: 'unavailable', status: 503 }),
    createDocument: async () => ({ state: 'unavailable', status: 503 }),
    revise: async (intent) => {
      head = {
        ...head,
        title: intent.title,
        language: intent.language,
        body: intent.body,
        licence: intent.licence,
        revisionId: revisionB,
      };
      return { state: 'acknowledged', receipt: { documentId: head.documentId, revisionId: revisionB } };
    },
    selectPublication: async (intent) => {
      calls.push(intent);
      if (select) return select(intent);
      head = {
        ...head,
        publicationId: intent.revisionId === null ? null : head.publicationId === null ? publicationA : publicationB,
      };
      return {
        state: 'acknowledged',
        receipt: { documentId: head.documentId, publicationId: head.publicationId, revisionId: intent.revisionId },
      };
    },
  };
  return {
    operations,
    calls,
    change: (next: Partial<KnowledgePrivateHead>) => {
      head = { ...head, ...next };
    },
  };
}

test('review saved A, publish A, save B privately, explicitly update B and withdraw without changing the draft', async () => {
  const page = await harness();
  const source = fixture();
  try {
    const view = await page.mount(address, source.operations);
    const title = await view.findInput('Document title');
    await view.setInput(title, 'Unsaved B');
    await view.click(view.button('Review saved version'));
    view.expectText('This is a private review of the saved version');
    view.expectText('Saved version A');
    view.expectText('Only saved A belongs in publication review.');
    expect(source.calls).toHaveLength(0);
    await view.click(view.button('Publish this exact version'));
    await view.findText('A separate private read observed the acknowledged publication identity.');
    expect(source.calls[0]).toMatchObject({
      expectedHeadRevisionId: knowledgeRevisionId,
      expectedPublicationId: null,
      revisionId: knowledgeRevisionId,
    });
    expect(title.value).toBe('Unsaved B');
    view.expectLink(exact(knowledgeRevisionId));
    await view.setInput(title, 'Saved B');
    await view.click(view.button('Save revision'));
    await view.findText('The current private head matches the acknowledged revision.');
    view.expectText('The saved private head is newer.');
    view.expectLink(exact(knowledgeRevisionId));
    view.expectNoLink(exact(revisionB));
    expect(source.calls).toHaveLength(1);
    await view.click(view.button('Review saved version'));
    await view.click(view.button('Publish this exact version'));
    await view.findText(publicationB);
    view.expectLink(exact(revisionB));
    view.expectNoLink(exact(knowledgeRevisionId));
    expect(source.calls[1]).toMatchObject({
      expectedHeadRevisionId: revisionB,
      expectedPublicationId: publicationA,
      revisionId: revisionB,
    });
    await view.click(view.button('Review withdrawal'));
    view.expectText(publicationB);
    await view.click(view.button('Withdraw this publication'));
    await view.findText('The native withdrawal command was acknowledged.');
    expect(source.calls[2]).toMatchObject({
      expectedHeadRevisionId: revisionB,
      expectedPublicationId: publicationB,
      revisionId: null,
    });
    expect(title.value).toBe('Saved B');
    view.expectNoLink(exact(revisionB));
    expect(JSON.stringify(page.cachedValues())).not.toContain('Only saved A');
  } finally {
    await page.close();
  }
});

test('publication conflict retains draft, requires reread and fresh review with the new publication identity', async () => {
  const page = await harness();
  const source = fixture(async () => ({ state: 'conflict', status: 412 }));
  try {
    const view = await page.mount(address, source.operations);
    const title = await view.findInput('Document title');
    await view.setInput(title, 'Keep my unsaved draft');
    await view.click(view.button('Review saved version'));
    await view.click(view.button('Publish this exact version'));
    await view.findText('The saved head or publication changed. Your draft is retained.');
    expect(view.button('Review saved version').disabled).toBe(true);
    source.change({ publicationId: publicationA });
    await view.click(view.button('Reread saved head'));
    expect(title.value).toBe('Keep my unsaved draft');
    await view.click(view.button('Review saved version'));
    await view.click(view.button('Publish this exact version'));
    expect(source.calls[1]!.expectedPublicationId).toBe(publicationA);
    expect(source.calls[1]!.idempotencyKey).not.toBe(source.calls[0]!.idempotencyKey);
  } finally {
    await page.close();
  }
});

test('a matching newer private read never settles uncertainty; replay preserves operands, key and captured credential', async () => {
  const page = await harness();
  let attempt = 0;
  const source = fixture(async (intent) =>
    ++attempt === 1
      ? { state: 'uncertain' }
      : {
          state: 'acknowledged',
          receipt: { documentId: knowledgeDocumentId, publicationId: publicationA, revisionId: intent.revisionId },
        },
  );
  try {
    const view = await page.mount(address, source.operations);
    await view.findInput('Document title');
    await view.click(view.button('Review saved version'));
    await view.click(view.button('Publish this exact version'));
    await view.findText('The publication outcome is unknown.');
    source.change({ publicationId: publicationA });
    await view.click(view.button('Reread saved head'));
    view.expectNoLink(exact(knowledgeRevisionId));
    view.expectText('The publication outcome is unknown.');
    expect(view.button('Review saved version').disabled).toBe(true);
    await view.click(view.button('Replay exact publication command'));
    await view.findText('The native publication command was acknowledged');
    expect(source.calls[1]).toBe(source.calls[0]);
    expect(source.calls[1]!.binding.credential).toBe(`${credential}-1`);
    expect(Object.isFrozen(source.calls[0])).toBe(true);
    view.expectLink(exact(knowledgeRevisionId));
  } finally {
    await page.close();
  }
});

test('a changed saved observation retires confirmation without altering the editor draft', async () => {
  const page = await harness();
  const source = fixture();
  try {
    const view = await page.mount(address, source.operations);
    const title = await view.findInput('Document title');
    await view.setInput(title, 'Retain this unsaved draft');
    await view.click(view.button('Review saved version'));
    source.change({ publicationId: publicationA });
    await view.click(view.button('Reread saved head'));
    expect(document.body.textContent).not.toContain('Publish this exact version');
    expect(title.value).toBe('Retain this unsaved draft');
    expect(source.calls).toHaveLength(0);
  } finally {
    await page.close();
  }
});

test('each session, CSRF, exposure, locale, source and address replacement fences late publication acknowledgements', async () => {
  for (const replacement of ['viewer', 'csrf', 'exposure', 'locale', 'source', 'address', 'signed-out'] as const) {
    const page = await harness();
    let resolve!: (value: KnowledgePublicationResult) => void;
    const pending = new Promise<KnowledgePublicationResult>((yes) => {
      resolve = yes;
    });
    const source = fixture(() => pending);
    try {
      const view = await page.mount(address, source.operations);
      await view.findInput('Document title');
      await view.click(view.button('Review saved version'));
      await view.click(view.button('Publish this exact version'));
      const nextAccess =
        replacement === 'viewer'
          ? { ...access, viewer: publicationB }
          : replacement === 'csrf'
            ? { ...access, csrfToken: 'rotated' }
            : replacement === 'exposure'
              ? { ...access, owner: 'new-exposure', publication: 'denied' as const }
              : replacement === 'signed-out'
                ? { state: 'signed-out' as const }
                : access;
      await page.replace(
        replacement === 'address' ? { ...address, documentId: publicationB } : address,
        replacement === 'source' ? fixture().operations : source.operations,
        nextAccess,
        replacement === 'locale' ? 'fr' : 'en',
      );
      resolve({
        state: 'acknowledged',
        receipt: { documentId: knowledgeDocumentId, publicationId: publicationA, revisionId: knowledgeRevisionId },
      });
      await page.flush();
      expect(document.querySelectorAll('a[href*="revisionId="]')).toHaveLength(0);
    } finally {
      await page.close();
    }
  }
});

async function harness() {
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
    access: KnowledgePrivatePageAccess;
    locale: string;
  };
  let entry: Entry = {
    address: { kind: 'resume', notebookId, documentId: knowledgeDocumentId },
    operations: {
      selectPublication: async () => ({ state: 'unavailable', status: 503 }),
      prepare: async () => ({ state: 'ready', viewer, csrfToken, credential }),
      read: async () => ({ state: 'unavailable', status: 503 }),
      createNotebook: async () => ({ state: 'unavailable', status: 503 }),
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
      <KnowledgePrivateAccessEntry
        address={current.address}
        access={current.access}
        locale={current.locale}
        operations={current.operations}
      />
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
    nextAccess: KnowledgePrivatePageAccess = access,
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
  function api() {
    const findText = async (text: string) => {
      for (let attempt = 0; attempt < 120; attempt++) {
        if (document.body.textContent?.includes(text)) return;
        await act(async () => new Promise((resolve) => window.setTimeout(resolve, 5)));
      }
      throw new Error(`Text not found: ${text}`);
    };
    const button = (label: string) => {
      const found = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
        (node) => node.textContent?.trim() === label,
      );
      if (!found) throw new Error(`Button not found: ${label}`);
      return found;
    };
    return {
      findText,
      button,
      click: (node: HTMLElement) => act(async () => user.click(node)),
      findInput: async (label: string) => {
        await findText(label);
        const found = [...document.querySelectorAll<HTMLInputElement>('input')].find(
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
      expectText: (text: string) => expect(document.body.textContent).toContain(text),
      expectMissingText: (text: string) => expect(document.body.textContent).not.toContain(text),
      expectNoLink: (href: string) =>
        expect([...document.querySelectorAll('a')].some((node) => node.getAttribute('href') === href)).toBe(false),
      expectLink: (href: string) =>
        expect([...document.querySelectorAll('a')].some((node) => node.getAttribute('href') === href)).toBe(true),
    };
  }
  return {
    mount: render,
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
