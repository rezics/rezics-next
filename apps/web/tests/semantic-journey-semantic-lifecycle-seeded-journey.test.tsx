import { expect, test } from 'bun:test';
import { act, createElement } from 'react';
import { ZoneLifecycleControls } from '../src/features/catalogue/lifecycle-zone.tsx';
import type { ZoneLifecycleResult } from '../src/features/catalogue/lifecycle-zone-commands.ts';

test('owner delete and restore complete through keyboard use on narrow and wide layouts', async () => {
  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  const { Window } = await import(createRequire(require.resolve('@puckeditor/core')).resolve('happy-dom'));
  const window = new Window({ url: 'https://site.test/en/my/zones/edit', width: 390, height: 720 });
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    HTMLButtonElement: window.HTMLButtonElement,
    Element: window.Element,
    Node: window.Node,
    Document: window.Document,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const saved = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });

  const { createRoot } = await import('react-dom/client');
  const storybook = createRequire(require.resolve('storybook/test'));
  const { within, waitFor } = await import(storybook.resolve('@testing-library/dom'));
  const { default: userEvent } = await import(storybook.resolve('@testing-library/user-event'));

  const host = window.document.createElement('main') as unknown as HTMLElement;
  window.document.body.append(host);
  const root = createRoot(host);
  const user = userEvent.setup({ document: window.document, delay: null });
  const seen: string[] = [];
  let last: ZoneLifecycleResult | undefined;
  let deleted = false;
  const render = async (width: number) => {
    window.resizeTo(width, 720);
    await act(async () =>
      root.render(
        createElement(
          'div',
          { className: width < 640 ? 'max-w-xs' : 'max-w-4xl' },
          createElement(ZoneLifecycleControls, {
            deleted,
            withheld: false,
            busy: false,
            last,
            onDelete: () => {
              seen.push('delete');
              deleted = true;
              last = {
                ok: true,
                operation: 'delete',
                revision: '2',
                deletedAt: '2026-11-06T00:00:00.000Z',
                restoreUntil: '2026-12-06T00:00:00.000Z',
              };
            },
            onRestore: () => {
              seen.push('restore');
              deleted = false;
              last = { ok: true, operation: 'restore', revision: '3', deletedAt: null, restoreUntil: null };
            },
          }),
        ),
      ),
    );
  };

  try {
    await render(390);
    expect(host.querySelector('.max-w-xs')).toBeDefined();
    const canvas = () => within(host);
    await act(async () => {
      canvas().getByRole('button', { name: 'Delete zone' }).focus();
      await user.keyboard('{Enter}');
    });
    await render(390);
    await waitFor(() => expect(canvas().getByRole('button', { name: 'Restore zone' })).toBeDefined());
    await render(1280);
    expect(host.querySelector('.max-w-4xl')).toBeDefined();
    await act(async () => {
      canvas().getByRole('button', { name: 'Restore zone' }).focus();
      await user.keyboard('{Enter}');
    });
    await render(1280);
    await waitFor(() => expect(canvas().getByRole('button', { name: 'Delete zone' })).toBeDefined());
    expect(seen).toEqual(['delete', 'restore']);
  } finally {
    await act(async () => root.unmount());
    for (const key of Object.keys(globals)) {
      const descriptor = saved.get(key);
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    window.close();
  }
});
