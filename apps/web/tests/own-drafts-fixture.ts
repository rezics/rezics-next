import { mock } from 'bun:test';
import type { OwnDraftEntry, OwnDraftIdentity } from '../src/threads/own-drafts/model';
import { act, createElement, type ReactNode } from 'react';
import { dirname } from 'node:path';
import { fromPlainText, type DocumentSnapshot } from '@rezics/document';

export const accountId = '0192f3a0-6c1e-7b2a-9d4e-000000000001';
export const threadId = '0192f3a0-6c1e-7b2a-9d4e-000000000002';
export const postId = '0192f3a0-6c1e-7b2a-9d4e-000000000003';
export const identity: OwnDraftIdentity = {
  accountId,
  authnEpoch: 2,
  callerEpoch: 'caller-1',
  locale: 'en',
  source: 'content',
  address: '/drafts',
};
export function row(overrides: Partial<OwnDraftEntry> = {}): OwnDraftEntry {
  return {
    id: postId,
    threadId,
    firstPostId: postId,
    revisionId: '0192f3a0-6c1e-7b2a-9d4e-000000000004',
    authorId: accountId,
    kind: 'discussion',
    documentKind: 'opening',
    title: 'A bounded server draft',
    savedAt: '2026-10-28T09:42:00.000Z',
    licence: 'LicenseRef-rezics-terms',
    language: 'en',
    subjectIds: [],
    mediaIds: [],
    board: { id: 'board-1', title: 'Board', realmId: null },
    actions: {
      resume: `/v1/accounts/${accountId}/drafts/${postId}?threadId=${threadId}`,
      edit: `/v1/posts/${postId}/revisions`,
      publish: `/v1/posts/${postId}/revisions`,
      erase: `/v1/posts/${postId}`,
    },
    ...overrides,
  };
}

export function selected(entry: OwnDraftEntry = row(), text = 'Selected server body', revision = entry.revisionId) {
  return {
    revision,
    post: {
      id: entry.id,
      threadId: entry.threadId,
      parentId: null,
      body: fromPlainText(text, 'blocks') as DocumentSnapshot,
      mediaIds: entry.mediaIds,
    },
  };
}

// The mounted browser shell supplies commands; no Cloudflare runtime is involved.
mock.module('cloudflare:workers', () => ({ env: {} }));

/** A small mounted shell for the three private drafts outcome suites. */
export async function mountOwnDrafts() {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://site.test/en/drafts' });
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    Element: window.Element,
    Node: window.Node,
    HTMLFormElement: window.HTMLFormElement,
    HTMLButtonElement: window.HTMLButtonElement,
    MutationObserver: window.MutationObserver,
    ResizeObserver: window.ResizeObserver,
    getComputedStyle: window.getComputedStyle.bind(window),
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = Object.fromEntries(
    Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
  );
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, value });
  const { createRoot } = await import('react-dom/client');
  const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
  const { sessionQuery } = await import('../src/session/query');
  const { OwnDraftsPage } = await import('../src/threads/own-drafts/page');
  const host = window.document.createElement('div');
  window.document.body.append(host);
  const root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(sessionQuery.queryKey, { state: 'signed-in', subject: accountId, csrfToken: 'fixture-csrf' });
  return {
    host,
    window,
    client,
    async render(props: Parameters<typeof OwnDraftsPage>[0]) {
      await this.renderComponent(createElement(OwnDraftsPage, props));
    },
    async renderComponent(element: ReactNode) {
      await act(async () => root.render(createElement(QueryClientProvider, { client }, element)));
    },
    async click(label: string) {
      const button = [...window.document.querySelectorAll('button')].find((node) => node.textContent === label);
      if (!button) throw new Error(`Missing own-drafts button: ${label}`);
      await act(async () => button.click());
    },
    async close() {
      await act(async () => root.unmount());
      client.clear();
      for (const [key, descriptor] of Object.entries(previous)) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
      await window.happyDOM.close();
    },
  };
}
