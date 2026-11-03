import { expect, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import example from '../src/kernel/recorded/my-realms.json';
import { formatMyRealmsInventory } from '../src/community/my-realms-native';

test('installed native inventory formats only its returned window without inferring entry or actions', async () => {
  for (const count of [0, 1, 10, 20]) {
    const items = Array.from({ length: count }, (_, i) => example.items[i % example.items.length]!);
    const next = 'opaque/sparse?cursor=%25';
    let reads = 0;
    const client = createKernelClient('https://kernel.example', {
      fetch: async () => {
        reads++;
        return Response.json({ items, next });
      },
    });
    const { data } = await client.me.realms.get();
    if (!data) throw new Error('Expected the recorded native inventory');
    expect(formatMyRealmsInventory(data)).toEqual({
      realms: items.map(({ realmId, name }) => ({ realmId, name })),
      next,
    });
    expect(reads).toBe(1);
  }
});

test('mounted installed inventory keeps names and continuation without inventing entry or actions in eight locales', async () => {
  const { dirname } = await import('node:path');
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://site.example/en/realms' });
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    location: window.location,
    HTMLElement: window.HTMLElement,
    Node: window.Node,
    Element: window.Element,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const { act, createElement } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { createMemoryHistory, createRootRoute, createRouter, RouterProvider } = await import('@tanstack/react-router');
  const { MyRealmsPageView } = await import('../src/community/my-realms-page');
  const { m } = await import('../src/paraglide/messages.js');
  const { setLocale } = await import('../src/paraglide/runtime.js');
  const host = window.document.createElement('main');
  window.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  try {
    for (const locale of ['en', 'zh-Hant', 'zh-Hans', 'ja', 'ko', 'de', 'fr', 'es'] as const) {
      await setLocale(locale, { reload: false });
      for (const count of [0, 1, 10, 20]) {
        const next = 'opaque/sparse?cursor=%25';
        const client = createKernelClient('https://kernel.example', {
          fetch: async () =>
            Response.json({
              items: Array.from({ length: count }, (_, i) => ({
                ...example.items[i % example.items.length]!,
                realmId: `realm-${i}`,
                name: `Readers ${i} ${'Long community title 共讀 '.repeat(8)}`,
              })),
              next,
            }),
        });
        const { data } = await client.me.realms.get();
        if (!data) throw new Error('Expected native inventory');
        const page = { signedIn: true, ...formatMyRealmsInventory(data) };
        const route = createRootRoute({ component: () => createElement(MyRealmsPageView, { page }) });
        const router = createRouter({
          routeTree: route,
          history: createMemoryHistory({ initialEntries: ['/realms'] }),
        });
        await router.load();
        await act(async () => {
          root.render(createElement(RouterProvider, { key: `${locale}-${count}`, router }));
        });
        const rows = [...host.querySelectorAll('li')];
        expect(rows).toHaveLength(count);
        rows.forEach((row, i) => {
          expect(row.querySelector('h2')?.textContent).toBe(page.realms[i]!.name);
          expect(row.textContent).toContain(m.realms_entry_unavailable());
          expect(row.querySelector('a, button, img')).toBeNull();
        });
        const continuation = host.querySelector('nav a');
        expect(continuation?.textContent).toBe(m.realms_more());
        expect(new URL(continuation!.getAttribute('href')!, 'https://site.example').searchParams.get('cursor')).toBe(
          next,
        );
        expect(host.querySelector('button, dialog')).toBeNull();
        if (!count) expect(host.textContent).toContain(m.realm_list_details_sparse_page_empty());
      }
    }
  } finally {
    await act(async () => root.unmount());
    await setLocale('en', { reload: false });
    for (const [key, descriptor] of previous)
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    await window.happyDOM.close();
  }
});
