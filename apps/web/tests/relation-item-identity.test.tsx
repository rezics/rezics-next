import { expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act } from 'react';
import * as start from '../.storybook/react-start';
import type { OverviewValue, Section } from '../src/features/pages/overview';

mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);
const { relationGroupKey } = await import('../src/features/pages/relation-stream-query');
let returned: Section;
mock.module('../src/features/pages/relation-stream-query', () => ({
  relationGroupKey,
  loadRelationGroup: async () => returned,
}));
const [{ relationStreamItems, RelationStream }, { defaultReader }, { PlainLink }, { m }] = await Promise.all([
  import('../src/features/pages/relation-stream'),
  import('../src/subject/reader'),
  import('../src/features/pages/shared'),
  import('../src/paraglide/messages.js'),
]);
const subject = '0192f3a0-6c1e-7b2a-9d4e-000000000101';
const target = '0192f3a0-6c1e-7b2a-9d4e-000000000102';
const foreign = '0192f3a0-6c1e-7b2a-9d4e-000000000103';
const summary = { id: target, type: 'schema:Book', label: { value: 'Native target', language: 'en' } };
const statement = {
  id: 'assertion',
  property: { id: 'schema:author', data_type: 'wikibase-item' },
  value: { type: 'value', content: subject },
  qualifiers: [],
  references: [],
  rank: 'normal',
};
const holder = { subject: target, statement: statement.id, assertion: statement, summary, label: 'Native target' };
const relation = { target, statement, summary, label: 'Native target' };
const value = {
  subject,
  locale: 'en',
  reader: defaultReader,
  link: PlainLink,
  sections: new Map(),
  labels: { spoilerShow: 'Show', cover: { withheld: '', reveal: '', credit: '', via: '' } },
} as unknown as OverviewValue;
const page = (kind: 'links' | 'relations', rows: unknown[], next: string | null = null): Section => ({
  ok: true,
  read: { kind, id: subject, property: 'schema:author', limit: 12 },
  body: { [kind]: rows, next },
});

test('native summaries bind to the row target; absence keeps its existing meaning', () => {
  for (const [kind, row] of [
    ['links', holder],
    ['relations', relation],
  ] as const) {
    expect(relationStreamItems(page(kind, [row]), value)?.items[0]).toMatchObject({
      id: target,
      summary,
      statement: 'assertion',
    });
    expect(relationStreamItems(page(kind, [{ ...row, summary: undefined }]), value)?.items).toHaveLength(
      kind === 'links' ? 1 : 0,
    );
    expect(relationStreamItems(page(kind, [{ ...row, summary: null }]), value)?.items).toEqual([]);
    for (const change of [
      { summary: { ...summary, id: foreign } },
      { summary: { type: summary.type } },
      { [kind === 'links' ? 'subject' : 'target']: undefined },
    ])
      expect(relationStreamItems(page(kind, [row, { ...row, ...change }]), value, 1)).toBeUndefined();
  }
  expect(
    relationStreamItems(page('links', [{ ...holder, assertion: { ...statement, id: 'foreign' } }]), value),
  ).toBeUndefined();
  // Inverse properties and canonical targets are supplied by the row, not guessed from the statement.
  expect(relationStreamItems(page('links', [{ ...holder, property: 'schema:illustrator' }]), value)?.items[0]?.id).toBe(
    target,
  );
  expect(
    relationStreamItems(
      page('relations', [{ ...relation, target: null, summary: null, external: 'https://example.test' }]),
      value,
    )?.items,
  ).toEqual([]);
});

test('successful malformed initial and returned pages show failure without partial rows or foreign links', async () => {
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
  const [{ createRoot }, { QueryClient, QueryClientProvider }, routing] = await Promise.all([
    import('react-dom/client'),
    import('@tanstack/react-query'),
    import('@tanstack/react-router'),
  ]);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const host = window.document.createElement('div');
  window.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  let replace: (section: Section) => void = () => {};
  const { useState } = await import('react');
  const route = routing.createRootRoute({
    component: () => {
      const [section, setSection] = useState(() => page('links', [holder], 'next'));
      replace = setSection;
      return <RelationStream value={value} section={section} node="credits" view="relations" title="Credits" />;
    },
  });
  const router = routing.createRouter({
    routeTree: route,
    history: routing.createMemoryHistory({ initialEntries: ['/'] }),
  });
  router.invalidate = async () => {};
  const failed = () => {
    expect(host.querySelector('[role="alert"]')?.textContent).toBe(m.subject_section_failed({}, { locale: 'en' }));
    expect(host.querySelector('article')).toBeNull();
    expect(host.innerHTML).not.toContain(foreign);
    expect(host.textContent).not.toContain(m.subject_relation_empty_page({}, { locale: 'en' }));
    expect(host.querySelector('[data-slot="restart-group"]')).not.toBeNull();
    expect(host.querySelector('[data-slot="continue-group"]')).toBeNull();
    expect(host.querySelector('[aria-live]')?.textContent).toBe('');
  };
  try {
    await router.load();
    await act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <routing.RouterProvider router={router} />
        </QueryClientProvider>,
      ),
    );
    expect(host.querySelector(`a[href*="${target}"]`)).not.toBeNull();
    returned = page('links', [holder, { ...holder, summary: { ...summary, id: foreign } }]);
    await act(async () => {
      host
        .querySelector('[data-slot="continue-group"]')!
        .dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
      await Bun.sleep(0);
    });
    failed();
    for (const [kind, row] of [
      ['links', holder],
      ['relations', relation],
    ] as const) {
      await act(async () => replace(page(kind, [row, { ...row, summary: { ...summary, id: foreign } }], 'next')));
      failed();
    }
  } finally {
    await act(async () => root.unmount());
    client.clear();
    await window.happyDOM.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
