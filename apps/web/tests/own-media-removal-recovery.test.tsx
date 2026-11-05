import { expect, mock, test } from 'bun:test';
import { createRequire } from 'node:module';
import { act, useState } from 'react';
import * as start from '../.storybook/react-start';
import type { OwnMediaEraseResult } from '../src/media/own-inventory/actions';
import type { OwnMediaEraseIntent } from '../src/media/own-inventory/inventory';
import type { OwnMediaInventoryEntry } from '../src/media/own-inventory/wire';
mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);
mock.module('cloudflare:workers', () => ({ env: {} }));

const entry = (id: string): OwnMediaInventoryEntry => ({
  id,
  purpose: 'post-image',
  state: 'available',
  declaredMediaType: 'image/png',
  actualMediaType: null,
  declaredByteCount: 24,
  actualByteCount: 24,
  createdAt: '2026-10-01T00:00:00Z',
  claimedAt: null,
  collectionPending: false,
  takenDown: false,
  container: null,
  actions: {
    read: { operationId: 'media.authorize_download', variants: ['original'], recheckAtUse: true },
    remove: { operationId: 'media.erase' },
    resume: null,
    retry: null,
  },
});

async function mount() {
  const require = createRequire(import.meta.url);
  const { Window } = await import(createRequire(require.resolve('@puckeditor/core')).resolve('happy-dom'));
  const window = new Window({ url: 'https://site.test/library/media' });
  const globals = {
    window,
    scrollTo: window.scrollTo.bind(window),
    ...Object.fromEntries(
      [
        'document',
        'navigator',
        'HTMLElement',
        'Element',
        'Node',
        'Document',
        'DocumentFragment',
        'MutationObserver',
      ].map((key) => [key, Reflect.get(window, key)]),
    ),
    getComputedStyle: window.getComputedStyle.bind(window),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const saved = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const { createRoot } = await import('react-dom/client');
  const { createMemoryHistory, createRootRoute, createRouter, RouterProvider } = await import('@tanstack/react-router');
  const { OwnMediaInventoryWorkspace } = await import('../src/media/own-inventory/page');
  const { setLocale } = await import('../src/paraglide/runtime');
  setLocale('en', { reload: false });
  const host = window.document.createElement('div') as unknown as HTMLDivElement;
  window.document.body.append(host);
  const root = createRoot(host);
  let finish!: (result: OwnMediaEraseResult) => void;
  const calls: OwnMediaEraseIntent[] = [];
  let refreshes = 0;
  let current = true;
  const originalSender = async ({ data }: { data: OwnMediaEraseIntent }) => {
    calls.push(data);
    return new Promise<OwnMediaEraseResult>((resolve) => {
      finish = resolve;
    });
  };
  const props = {
    state: 'ready' as const,
    page: { availability: 'available' as const, entries: [entry('A'), entry('B')], nextCursor: 'opaque-next' },
    cursor: 'opaque-current',
    subject: 'viewer',
    locale: 'en',
    viewKey: 'visit',
    isCurrent: () => current,
    onRefresh: async () => {
      refreshes++;
    },
    onErase: originalSender,
  };
  let redraw!: () => void;
  function View() {
    const [, update] = useState(0);
    redraw = () => update((value) => value + 1);
    return <OwnMediaInventoryWorkspace {...props} />;
  }
  const router = createRouter({
    routeTree: createRootRoute({ component: View }),
    history: createMemoryHistory({ initialEntries: ['/library/media'] }),
  });
  await act(async () => {
    root.render(<RouterProvider router={router} />);
  });
  const render = async () =>
    act(async () => {
      redraw();
    });
  const buttons = () => Array.from(host.querySelectorAll('button'));
  const button = (text: string) => buttons().find((b) => b.textContent === text)!;
  const click = async (target: HTMLElement) =>
    act(async () => {
      target.click();
    });
  const select = (index: number) => click(buttons().filter((b) => b.hasAttribute('aria-expanded'))[index]!);
  const begin = async () => {
    await select(0);
    await click(button('Remove this media'));
    await act(async () => {
      const confirm = button('Confirm removal');
      confirm.click();
      // Reentrant movement before React publishes the sending episode.
      host.querySelector<HTMLAnchorElement>('a[href*="cursor="]')!.click();
      confirm.click();
    });
  };
  return {
    host,
    props,
    calls,
    button,
    click,
    select,
    begin,
    render,
    refreshes: () => refreshes,
    location: () => router.state.location.href,
    next: () => host.querySelector<HTMLAnchorElement>('a[href*="cursor="]')!,
    retire: () => {
      current = false;
    },
    finish: async (result: OwnMediaEraseResult) =>
      act(async () => {
        finish(result);
      }),
    close: async () => {
      await act(async () => root.unmount());
      window.happyDOM.abort();
      for (const [key, descriptor] of saved) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    },
  };
}

test('browsing during removal keeps the original sender and exact uncertain command; acknowledgement refreshes', async () => {
  const h = await mount();
  try {
    await h.begin();
    const original = h.calls[0]!;
    expect(h.location()).toBe('/library/media');
    expect(h.next().getAttribute('aria-disabled')).toBe('true');
    expect(h.host.textContent).toContain('Page movement is unavailable');
    await h.select(1);
    await h.click(h.button('Remove this media'));
    expect(h.calls).toHaveLength(1);
    await h.finish('uncertain');
    await h.click(h.next());
    expect(h.location()).toBe('/library/media');
    expect(h.next().getAttribute('aria-disabled')).toBe('true');
    expect(h.host.querySelector('[role="alert"]')?.textContent).toContain('A');
    expect(h.host.querySelector('[role="alert"]')?.textContent).toContain('Removal is not confirmed');
    await h.click(h.button('Return to original media'));
    expect(h.button('Remove this media').disabled).toBe(true);
    h.props.onErase = async () => {
      throw new Error('replacement sender must not run');
    };
    await h.render();
    const retry = h.button('Retry original removal');
    await act(async () => {
      retry.click();
      retry.click();
    });
    expect(h.calls).toHaveLength(2);
    expect(h.calls[1]).toBe(original);
    expect(original).toMatchObject({ mediaId: 'A', viewer: 'viewer', source: 'media.own/v1' });
    expect(original.idempotencyKey).toBeTruthy();
    await h.select(1);
    await h.finish('acknowledged');
    expect(h.refreshes()).toBe(1);
    expect(h.next().getAttribute('aria-disabled')).toBe('false');
    expect(h.host.querySelector('[role="status"]')?.textContent).toContain('A');
    expect(h.props.page.nextCursor).toBe('opaque-next');
    expect(h.host.querySelector('a[href="/media/B/original"]')).not.toBeNull();
  } finally {
    await h.close();
  }
});

test('missing rows, withdrawn advice and retired authority withhold the retained recovery', async () => {
  for (const withdrawal of ['row', 'advice', 'authority', 'viewer', 'read']) {
    const h = await mount();
    try {
      await h.begin();
      await h.finish('uncertain');
      if (withdrawal === 'row') h.props.page.entries = [entry('B')];
      if (withdrawal === 'advice') h.props.page.entries[0]!.actions.remove = null;
      if (withdrawal === 'authority') h.retire();
      if (withdrawal === 'viewer') h.props.subject = 'replacement';
      if (withdrawal === 'read') h.props.viewKey = 'replacement-read';
      await h.render();
      expect(h.button('Retry original removal').disabled).toBe(true);
      await h.click(h.button('Retry original removal'));
      expect(h.calls).toHaveLength(1);
      expect(h.host.textContent).toContain('Recovery is withheld');
    } finally {
      await h.close();
    }
  }
});
