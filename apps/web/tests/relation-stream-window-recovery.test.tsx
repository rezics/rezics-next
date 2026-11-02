import { expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, createElement as h, useState } from 'react';
import type { OverviewValue, Section } from '../src/features/pages/overview';
import type { RelationGroupRequest } from '../src/features/pages/relation-stream-query';

// Exercise the mounted reader through its existing BFF seam, retaining the real query keys and owner guards.
test('Relation window replaces pages, retries transport, stops cycles and bounds each private traversal', async () => {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://rezics.test/' });
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    Element: window.Element,
    Node: window.Node,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, value });
  const held: { request: RelationGroupRequest; resolve(value: Section): void; reject(error: Error): void }[] = [];
  const start = await import('../.storybook/react-start');
  mock.module('@tanstack/react-start', () => start);
  mock.module('@tanstack/react-start/server', () => start);
  const { relationGroupKey } = await import('../src/features/pages/relation-stream-query');
  mock.module('../src/features/pages/relation-stream-query', () => ({
    relationGroupKey,
    loadRelationGroup: ({ data }: { data: RelationGroupRequest }) =>
      new Promise<Section>((resolve, reject) => held.push({ request: data, resolve, reject })),
  }));
  const [
    { createRoot },
    { QueryClient, QueryClientProvider },
    routing,
    { RelationStream },
    { defaultReader },
    { sessionQuery },
    { setLocale },
  ] = await Promise.all([
    import('react-dom/client'),
    import('@tanstack/react-query'),
    import('@tanstack/react-router'),
    import('../src/features/pages/relation-stream'),
    import('../src/subject/reader'),
    import('../src/session/query'),
    import('../src/paraglide/runtime.js'),
  ]);
  setLocale('en', { reload: false });
  const subject = '0192f3a0-6c1e-7b2a-9d4e-000000000101';
  const realm = '0192f3a0-6c1e-7b2a-9d4e-000000000301';
  const context = { id: '0192f3a0-6c1e-7b2a-9d4e-000000000201', population: { kind: 'realm', id: realm } };
  const value = {
    subject,
    subjectLabel: 'Book',
    locale: 'en',
    pageTarget: { subject },
    realm,
    context,
    cacheReader: 'reader',
    reader: defaultReader,
    link: ({ href, children, ...props }: { href: string; children?: unknown }) =>
      h('a', { ...props, href }, children as never),
    labels: { spoilerShow: 'Show', cover: { withheld: '', reveal: '', credit: '', via: '' } },
    relations: {},
    sections: new Map(),
  } as unknown as OverviewValue;
  const page = (labels: string[], next: string | null): Section => ({
    ok: true,
    read: { kind: 'links', id: subject, context: context.id, property: 'schema:author', limit: 12 },
    body: {
      links: labels.map((label) => ({
        subject,
        label,
        statement: label,
        type: 'schema:Book',
        property: 'schema:author',
      })),
      next,
    },
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(sessionQuery.queryKey, { state: 'signed-in', subject: 'reader' });
  let replaceReading: (section: Section) => void = () => {};
  const route = routing.createRootRoute({
    component: () => {
      const [reading, setReading] = useState(() => page(['First'], 'opaque:/+?=&% 日本語#'));
      replaceReading = setReading;
      return h(RelationStream, { value, section: reading, node: 'credits', view: 'relations', title: 'Credits' });
    },
  });
  const router = routing.createRouter({
    routeTree: route,
    history: routing.createMemoryHistory({ initialEntries: ['/'] }),
  });
  let invalidations = 0;
  router.invalidate = async () => {
    invalidations++;
  };
  await router.load();
  const host = window.document.createElement('div');
  window.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  const render = () =>
    act(async () => {
      root.render(h(QueryClientProvider, { client }, h(routing.RouterProvider, { router })));
    });
  const flush = () =>
    act(async () => {
      await Bun.sleep(0);
    });
  const more = () => host.querySelector<HTMLAnchorElement>('[data-slot="continue-group"]')!;
  const status = () => host.querySelector('[aria-live]')!.textContent;
  const rows = () => [...host.querySelectorAll('article')].map((row) => row.textContent);
  const restart = () => host.querySelector<HTMLAnchorElement>('[data-slot="restart-group"]')!;
  const click = async (modifiers = {}) => {
    const action = more();
    action.focus();
    await act(async () => {
      action.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true, ...modifiers }));
    });
    await flush();
  };
  const accept = async (next: Section) => {
    held.at(-1)!.resolve(next);
    await flush();
  };
  const replace = async (next: Section) => {
    await act(async () => replaceReading(next));
    await flush();
  };
  try {
    await render();
    const href = more().getAttribute('href')!;
    expect(new URL(href, window.location.href).searchParams.get('cursor')).toBe('opaque:/+?=&% 日本語#');
    expect(new URL(href, window.location.href).searchParams.get('realm')).toBe(realm);
    await click({ ctrlKey: true });
    expect(held).toHaveLength(0);
    await click();
    expect(rows()).toEqual([expect.stringContaining('First')]);
    held.at(-1)!.reject(new TypeError('Network connection lost'));
    await flush();
    expect(rows()).toEqual([expect.stringContaining('First')]);
    expect(more().textContent).toContain('Retry');
    expect(more().getAttribute('href')).toBe(href);
    expect(invalidations).toBe(0);
    await click();
    expect(held[1]!.request).toEqual(held[0]!.request);
    const second = page(['Second', 'Second', 'Third'], 'next');
    await accept(second);
    expect(rows()).toEqual([expect.stringContaining('Second'), expect.stringContaining('Third')]);
    expect(status()).toContain(': 2. You can load more.');
    expect(
      client
        .getQueryCache()
        .getAll()
        .filter((query) => query.queryKey[0] === 'subject-relation-group'),
    ).toHaveLength(0);
    await click();
    await accept(page([], 'empty-next'));
    expect(rows()).toHaveLength(0);
    expect(status()).toContain(': 0. You can load more.');
    await click();
    await accept(page(['Second'], 'next'));
    expect(rows()).toEqual([expect.stringContaining('Second')]);
    expect(more()).toBeNull();
    expect(status()).toContain(': 1. Start again');
    expect(window.document.activeElement).toBe(host.querySelector('[data-slot="relation-stream-end"]'));
    expect(new URL(restart().href).searchParams.has('cursor')).toBe(false);
    expect(new URL(restart().href).searchParams.get('realm')).toBe(realm);

    // A fresh authoritative page starts an independent traversal; a closed successful page cannot revive.
    await replace(page(['Fresh'], 'fresh'));
    await click();
    await accept({ ok: false, status: 409 });
    expect(rows()).toHaveLength(0);
    expect(more()).toBeNull();
    expect(restart()).not.toBeNull();
    expect(invalidations).toBe(1);
    await replace(second);
    expect(rows()).toHaveLength(0);
    expect(more()).toBeNull();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('unavailable');

    await replace(page(['Bound 1'], 'bound-1'));
    const before = held.length;
    for (let count = 2; count <= 64; count++) {
      await click();
      await accept(page([`Bound ${count}`], `bound-${count}`));
      expect(rows()).toEqual([expect.stringContaining(`Bound ${count}`)]);
    }
    expect(held.length - before).toBe(63);
    expect(more()).toBeNull();
    expect(restart()).not.toBeNull();
    expect(host.querySelector('[data-slot="relation-stream-end"]')?.textContent).toContain('reading limit');
    expect(invalidations).toBe(1);

    await replace(page(['Authority'], 'authority'));
    await click();
    held.at(-1)!.reject(Object.assign(new Error('dependency_unavailable'), { status: 503 }));
    await flush();
    expect(rows()).toHaveLength(0);
    expect(more()).toBeNull();
    expect(invalidations).toBe(2);
    await replace(page(['Terminal'], 'terminal'));
    await click();
    await accept(page(['Terminal'], null));
    expect(status()).toContain(': 1. End of this list.');
    expect(restart()).toBeNull();

    // A reused node cannot replace the visible stream under its old heading.
    for (const change of [
      { kind: 'relations' as const },
      { property: 'schema:illustrator' },
      { id: realm },
      { filter: realm },
      { type: 'schema:Person' },
    ]) {
      await replace(page(['Original'], 'original'));
      await click();
      const next = page(['Changed'], 'changed');
      if (!next.ok) throw new Error('Expected successful fixture');
      const before = held.length;
      const previousInvalidations = invalidations;
      await accept({ ...next, read: { ...next.read, ...change } as typeof next.read });
      expect(host.querySelector('h2')?.textContent).toBe('Credits');
      expect(rows()).toHaveLength(0);
      expect(host.querySelector('[role="alert"]')?.textContent).toContain('changed');
      expect(more()).toBeNull();
      expect(new URL(restart().href).searchParams.has('cursor')).toBe(false);
      expect(invalidations).toBe(previousInvalidations + 1);
      expect(held).toHaveLength(before);
    }

    await replace(page(['Old'], 'old'));
    await click();
    const stale = held.at(-1)!;
    await replace(page(['Replacement'], 'replacement'));
    const previousInvalidations = invalidations;
    stale.resolve({ ok: true, read: { kind: 'relations', id: realm, property: 'schema:author', limit: 12 }, body: {} });
    await flush();
    expect(rows()).toEqual([expect.stringContaining('Replacement')]);
    expect(status()).toBe('');
    expect(invalidations).toBe(previousInvalidations);
  } finally {
    await act(async () => root.unmount());
    client.clear();
    mock.restore();
    for (const [key, descriptor] of previous)
      descriptor ? Object.defineProperty(globalThis, key, descriptor) : Reflect.deleteProperty(globalThis, key);
    await window.happyDOM.close();
  }
});
