import { expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, createElement, useState } from 'react';
import type { MenuProps } from '@rezics/ui/menu';
import type { LabelInput, LabelResult, LabelsPage } from '../src/library/labels-read';

test('Labels protects local drafts, preserves focus and original retries, and bypasses confirmed saves and retirement', async () => {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://site.test/labels' });
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    HTMLInputElement: window.HTMLInputElement,
    HTMLAnchorElement: window.HTMLAnchorElement,
    HTMLFormElement: window.HTMLFormElement,
    Element: window.Element,
    Node: window.Node,
    Document: window.Document,
    FormData: window.FormData,
    MutationObserver: window.MutationObserver,
    ResizeObserver: window.ResizeObserver,
    getComputedStyle: window.getComputedStyle.bind(window),
    matchMedia: window.matchMedia.bind(window),
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const calls: { data: LabelInput; headers: HeadersInit }[] = [];
  let finish!: (result: LabelResult) => void;
  mock.module('../src/library/labels-actions', () => ({
    manageLabel: (call: (typeof calls)[number]) => {
      calls.push(call);
      return new Promise<LabelResult>((resolve) => {
        finish = resolve;
      });
    },
  }));
  mock.module('../src/library/labels-read-route', () => ({ readLabelsPage: async () => page }));
  // Expose the existing menu actions directly; dialog and routing behavior remain real.
  mock.module('@rezics/ui/menu', () => ({
    Menu: ({ entries }: MenuProps) =>
      createElement(
        'div',
        null,
        ...entries.flatMap((entry, index) =>
          entry.type === 'item' || entry.type === 'destructive'
            ? [createElement('button', { key: index, onClick: entry.onSelect }, entry.label)]
            : [],
        ),
      ),
  }));
  const page: LabelsPage = {
    signedIn: true,
    state: 'loaded',
    csrfToken: 'original-credential',
    createKey: 'create-key',
    undoKey: 'undo-key',
    next: 'next',
    operations: ['library_label.list', 'library_label.create', 'library_label.rename', 'library_label.delete'],
    labels: [{ id: 'label', name: 'Original', revision: 7, renameKey: 'rename-key', deleteKey: 'delete-key' }],
  };
  const { LabelsPageView } = await import('../src/library/labels-page');
  const { hasUnsentLabelName } = await import('../src/library/label-draft-navigation');
  expect(hasUnsentLabelName(' \n ', '')).toBe(false);
  expect(hasUnsentLabelName('Name', 'Name')).toBe(false);
  expect(hasUnsentLabelName(' Name ', 'Name')).toBe(true);
  expect(hasUnsentLabelName('Sent', 'Name', 'Sent')).toBe(false);
  expect(hasUnsentLabelName('Later', 'Name', 'Sent')).toBe(true);
  const { m } = await import('../src/paraglide/messages.js');
  const { createRoot } = await import('react-dom/client');
  const { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider } =
    await import('@tanstack/react-router');
  let current = true;
  let rerender!: () => void;
  function Fixture() {
    const [, update] = useState(0);
    rerender = () => update((value) => value + 1);
    return createElement(LabelsPageView, {
      page,
      locale: 'en',
      isCurrent: () => current,
      refresh: async () => ({ ...page, createKey: 'fresh-key' }),
    });
  }
  const rootRoute = createRootRoute({ component: Outlet });
  const route = createRoute({ getParentRoute: () => rootRoute, path: '/labels', component: Fixture });
  const away = createRoute({ getParentRoute: () => rootRoute, path: '/away', component: () => 'Away' });
  const router = createRouter({
    routeTree: rootRoute.addChildren([route, away]),
    history: createMemoryHistory({ initialEntries: ['/labels'] }),
  });
  const host = window.document.createElement('div');
  window.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  const settle = async (ready: () => boolean) => {
    for (let count = 0; count < 100 && !ready(); count++)
      await act(async () => {
        await Bun.sleep(10);
      });
    expect(ready()).toBe(true);
  };
  const field = (id: string) => window.document.getElementById(id) as InstanceType<typeof window.HTMLInputElement>;
  const alert = () => window.document.querySelector('[role="alertdialog"]');
  const click = async (text: string) => {
    await act(async () => {
      const scope = alert() ?? window.document;
      [...scope.querySelectorAll('button')].find((button) => button.textContent === text)!.click();
    });
  };
  const edit = async (id: string, value: string) => {
    await act(async () => {
      const input = field(id);
      input.focus();
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(input, value);
      input.dispatchEvent(new window.Event('input', { bubbles: true }));
    });
  };
  const unload = () => {
    const event = new window.Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  };
  const submit = async (id: string) => {
    await act(async () => {
      field(id)
        .closest('form')!
        .dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    });
  };
  try {
    await act(async () => {
      await router.load();
      root.render(createElement(RouterProvider, { router }));
    });
    await settle(() => !!field('new-label'));
    expect(unload()).toBe(false);
    await edit('new-label', '  Draft e\u0301  ');
    expect(unload()).toBe(true);
    await act(async () => {
      void router.navigate({ href: '/labels?q=exact%25&cursor=opaque' });
    });
    await settle(() => !!alert());
    await click(m.library_label_draft_navigation_stay());
    expect(router.state.location.searchStr).toBe('');
    expect(field('new-label').value).toBe('  Draft e\u0301  ');
    await settle(() => window.document.activeElement === field('new-label'));
    await submit('label-prefix');
    expect(alert()).not.toBeNull();
    await click(m.library_label_draft_navigation_stay());
    await act(async () => {
      host.querySelector('a[href]')!.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
    });
    expect(alert()).not.toBeNull();
    await click(m.library_label_draft_navigation_stay());
    await click(m.library_label_rename());
    await edit('label-label', '  Rename e\u0301  ');
    await click(m.action_cancel());
    expect(alert()).not.toBeNull();
    await click(m.library_label_draft_navigation_stay());
    expect(field('label-label').value).toBe('  Rename e\u0301  ');
    await settle(() => window.document.activeElement === field('label-label'));
    await act(async () => {
      field('label-label').dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    await settle(() => !!alert());
    await click(m.library_label_draft_navigation_stay());
    await click(m.library_label_delete());
    await click(m.library_label_draft_navigation_discard());
    expect(field('label-label')).toBeNull();
    expect(calls).toHaveLength(0);
    expect(field('new-label').value).toBe('  Draft e\u0301  ');
    await click(m.action_cancel());
    await edit('new-label', '');
    await click(m.library_label_rename());
    await edit('label-label', 'Changed');
    await edit('label-label', 'Original');
    expect(unload()).toBe(false);
    await edit('label-label', 'Sent');
    await submit('label-label');
    expect(unload()).toBe(false);
    await act(async () => {
      finish({ ok: false, reason: 'unavailable' });
    });
    expect(field('label-label').disabled).toBe(false);
    expect(unload()).toBe(false);
    await edit('label-label', 'Later');
    expect(unload()).toBe(true);
    await submit('label-label');
    expect(calls[1]).toEqual(calls[0]);
    expect(calls[1]!.data).toMatchObject({ name: 'Sent', revision: 7, idempotencyKey: 'rename-key' });
    await act(async () => {
      finish({ ok: true });
    });
    expect(field('label-label').value).toBe('Later');
    expect(unload()).toBe(true);
    await click(m.action_cancel());
    await click(m.library_label_draft_navigation_discard());
    expect(unload()).toBe(false);
    await edit('new-label', 'Refused');
    await submit('new-label');
    await act(async () => {
      finish({ ok: false, reason: 'conflict' });
    });
    expect(field('new-label').value).toBe('Refused');
    expect(unload()).toBe(true);
    await submit('new-label');
    await act(async () => {
      finish({ ok: true });
    });
    expect(field('new-label').value).toBe('');
    expect(unload()).toBe(false);
    await edit('new-label', 'Retiring');
    await act(async () => {
      void router.navigate({ href: '/away' });
    });
    await settle(() => !!alert());
    const count = calls.length;
    await act(async () => {
      current = false;
      rerender();
    });
    await settle(() => router.state.location.pathname === '/away');
    expect(alert()).toBeNull();
    expect(unload()).toBe(false);
    expect(calls).toHaveLength(count);
  } finally {
    await act(async () => root.unmount());
    mock.restore();
    window.happyDOM.abort();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
