import { expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, createElement as h, useState } from 'react';
import { createKernelClient } from '@rezics/client';
import { planReads, platformRegistry, type CompositionDocument } from '@rezics/composition';
import type { OverviewValue, Section } from '../src/features/pages/overview';
import type { RelationGroupRequest } from '../src/features/pages/relation-stream-query';
import {
  admitRelationRetryAt,
  relationRetryAfter,
  relationRetryBlocks,
  sectionFailure,
} from '../src/features/pages/relation-retry-admission';

const subject = '0192f3a0-6c1e-7b2a-9d4e-000000000101';
const document: CompositionDocument = {
  root: { props: {} },
  content: [{ type: 'SubjectList', props: { id: 'editions', property: 'schema:exampleOfWork', limit: 12, paged: true } }],
};

test('outer and leaf Relation 429 hints become one captured Search deadline', async () => {
  const now = 1_000;
  const date = new Date(3_000).toUTCString();
  expect(admitRelationRetryAt('5', now)).toBe(6_000);
  expect(admitRelationRetryAt(date, now)).toBe(3_000);
  expect(admitRelationRetryAt('invalid', now)).toBeUndefined();
  expect(admitRelationRetryAt('0', now)).toBe(now);
  expect(relationRetryAfter({ 'Retry-After': '7' })).toBe('7');
  expect(relationRetryAfter({ 'retry-after': 'tomorrow' })).toBe('tomorrow');
  expect(relationRetryBlocks(6_000, 5_999)).toBe(true);
  expect(relationRetryBlocks(6_000, 6_000)).toBe(false);
  expect(sectionFailure(429, '5')).toEqual({ ok: false, status: 429, retryAfter: '5' });

  const { readRelationGroup } = await import('../src/features/pages/relation-stream-query');
  const continuation = { node: 'editions', cursor: 'next-cursor' };
  const request: RelationGroupRequest = {
    subject,
    locale: 'en',
    view: 'relations',
    node: continuation.node,
    cursor: continuation.cursor,
  };
  const plan = planReads(platformRegistry, document, { subject, continuation });
  const key = plan.nodes.editions!;
  const leaf = (status: number, headers?: Record<string, string>) => ({
    subject,
    profile: `sha256:${'a'.repeat(64)}`,
    template: { scope: 'type' as const, key: 'schema:Book' },
    document,
    continuation,
    reads: {
      [key]: {
        status,
        body: status === 200 ? { links: [], next: 'later' } : { code: 'rate_limited' },
        ...(headers ? { headers } : {}),
      },
    },
  });
  const client = (response: Response) =>
    createKernelClient('https://kernel.invalid', { fetch: (async () => response) as typeof fetch });

  expect(
    await readRelationGroup(
      client(Response.json({ code: 'rate_limited' }, { status: 429, headers: { 'retry-after': '5' } })),
      request,
    ),
  ).toEqual({ ok: false, status: 429, retryAfter: '5' });
  expect(
    await readRelationGroup(
      client(Response.json({ code: 'rate_limited' }, { status: 429, headers: { 'Retry-After': date } })),
      request,
    ),
  ).toEqual({ ok: false, status: 429, retryAfter: date });
  expect(await readRelationGroup(client(Response.json({ code: 'rate_limited' }, { status: 429 })), request)).toEqual({
    ok: false,
    status: 429,
  });
  expect(await readRelationGroup(client(Response.json(leaf(429, { 'retry-after': '7' }))), request)).toEqual({
    ok: false,
    status: 429,
    retryAfter: '7',
  });
  expect(await readRelationGroup(client(Response.json(leaf(429, { 'retry-after': 'tomorrow' }))), request)).toEqual({
    ok: false,
    status: 429,
    retryAfter: 'tomorrow',
  });
  expect(await readRelationGroup(client(Response.json(leaf(401))), request)).toEqual({ ok: false, status: 401 });
});

test('a rate-limited continuation keeps its window until a current owner retries after the native wait', async () => {
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
    { m },
  ] = await Promise.all([
    import('react-dom/client'),
    import('@tanstack/react-query'),
    import('@tanstack/react-router'),
    import('../src/features/pages/relation-stream'),
    import('../src/subject/reader'),
    import('../src/session/query'),
    import('../src/paraglide/runtime.js'),
    import('../src/paraglide/messages.js'),
  ]);
  setLocale('en', { reload: false });
  let now = 1_700_000_000_000;
  const clock = Date.now;
  Date.now = () => now;
  const value = {
    subject,
    subjectLabel: 'Book',
    locale: 'en',
    pageTarget: { subject },
    cacheReader: 'reader',
    reader: defaultReader,
    link: ({ href, children, ...props }: { href: string; children?: unknown }) =>
      h('a', { ...props, href }, children as never),
    labels: { spoilerShow: 'Show', cover: { withheld: '', reveal: '', credit: '', via: '' } },
    relations: {},
    sections: new Map(),
  } as unknown as OverviewValue;
  const page = (label: string, next: string): Section => ({
    ok: true,
    read: { kind: 'links', id: subject, property: 'schema:author', limit: 12 },
    body: { links: [{ subject, label, statement: label, type: 'schema:Book', property: 'schema:author' }], next },
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(sessionQuery.queryKey, { state: 'signed-in', subject: 'reader' });
  const initial = page('First', 'cursor-one');
  const route = routing.createRootRoute({
    component: () => {
      const [section] = useState(initial);
      return h(RelationStream, { value, section, node: 'credits', view: 'relations', title: 'Credits' });
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
  const more = () => host.querySelector<HTMLAnchorElement>('[data-slot="continue-group"]');
  const restart = () => host.querySelector<HTMLAnchorElement>('[data-slot="restart-group"]');
  const rows = () => [...host.querySelectorAll('article')].map((row) => row.textContent);
  const click = async () => {
    const action = more();
    action?.focus();
    await act(async () => {
      action?.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
    });
    await flush();
  };
  try {
    await render();
    const href = more()!.getAttribute('href')!;
    expect(new URL(href, window.location.href).searchParams.get('cursor')).toBe('cursor-one');
    await click();
    held.at(-1)!.resolve({ ok: false, status: 429, retryAfter: '5' });
    await flush();
    expect(rows()).toEqual([expect.stringContaining('First')]);
    expect(more()).toBeNull();
    expect(restart()).toBeNull();
    expect(host.querySelector('[role="alert"]')?.textContent).toBe(m.subject_relation_retry_after({ seconds: 5 }));
    expect(invalidations).toBe(0);
    await click();
    await render();
    expect(held).toHaveLength(1);
    expect(more()).toBeNull();
    expect(new URL(href, window.location.href).searchParams.get('cursor')).toBe('cursor-one');

    now += 5_000;
    await render();
    expect(more()?.getAttribute('href')).toBe(href);
    expect(more()?.textContent).toContain('Retry');
    expect(restart()).not.toBeNull();
    expect(host.querySelector('[role="alert"]')?.textContent).toBe(m.subject_relation_limited());
    await click();
    await click();
    expect(held).toHaveLength(2);
    expect(held[1]!.request).toEqual(held[0]!.request);
    expect(held[1]!.request.cursor).toBe('cursor-one');
    held.at(-1)!.resolve(page('Second', 'cursor-two'));
    await flush();
    expect(rows()).toEqual([expect.stringContaining('Second')]);
    expect(invalidations).toBe(0);

    await click();
    held.at(-1)!.reject(Object.assign(new Error('rate_limited'), { status: 429, retryAfter: '5' }));
    await flush();
    expect(rows()).toEqual([expect.stringContaining('Second')]);
    expect(more()).toBeNull();
    expect(restart()).toBeNull();
    expect(invalidations).toBe(0);

    now += 5_000;
    await render();
    expect(more()?.getAttribute('href') && new URL(more()!.href).searchParams.get('cursor')).toBe('cursor-two');
    await act(async () => {
      client.setQueryData(sessionQuery.queryKey, { state: 'signed-out', csrfToken: null });
    });
    await flush();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('unavailable');
    expect(more()).toBeNull();
    now += 10_000;
    await render();
    expect(held).toHaveLength(3);
    expect(invalidations).toBe(0);
  } finally {
    Date.now = clock;
    await act(async () => root.unmount());
    client.clear();
    mock.restore();
    for (const [key, descriptor] of previous)
      descriptor ? Object.defineProperty(globalThis, key, descriptor) : Reflect.deleteProperty(globalThis, key);
    await window.happyDOM.close();
  }
});
