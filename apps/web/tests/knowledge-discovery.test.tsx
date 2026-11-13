import { afterAll, expect, mock, test } from 'bun:test';
import { act, type ReactElement } from 'react';
import * as start from '../.storybook/react-start';
import { installPostReadingDom } from './post-reading-dom';
import type { KnowledgeDiscoveryRead, KnowledgeDiscoveryRequest } from '../src/knowledge/discovery';
import type { KnowledgeDiscoveryBinding } from '../src/knowledge/discovery-visit';
import {
  knowledgeDocumentId,
  knowledgeLicence,
  knowledgePublicationId,
  knowledgeRevisionId,
  knowledgeSubjectId,
  knowledgeTitle,
} from '../src/stories/knowledge-document-fixtures';

mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);
mock.module('cloudflare:workers', () => ({ env: {} }));

const dom = installPostReadingDom();
const { QueryClient, QueryClientProvider, notifyManager } = await import('@tanstack/react-query');
const { createRoot } = await import('react-dom/client');
const { KnowledgeDiscoveryCaller } = await import('../src/knowledge/discovery-panel');
const { KnowledgeDiscoveryReading } = await import('../src/knowledge/discovery-visit');
const { knowledgeDiscoveryExactHref } = await import('../src/knowledge/discovery');
const { m } = await import('../src/paraglide/messages.js');
const { setLocale } = await import('../src/paraglide/runtime.js');

afterAll(async () => {
  notifyManager.setScheduler((callback) => setTimeout(callback, 0));
  await dom.restore();
  mock.restore();
});

const visitHref = `/en/subjects/${knowledgeSubjectId}/selected-public-knowledge`;
const binding: KnowledgeDiscoveryBinding = {
  subjectId: knowledgeSubjectId,
  locale: 'en',
  visitHref,
  sessionRevision: 0,
};
const row = {
  subjectId: knowledgeSubjectId,
  documentId: knowledgeDocumentId,
  publicationId: knowledgePublicationId,
  revisionId: knowledgeRevisionId,
  publishedAt: '2026-10-30T12:00:00.000Z',
  title: knowledgeTitle,
  language: 'en' as const,
  licence: knowledgeLicence,
  sha256: 'a'.repeat(64),
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

async function mount(
  read: (request: KnowledgeDiscoveryRequest) => Promise<KnowledgeDiscoveryRead>,
  current = () => true,
) {
  setLocale('en', { reload: false });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(['session'], { state: 'signed-out', subject: null, csrfToken: null });
  notifyManager.setScheduler((callback) => callback());
  const host = dom.window.document.createElement('main') as unknown as HTMLElement;
  dom.window.document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      (
        <QueryClientProvider client={client}>
          <KnowledgeDiscoveryCaller binding={binding} returnTo={visitHref} read={read} current={current} />
        </QueryClientProvider>
      ) as ReactElement,
    );
  });
  return {
    host,
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

test('default mount issues one first page, keeps native order and exact return links, and continues sparse/preparing pages', async () => {
  const requests: Array<string | null> = [];
  const pages: KnowledgeDiscoveryRead[] = [
    {
      state: 'ready',
      page: { documents: [row, { ...row, documentId: knowledgeRevisionId, title: 'Second' }], next: 'more-1' },
    },
    { state: 'ready', page: { documents: [], next: 'prep-1' } },
    { state: 'preparing', next: 'prep-2' },
    { state: 'ready', page: { documents: [{ ...row, title: 'After preparation' }], next: null } },
  ];
  const mounted = await mount(async (request) => {
    requests.push(request.cursor);
    return pages[requests.length - 1]!;
  });
  try {
    expect(requests).toEqual([null]);
    expect(mounted.host.textContent).toContain(knowledgeTitle);
    expect(mounted.host.textContent).toContain('Second');
    const href = knowledgeDiscoveryExactHref('en', row, visitHref);
    expect([...mounted.host.querySelectorAll('a')].some((node) => node.getAttribute('href') === href)).toBe(true);
    await mounted.click(m.knowledge_discovery_more());
    expect(requests).toEqual([null, 'more-1']);
    expect(mounted.host.textContent).toContain(m.knowledge_discovery_sparse());
    await mounted.click(m.knowledge_discovery_more());
    expect(requests).toEqual([null, 'more-1', 'prep-1']);
    expect(mounted.host.textContent).toContain(m.knowledge_discovery_preparing());
    await mounted.click(m.knowledge_discovery_continue());
    expect(requests).toEqual([null, 'more-1', 'prep-1', 'prep-2']);
    expect(mounted.host.textContent).toContain('After preparation');
    expect(mounted.host.textContent).toContain(m.knowledge_discovery_end());
  } finally {
    await mounted.dispose();
  }
});

test('retry repeats the failed cursor and restart omits it', async () => {
  const requests: Array<string | null> = [];
  const reading = new KnowledgeDiscoveryReading(async (request) => {
    requests.push(request.cursor);
    if (requests.length === 1) return { state: 'unavailable', status: 503 };
    if (request.cursor === 'failed-cursor') return { state: 'restart', status: 409 };
    return { state: 'ready', page: { documents: [row], next: null } };
  }, binding);
  await reading.open('failed-cursor');
  expect(requests).toEqual(['failed-cursor']);
  expect(reading.getSnapshot().state).toBe('unavailable');
  reading.actions(reading.getSnapshot()).retry();
  await act(async () => Promise.resolve());
  expect(requests).toEqual(['failed-cursor', 'failed-cursor']);
  expect(reading.getSnapshot().state).toBe('restart');
  reading.actions(reading.getSnapshot()).restart();
  await act(async () => Promise.resolve());
  expect(requests).toEqual(['failed-cursor', 'failed-cursor', null]);
  expect(reading.getSnapshot()).toMatchObject({ state: 'ready', page: { documents: [row], next: null } });
});

test('a late former page cannot restore rows after retirement or a replaced current visit', async () => {
  const late = deferred<KnowledgeDiscoveryRead>();
  const reading = new KnowledgeDiscoveryReading(async () => late.promise, binding);
  void reading.open(null);
  reading.retire();
  late.resolve({ state: 'ready', page: { documents: [{ ...row, title: 'Late former title' }], next: null } });
  await act(async () => Promise.resolve());
  expect(reading.getSnapshot().state).toBe('retired');
  expect(JSON.stringify(reading.getSnapshot())).not.toContain('Late former title');

  let current = true;
  const second = deferred<KnowledgeDiscoveryRead>();
  const mounted = await mount(
    async () => second.promise,
    () => current,
  );
  try {
    expect(mounted.host.textContent).toContain(m.knowledge_discovery_preparing());
    current = false;
    await act(async () => {
      second.resolve({ state: 'ready', page: { documents: [{ ...row, title: 'Retired late title' }], next: null } });
      await Promise.resolve();
    });
    expect(mounted.host.textContent).not.toContain('Retired late title');
    expect(mounted.host.textContent).not.toContain(knowledgeTitle);
  } finally {
    await mounted.dispose();
  }
});
