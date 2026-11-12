import { expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import * as start from '../.storybook/react-start';
import type { KnowledgeTransferOperations } from '../src/knowledge/transfer-visit';
import type { KnowledgeCopyReadback } from '../src/knowledge/transfer';
import { knowledgeReadyDocument } from '../src/stories/knowledge-document-fixtures';

mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);
mock.module('cloudflare:workers', () => ({ env: {} }));
const id = (n: number) => `0192f3a0-6c1e-7b2a-9d4e-${String(n).padStart(12, '0')}`;
const source = { representation: 'public' as const, documentId: id(1), revisionId: id(2) };
const receipt = {
  notebookId: id(10),
  documentId: id(11),
  revisionId: id(12),
  placementId: id(13),
  structureRevisionId: id(14),
};
const notebook = {
  notebookId: id(10),
  subjectId: id(4),
  title: 'Private study notebook',
  structureRevisionId: id(20),
  createdAt: '2026-11-10T00:00:00Z',
};
function operations(): KnowledgeTransferOperations {
  return {
    current: () => true,
    subscribeRetirement: () => () => {},
    export: async () => ({ state: 'ready', bytes: 'native exact JSON' }),
    prepare: async () => ({ state: 'ready', viewer: id(99), csrfToken: 'csrf', credential: 'captured' }),
    navigate: async (request) => ({
      state: 'ready',
      page:
        request.kind === 'owned'
          ? { kind: 'owned', notebooks: [notebook], next: null }
          : {
              kind: 'outline',
              notebookId: id(10),
              parentPlacementId: null,
              structureRevisionId: id(20),
              placements: [],
              next: null,
            },
    }),
    copy: async () => ({ state: 'acknowledged', receipt }),
    readback: async () => ({
      state: 'ready',
      head: {
        ...knowledgeReadyDocument,
        accountId: id(99),
        notebookId: id(10),
        documentId: id(11),
        revisionId: id(12),
        subjectIds: [id(4)],
        publicationId: null,
      },
      provenance: null,
    }),
  };
}

test('mounted review shows native empty destination, confirms once and waits for exact readback before editor link', async () => {
  const h = await harness();
  const { KnowledgeTransferEntry } = await import('../src/knowledge/transfer-panel');
  let complete!: (readback: KnowledgeCopyReadback) => void;
  let copies = 0;
  const base = operations();
  const ops = {
    ...base,
    copy: async () => {
      copies++;
      return base.copy({} as never);
    },
    readback: () =>
      new Promise<KnowledgeCopyReadback>((resolve) => {
        complete = resolve;
      }),
  };
  try {
    await h.render(
      <KnowledgeTransferEntry source={source} title="Selected exact source" locale="en" operations={ops} />,
    );
    await h.click('Create a private copy');
    await h.click('Private study notebook');
    expect(h.text()).toContain('No documents are available at this level.');
    await h.click('Review this destination');
    expect(h.text()).toContain(id(20));
    await h.click('Confirm private copy');
    expect(copies).toBe(1);
    expect(document.querySelector('a[href*="/documents/"]')).toBeNull();
    await h.act(async () => complete(await base.readback(receipt)));
    expect(document.querySelector('a')?.getAttribute('href')).toBe(
      `/en/knowledge/notebooks/${id(10)}/documents/${id(11)}`,
    );
    expect(h.text()).toContain('Your independent private copy is ready.');
  } finally {
    await h.close();
  }
});

test('mounted download retry keeps bytes and replacement releases its URL; unsaved editor offers save-first guidance', async () => {
  const h = await harness();
  const { KnowledgeTransferEntry } = await import('../src/knowledge/transfer-panel');
  let exports = 0,
    disposals = 0;
  const saved: string[] = [];
  const ops = {
    ...operations(),
    export: async () => {
      exports++;
      return { state: 'ready' as const, bytes: 'native exact JSON' };
    },
  };
  const saver = (bytes: string) => ({
    save: () => {
      saved.push(bytes);
    },
    dispose: () => {
      disposals++;
    },
  });
  try {
    await h.render(
      <KnowledgeTransferEntry key="first" source={source} title="Source" locale="en" operations={ops} saver={saver} />,
    );
    await h.click('Export JSON');
    await h.click('Save this download again');
    expect(exports).toBe(1);
    expect(saved).toEqual(['native exact JSON', 'native exact JSON']);
    await h.render(
      <KnowledgeTransferEntry
        key="new-source"
        source={source}
        title="Source"
        locale="en"
        operations={ops}
        saver={saver}
        blocked
      />,
    );
    expect(disposals).toBe(1);
    expect(h.text()).toContain('Save your changes before exporting or copying this document.');
    expect(document.querySelector('button')).toBeNull();
  } finally {
    await h.close();
  }
});

test('public source withdrawal removes transfer actions and citation/subject links until a fresh admitted page', async () => {
  const h = await harness();
  const { KnowledgeDocumentPage } = await import('../src/knowledge/page');
  const { KnowledgeTransferEntry } = await import('../src/knowledge/transfer-panel');
  const page = { state: 'ready' as const, document: knowledgeReadyDocument };
  const ops = { ...operations(), export: async () => ({ state: 'not-found' as const }) };
  try {
    await h.render(
      <KnowledgeDocumentPage
        request={{ ...source, locale: 'en' }}
        page={page}
        transfer={(document, onSourceLost) => (
          <KnowledgeTransferEntry
            source={source}
            title={document.title}
            locale="en"
            operations={ops}
            onSourceLost={onSourceLost}
          />
        )}
      />,
    );
    expect(document.querySelectorAll('a').length).toBeGreaterThan(0);
    await h.click('Export JSON');
    expect(document.querySelectorAll('a')).toHaveLength(0);
    expect(document.querySelectorAll('button')).toHaveLength(0);
  } finally {
    await h.close();
  }
});

async function harness() {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://site.test/en/knowledge/documents/source', width: 390 });
  const values = {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    Element: window.Element,
    Node: window.Node,
    MutationObserver: window.MutationObserver,
    getComputedStyle: window.getComputedStyle.bind(window),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(values).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(values))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const { act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { setLocale } = await import('../src/paraglide/runtime.js');
  setLocale('en', { reload: false });
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const flush = async () => {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  };
  return {
    act,
    render: async (element: React.ReactNode) => {
      await act(async () => root.render(element));
      await flush();
    },
    click: async (label: string) => {
      const button = [...container.querySelectorAll('button')].find((item) => item.textContent === label);
      expect(button).toBeDefined();
      await act(async () => {
        button!.focus();
        button!.click();
      });
      await flush();
    },
    text: () => container.textContent ?? '',
    close: async () => {
      await act(async () => root.unmount());
      container.remove();
      await window.happyDOM.close();
      for (const [key, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    },
  };
}
