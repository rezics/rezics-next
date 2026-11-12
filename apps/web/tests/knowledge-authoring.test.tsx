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
import type { KnowledgeOutlinePage, KnowledgeOwnedNotebook } from '../src/knowledge/navigation.ts';

mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);
mock.module('cloudflare:workers', () => ({ env: {} }));

const notebookId = '0192f3a0-6c1e-7b2a-9d4e-000000000010';
const notebookSubjectId = '0192f3a0-6c1e-7b2a-9d4e-000000000044';
const parentPlacementId = '0192f3a0-6c1e-7b2a-9d4e-000000000015';
const placementId = '0192f3a0-6c1e-7b2a-9d4e-000000000014';
const structureRevisionId = '0192f3a0-6c1e-7b2a-9d4e-000000000012';
const nextStructureRevisionId = '0192f3a0-6c1e-7b2a-9d4e-000000000016';
const savedRevisionId = '0192f3a0-6c1e-7b2a-9d4e-000000000011';
const viewer = '0192f3a0-6c1e-7b2a-9d4e-000000000099';
const csrfToken = 'private-authoring-session';
const credential = 'private-authoring-credential';
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

const ownedNotebook: KnowledgeOwnedNotebook = {
  notebookId,
  subjectId: notebookSubjectId,
  title: 'Owned field notebook',
  structureRevisionId,
  createdAt: '2026-11-13T12:00:00.000Z',
};

function rootOutline(structure = structureRevisionId): KnowledgeOutlinePage {
  return {
    notebookId,
    structureRevisionId: structure,
    parentPlacementId: null,
    placements: [
      {
        placementId: parentPlacementId,
        documentId: '0192f3a0-6c1e-7b2a-9d4e-000000000021',
        parentPlacementId: null,
        position: '0',
        title: 'Character arc',
      },
    ],
    next: null,
  };
}

function nestedOutline(structure = structureRevisionId): KnowledgeOutlinePage {
  return {
    notebookId,
    structureRevisionId: structure,
    parentPlacementId,
    placements: [],
    next: null,
  };
}

function savedHead(title = 'Saved inspiration'): KnowledgePrivateHead {
  return {
    accountId: viewer,
    notebookId,
    documentId: knowledgeDocumentId,
    revisionId: knowledgeRevisionId,
    publicationId: null,
    title,
    language: 'en',
    licence: 'LicenseRef-rezics-terms',
    subjectIds: [notebookSubjectId],
    body: knowledgeBody(title),
  };
}

function acknowledgedReceipt(structure = nextStructureRevisionId) {
  return {
    state: 'acknowledged' as const,
    receipt: {
      notebookId,
      documentId: knowledgeDocumentId,
      placementId,
      revisionId: savedRevisionId,
      structureRevisionId: structure,
    },
  };
}

test('existing notebook root creation uses the inventory row subject and observed outline', async () => {
  const page = await harness();
  const outlines: Array<{ notebookId: string; parentPlacementId: string | null; cursor: string | null }> = [];
  const documents: Array<Parameters<KnowledgePrivateOperations['createDocument']>[0]> = [];
  const operations = baseOperations({
    listNotebooks: async (cursor) => {
      expect(cursor).toBeNull();
      return { state: 'ready', page: { notebooks: [ownedNotebook], next: 'later' } };
    },
    readOutline: async (input) => {
      outlines.push(structuredClone(input));
      return { state: 'ready', page: rootOutline() };
    },
    createDocument: async (intent) => {
      documents.push(structuredClone(intent));
      return acknowledgedReceipt();
    },
    read: async () => ({ state: 'ready', viewer, csrfToken, credential, head: savedHead() }),
  });
  try {
    const view = await page.mount({ kind: 'create', subjectId: knowledgeSubjectId }, operations);
    await view.click(view.button('Existing notebook'));
    await view.click(view.button('Open your notebooks'));
    await view.findText('Owned field notebook');
    await view.click(view.button('Use this notebook'));
    await view.click(view.button('Open this outline'));
    await view.findText('Character arc');
    await view.click(view.button('Place the new document here'));
    await view.findText('Notebook root');
    await view.click(view.button('Inspiration'));
    await view.click(view.button('Create document'));
    await view.findText('Saved inspiration');
    view.expectText('Current private head');
    expect(outlines).toEqual([{ notebookId, parentPlacementId: null, cursor: null }]);
    expect(documents).toHaveLength(1);
    expect(documents[0]).toMatchObject({
      notebookId,
      structureRevisionId,
      parentPlacementId: null,
      subjectId: notebookSubjectId,
      title: 'Inspiration',
    });
    expect(documents[0]!.subjectId).not.toBe(knowledgeSubjectId);
  } finally {
    await page.close();
  }
});

test('nested parent creation sends the chosen placement and the row subject', async () => {
  const page = await harness();
  const outlines: Array<{ parentPlacementId: string | null }> = [];
  const documents: Array<Parameters<KnowledgePrivateOperations['createDocument']>[0]> = [];
  const operations = baseOperations({
    listNotebooks: async () => ({ state: 'ready', page: { notebooks: [ownedNotebook], next: null } }),
    readOutline: async (input) => {
      outlines.push({ parentPlacementId: input.parentPlacementId });
      return {
        state: 'ready',
        page: input.parentPlacementId === null ? rootOutline() : nestedOutline(),
      };
    },
    createDocument: async (intent) => {
      documents.push(structuredClone(intent));
      return acknowledgedReceipt();
    },
    read: async () => ({ state: 'ready', viewer, csrfToken, credential, head: savedHead('Saved scene') }),
  });
  try {
    const view = await page.mount({ kind: 'create', subjectId: knowledgeSubjectId }, operations);
    await openExistingRoot(view);
    await view.click(view.button('Open this parent'));
    await view.findText('Return to previous destination');
    await view.click(view.button('Place the new document here'));
    await view.findText('Character arc');
    await view.click(view.button('Scene'));
    await view.click(view.button('Create document'));
    await view.findText('Saved scene');
    expect(outlines).toEqual([{ parentPlacementId: null }, { parentPlacementId }]);
    expect(documents[0]).toMatchObject({
      notebookId,
      parentPlacementId,
      subjectId: notebookSubjectId,
      title: 'Scene',
    });
  } finally {
    await page.close();
  }
});

test('structure conflict keeps the draft, rereads the destination and requires Place here again', async () => {
  const page = await harness();
  const documents: Array<Parameters<KnowledgePrivateOperations['createDocument']>[0]> = [];
  let outlineReads = 0;
  const operations = baseOperations({
    listNotebooks: async () => ({ state: 'ready', page: { notebooks: [ownedNotebook], next: null } }),
    readOutline: async () => {
      outlineReads += 1;
      return { state: 'ready', page: rootOutline(outlineReads === 1 ? structureRevisionId : nextStructureRevisionId) };
    },
    createDocument: async (intent) => {
      documents.push(structuredClone(intent));
      if (documents.length === 1) return { state: 'conflict', status: 412 };
      return acknowledgedReceipt();
    },
    read: async () => ({ state: 'ready', viewer, csrfToken, credential, head: savedHead('Retained after conflict') }),
  });
  try {
    const view = await page.mount({ kind: 'create', subjectId: knowledgeSubjectId }, operations);
    await openExistingRoot(view);
    await view.click(view.button('Place the new document here'));
    const title = await view.findInput('Document title');
    await view.setInput(title, 'Retained after conflict');
    await view.click(view.button('Create document'));
    await view.findText(
      'The notebook structure changed. Your draft is retained. Review this destination again before creating.',
    );
    expect(title.value).toBe('Retained after conflict');
    expect(view.button('Create document').disabled).toBe(true);
    await view.findText('Place the new document here');
    await view.click(view.button('Place the new document here'));
    await view.findText(nextStructureRevisionId);
    await view.click(view.button('Create document'));
    await view.findText('Retained after conflict');
    expect(documents).toHaveLength(2);
    expect(documents[0]!.structureRevisionId).toBe(structureRevisionId);
    expect(documents[1]!.structureRevisionId).toBe(nextStructureRevisionId);
    expect(documents[0]!.title).toBe('Retained after conflict');
    expect(documents[1]!.title).toBe('Retained after conflict');
    expect(documents[0]!.idempotencyKey).not.toBe(documents[1]!.idempotencyKey);
  } finally {
    await page.close();
  }
});

test('uncertain existing-notebook creation retries the original key, credential and operands', async () => {
  const page = await harness();
  const documents: Array<Parameters<KnowledgePrivateOperations['createDocument']>[0]> = [];
  const operations = baseOperations({
    listNotebooks: async () => ({ state: 'ready', page: { notebooks: [ownedNotebook], next: null } }),
    readOutline: async () => ({ state: 'ready', page: rootOutline() }),
    createDocument: async (intent) => {
      documents.push(structuredClone(intent));
      if (documents.length === 1) return { state: 'uncertain' };
      return acknowledgedReceipt();
    },
    read: async () => ({ state: 'ready', viewer, csrfToken, credential, head: savedHead() }),
  });
  try {
    const view = await page.mount({ kind: 'create', subjectId: knowledgeSubjectId }, operations);
    await openExistingRoot(view);
    await view.click(view.button('Place the new document here'));
    await view.click(view.button('Create document'));
    await view.findText('The command outcome is unknown. Retry this exact command to obtain its native receipt.');
    await view.click(view.button('Retry exact command'));
    await view.findText('Saved inspiration');
    expect(documents).toHaveLength(2);
    expect(documents[0]).toEqual(documents[1]);
    expect(documents[0]!.binding.credential).toBe(credential);
    expect(documents[0]!.parentPlacementId).toBeNull();
  } finally {
    await page.close();
  }
});

test('new-notebook creation remains the default after leaving an existing placement', async () => {
  const page = await harness();
  const operations = baseOperations({
    listNotebooks: async () => ({ state: 'ready', page: { notebooks: [ownedNotebook], next: null } }),
    createNotebook: async (intent) => {
      expect(intent.subjectId).toBe(knowledgeSubjectId);
      return { state: 'acknowledged', receipt: { notebookId, structureRevisionId } };
    },
    createDocument: async (intent) => {
      expect(intent.parentPlacementId).toBeNull();
      expect(intent.subjectId).toBe(knowledgeSubjectId);
      return acknowledgedReceipt();
    },
    read: async () => ({
      state: 'ready',
      viewer,
      csrfToken,
      credential,
      head: { ...savedHead('New notebook note'), subjectIds: [knowledgeSubjectId] },
    }),
  });
  try {
    const view = await page.mount({ kind: 'create', subjectId: knowledgeSubjectId }, operations);
    await view.click(view.button('Existing notebook'));
    await view.click(view.button('Open your notebooks'));
    await view.click(view.button('Use this notebook'));
    await view.click(view.button('New notebook'));
    view.expectMissingText('Owned field notebook');
    await view.click(view.button('Create notebook'));
    await view.findText('The native notebook command was acknowledged. Its receipt is held for document creation.');
    await view.click(view.button('Create document'));
    await view.findText('New notebook note');
  } finally {
    await page.close();
  }
});

async function openExistingRoot(view: Awaited<ReturnType<Awaited<ReturnType<typeof harness>>['mount']>>) {
  await view.click(view.button('Existing notebook'));
  await view.click(view.button('Open your notebooks'));
  await view.click(view.button('Use this notebook'));
  await view.click(view.button('Open this outline'));
}

function baseOperations(overrides: Partial<KnowledgePrivateOperations>): KnowledgePrivateOperations {
  return {
    selectPublication: async () => ({ state: 'unavailable', status: 503 }),
    prepare: async () => ({ state: 'ready', viewer, csrfToken, credential }),
    read: async () => ({ state: 'unavailable', status: 503 }),
    createNotebook: async () => ({ state: 'unavailable', status: 503 }),
    listNotebooks: async () => ({ state: 'unavailable', status: 503 }),
    readOutline: async () => ({ state: 'unavailable', status: 503 }),
    createDocument: async () => ({ state: 'unavailable', status: 503 }),
    revise: async () => ({ state: 'unavailable', status: 503 }),
    ...overrides,
  };
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
    scrollTo: () => undefined,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  window.scrollTo = () => undefined;
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
    operations: baseOperations({}),
    access,
    locale: 'en',
  };
  let setEntry!: (value: Entry) => void;
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
  const router = createRouter({
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
    };
  }
  return {
    mount: render,
    close: async () => {
      await act(async () => root.unmount());
      client.clear();
    },
  };
}
