import { expect, test } from 'bun:test';
import { createRequire } from 'node:module';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, useState, type Dispatch, type SetStateAction } from 'react';
import type { RecentItem } from '../src/search/recent';

const entry = (id: string, text: string): RecentItem => ({
  id,
  entry: { kind: 'query', text },
  revision: 0,
  lastUsed: '2026-11-01T00:00:00.000Z',
  display: { name: text, href: `/search?q=${text}`, avatar: null },
});

test('history removals and clear keep focus useful, announce completion, and leave remote focus alone', async () => {
  const require = createRequire(import.meta.url);
  const { Window } = await import(createRequire(require.resolve('@puckeditor/core')).resolve('happy-dom'));
  const window = new Window({ url: 'https://site.invalid/en' });
  const globals = [
    'window',
    'document',
    'navigator',
    'HTMLElement',
    'HTMLButtonElement',
    'HTMLInputElement',
    'Element',
    'Node',
    'Document',
    'DocumentFragment',
    'ShadowRoot',
    'MutationObserver',
    'ResizeObserver',
    'Event',
    'MouseEvent',
    'PointerEvent',
    'KeyboardEvent',
    'FocusEvent',
    'CSS',
    'getComputedStyle',
    'requestAnimationFrame',
    'cancelAnimationFrame',
    'IS_REACT_ACT_ENVIRONMENT',
  ];
  const saved = new Map(globals.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const key of globals) {
    const value = key === 'window' ? window : key === 'IS_REACT_ACT_ENVIRONMENT' ? true : window[key as keyof Window];
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }

  const { act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { setLocale } = await import('../src/paraglide/runtime.js');
  const { m } = await import('../src/paraglide/messages.js');
  const { RecentHistoryView } = await import('../src/search/recent');
  const { useRecentHistory } = await import('../src/search/recent-history-hook');
  setLocale('en', { reload: false });
  const host = window.document.createElement('main');
  window.document.body.append(host);
  let update!: Dispatch<SetStateAction<RecentItem[]>>;
  let external: HTMLButtonElement | null = null;
  let preserveFocus = false,
    pending = false,
    bucket = 'account:A';
  const client = new QueryClient();
  const session = (subject: string) =>
    client.setQueryData(['session'], { state: 'signed-in', subject, csrfToken: null });
  const adapter = { sync: async () => {} };
  session('A');
  function Harness() {
    const { owner } = useRecentHistory(bucket, adapter);
    const [entries, setEntries] = useState([entry('a', 'Alpha'), entry('b', 'Beta'), entry('c', 'Gamma')]);
    update = setEntries;
    return createElement(
      'div',
      null,
      createElement('button', { ref: (node: HTMLButtonElement | null) => (external = node) }, 'Outside'),
      createElement(RecentHistoryView, {
        entries,
        owner,
        status: 'ready',
        history: true,
        onRemove(id: string) {
          if (pending) return;
          if (preserveFocus) external?.focus();
          setEntries((current) => current.filter((item) => item.id !== id));
        },
        onClear: () => {
          if (!pending) setEntries([]);
        },
      }),
    );
  }
  const root = createRoot(host);
  const remove = (name: string) =>
    Array.from(host.querySelectorAll<HTMLButtonElement>('button[aria-label]')).find(
      (button) => button.getAttribute('aria-label') === m.search_history_remove({ name }),
    )!;
  const active = () => window.document.activeElement;
  const status = () => host.querySelector('[aria-live="polite"]')?.textContent;

  try {
    await act(async () => root.render(createElement(QueryClientProvider, { client }, createElement(Harness))));
    await act(async () => {
      remove('Beta').focus();
      remove('Beta').click();
    });
    expect(active()).toBe(remove('Gamma'));
    expect(status()).toBe(m.search_history_management_removed({ name: 'Beta' }));
    await act(async () => {
      remove('Gamma').focus();
      remove('Gamma').click();
    });
    expect(active()).toBe(remove('Alpha'));
    await act(async () => {
      remove('Alpha').focus();
      remove('Alpha').click();
    });
    expect(active()).toBe(host.querySelector('section'));

    await act(async () => update([entry('a', 'Alpha')]));
    const clear = Array.from(host.querySelectorAll('button')).find(
      (button) => button.textContent === m.search_history_clear(),
    )!;
    await act(async () => {
      clear.focus();
      clear.click();
    });
    expect(active()).toBe(host.querySelector('section'));
    expect(status()).toBe(m.search_history_management_cleared());

    await act(async () => update([entry('a', 'Alpha'), entry('b', 'Beta')]));
    preserveFocus = true;
    await act(async () => {
      remove('Alpha').focus();
      remove('Alpha').click();
    });
    expect(active()).toBe(external);
    preserveFocus = false;
    await act(async () => update([entry('a', 'Alpha'), entry('b', 'Beta')]));
    external!.focus();
    await act(async () => update((current) => current.filter((item) => item.id !== 'a')));
    expect(active()).toBe(external);

    pending = true;
    for (const kind of ['remove', 'clear'])
      for (const change of ['account', 'session', 'return', 'batched-return']) {
        await act(async () => {
          bucket = 'account:A';
          session('A');
          update([entry('a', 'Alpha')]);
        });
        const source = kind === 'remove' ? remove('Alpha') : clear;
        await act(async () => {
          source.focus();
          source.click();
        });
        expect(status()).toBe('');
        expect(active()).toBe(source);
        await act(async () => {
          session(change === 'session' ? 'A' : 'B');
          if (change === 'batched-return') session('A');
          bucket = change === 'session' || change === 'batched-return' ? 'account:A' : 'account:B';
          update(change === 'return' ? [entry('a', 'Alpha')] : []);
        });
        if (change === 'return')
          await act(async () => {
            bucket = 'account:A';
            session('A');
            update([]);
          });
        expect(status()).toBe('');
        expect(active()).not.toBe(host.querySelector('section'));
      }
  } finally {
    await act(async () => root.unmount());
    client.clear();
    host.remove();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    window.close();
  }
});
