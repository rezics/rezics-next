import { expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, createElement as h, useState } from 'react';
import type { OverviewValue, Section } from '../src/features/pages/overview';
import type { RelationGroupRequest } from '../src/features/pages/relation-stream-query';
import type { RelationHistorySelection } from '../src/features/pages/subject-history';

test('relation readers and history keep exact selection across continuation keyboard retry and return', async () => {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://rezics.test/en/subjects/work/relations', width: 390 });
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    HTMLButtonElement: window.HTMLButtonElement,
    Element: window.Element,
    Node: window.Node,
    getComputedStyle: window.getComputedStyle.bind(window),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
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
    { RelationHistorySelectionView },
    { defaultReader },
    { sessionQuery },
    { setLocale },
    { m },
  ] = await Promise.all([
    import('react-dom/client'),
    import('@tanstack/react-query'),
    import('@tanstack/react-router'),
    import('../src/features/pages/relation-stream'),
    import('../src/features/pages/subject-history-view'),
    import('../src/subject/reader'),
    import('../src/session/query'),
    import('../src/paraglide/runtime.js'),
    import('../src/paraglide/messages.js'),
  ]);
  const testingLibrary = dirname(Bun.resolveSync('storybook/test', import.meta.dir));
  const { default: userEvent } = await import(Bun.resolveSync('@testing-library/user-event', testingLibrary));
  setLocale('zh-Hans', { reload: false });
  const subject = '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e01';
  const selection: RelationHistorySelection = {
    subject,
    label: '旅程的作品',
    locale: 'zh-Hans',
    view: 'relations',
    node: 'appearances',
    property: 'ex:appearance',
    direction: 'forward',
    cursor: 'page-two',
  };
  const value = {
    subject,
    subjectLabel: '旅程的作品',
    locale: 'zh-Hans',
    pageTarget: { subject },
    cacheReader: null,
    reader: defaultReader,
    link: ({ href, children, ...props }: { href: string; children?: unknown }) =>
      h('a', { ...props, href }, children as never),
    labels: { spoilerShow: '显示', cover: { withheld: '', reveal: '', credit: '', via: '' } },
    relations: {},
    sections: new Map(),
  } as unknown as OverviewValue;
  const page = (labels: string[], next: string | null): Section => ({
    ok: true,
    read: { kind: 'relations', id: subject, property: 'ex:appearance', limit: 5 },
    body: {
      relations: labels.map((label, index) => ({
        target: `0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e1${index}`,
        statement: {
          id: `statement-${index}`,
          property: { id: 'ex:appearance', data_type: 'wikibase-item' },
          value: { type: 'value', content: `0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e1${index}` },
          qualifiers:
            index === 0
              ? [
                  {
                    property: { id: 'rezics:spoilerLevel', data_type: 'quantity' },
                    value: { type: 'value', content: { amount: '+2', unit: '1' } },
                  },
                ]
              : [],
          references: [
            {
              parts: [
                { property: { id: 'schema:url' }, value: { type: 'value', content: 'https://example.test/original' } },
              ],
            },
          ],
          rank: 'normal',
        },
        summary: {
          id: `0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e1${index}`,
          type: 'ex:Person',
          label: { value: label, language: 'ja' },
        },
        label,
      })),
      next,
    },
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(sessionQuery.queryKey, { state: 'signed-out', subject: null });
  const route = routing.createRootRoute({
    component: () => {
      const [reading, setReading] = useState(() => page(['人物0', '人物1', '人物2', '人物3', '人物4'], 'page-two'));
      const [history, setHistory] = useState({
        revisions: [
          { revision: 1, kind: 'create' },
          { revision: 2, kind: 'propose' },
          { revision: 3, kind: 'accept' },
          { revision: 4, kind: 'adopt' },
        ],
        next: 'history-two',
      });
      return h(
        'div',
        { className: 'space-y-8' },
        h(RelationStream, {
          value,
          section: reading,
          node: 'appearances',
          view: 'relations',
          title: '関係',
        }),
        h(RelationHistorySelectionView, {
          selection: { ...selection, cursor: reading.ok ? (reading.body.next as string | null) : selection.cursor },
          returned: reading.ok ? (reading.body.relations as unknown[]).length : 0,
          revisions: history.revisions,
          next: history.next,
          locale: 'zh-Hans',
          onRetry: (href: string, event: { preventDefault(): void }) => {
            event.preventDefault();
            setReading(page(['人物5', '人物6', '人物7', '人物8', '人物9'], null));
            void href;
          },
          onMoreHistory: (cursor: string) => {
            expect(cursor).toBe('history-two');
            setHistory({
              revisions: [
                { revision: 5, kind: 'propose' },
                { revision: 6, kind: 'adopt' },
              ],
              next: null,
            });
          },
        }),
      );
    },
  });
  const router = routing.createRouter({
    routeTree: route,
    history: routing.createMemoryHistory({ initialEntries: ['/zh-Hans/subjects/work/relations'] }),
  });
  await router.load();
  const host = window.document.createElement('main');
  window.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  const user = userEvent.setup({ document: window.document });
  const render = () =>
    act(async () => root.render(h(QueryClientProvider, { client }, h(routing.RouterProvider, { router }))));
  const flush = () =>
    act(async () => {
      await Bun.sleep(0);
    });
  try {
    await render();
    expect(host.querySelector('[data-slot="subject-history-count"]')?.textContent?.trim()).toBe('');
    expect(host.querySelector('[data-slot="subject-history-stream"]')?.textContent).toContain('appearances');
    expect(host.querySelector('[data-slot="subject-history-stream"]')?.textContent).toContain('forward');
    expect(host.querySelector('[data-slot="subject-history-changes"]')?.getAttribute('href')).toContain('via=');
    const more = host.querySelector<HTMLAnchorElement>('[data-slot="continue-group"]')!;
    more.focus();
    expect(window.document.activeElement).toBe(more);
    await act(async () => user.keyboard('{Enter}'));
    await flush();
    expect(held[0]!.request).toMatchObject({
      subject,
      locale: 'zh-Hans',
      view: 'relations',
      node: 'appearances',
      cursor: 'page-two',
    });
    held[0]!.resolve(page(['人物5', '人物6', '人物7', '人物8', '人物9'], null));
    await flush();
    expect([...host.querySelectorAll('article')].some((row) => row.textContent?.includes('人物5'))).toBe(true);
    expect(host.querySelector('[data-slot="continue-group"]')).toBeNull();
    const historyMore = host.querySelector<HTMLButtonElement>('[data-slot="subject-history-more"]')!;
    historyMore.focus();
    await act(async () => user.keyboard('{Enter}'));
    await flush();
    expect(host.querySelector('[data-slot="subject-history-revisions"]')?.textContent).toContain('5');
    expect(host.querySelector('[data-slot="subject-history-more"]')).toBeNull();
    const retry = host.querySelector<HTMLAnchorElement>('[data-slot="subject-history-retry"]')!;
    expect(new URL(retry.href).searchParams.get('node')).toBe('appearances');
    expect(new URL(retry.href).searchParams.get('streamDirection')).toBe('forward');
    window.resizeTo(1280, 800);
    expect(window.innerWidth).toBe(1280);
    expect(retry.className).toContain('min-h-11');
    expect(m.changes_title({}, { locale: 'zh-Hans' as never })).toBeTruthy();
  } finally {
    await act(async () => root.unmount());
    client.clear();
    mock.restore();
    for (const [key, descriptor] of previous)
      descriptor ? Object.defineProperty(globalThis, key, descriptor) : Reflect.deleteProperty(globalThis, key);
    await window.happyDOM.close();
  }
});
