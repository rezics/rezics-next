import { expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act } from 'react';
import * as start from '../.storybook/react-start';
import type { OverviewValue, Section } from '../src/features/pages/overview';
import { admitRelationPage } from '../src/features/pages/relation-page-admission';

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
const targets = [
  '0192f3a0-6c1e-7b2a-9d4e-000000000102',
  '0192f3a0-6c1e-7b2a-9d4e-000000000103',
  '0192f3a0-6c1e-7b2a-9d4e-000000000104',
] as const;
const statement = {
  id: 'assertion',
  property: { id: 'schema:author', data_type: 'wikibase-item' },
  value: { type: 'value', content: subject },
  qualifiers: [],
  references: [],
  rank: 'normal',
};
const value = {
  subject,
  locale: 'en',
  reader: defaultReader,
  link: PlainLink,
  sections: new Map(),
  labels: { spoilerShow: 'Show', cover: { withheld: '', reveal: '', credit: '', via: '' } },
} as unknown as OverviewValue;
const row = (kind: 'links' | 'relations', target: string, statementId: string, label: string) => {
  const summary = { id: target, type: 'schema:Book', label: { value: label, language: 'en' } };
  return kind === 'links'
    ? { subject: target, statement: statementId, assertion: { ...statement, id: statementId }, summary, label }
    : { target, statement: { ...statement, id: statementId }, summary, label };
};
const page = (
  kind: 'links' | 'relations',
  rows: unknown[],
  next: string | null = null,
  limit = 2,
  count?: { value: number; exact: boolean },
): Section => ({
  ok: true,
  read: { kind, id: subject, property: 'schema:author', limit },
  body: { [kind]: rows, next, ...(count ? { count } : {}) },
});

test('sparse native pages keep their counts; over-limit raw pages are refused before projection', () => {
  for (const kind of ['links', 'relations'] as const) {
    const alice = row(kind, targets[0], 'alice', 'Alice');
    const bob = row(kind, targets[1], 'bob', 'Bob');
    const carol = row(kind, targets[2], 'carol', 'Carol');
    const empty = page(kind, [], 'empty-next', 2, { value: 5, exact: false });
    expect(admitRelationPage(empty)).toEqual({ ok: true });
    expect(relationStreamItems(empty, value)?.count).toEqual({ value: 5, relation: 'lower_bound' });
    expect(admitRelationPage(page(kind, [alice, bob]))).toEqual({ ok: true });
    expect(admitRelationPage(page(kind, [alice, alice, carol], 'too-many'))).toEqual({
      ok: false,
      reason: 'over-limit',
    });
  }
});

test('an over-limit continuation keeps the last admitted window without advancing the cursor', async () => {
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
      const [section, setSection] = useState(() => page('links', [row('links', targets[0], 'alice', 'Alice')], 'next'));
      replace = setSection;
      return <RelationStream value={value} section={section} node="credits" view="relations" title="Credits" />;
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
  const labels = () => [...host.querySelectorAll('article')].map((node) => node.textContent);
  const failed = () => {
    expect(host.querySelector('[role="alert"]')?.textContent).toBe(m.subject_section_failed({}, { locale: 'en' }));
    expect(host.querySelector('article')).toBeNull();
    expect(host.textContent).not.toContain(m.subject_relation_empty_page({}, { locale: 'en' }));
    expect(host.querySelector('[data-slot="continue-group"]')).toBeNull();
  };
  const click = async () => {
    await act(async () => {
      host
        .querySelector('[data-slot="continue-group"]')!
        .dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
      await Bun.sleep(0);
    });
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
    for (const kind of ['links', 'relations'] as const) {
      const alice = row(kind, targets[0], 'alice', 'Alice');
      const bob = row(kind, targets[1], 'bob', 'Bob');
      const carol = row(kind, targets[2], 'carol', 'Carol');
      await act(async () => replace(page(kind, [alice, alice, carol], 'next')));
      failed();
      expect(host.textContent).not.toContain('Carol');
      await act(async () => replace(page(kind, [alice], 'next')));
      expect(labels()).toEqual([expect.stringContaining('Alice')]);
      returned = page(kind, [alice, bob], 'again');
      await click();
      expect(labels()).toEqual([expect.stringContaining('Alice'), expect.stringContaining('Bob')]);
      expect(host.querySelector('[aria-live]')?.textContent).toContain(': 2. You can load more.');
      const href = host.querySelector('[data-slot="continue-group"]')!.getAttribute('href')!;
      expect(new URL(href, window.location.href).searchParams.get('cursor')).toBe('again');
      returned = page(kind, [alice, alice, carol], 'too-many');
      await click();
      expect(labels()).toEqual([expect.stringContaining('Alice'), expect.stringContaining('Bob')]);
      expect(host.textContent).not.toContain('Carol');
      expect(host.querySelector('[role="alert"]')?.textContent).toBe(m.subject_section_failed({}, { locale: 'en' }));
      expect(host.querySelector('[aria-live]')?.textContent).toBe('');
      expect(host.querySelector('[data-slot="continue-group"]')?.textContent).toContain('Retry');
      expect(host.querySelector('[data-slot="continue-group"]')?.getAttribute('href')).toBe(href);
      expect(invalidations).toBe(0);
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
