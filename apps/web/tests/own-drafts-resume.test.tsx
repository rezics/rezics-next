import { expect, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, createElement } from 'react';
import { fromPlainText } from '@rezics/document';
import {
  readSelectedOwnDraft,
  type OwnDraftReader,
  type OwnDraftSelectionRequest,
} from '../src/threads/own-drafts/model';

import { accountId, identity, postId, row, threadId } from './own-drafts-fixture';
const revisionId = row().revisionId;

test('explicit selection reads one exact current draft; stale or concealed revisions stay unavailable', async () => {
  const entry = row();
  const calls: OwnDraftSelectionRequest[] = [];
  let stale = false;
  const reader: OwnDraftReader = {
    list: async () => ({ state: 'ready', viewer: { accountId, authnEpoch: 2 }, drafts: [entry], next: null }),
    resume: async (request) => {
      calls.push(request);
      return {
        revision: stale ? 'newer-revision' : revisionId,
        post: { id: postId, threadId, body: fromPlainText('Only this chosen body', 'blocks') },
      };
    },
  };

  await reader.list({ accountId }, new AbortController().signal);
  expect(calls).toHaveLength(0);
  const chosen = await readSelectedOwnDraft(reader, identity, entry, new AbortController().signal);
  expect(calls).toEqual([{ accountId, id: postId, threadId }]);
  expect(typeof chosen).not.toBe('string');
  stale = true;
  expect(await readSelectedOwnDraft(reader, identity, entry, new AbortController().signal)).toBe('stale');
  expect(calls).toHaveLength(2);
  const retired = new AbortController();
  retired.abort();
  expect(await readSelectedOwnDraft(reader, identity, entry, retired.signal)).toBe('unavailable');
  expect(calls).toHaveLength(2);
});

test('mounted inventory bounds selected reads and retires bodies, advice and late effects with their owner', async () => {
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
  const { OwnDraftsPage } = await import('../src/threads/own-drafts/page');
  const host = window.document.createElement('div');
  window.document.body.append(host);
  const root = createRoot(host);
  const button = (label: string) => [...host.querySelectorAll('button')].find((node) => node.textContent === label)!;
  let reads = 0;
  let pages = 0;
  let pending: ((value: Awaited<ReturnType<OwnDraftReader['resume']>>) => void) | undefined;
  let selectedSignal: AbortSignal | undefined;
  const selection = {
    revision: revisionId,
    post: { id: postId, threadId, body: fromPlainText('Private selected bytes', 'blocks') },
  };
  const reader = (size: number): OwnDraftReader => ({
    async list(request) {
      pages++;
      const drafts = request.cursor
        ? []
        : Array.from({ length: size }, (_, index) => (index === 0 ? row() : row({ id: `other-${index}` })));
      return { state: 'ready', viewer: { accountId, authnEpoch: 2 }, drafts, next: request.cursor ? null : 'opaque' };
    },
    async resume(_request, signal) {
      reads++;
      selectedSignal = signal;
      return new Promise((resolve) => {
        pending = resolve;
      });
    },
  });
  const render = async (source: OwnDraftReader, owner = identity, active = true) => {
    await act(async () => {
      root.render(createElement(OwnDraftsPage, { identity: owner, active, reader: source }));
    });
  };
  const click = async (label: string) => {
    await act(async () => button(label).click());
  };
  try {
    for (const size of [1, 10, 20]) {
      const source = reader(size);
      await render(source);
      expect(host.querySelectorAll('li')).toHaveLength(size);
      const before = reads;
      await click('Inspect draft privately');
      expect(reads).toBe(before + 1);
      expect(window.document.activeElement?.tagName).toBe('H1');
      await act(async () => {
        pending!(selection);
      });
      expect(host.querySelectorAll('article')).toHaveLength(1);
      expect(host.textContent).toContain('Private selected bytes');
      await click('Return to drafts');
      expect(window.document.activeElement?.textContent).toBe('Inspect draft privately');
      await click('Continue to older drafts');
      expect(host.querySelectorAll('li')).toHaveLength(0);
      expect(host.textContent).not.toContain('Private selected bytes');
      expect(reads).toBe(before + 1);
    }
    // No hidden refill, including the sparse page: one request per explicitly opened page.
    expect(pages).toBe(6);
    for (const change of ['account', 'credential', 'locale', 'source', 'inactive', 'reader'] as const) {
      const source = reader(1);
      await render(source);
      await click('Inspect draft privately');
      const late = pending!;
      const next =
        change === 'account'
          ? { ...identity, accountId: 'another-account' }
          : change === 'credential'
            ? { ...identity, callerEpoch: 'new-credential' }
            : change === 'locale'
              ? { ...identity, locale: 'ja' as const }
              : change === 'source'
                ? { ...identity, source: 'replacement' }
                : identity;
      await render(change === 'reader' ? reader(1) : source, next, change !== 'inactive');
      expect(selectedSignal?.aborted).toBe(true);
      await act(async () => {
        late(selection);
      });
      expect(host.textContent).not.toContain('Private selected bytes');
      expect(host.querySelector('article')).toBeNull();
    }
  } finally {
    await act(async () => root.unmount());
    for (const [key, descriptor] of Object.entries(previous)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    await window.happyDOM.close();
  }
});
