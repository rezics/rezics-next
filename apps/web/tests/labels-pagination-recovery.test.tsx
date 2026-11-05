import { expect, mock, test } from 'bun:test';
import { QueryClient } from '@tanstack/react-query';
import { dirname } from 'node:path';
import { act } from 'react';
import { renderToString } from 'react-dom/server';
import type { LabelInput, LabelResult, LabelsPage } from '../src/library/labels-read';
import {
  LABELS_WINDOW_MAX_PREDECESSORS,
  LABELS_WINDOW_QUERY_KEY,
  acceptLabelsWindow,
  labelsWindowHasPrevious,
  labelsWindowOwner,
  labelsWindowPrevious,
  labelsWindowVisit,
  stageLabelsWindow,
} from '../src/library/labels-window-navigation';
import { m } from '../src/paraglide/messages.js';

// Focused presentation and deferred-result cases; native/browser acceptance belongs to integration.
const writes: { data: LabelInput; headers: HeadersInit }[] = [];
let send: (input: LabelInput) => Promise<LabelResult> = async () => {
  throw new Error('Unexpected Labels write');
};
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

test('Accepted cursor windows support Previous and First, preserve failed targets, bound history, and start fresh by raw prefix', () => {
  const client = new QueryClient();
  const source = {};
  const owner = labelsWindowOwner(client, { locale: 'fr', query, source, viewer: 3, listEpoch: 5 });
  const visitId = 'three-windows';
  const move = (current: string | null, target: string | null, direction: 'next' | 'previous' | 'first') => {
    expect(
      stageLabelsWindow(client, {
        visitId,
        owner,
        current,
        target,
        direction,
        restoreHeadingFocus: false,
      }),
    ).toBe(true);
  };
  const accept = (current: string | null, loaded = true) =>
    acceptLabelsWindow(client, { visitId, owner, current, loaded });

  move(null, 'cursor-one', 'next');
  expect(accept('cursor-one').committed).toBe(true);
  move('cursor-one', 'cursor-two', 'next');
  expect(accept('cursor-two').committed).toBe(true);
  move('cursor-two', 'cursor-three', 'next');
  expect(accept('cursor-three').committed).toBe(true);
  let visit = labelsWindowVisit(client, visitId, owner)!;
  expect(visit.path).toEqual([null, 'cursor-one', 'cursor-two', 'cursor-three']);
  expect(labelsWindowHasPrevious(visit, 'cursor-three')).toBe(true);

  move('cursor-three', 'cursor-two', 'previous');
  expect(accept('cursor-two', false).committed).toBe(false);
  visit = labelsWindowVisit(client, visitId, owner)!;
  expect(visit.path).toEqual([null, 'cursor-one', 'cursor-two', 'cursor-three']);
  expect(visit.staged?.target).toBe('cursor-two');
  expect(accept('cursor-two').committed).toBe(true); // Retry accepts the same staged target.
  expect(labelsWindowVisit(client, visitId, owner)?.path).toEqual([null, 'cursor-one', 'cursor-two']);
  move('cursor-two', null, 'first');
  expect(accept(null).committed).toBe(true);
  expect(labelsWindowVisit(client, visitId, owner)?.path).toEqual([null]);
  expect(labelsWindowPrevious(labelsWindowVisit(client, visitId, owner), null)).toBeUndefined();

  const otherPrefix = labelsWindowOwner(client, {
    locale: 'fr',
    query: `${query} `,
    source,
    viewer: 3,
    listEpoch: 5,
  });
  expect(labelsWindowVisit(client, visitId, otherPrefix)).toBeUndefined();
  expect(
    stageLabelsWindow(client, {
      visitId: 'direct-later-entry',
      owner: otherPrefix,
      current: 'supplied-cursor',
      target: 'supplied-next',
      direction: 'next',
      restoreHeadingFocus: false,
    }),
  ).toBe(true);
  const fresh = labelsWindowVisit(client, 'direct-later-entry', otherPrefix)!;
  expect(fresh.path).toEqual(['supplied-cursor']);
  expect(labelsWindowHasPrevious(fresh, 'supplied-cursor')).toBe(false);
  expect(
    acceptLabelsWindow(client, {
      visitId: 'direct-later-entry',
      owner: otherPrefix,
      current: 'supplied-next',
      loaded: true,
    }).committed,
  ).toBe(true);
  expect(labelsWindowHasPrevious(labelsWindowVisit(client, 'direct-later-entry', otherPrefix), 'supplied-next')).toBe(
    true,
  );

  const boundedId = 'bounded-history';
  let current: string | null = null;
  for (let index = 1; index <= LABELS_WINDOW_MAX_PREDECESSORS + 2; index++) {
    const target = `cursor-${index}`;
    expect(
      stageLabelsWindow(client, {
        visitId: boundedId,
        owner,
        current,
        target,
        direction: 'next',
        restoreHeadingFocus: false,
      }),
    ).toBe(true);
    expect(acceptLabelsWindow(client, { visitId: boundedId, owner, current: target, loaded: true }).committed).toBe(
      true,
    );
    current = target;
  }
  expect(client.getQueryData<{ path: unknown[] }>(LABELS_WINDOW_QUERY_KEY)?.path).toHaveLength(
    LABELS_WINDOW_MAX_PREDECESSORS + 1,
  );
  client.clear();
});

test('A dirty later-cursor Previous waits for Leave; Stay preserves the exact raw create draft and focus', async () => {
  await withDocument(async (window) => {
    const { createRoot } = await import('react-dom/client');
    const { LabelsPageView } = await import('../src/library/labels-page');
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    const moves: unknown[][] = [];
    const previous = () =>
      [...host.querySelectorAll('button')].find((button) => button.textContent === m.library_labels_previous())!;
    const dialogButton = (name: string) =>
      [...document.querySelectorAll('[role="alertdialog"] button')].find((button) => button.textContent === name)!;
    const draftValue = '  unsent e\u0301 + %_  ';
    try {
      await act(async () =>
        root.render(
          <LabelsPageView
            page={emptyPage({ query })}
            cursor={cursor}
            canPrevious
            locale="fr"
            onWindowMove={(...args) => moves.push(args)}
          />,
        ),
      );
      const input = host.querySelector('#new-label') as HTMLInputElement;
      await act(async () => {
        Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(input, draftValue);
        input.dispatchEvent(new window.Event('input', { bubbles: true }));
      });
      await act(async () => previous().click());
      expect(document.querySelector('[role="alertdialog"]')).not.toBeNull();
      expect(moves).toEqual([]);
      await act(async () => dialogButton(m.library_label_draft_navigation_stay()).click());
      expect((host.querySelector('#new-label') as HTMLInputElement).value).toBe(draftValue);
      expect(document.activeElement).toBe(host.querySelector('#new-label'));
      expect(moves).toEqual([]);

      await act(async () => previous().click());
      await act(async () => dialogButton(m.library_label_draft_navigation_discard()).click());
      expect(moves).toEqual([['previous', false]]);
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });
});

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
      if (scenario.state === 'unavailable')
        expect(host.querySelector('form, ul, [data-library-label-link]')).toBeNull();
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
            sendLabel={(input) => {
              writes.push({
                data: structuredClone(input.data),
                headers: { 'X-CSRF-Token': new Headers(input.headers).get('X-CSRF-Token')! },
              });
              return send(input.data);
            }}
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
      const name = form().querySelector('input[name="name"]') as HTMLInputElement;
      await act(async () => {
        Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(name, 'Original draft');
        name.dispatchEvent(new window.Event('input', { bubbles: true }));
      });
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
      expect(host.querySelector('#new-label')).toBeNull();
      expect(host.textContent).not.toContain('Original draft');
      const click = new window.MouseEvent('click', { bubbles: true, cancelable: true });
      link(host, m.library_collections_first_page()).dispatchEvent(click);
      expect(click.defaultPrevented).toBe(true);
      expect(writes).toHaveLength(before + 2);
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });
});
