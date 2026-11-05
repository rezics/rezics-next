import { afterAll, expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act } from 'react';
import { renderToString } from 'react-dom/server';
import type { LabelInput, LabelResult, LabelsPage } from '../src/library/labels-read';
import { m } from '../src/paraglide/messages.js';

// UNRUN: focused presentation and deferred-result cases; native/browser acceptance belongs to integration.
const writes: { data: LabelInput; headers: HeadersInit }[] = [];
let send: (input: LabelInput) => Promise<LabelResult> = async () => {
  throw new Error('Unexpected Labels write');
};
const read = mock(() => {
  throw new Error('Recovery links must not fetch during rendering');
});
mock.module('../src/library/labels-actions', () => ({
  manageLabel: (input: { data: LabelInput; headers: HeadersInit }) => {
    writes.push(structuredClone(input));
    return send(input.data);
  },
}));
mock.module('../src/library/labels-read-route', () => ({ readLabelsPage: read }));
afterAll(() => mock.restore());

const query = '  読書 %_ + & ?  ';
const cursor = 'exact+/cursor==';
const path = '/fr/library/labels';
const firstPage = `${path}?${new URLSearchParams({ q: query })}`;
const laterPage = `${path}?${new URLSearchParams({ q: query, cursor })}`;
const emptyPage = (extra: Partial<LabelsPage> = {}): LabelsPage => ({
  signedIn: true,
  state: 'loaded',
  operations: ['library_label.list', 'library_label.create', 'library_label.rename', 'library_label.delete'],
  csrfToken: 'current-csrf',
  createKey: '00000000-0000-4000-8000-000000000001',
  undoKey: '00000000-0000-4000-8000-000000000002',
  labels: [],
  next: null,
  ...extra,
});

async function withDocument(run: (window: any) => Promise<void>) {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: `https://site.test${laterPage}` });
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    HTMLInputElement: window.HTMLInputElement,
    HTMLButtonElement: window.HTMLButtonElement,
    Element: window.Element,
    Node: window.Node,
    Document: window.Document,
    DocumentFragment: window.DocumentFragment,
    MutationObserver: window.MutationObserver,
    ResizeObserver: window.ResizeObserver,
    FormData: window.FormData,
    getComputedStyle: window.getComputedStyle.bind(window),
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  try {
    await run(window);
  } finally {
    await window.happyDOM.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
}

function link(host: Element, name: string) {
  const links = [...host.querySelectorAll('a')].filter((item) => item.textContent === name);
  expect(links).toHaveLength(1);
  return links[0]!;
}

test('First-page emptiness, prefix no-results and bounded later-page emptiness remain distinct before and after hydration', async () => {
  await withDocument(async () => {
    const { LabelsPageView } = await import('../src/library/labels-page');
    const { hydrateRoot } = await import('react-dom/client');
    const scenarios: {
      state: 'loaded' | 'unavailable';
      reason: string;
      message: string;
      labels?: LabelsPage['labels'];
      next?: string;
    }[] = [
      { page: emptyPage(), cursor: undefined, message: m.library_labels_empty() },
      { page: emptyPage({ query }), cursor: undefined, message: m.library_subject_label_no_results() },
      { page: emptyPage(), cursor, message: m.library_labels_page_empty() },
      { page: emptyPage({ query }), cursor, message: m.library_labels_page_empty() },
      { page: emptyPage({ query: '' }), cursor, message: m.library_labels_page_empty() },
      { page: emptyPage({ query, next: 'next+/page==' }), cursor, message: m.library_labels_page_empty() },
    ];
    for (const scenario of scenarios) {
      const host = document.createElement('div');
      document.body.append(host);
      const tree = <LabelsPageView page={scenario.page} cursor={scenario.cursor} locale="fr" />;
      host.innerHTML = renderToString(tree);
      const errors: unknown[] = [];
      const outcome = () => {
        expect(host.textContent).toContain(scenario.message);
        expect(host.querySelector('ul')).toBeNull();
        if (scenario.cursor !== undefined) {
          expect(host.textContent).not.toContain(m.library_labels_empty());
          expect(host.textContent).not.toContain(m.library_subject_label_no_results());
          const target = new URL(link(host, m.library_collections_first_page()).href);
          expect(target.pathname).toBe(path);
          expect(target.searchParams.has('cursor')).toBe(false);
          expect(target.searchParams.get('q')).toBe(scenario.page.query ?? null);
        } else expect(host.querySelector('nav')).toBeNull();
        const form = host.querySelector('form[method="post"]')!;
        const address = new URL(form.getAttribute('action')!, 'https://site.test');
        expect(address.searchParams.get('q')).toBe(scenario.page.query ?? null);
        expect(address.searchParams.get('cursor')).toBe(scenario.cursor ?? null);
        if (scenario.page.next) {
          const next = new URL(link(host, m.library_label_more()).href);
          expect(next.searchParams.get('q')).toBe(query);
          expect(next.searchParams.get('cursor')).toBe(scenario.page.next);
        } else expect(host.textContent).not.toContain(m.library_label_more());
      };
      outcome();
      let root: ReturnType<typeof hydrateRoot> | undefined;
      try {
        await act(async () => {
          root = hydrateRoot(host, tree, { onRecoverableError: (error) => errors.push(error) });
        });
        outcome();
        expect(errors).toEqual([]);
      } finally {
        if (root) await act(async () => root!.unmount());
        host.remove();
      }
    }
    expect(read).not.toHaveBeenCalled();
    expect(writes).toHaveLength(0);
  });
});

test('Native cursor recovery names the first-page restart and preserves the exact applied query and locale', async () => {
  await withDocument(async () => {
    const { LabelsPageView } = await import('../src/library/labels-page');
    for (const scenario of [
      { state: 'loaded' as const, reason: 'stale_cursor', message: m.library_labels_stale_cursor() },
      { state: 'unavailable' as const, reason: 'stale_cursor', message: m.library_labels_stale_cursor() },
      {
        state: 'unavailable' as const,
        reason: 'invalid_cursor',
        message: m.library_labels_invalid_cursor(),
        labels: [{ id: 'rejected-row', name: 'Rejected row', revision: 8, renameKey: 'r', deleteKey: 'd' }],
        next: 'rejected-next',
      },
    ]) {
      const host = document.createElement('div');
      host.innerHTML = renderToString(
        <LabelsPageView
          page={emptyPage({
            state: scenario.state,
            query,
            feedback: { ok: false, reason: scenario.reason },
            ...(scenario.labels ? { labels: scenario.labels } : {}),
            ...(scenario.next ? { next: scenario.next } : {}),
          })}
          cursor={cursor}
          locale="fr"
        />,
      );
      expect(host.querySelectorAll('[role="alert"]')).toHaveLength(1);
      expect(host.querySelector('[role="alert"]')!.textContent).toBe(scenario.message);
      expect(link(host, m.library_collections_first_page()).getAttribute('href')).toBe(firstPage);
      expect(host.textContent).not.toContain(m.library_labels_empty());
      expect(host.textContent).not.toContain(m.library_subject_label_no_results());
      expect(host.textContent).not.toContain(m.library_labels_page_empty());
      expect(host.textContent).not.toContain(m.subject_view_retry());
      expect(host.textContent).not.toContain(m.library_label_more());
      expect(host.textContent).not.toContain('Rejected row');
      if (scenario.state === 'unavailable') expect(host.querySelector('form, ul, [data-library-label-link]')).toBeNull();
      expect([...host.querySelectorAll('a')].some((item) => item.textContent === m.library_labels_heading())).toBe(
        false,
      );
    }
  });
});

test('An unavailable read is one honest error with a same-address retry and no private rows or empty claim', async () => {
  await withDocument(async (window) => {
    const { LabelsPageView } = await import('../src/library/labels-page');
    const { hydrateRoot } = await import('react-dom/client');
    const host = document.createElement('div');
    document.body.append(host);
    let current = true;
    const tree = (
      <LabelsPageView
        page={emptyPage({
          state: 'unavailable',
          query,
          feedback: { ok: false, reason: 'dependency_unavailable' },
          labels: [{ id: 'old-private', name: 'Old private label', revision: 7, renameKey: 'r', deleteKey: 'd' }],
        })}
        cursor={cursor}
        locale="fr"
        isCurrent={() => current}
      />
    );
    host.innerHTML = renderToString(tree);
    expect(host.querySelectorAll('[role="alert"]')).toHaveLength(1);
    expect(host.querySelector('[role="alert"]')!.textContent).toBe(m.library_labels_unavailable());
    expect(link(host, m.subject_view_retry()).getAttribute('href')).toBe(laterPage);
    expect(
      [...host.querySelectorAll('a')].some((item) => item.textContent === m.library_collections_first_page()),
    ).toBe(false);
    expect(host.querySelector('form, ul, [data-library-label-link]')).toBeNull();
    for (const text of [
      m.library_labels_empty(),
      m.library_subject_label_no_results(),
      m.library_labels_page_empty(),
      'Old private label',
    ])
      expect(host.textContent).not.toContain(text);
    const errors: unknown[] = [];
    let root: ReturnType<typeof hydrateRoot> | undefined;
    try {
      await act(async () => {
        root = hydrateRoot(host, tree, { onRecoverableError: (error) => errors.push(error) });
      });
      expect(errors).toEqual([]);
      current = false;
      const click = new window.MouseEvent('click', { bubbles: true, cancelable: true });
      link(host, m.subject_view_retry()).dispatchEvent(click);
      expect(click.defaultPrevented).toBe(true);
      expect(read).not.toHaveBeenCalled();
    } finally {
      if (root) await act(async () => root!.unmount());
      host.remove();
    }
  });
});

test('Recovery presentation retains the original uncertain create through refresh and rejects its retired late completion', async () => {
  await withDocument(async (window) => {
    const { LabelsPageView } = await import('../src/library/labels-page');
    const { createRoot } = await import('react-dom/client');
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    let current = true;
    let page = emptyPage({ query });
    const refresh = mock(async () => emptyPage());
    const originating = {
      isCurrent: () => current,
      headers: () => (current ? { 'X-CSRF-Token': 'origin-csrf' } : null),
    };
    const show = () =>
      act(async () =>
        root.render(
          <LabelsPageView
            page={page}
            cursor={cursor}
            locale="fr"
            isCurrent={() => current}
            originating={originating}
            refresh={refresh}
          />,
        ),
      );
    const form = () => host.querySelector('input[name="operation"][value="create"]')!.closest('form')!;
    const submit = () =>
      act(async () => form().dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })));
    const before = writes.length;
    try {
      await show();
      (form().querySelector('input[name="name"]') as HTMLInputElement).value = 'Original draft';
      send = async () => {
        throw new Error('Reply lost');
      };
      await submit();
      expect(host.querySelector('[role="alert"]')!.textContent).toBe(m.library_label_unconfirmed());
      const original = writes[before]!;
      expect(original).toEqual({
        data: { operation: 'create', idempotencyKey: page.createKey, name: 'Original draft' },
        headers: { 'X-CSRF-Token': 'origin-csrf' },
      });
      page = emptyPage({ query, createKey: crypto.randomUUID() });
      await show();
      expect((form().querySelector('input[name="name"]') as HTMLInputElement).value).toBe('Original draft');
      expect(link(host, m.library_collections_first_page()).getAttribute('href')).toBe(firstPage);
      let complete!: (result: LabelResult) => void;
      send = () =>
        new Promise((resolve) => {
          complete = resolve;
        });
      await submit();
      expect(writes[before + 1]).toEqual(original);
      current = false;
      await act(async () => complete({ ok: true }));
      expect(refresh).not.toHaveBeenCalled();
      expect((form().querySelector('input[name="idempotencyKey"]') as HTMLInputElement).value).toBe(
        original.data.idempotencyKey,
      );
      const click = new window.MouseEvent('click', { bubbles: true, cancelable: true });
      link(host, m.library_collections_first_page()).dispatchEvent(click);
      expect(click.defaultPrevented).toBe(true);
      await submit();
      expect(writes).toHaveLength(before + 2);
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });
});
