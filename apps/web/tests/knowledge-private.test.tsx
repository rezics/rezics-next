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

mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);
mock.module('cloudflare:workers', () => ({ env: {} }));

const notebookId = '0192f3a0-6c1e-7b2a-9d4e-000000000010';
const nextRevisionId = '0192f3a0-6c1e-7b2a-9d4e-000000000011';
const savedRevisionId = '0192f3a0-6c1e-7b2a-9d4e-000000000012';
const viewer = '0192f3a0-6c1e-7b2a-9d4e-000000000099';
const otherDocumentId = '0192f3a0-6c1e-7b2a-9d4e-000000000021';
const csrfToken = 'private-story-session';
const credential = 'private-story-credential';
const access: Extract<KnowledgePrivatePageAccess, { state: 'ready' }> = {
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
};

function head(
  documentId = knowledgeDocumentId,
  revisionId = knowledgeRevisionId,
  title = 'A private field note',
): KnowledgePrivateHead {
  return {
    accountId: viewer,
    notebookId,
    documentId,
    revisionId,
    publicationId: null,
    title,
    language: 'en',
    licence: 'LicenseRef-rezics-terms',
    subjectIds: [knowledgeSubjectId],
    body: knowledgeBody('Private body from the exact current head.'),
  };
}

test('creation retains the acknowledged notebook, then retries only the frozen root document command', async () => {
  const page = await harness();
  const calls: Array<{ kind: string; input: unknown }> = [];
  let documentAttempt = 0;
  const operations: KnowledgePrivateOperations = {
    selectPublication: async () => ({ state: 'unavailable', status: 503 }),
    prepare: async () => ({ state: 'ready', viewer, csrfToken, credential }),
    read: async () => ({ state: 'unavailable', status: 503 }),
    createNotebook: async (intent) => {
      calls.push({ kind: 'notebook', input: structuredClone(intent) });
      return { state: 'acknowledged', receipt: { notebookId, structureRevisionId: knowledgeRevisionId } };
    },
    listNotebooks: async () => ({ state: 'unavailable', status: 503 }),
    readOutline: async () => ({ state: 'unavailable', status: 503 }),
    createDocument: async (intent) => {
      calls.push({ kind: 'document', input: structuredClone(intent) });
      if (documentAttempt++ === 0) return { state: 'unavailable', status: 503 };
      return {
        state: 'acknowledged',
        receipt: {
          notebookId,
          documentId: knowledgeDocumentId,
          placementId: savedRevisionId,
          revisionId: nextRevisionId,
          structureRevisionId: savedRevisionId,
        },
      };
    },
    revise: async () => ({ state: 'unavailable', status: 503 }),
  };
  try {
    const view = await page.mount({ kind: 'create', subjectId: knowledgeSubjectId }, operations);
    await view.click(view.button('Create notebook'));
    await view.findText('The native notebook command was acknowledged. Its receipt is held for document creation.');
    await view.click(view.button('Create document'));
    await view.findText('Private Knowledge is unavailable right now. Retry this same visit.');
    view.expectText(notebookId);
    expect(calls.filter(({ kind }) => kind === 'notebook')).toHaveLength(1);
    await view.click(view.button('Retry exact command'));
    await view.findText('The native document command was acknowledged.');
    expect(calls.filter(({ kind }) => kind === 'notebook')).toHaveLength(1);
    const documentCalls = calls.filter(({ kind }) => kind === 'document');
    expect(documentCalls).toHaveLength(2);
    expect(documentCalls[0]!.input).toEqual(documentCalls[1]!.input);
    expect(documentCalls[0]!.input).toMatchObject({
      notebookId,
      structureRevisionId: knowledgeRevisionId,
      parentPlacementId: null,
      subjectId: knowledgeSubjectId,
    });
    view.expectLink('/en/knowledge/notebooks/' + notebookId + '/documents/' + knowledgeDocumentId);
  } finally {
    await page.close();
  }
});

test('conflict keeps the draft, explicit reread supplies the next CAS head, and uncertain retry is exact', async () => {
  const page = await harness();
  let readCount = 0;
  let reviseCount = 0;
  const revisions: Array<Parameters<KnowledgePrivateOperations['revise']>[0]> = [];
  const operations: KnowledgePrivateOperations = {
    selectPublication: async () => ({ state: 'unavailable', status: 503 }),
    prepare: async () => ({ state: 'ready', viewer, csrfToken, credential }),
    read: async () => {
      readCount++;
      const current =
        readCount === 1
          ? head()
          : readCount === 2
            ? head(knowledgeDocumentId, nextRevisionId, 'Current server version')
            : head(knowledgeDocumentId, savedRevisionId, 'My retained draft');
      return { state: 'ready', viewer, csrfToken, credential, head: current };
    },
    createNotebook: async () => ({ state: 'unavailable', status: 503 }),
    listNotebooks: async () => ({ state: 'unavailable', status: 503 }),
    readOutline: async () => ({ state: 'unavailable', status: 503 }),
    createDocument: async () => ({ state: 'unavailable', status: 503 }),
    revise: async (intent) => {
      revisions.push(structuredClone(intent));
      if (reviseCount++ === 0) return { state: 'conflict', status: 412 };
      if (reviseCount === 2) return { state: 'uncertain' };
      return { state: 'acknowledged', receipt: { documentId: knowledgeDocumentId, revisionId: savedRevisionId } };
    },
  };
  try {
    const view = await page.mount({ kind: 'resume', notebookId, documentId: knowledgeDocumentId }, operations);
    const title = await view.findInput('Document title');
    await view.setInput(title, 'My retained draft');
    await view.click(view.button('Save revision'));
    await view.findText('The document changed on the server. Your draft is retained for review.');
    expect(title.value).toBe('My retained draft');

    await view.click(view.button('Read current version again'));
    await view.findText('Review current server version');
    view.expectText('Current server version');
    view.expectText('My retained draft');
    await view.click(view.button('Use this reviewed version as the new base'));
    await view.click(view.button('Save revision'));
    await view.findText('The command outcome is unknown. Retry this exact command to obtain its native receipt.');
    await view.click(view.button('Retry exact command'));
    await view.findText(
      'The native revision command was acknowledged. Readback is checking the current head separately.',
    );
    await view.findText('The current private head matches the acknowledged revision.');

    expect(revisions).toHaveLength(3);
    expect(revisions[0]!.expectedHeadRevisionId).toBe(knowledgeRevisionId);
    expect(revisions[1]!.expectedHeadRevisionId).toBe(nextRevisionId);
    expect(revisions[1]).toEqual(revisions[2]);
    expect(revisions[1]!.title).toBe('My retained draft');
  } finally {
    await page.close();
  }
});

test('viewer, exposure, locale, source and exact-address replacement retire late private reads', async () => {
  const page = await harness();
  const pending = deferred<Awaited<ReturnType<KnowledgePrivateOperations['read']>>>();
  const first: KnowledgePrivateOperations = {
    selectPublication: async () => ({ state: 'unavailable', status: 503 }),
    prepare: async () => ({ state: 'ready', viewer, csrfToken, credential }),
    read: async () => pending.promise,
    createNotebook: async () => ({ state: 'unavailable', status: 503 }),
    listNotebooks: async () => ({ state: 'unavailable', status: 503 }),
    readOutline: async () => ({ state: 'unavailable', status: 503 }),
    createDocument: async () => ({ state: 'unavailable', status: 503 }),
    revise: async () => ({ state: 'unavailable', status: 503 }),
  };
  const replacement: KnowledgePrivateOperations = {
    ...first,
    read: async () => ({
      state: 'ready',
      viewer,
      csrfToken,
      credential,
      head: head(otherDocumentId, nextRevisionId, 'Replacement current head'),
    }),
  };
  try {
    const originalAddress: KnowledgePrivatePageAddress = {
      kind: 'resume',
      notebookId,
      documentId: knowledgeDocumentId,
    };
    const nextAddress: KnowledgePrivatePageAddress = { kind: 'resume', notebookId, documentId: otherDocumentId };
    const view = await page.mount(originalAddress, first);
    await page.replace(nextAddress, replacement, { ...access, owner: 'session-2/exposure-3' }, 'fr');
    await view.findText('Replacement current head');
    pending.resolve({
      state: 'ready',
      viewer,
      csrfToken,
      credential,
      head: head(knowledgeDocumentId, knowledgeRevisionId, 'Late retired private head'),
    });
    await page.flush();
    view.expectMissingText('Late retired private head');
    view.expectText('Replacement current head');
    expect(JSON.stringify(page.cachedValues())).not.toContain('Private body from the exact current head.');
  } finally {
    await page.close();
  }
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

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
