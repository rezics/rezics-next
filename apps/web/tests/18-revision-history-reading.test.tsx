import { afterAll, expect, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, StrictMode } from 'react';
import type { ReactNode } from 'react';
import { selected, later, id } from '../src/stories/exact-revision/fixture';
import type { HistoryPage, HistoryView } from '../src/threads/post-history-lifetime';
import type { PageAuthor } from '../src/identity/read';

const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
);
const window = new Window({ url: 'https://site.test/en/threads/prepared?post=one' });
let calls = 0;
const globals = {
  window,
  document: window.document,
  navigator: window.navigator,
  location: window.location,
  HTMLElement: window.HTMLElement,
  HTMLButtonElement: window.HTMLButtonElement,
  Element: window.Element,
  Node: window.Node,
  Document: window.Document,
  DocumentFragment: window.DocumentFragment,
  MutationObserver: window.MutationObserver,
  ResizeObserver: window.ResizeObserver,
  getComputedStyle: window.getComputedStyle.bind(window),
  requestAnimationFrame: window.requestAnimationFrame.bind(window),
  cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
  matchMedia: window.matchMedia.bind(window),
  IS_REACT_ACT_ENVIRONMENT: true,
  fetch: async () => {
    calls++;
    throw new Error('Inspection must not fetch');
  },
};
const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals))
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
const { createRoot } = await import('react-dom/client');
const { RevisionHistoryNavigation } = await import('../src/threads/revision-history-navigation');
const { boundedHistoryText, projectRevisionSummaries } = await import('../src/threads/revision-history-summary');
const { m } = await import('../src/paraglide/messages.js');
const { setLocale } = await import('../src/paraglide/runtime.js');
setLocale('en', { reload: false });

const author: PageAuthor = {
  id: selected.authorId,
  state: 'active',
  kind: 'actor',
  displayName: 'Prepared author',
  handle: 'prepared-author',
  automated: false,
  operatorId: null,
};
const authors = { [author.id]: author };
const entries = (count: number): HistoryView['revisions'] =>
  Array.from({ length: count }, (_, index) => ({
    revision: { ...(index % 2 ? later : selected), revisionId: id(1_000 + index) },
    documentMedia: { kind: 'unavailable' },
  }));
function navigation(
  rows: HistoryView['revisions'],
  options: {
    key?: string;
    active?: boolean;
    isCurrent?: () => boolean;
    authors?: HistoryPage['authors'];
  } = {},
) {
  return (
    <RevisionHistoryNavigation
      key={options.key ?? 'reader-a'}
      entries={rows}
      authors={options.authors ?? authors}
      mentions={{}}
      subjects={[]}
      reviewVotes={{ [selected.id]: { ...selected.voteCitation!, units: 9, revision: 7 } }}
      viewerId={selected.authorId}
      review
      now="2026-11-01T12:00:00Z"
      active={options.active ?? true}
      hasMore
      isCurrent={options.isCurrent ?? (() => true)}
    />
  );
}
function mount() {
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  return {
    host,
    async render(node: ReactNode) {
      await act(async () => root.render(<StrictMode>{node}</StrictMode>));
    },
    async dispose() {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}
function button(host: ParentNode, label: string) {
  const result = [...host.querySelectorAll<HTMLButtonElement>('button')].find((item) => item.textContent === label);
  expect(result).toBeDefined();
  return result!;
}
async function click(control: HTMLElement) {
  await act(async () => control.click());
}
function retainedClick(control: HTMLElement) {
  const key = Object.keys(control).find((name) => name.startsWith('__reactProps$'))!;
  return (control as unknown as Record<string, { onClick: () => void }>)[key]!.onClick;
}
async function key(control: HTMLElement, value: string) {
  await act(async () =>
    control.dispatchEvent(new window.KeyboardEvent('keydown', { key: value, bubbles: true }) as unknown as Event),
  );
}
afterAll(async () => {
  await window.happyDOM.close();
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

test('1/10/100 supplied revisions project once per row without touching bodies, bound metadata and mount one full inspector', async () => {
  const view = mount();
  try {
    for (const count of [1, 10, 100]) {
      let work = 0;
      const supplied = entries(count);
      const poisoned = supplied.map(({ revision, documentMedia }) => ({
        documentMedia,
        revision: {
          ...revision,
          get licence() {
            work++;
            return '😀'.repeat(4_000);
          },
          get body(): typeof selected.body {
            throw new Error('Summary accessed a document');
          },
        },
      }));
      const projected = projectRevisionSummaries(
        poisoned,
        { [author.id]: { ...author, displayName: '🧭'.repeat(4_000) } },
        'en',
      );
      expect(work).toBe(count);
      expect(projected).toHaveLength(count);
      for (const summary of projected) {
        expect([...summary.author, ...summary.licence].length).toBeLessThanOrEqual(240);
        expect('body' in summary).toBe(false);
      }
      await view.render(navigation(supplied, { key: String(count) }));
      expect(view.host.querySelectorAll('[data-history-summary]')).toHaveLength(count);
      expect(view.host.querySelector('[data-slot="document-body"]')).toBeNull();
      const exactLinks = [...view.host.querySelectorAll('h4 a')].map((link) => link.getAttribute('href'));
      expect(exactLinks).toEqual(
        supplied.map(({ revision }) => `/en/posts/${revision.id}/revisions/${revision.revisionId}`),
      );
      await click(button(view.host, m.revision_history_inspect({ number: String(count) })));
      expect(view.host.querySelectorAll('[data-history-inspector]')).toHaveLength(1);
      expect(view.host.querySelectorAll('[data-slot="document-body"]')).toHaveLength(1);
      if (count > 1) await click(button(view.host, m.revision_history_inspect({ number: '1' })));
      expect(view.host.querySelectorAll('[data-slot="document-body"]')).toHaveLength(1);
      expect(view.host.textContent).toContain('The original edition leaves room for the reader to pause.');
      expect(view.host.textContent).toContain(m.thread_provenance_current_vote());
      await click(button(view.host, m.revision_history_collapse({ number: '1' })));
      expect(view.host.querySelector('[data-history-inspector]')).toBeNull();
      expect([...view.host.querySelectorAll('h4 a')].map((link) => link.getAttribute('href'))).toEqual(exactLinks);
    }
    expect(boundedHistoryText('abc', 0)).toBe('');
    expect(boundedHistoryText('abc', 3)).toBe('abc');
    expect(boundedHistoryText('😀😀😀😀', 3)).toBe('😀😀…');
    expect(calls).toBe(0);
  } finally {
    await view.dispose();
  }
});

test('loaded-only keyboard navigation, removed documents, continuation and close/reopen retain honest disclosure and focus', async () => {
  const view = mount();
  const rows = entries(10);
  rows[1] = { ...rows[1]!, revision: { ...rows[1]!.revision, availability: 'erased', body: null } };
  try {
    await view.render(navigation(rows));
    const first = button(view.host, m.revision_history_inspect({ number: '1' }));
    first.focus();
    await key(first, 'ArrowDown');
    const second = button(view.host, m.revision_history_inspect({ number: '2' }));
    expect(document.activeElement).toBe(second);
    expect(view.host.querySelector('[data-history-inspector]')).toBeNull();
    await click(second);
    expect(view.host.textContent).toContain(m.revision_history_erased_explanation());
    expect(view.host.querySelector('[data-slot="document-body"]')).toBeNull();
    expect(view.host.textContent).toContain(m.thread_provenance_current_vote());
    expect(view.host.querySelector('[data-history-inspector] a[target="_blank"]')?.getAttribute('href')).toContain(
      rows[1]!.revision.revisionId,
    );
    await key(second, 'End');
    const last = button(view.host, m.revision_history_inspect({ number: '10' }));
    expect(document.activeElement).toBe(last);
    await click(last);
    const body = view.host.querySelector('[data-slot="document-body"]');
    await view.render(
      navigation([
        ...rows,
        ...entries(10).map((entry, index) => ({
          ...entry,
          revision: { ...entry.revision, revisionId: id(2_000 + index) },
        })),
      ]),
    );
    expect(view.host.querySelector('[data-slot="document-body"]')).toBe(body);
    expect(document.activeElement).toBe(last);
    expect(view.host.textContent).toContain(m.revision_history_inspecting({ number: '10', count: '20' }));
    await view.render(navigation(rows, { active: false }));
    expect(view.host.querySelector('[data-history-inspector]')).toBeNull();
    await view.render(navigation(rows));
    expect(button(view.host, m.revision_history_collapse({ number: '10' })).getAttribute('aria-expanded')).toBe('true');
    const close = button(view.host, m.revision_history_close_inspector());
    close.focus();
    await click(close);
    expect(document.activeElement).toBe(button(view.host, m.revision_history_inspect({ number: '10' })));
    expect(calls).toBe(0);
  } finally {
    await view.dispose();
  }
});

test('immutable copy has a selectable safe fallback; retirement and late callbacks cannot revive an A–B–A reader', async () => {
  const view = mount();
  const rows = entries(10);
  let current = true;
  const owns = () => current;
  let rejectCopy!: (error: Error) => void;
  Object.defineProperty(window.navigator, 'clipboard', {
    configurable: true,
    value: {
      writeText: () => Promise.reject(new Error('Clipboard denied')),
    },
  });
  try {
    await view.render(navigation(rows, { isCurrent: owns }));
    const retained = retainedClick(button(view.host, m.revision_history_inspect({ number: '3' })));
    await click(button(view.host, m.revision_history_inspect({ number: '1' })));
    const oldCollapse = retainedClick(button(view.host, m.revision_history_collapse({ number: '1' })));
    await click(button(view.host, m.revision_history_inspect({ number: '2' })));
    await act(async () => oldCollapse());
    expect(button(view.host, m.revision_history_collapse({ number: '2' })).getAttribute('aria-expanded')).toBe('true');
    const open = view.host.querySelector<HTMLAnchorElement>('[data-history-inspector] a[target="_blank"]')!;
    expect(open.rel).toBe('noopener noreferrer');
    const href = open.getAttribute('href');
    await click(button(view.host, m.thread_content_more_actions()));
    await click(
      [...document.querySelectorAll<HTMLElement>('[role="menuitem"], button')].find(
        (item) => item.textContent === m.thread_content_copy_link(),
      )!,
    );
    const fallback = view.host.querySelector<HTMLInputElement>('input[readonly]')!;
    expect(fallback).not.toBeNull();
    expect(fallback.value).toBe(`https://site.test${href}`);
    expect(new URL(fallback.value).search).toBe('');
    expect(new URL(fallback.value).username).toBe('');
    expect(new URL(fallback.value).password).toBe('');
    Object.defineProperty(window.navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: () =>
          new Promise<void>((_, reject) => {
            rejectCopy = reject;
          }),
      },
    });
    await click(button(view.host, m.thread_content_more_actions()));
    await click(
      [...document.querySelectorAll<HTMLElement>('[role="menuitem"], button')].find(
        (item) => item.textContent === m.thread_content_copy_link(),
      )!,
    );
    current = false;
    await act(async () => retained());
    expect(view.host.querySelector('[data-history-selected]')?.id).toContain(rows[1]!.revision.revisionId);
    await view.render(navigation(rows, { key: 'reader-b' }));
    current = true;
    await view.render(
      navigation(rows, {
        key: 'reader-a-new',
        isCurrent: owns,
        authors: {
          [author.id]: { ...author, state: 'deleted', displayName: 'Never disclose retained deleted name' },
        },
      }),
    );
    await act(async () => {
      retained();
      rejectCopy(new Error('Late clipboard failure'));
    });
    expect(view.host.querySelector('[data-history-inspector]')).toBeNull();
    expect(view.host.querySelector('input[readonly]')).toBeNull();
    expect(view.host.textContent).not.toContain('Never disclose retained deleted name');
    expect(view.host.textContent).not.toContain(author.handle);
    expect(calls).toBe(0);
  } finally {
    await view.dispose();
  }
});
