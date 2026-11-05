import { expect, test } from 'bun:test';
import { createRequire } from 'node:module';
import { createElement, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import type { RecentEntry, RecentHistory } from '../src/search/recent-history';

const entry = (id: string, query = id): RecentEntry => ({ id, query, visitedAt: 0 });

test('the default header history keeps removal focus useful and current', async () => {
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
  const { HeaderSearch } = await import('../src/search/header-search/header-search');
  setLocale('en', { reload: false });
  const host = window.document.createElement('main');
  window.document.body.append(host);

  let updateEntries!: Dispatch<SetStateAction<RecentEntry[]>>;
  let updateOwner!: Dispatch<SetStateAction<string>>;
  let updateDeferred!: Dispatch<SetStateAction<boolean>>;
  let outside: HTMLButtonElement | null = null;
  function Harness() {
    const [entries, setEntries] = useState(() =>
      Array.from({ length: 36 }, (_, index) => entry(`id-${index}`, `Query ${index}`)),
    );
    const [ownerKey, setOwnerKey] = useState('A');
    const [deferred, setDeferred] = useState(false);
    const ownerRef = useRef(ownerKey);
    ownerRef.current = ownerKey;
    const owner = useMemo(() => () => ownerRef.current === ownerKey, [ownerKey]);
    updateEntries = setEntries;
    updateOwner = setOwnerKey;
    updateDeferred = setDeferred;
    const history: RecentHistory = {
      owner,
      entries,
      persistence: 'local',
      sync: 'local-only',
      remember() {},
      remove(id) {
        if (!deferred) setEntries((current) => current.filter((item) => item.id !== id));
      },
    };
    return createElement(
      'div',
      null,
      createElement('button', { ref: (node: HTMLButtonElement | null) => (outside = node) }, 'Outside'),
      // ShellSearch supplies history and leaves the recent slot unset, so HeaderSearch mounts its default panel.
      createElement(HeaderSearch, { locale: 'en', history }),
    );
  }

  const root = createRoot(host);
  const actions = () => Array.from(host.querySelectorAll<HTMLButtonElement>('[data-history-action]'));
  const action = (id: string) => actions().find((button) => button.dataset.historyId === id)!;
  const region = () => host.querySelector<HTMLElement>('[data-search-discovery] section[tabindex="-1"]')!;
  const announcement = () => host.querySelector('[data-search-discovery] [aria-live="polite"]')?.textContent;

  try {
    await act(async () => root.render(createElement(Harness)));
    const trigger = host.querySelector<HTMLButtonElement>('[data-header-search] .header-search-trigger')!;
    await act(async () => trigger.click());
    const remove = async (id: string) =>
      act(async () => {
        action(id).focus();
        action(id).click();
      });

    expect(actions()).toHaveLength(5);
    await remove('id-0');
    expect(window.document.activeElement).toBe(action('id-1'));
    await remove('id-3');
    expect(window.document.activeElement).toBe(action('id-4'));
    await remove('id-6');
    expect(window.document.activeElement).toBe(action('id-7'));

    const toggle = host.querySelector<HTMLButtonElement>('[data-search-discovery] section button[aria-expanded]')!;
    await act(async () => toggle.click());
    expect(actions()).toHaveLength(32);
    await remove('id-34');
    expect(window.document.activeElement).toBe(action('id-35'));

    await act(async () => updateEntries([entry('only', 'Only')]));
    await remove('only');
    expect(window.document.activeElement).toBe(region());
    expect(region().getAttribute('aria-label')).toBe(m.header_search_history());
    expect(announcement()).toBe(m.search_history_management_removed({ name: 'Only' }));

    await act(async () => {
      updateEntries([entry('deferred', 'Deferred'), entry('stay', 'Stay')]);
      updateDeferred(true);
    });
    await act(async () => {
      action('deferred').focus();
      action('deferred').click();
    });
    await act(async () => outside?.focus());
    await act(async () => updateEntries((current) => current.filter((item) => item.id !== 'deferred')));
    expect(window.document.activeElement).toBe(outside);

    await act(async () => updateEntries([entry('obsolete', 'Obsolete')]));
    await act(async () => {
      action('obsolete').focus();
      action('obsolete').click();
    });
    await act(async () => {
      updateOwner('B');
      updateEntries([]);
    });
    expect(window.document.activeElement).not.toBe(region());
    expect(announcement()).toBe('');
  } finally {
    await act(async () => root.unmount());
    host.remove();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    window.close();
  }
});
