import { afterAll, expect, mock, test } from 'bun:test';
import { act, StrictMode, type ReactElement } from 'react';
import * as start from '../.storybook/react-start';
import { installPostReadingDom } from './post-reading-dom';
import {
  knowledgeExactRequest,
  knowledgeLiveRequest,
  knowledgeOtherRevisionId,
  knowledgePublicationText,
  knowledgeReady,
  knowledgeReadyDocument,
  knowledgeTitle,
} from '../src/stories/knowledge-document-fixtures';
import type { KnowledgeDocumentVisit } from '../src/knowledge/route';
import type { KnowledgeReadRequest, KnowledgeReadState } from '../src/knowledge/public-read';

mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);
mock.module('cloudflare:workers', () => ({ env: {} }));

const dom = installPostReadingDom();
const { QueryClient, QueryClientProvider, notifyManager } = await import('@tanstack/react-query');
const { createRoot } = await import('react-dom/client');
const { KnowledgeDocumentCaller, openKnowledgeDocumentVisit } = await import('../src/knowledge/route');
const { m } = await import('../src/paraglide/messages.js');
const { setLocale } = await import('../src/paraglide/runtime.js');

afterAll(async () => {
  notifyManager.setScheduler((callback) => setTimeout(callback, 0));
  await dom.restore();
  mock.restore();
});

function visitOf(request: KnowledgeReadRequest, page: KnowledgeReadState, sessionRevision = 0): KnowledgeDocumentVisit {
  return { request: { ...request }, sessionRevision, page };
}

async function mount(visit: KnowledgeDocumentVisit, request: KnowledgeReadRequest, loading = false) {
  setLocale('en', { reload: false });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(['session'], { state: 'signed-out', subject: null, csrfToken: null });
  notifyManager.setScheduler((callback) => callback());
  const retries: KnowledgeReadRequest[] = [];
  const host = dom.window.document.createElement('main') as unknown as HTMLElement;
  dom.window.document.body.append(host);
  const root = createRoot(host);
  const render = (nextVisit: KnowledgeDocumentVisit, nextRequest: KnowledgeReadRequest, nextLoading = loading) => (
    <StrictMode>
      <QueryClientProvider client={client}>
        <KnowledgeDocumentCaller
          visit={nextVisit}
          request={nextRequest}
          loading={nextLoading}
          onRetry={() => {
            retries.push({ ...nextRequest });
          }}
        />
      </QueryClientProvider>
    </StrictMode>
  );
  await act(async () => {
    root.render(render(visit, request, loading) as ReactElement);
  });
  return {
    client,
    host,
    retries,
    async show(nextVisit: KnowledgeDocumentVisit, nextRequest = request, nextLoading = false) {
      await act(async () => {
        root.render(render(nextVisit, nextRequest, nextLoading) as ReactElement);
      });
    },
    async click(name: string) {
      const button = [...host.querySelectorAll('button')].find((item) => item.textContent?.trim() === name);
      expect(button).toBeDefined();
      const propsKey = Object.getOwnPropertyNames(button!).find((key) => key.startsWith('__reactProps$'));
      const onClick = (button as unknown as Record<string, { onClick?: () => void }>)[propsKey!]?.onClick;
      expect(typeof onClick).toBe('function');
      await act(async () => {
        onClick!();
        await Promise.resolve();
      });
    },
    async dispose() {
      await act(async () => root.unmount());
      client.clear();
      host.remove();
    },
  };
}

test('replacement retires the old public body and ignores a late former result', async () => {
  const first = visitOf(knowledgeLiveRequest, knowledgeReady);
  const mounted = await mount(first, knowledgeLiveRequest);
  try {
    expect(mounted.host.textContent).toContain(knowledgePublicationText);
    const nextRequest = { ...knowledgeLiveRequest, documentId: knowledgeOtherRevisionId };
    await mounted.show(first, nextRequest);
    expect(mounted.host.textContent).toContain(m.knowledge_preparing());
    expect(mounted.host.textContent).not.toContain(knowledgePublicationText);
    expect(mounted.host.querySelector('[data-slot="document-body"]')).toBeNull();
    first.page = {
      state: 'ready',
      document: { ...knowledgeReadyDocument, title: 'Late former title', body: knowledgeReadyDocument.body },
    };
    await mounted.show(first, nextRequest);
    expect(mounted.host.textContent).not.toContain('Late former title');
    expect(mounted.host.textContent).not.toContain(knowledgePublicationText);
    expect(mounted.host.textContent).toContain(m.knowledge_preparing());
  } finally {
    await mounted.dispose();
  }
});

test('retry keeps its exact operands and a failed reading leaves no former public body', async () => {
  const opened = await openKnowledgeDocumentVisit(0, knowledgeExactRequest, async () => ({
    state: 'unavailable',
    status: 503,
  }));
  expect(opened.request).toEqual(knowledgeExactRequest);
  const unavailable = visitOf(knowledgeExactRequest, { state: 'unavailable', status: 503 });
  const mounted = await mount(unavailable, knowledgeExactRequest);
  try {
    expect(mounted.host.textContent).toContain(m.knowledge_unavailable());
    expect(mounted.host.textContent).not.toContain(knowledgePublicationText);
    await mounted.click(m.knowledge_retry());
    expect(mounted.retries).toEqual([knowledgeExactRequest]);
    await mounted.show(unavailable, knowledgeExactRequest);
    expect(mounted.host.textContent).toContain(m.knowledge_preparing());
    expect(mounted.host.textContent).not.toContain(knowledgePublicationText);
    unavailable.page = knowledgeReady;
    await mounted.show(unavailable, knowledgeExactRequest);
    expect(mounted.host.textContent).not.toContain(knowledgePublicationText);
    expect(mounted.host.textContent).not.toContain(knowledgeTitle);
  } finally {
    await mounted.dispose();
  }
});

test('credential lifetime changes fence the current public reading', async () => {
  const ready = visitOf(knowledgeLiveRequest, knowledgeReady, 0);
  const mounted = await mount(ready, knowledgeLiveRequest);
  try {
    expect(mounted.host.textContent).toContain(knowledgePublicationText);
    await act(async () => {
      mounted.client.setQueryData(['session'], {
        state: 'signed-in',
        subject: knowledgeOtherRevisionId,
        csrfToken: 'rotated',
      });
    });
    expect(mounted.host.textContent).toContain(m.knowledge_preparing());
    expect(mounted.host.textContent).not.toContain(knowledgePublicationText);
    ready.page = knowledgeReady;
    await mounted.show(ready, knowledgeLiveRequest);
    expect(mounted.host.textContent).not.toContain(knowledgePublicationText);
  } finally {
    await mounted.dispose();
  }
});

test('copy feedback stays on the current citation and a later address drops it', async () => {
  const writes: string[] = [];
  const clipboard = {
    writeText: async (value: string) => {
      writes.push(value);
    },
  };
  setLocale('en', { reload: false });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  notifyManager.setScheduler((callback) => callback());
  const host = dom.window.document.createElement('main') as unknown as HTMLElement;
  dom.window.document.body.append(host);
  const root = createRoot(host);
  const { KnowledgeDocumentPage } = await import('../src/knowledge/page');
  const { knowledgeCitationHref } = await import('../src/knowledge/public-read');
  await act(async () => {
    root.render(
      <StrictMode>
        <QueryClientProvider client={client}>
          <KnowledgeDocumentPage
            request={knowledgeLiveRequest}
            page={knowledgeReady}
            clipboard={clipboard}
            origin="https://site.test"
          />
        </QueryClientProvider>
      </StrictMode>,
    );
  });
  const button = [...host.querySelectorAll('button')].find(
    (item) => item.textContent?.trim() === m.knowledge_citation_copy(),
  );
  expect(button).toBeDefined();
  const propsKey = Object.getOwnPropertyNames(button!).find((key) => key.startsWith('__reactProps$'));
  const onClick = (button as unknown as Record<string, { onClick?: () => void }>)[propsKey!]?.onClick;
  expect(typeof onClick).toBe('function');
  await act(async () => {
    onClick!();
    await Promise.resolve();
  });
  expect(writes).toEqual([`https://site.test${knowledgeCitationHref('en', knowledgeReadyDocument)}`]);
  expect(host.textContent).toContain(m.knowledge_citation_copied());
  await act(async () => {
    root.render(
      <StrictMode>
        <QueryClientProvider client={client}>
          <KnowledgeDocumentPage
            request={knowledgeExactRequest}
            page={knowledgeReady}
            clipboard={clipboard}
            origin="https://other.test"
          />
        </QueryClientProvider>
      </StrictMode>,
    );
  });
  expect(host.textContent).not.toContain(m.knowledge_citation_copied());
  await act(async () => root.unmount());
  host.remove();
});
