import { expect, test } from 'bun:test';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { act, createElement } from 'react';
import { fromPlainText } from '@rezics/document';
import {
  readSelectedOwnDraft,
  type OwnDraftReader,
  type OwnDraftSelectionRequest,
} from '../src/threads/own-drafts/model';

import { accountId, identity, mountOwnDrafts, postId, row, selected, threadId } from './own-drafts-fixture';
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
        post: {
          id: postId,
          threadId,
          parentId: null,
          mediaIds: entry.mediaIds,
          body: fromPlainText('Only this chosen body', 'blocks'),
        },
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
    post: {
      id: postId,
      threadId,
      parentId: null,
      mediaIds: row().mediaIds,
      body: fromPlainText('Private selected bytes', 'blocks'),
    },
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

test('browser writing stays separate until the person names it as the editor source', async () => {
  const entry = row();
  const native = selected(entry, 'Server-saved body');
  const browser = {
    slot: 0,
    actor: accountId,
    scope: { kind: 'thread' as const, boardId: entry.board.id, subjects: [] },
    revision: 'browser-local-revision',
    updated: 1_798_000_000_000,
    bytes: 0,
    state: 'unsent' as const,
    payload: {
      title: 'Browser-only title',
      body: fromPlainText('Independent browser body', 'blocks'),
      text: 'Independent browser body',
      attachmentRepair: false,
    },
  };
  const reader: OwnDraftReader = {
    list: async () => ({ state: 'ready', viewer: { accountId, authnEpoch: 2 }, drafts: [entry], next: null }),
    resume: async () => native,
  };
  const writes: unknown[] = [];
  const fixture = await mountOwnDrafts();
  try {
    await fixture.render({
      identity,
      active: true,
      reader,
      localWritingReader: { load: async () => browser },
      commands: {
        async write(input) {
          writes.push(input);
          return { ok: false, reason: 'unavailable' };
        },
        async erase() {
          return { ok: true };
        },
        async readback() {
          return 'unavailable';
        },
      },
    });
    await fixture.click('Inspect draft privately');
    expect(fixture.host.textContent).toContain('Server-saved body');
    expect(fixture.host.textContent).toContain('Independent browser body');
    expect(fixture.host.textContent).toContain('Choose which writing to open');
    expect(writes).toHaveLength(0);
    await fixture.click('Use browser-saved body in editor');
    expect(fixture.host.textContent).toContain('Saved in this browser');
    expect(fixture.host.textContent).toContain('Independent browser body');
    expect(fixture.host.textContent).not.toContain('Server-saved body');
    expect(writes).toHaveLength(0);
  } finally {
    await fixture.close();
  }
});

test('Return to drafts keeps edited server and browser writing on Stay and discards only on deliberate departure', async () => {
  const entry = row();
  const browser = {
    slot: 0,
    actor: accountId,
    scope: { kind: 'thread' as const, boardId: entry.board.id, subjects: [] },
    revision: 'browser-local-revision',
    updated: 1_798_000_000_000,
    bytes: 0,
    state: 'unsent' as const,
    payload: {
      title: 'Browser-only title',
      body: fromPlainText('Independent browser body', 'blocks'),
      text: 'Independent browser body',
      attachmentRepair: false,
    },
  };
  const reader: OwnDraftReader = {
    list: async () => ({ state: 'ready', viewer: { accountId, authnEpoch: 2 }, drafts: [entry], next: null }),
    resume: async () => selected(entry, 'Server-saved body'),
  };
  const fixture = await mountOwnDrafts();
  const { m } = await import('../src/paraglide/messages.js');
  const storybookRequire = createRequire(createRequire(import.meta.url).resolve('storybook/test'));
  const { default: userEvent } = await import(storybookRequire.resolve('@testing-library/user-event'));
  const user = userEvent.setup({ document: fixture.window.document });
  const sourceLabel = (source: 'server' | 'browser') =>
    source === 'server' ? m.own_drafts_server_source() : m.own_drafts_browser_source();
  const editor = () =>
    [...fixture.host.querySelectorAll<HTMLElement>('[role="textbox"]')].find((node) =>
      node.classList.contains('ProseMirror'),
    );
  try {
    await fixture.render({
      identity,
      active: true,
      reader,
      localWritingReader: { load: async () => browser },
      commands: {
        async write() {
          return { ok: false, reason: 'unavailable' };
        },
        async erase() {
          return { ok: true };
        },
        async readback() {
          return 'unavailable';
        },
      },
    });
    for (const source of ['server', 'browser'] as const) {
      await fixture.click('Inspect draft privately');
      await fixture.click(source === 'server' ? 'Use server-saved body in editor' : 'Use browser-saved body in editor');
      const currentEditor = editor();
      expect(currentEditor).toBeDefined();
      await act(async () => {
        await user.click(currentEditor!);
        await user.keyboard(' resumed changes');
        await user.tab();
      });
      const exactMarkup = editor()?.innerHTML;
      const returnButton = [...fixture.host.querySelectorAll('button')].find(
        (node) => node.textContent === m.own_drafts_return({}, { locale: 'en' }),
      )!;
      await act(async () => user.click(returnButton));
      expect(fixture.host.querySelector('[role="alertdialog"]')?.textContent).toContain(
        m.thread_authoring_leave_unsaved(),
      );
      await fixture.click(m.thread_authoring_stay());
      expect(fixture.window.document.activeElement).toBe(returnButton);
      expect(editor()?.innerHTML).toBe(exactMarkup);
      expect(fixture.host.textContent).toContain(sourceLabel(source));
      expect(editor()?.textContent).toContain('resumed changes');

      await act(async () => user.click(returnButton));
      await fixture.click(m.thread_authoring_leave());
      expect(editor()).toBeUndefined();
      expect(fixture.host.textContent).not.toContain('resumed changes');
      expect(fixture.window.document.activeElement?.textContent).toBe('Inspect draft privately');
    }
  } finally {
    await fixture.close();
  }
});
