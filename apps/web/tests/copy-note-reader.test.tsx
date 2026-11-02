import { afterAll, describe, expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act } from 'react';
import * as start from '../.storybook/react-start';
import recording from '../src/kernel/recorded/library-copies.json';
import type { CopiesOrigin } from '../src/library/copies-page';
import type { CopiesPageData, CopyItem } from '../src/library/copies-read';

// UNRUN: focused reader outcomes; native, browser and Storybook verification is deferred.
const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
);
const window = new Window({ url: 'https://site.test/en/library/copies', width: 390, height: 844 });
const globals = {
  window,
  document: window.document,
  navigator: window.navigator,
  HTMLElement: window.HTMLElement,
  HTMLInputElement: window.HTMLInputElement,
  HTMLButtonElement: window.HTMLButtonElement,
  Element: window.Element,
  Node: window.Node,
  NodeFilter: window.NodeFilter,
  Document: window.Document,
  ShadowRoot: window.ShadowRoot,
  DocumentFragment: window.DocumentFragment,
  MutationObserver: window.MutationObserver,
  ResizeObserver: window.ResizeObserver,
  Event: window.Event,
  KeyboardEvent: window.KeyboardEvent,
  FocusEvent: window.FocusEvent,
  MouseEvent: window.MouseEvent,
  PointerEvent: window.PointerEvent,
  CSS: window.CSS,
  getComputedStyle: window.getComputedStyle.bind(window),
  requestAnimationFrame: window.requestAnimationFrame.bind(window),
  cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
  IS_REACT_ACT_ENVIRONMENT: true,
};
const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals))
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
afterAll(async () => {
  mock.restore();
  await window.happyDOM.close();
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

const unexpectedIO = mock(() => {
  throw new Error('Reading supplied copy text must not inspect, fetch or mutate a copy');
});
mock.module('cloudflare:workers', () => ({ env: {} }));
mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);
mock.module('../src/library/copies-actions', () => ({
  createCopy: unexpectedIO,
  updateCopy: unexpectedIO,
  deleteCopy: unexpectedIO,
  undoCopy: unexpectedIO,
  readCopySubject: unexpectedIO,
  readCopyDetail: unexpectedIO,
}));
const { createRoot } = await import('react-dom/client');
const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
const { CopiesPage } = await import('../src/library/copies-page');
const { subjectOf } = await import('../src/library/reads');
const { sessionQuery, exposureQuery } = await import('../src/session/query');
const { within, userEvent } = await import('storybook/test');
const { m } = await import('../src/paraglide/messages.js');
const { setLocale } = await import('../src/paraglide/runtime.js');
const { subjectHref } = await import('../src/subject/subject-href');

const id = (n: number) => `019a1b2c-3d4e-7f00-8a00-${String(n).padStart(12, '0')}`;
const recorded = recording.copies[0]!;
const subject = subjectOf(recorded.subject)!;
const copy = (n: number, changes: Partial<CopyItem> = {}): CopyItem => ({
  ...recorded,
  id: id(n),
  idempotencyKey: id(n + 100),
  subject,
  kind: 'print',
  kindLabel: 'Print at acceptance',
  kindLabelLanguage: 'en',
  statusLabel: 'Kept at acceptance',
  statusLabelLanguage: 'en',
  meaning: 'known',
  source: null,
  location: null,
  ...changes,
});
const exactNote = `  First line\twith spaces  \r\n\r\n${'無間隔📚'.repeat(350)}\n<script>literal text</script>\n  Last line  \t`;

async function mount(copies: CopyItem[], originating = true) {
  setLocale('en', { reload: false });
  unexpectedIO.mockClear();
  const host = window.document.createElement('main');
  window.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  client.setQueryData(sessionQuery.queryKey, { state: 'signed-in', subject: 'owner', csrfToken: 'csrf' });
  client.setQueryData(exposureQuery.queryKey, ['personal_library']);
  client.setQueryData(['exposure', 'anonymous'], []);
  const origin: CopiesOrigin = {
    isCurrent: () => true,
    headers: unexpectedIO,
    readDetail: unexpectedIO,
    readSubject: unexpectedIO,
  };
  const show = async (items = copies) => {
    const page: CopiesPageData = { signedIn: true, subjectId: null, copies: items, next: null, addKey: id(200) };
    await act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <CopiesPage page={page} {...(originating ? { originating: origin } : {})} />
        </QueryClientProvider>,
      ),
    );
  };
  await show();
  const user = userEvent.setup({ document: window.document as unknown as Document });
  const navigations: string[] = [];
  host.addEventListener('click', (event) => {
    const anchor = (event.target as Element).closest('a');
    if (anchor) {
      navigations.push(anchor.href);
      event.preventDefault();
    }
  });
  return {
    host,
    show,
    user,
    navigations,
    rows: () => [...host.querySelectorAll<HTMLLIElement>('ul > li')],
    click: (element: Element) => act(async () => user.click(element as HTMLElement)),
    close: async () => {
      await act(async () => root.unmount());
      client.clear();
      host.remove();
    },
  };
}

function reader(row: Element, label: string) {
  const group = within(row as HTMLElement).getByRole('group', { name: label });
  const control = within(group).getByRole('button');
  const text = window.document.getElementById(control.getAttribute('aria-controls')!)!;
  expect(group.contains(text)).toBe(true);
  return { group, control, text };
}

describe('Private copy text stays exact and readable without opening mutation UI', () => {
  test('a bounded note preserves all whitespace and literal text through expansion and collapse', async () => {
    const h = await mount([copy(1, { note: exactNote })]);
    try {
      const row = h.rows()[0]!;
      const { control, text } = reader(row, m.library_copy_note());
      expect(control.textContent).toBe(m.library_copy_note_reader_expand_note());
      expect(control.getAttribute('aria-expanded')).toBe('false');
      expect(text.textContent).toBe(exactNote);
      expect(text.classList.contains('line-clamp-2')).toBe(true);
      expect(text.classList.contains('whitespace-break-spaces')).toBe(true);
      expect(text.classList.contains('[overflow-wrap:anywhere]')).toBe(true);
      expect(row.querySelector('script')).toBeNull();
      expect(control.closest('[data-slot="list-row-control"]')?.classList.contains('z-10')).toBe(true);
      expect(row.querySelector('a button')).toBeNull();
      await h.click(control);
      expect(control.getAttribute('aria-expanded')).toBe('true');
      expect(control.textContent).toBe(m.library_copy_note_reader_collapse_note());
      expect(text.classList.contains('line-clamp-2')).toBe(false);
      expect(text.textContent).toBe(exactNote);
      expect(window.document.activeElement).toBe(control);
      await h.click(text);
      await h.click(control);
      expect(control.getAttribute('aria-expanded')).toBe('false');
      expect(text.textContent).toBe(exactNote);
      expect(within(h.host as unknown as HTMLElement).queryByRole('dialog')).toBeNull();
      expect(h.navigations).toEqual([]);
      expect(unexpectedIO).not.toHaveBeenCalled();
    } finally {
      await h.close();
    }
  });

  test('source and location have independent exact full readers for unbroken and multiline values', async () => {
    const location = `  Shelf\t${'位置'.repeat(800)}\n\n  lower shelf  `;
    const source = `Seller: ${'source_without_breaks'.repeat(150)}\r\nReceipt  42\t `;
    const h = await mount([copy(1, { source, location, note: exactNote })]);
    try {
      const row = h.rows()[0]!;
      const noteReader = reader(row, m.library_copy_note());
      for (const [label, value] of [
        [m.library_copy_location(), location],
        [m.library_copy_source(), source],
      ]) {
        const field = reader(row, label!);
        expect(field.text.textContent).toBe(value);
        expect(field.text.classList.contains('line-clamp-2')).toBe(true);
        expect(field.text.classList.contains('[overflow-wrap:anywhere]')).toBe(true);
        await h.click(field.control);
        expect(field.control.getAttribute('aria-expanded')).toBe('true');
        expect(field.text.textContent).toBe(value);
        expect(field.text.classList.contains('whitespace-break-spaces')).toBe(true);
        expect(noteReader.control.getAttribute('aria-expanded')).toBe('false');
      }
      expect(h.navigations).toEqual([]);
      expect(unexpectedIO).not.toHaveBeenCalled();
    } finally {
      await h.close();
    }
  });

  test('same-subject physical copies keep their own expansion state and supplied order after reordering', async () => {
    const first = copy(1, { note: exactNote });
    const second = copy(2, { note: exactNote });
    const h = await mount([first, second]);
    try {
      const rows = h.rows();
      const a = reader(rows[0]!, m.library_copy_note());
      const b = reader(rows[1]!, m.library_copy_note());
      expect(a.text.id).not.toBe(b.text.id);
      const originalHref = rows[0]!.querySelector('a')!.getAttribute('href');
      expect(originalHref).toBe(rows[1]!.querySelector('a')!.getAttribute('href'));
      await h.click(a.control);
      expect(b.control.getAttribute('aria-expanded')).toBe('false');
      await h.show([second, first]);
      expect(h.rows()[0]).toBe(rows[1]);
      expect(h.rows()[1]).toBe(rows[0]);
      expect(reader(h.rows()[0]!, m.library_copy_note()).control.getAttribute('aria-expanded')).toBe('false');
      expect(reader(h.rows()[1]!, m.library_copy_note()).control.getAttribute('aria-expanded')).toBe('true');
      expect(h.rows()[1]!.querySelector('a')!.getAttribute('href')).toBe(originalHref);
      expect(unexpectedIO).not.toHaveBeenCalled();
    } finally {
      await h.close();
    }
  });

  test('unresolved history and unavailable subjects stay truthful beside the independent readers', async () => {
    const items = [
      copy(1, {
        subject: null,
        kind: null,
        status: 'historic/raw-status',
        meaning: 'unknown',
        kindLabel: undefined,
        statusLabel: undefined,
        statusEditing: { state: 'unsupported' },
        acquiredOn: null,
        disposedOn: null,
        note: exactNote,
      }),
      copy(2, {
        kind: 'retired/raw-kind',
        status: 'old/status',
        meaning: 'unavailable',
        kindLabel: undefined,
        statusLabel: undefined,
        statusEditing: { state: 'unavailable' },
        acquiredOn: '2024-12-03',
        disposedOn: '2025-03-19',
        note: exactNote,
      }),
    ];
    const h = await mount(items);
    try {
      for (const [index, row] of h.rows().entries()) {
        const ui = within(row as unknown as HTMLElement);
        const history = row.querySelector('details')!;
        await h.click(reader(row, m.library_copy_note()).control);
        expect(history.open).toBe(false);
        await h.click(history.querySelector('summary')!);
        expect([...history.querySelectorAll('code')].map((value) => value.textContent)).toEqual([
          items[index]!.kind ?? 'null',
          items[index]!.status,
        ]);
        expect(history.textContent).toContain(
          index === 0 ? m.library_copy_meaning_unknown() : m.library_history_unavailable(),
        );
        if (index === 0) {
          expect(ui.getByRole('heading', { name: m.library_subject_unavailable() })).toBeDefined();
          expect(ui.queryByRole('link')).toBeNull();
          expect(ui.queryByText(`${m.library_copy_acquired()}:`)).toBeNull();
          expect(ui.queryByText(`${m.library_copy_disposed()}:`)).toBeNull();
        } else {
          const date = (value: string) =>
            new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeZone: 'UTC' }).format(
              new Date(`${value}T12:00:00Z`),
            );
          expect(row.textContent).toContain(date(items[index]!.acquiredOn!));
          expect(row.textContent).toContain(date(items[index]!.disposedOn!));
        }
        expect(ui.getByRole('button', { name: m.library_copy_more_actions() })).toBeDefined();
      }
      expect(unexpectedIO).not.toHaveBeenCalled();
    } finally {
      await h.close();
    }
  });

  test('accepted labels and recorded dates remain unchanged with absent, retired or current status advice', async () => {
    const advice: CopyItem['statusEditing'][] = [
      undefined,
      { state: 'unsupported' },
      { state: 'unavailable' },
      { state: 'supported', statuses: [{ id: 'another-status', label: 'Current advice only' }] },
    ];
    const h = await mount(
      advice.map((statusEditing, index) =>
        copy(index + 1, {
          statusEditing,
          acquiredOn: '2024-12-03',
          disposedOn: '2025-03-19',
          note: exactNote,
        }),
      ),
    );
    try {
      for (const row of h.rows()) {
        await h.click(reader(row, m.library_copy_note()).control);
        const ui = within(row as unknown as HTMLElement);
        expect(ui.getByText('Print at acceptance').getAttribute('lang')).toBe('en');
        expect(ui.getByText('Kept at acceptance').getAttribute('lang')).toBe('en');
        expect(row.textContent).toContain('Dec 3, 2024');
        expect(row.textContent).toContain('Mar 19, 2025');
        expect(row.textContent).not.toContain('Current advice only');
        expect(row.querySelector('details')).toBeNull();
      }
      expect(unexpectedIO).not.toHaveBeenCalled();
    } finally {
      await h.close();
    }
  });

  test('empty and missing notes stay absent while a whitespace-only recorded note remains exact', async () => {
    const h = await mount([
      copy(1, { note: null, source: null, location: null }),
      copy(2, { note: '', source: '', location: '' }),
      copy(3, { note: ' \n\t  ' }),
    ]);
    try {
      for (const row of h.rows().slice(0, 2))
        expect(within(row as unknown as HTMLElement).queryByRole('group')).toBeNull();
      const field = reader(h.rows()[2]!, m.library_copy_note());
      await h.click(field.control);
      expect(field.text.textContent).toBe(' \n\t  ');
      expect(unexpectedIO).not.toHaveBeenCalled();
    } finally {
      await h.close();
    }
  });

  test('Tab, Enter and Space read the note without navigating or inspecting an editor', async () => {
    const h = await mount([copy(1, { note: exactNote })]);
    try {
      const row = h.rows()[0]!;
      const link = row.querySelector('a')!;
      expect(link.getAttribute('href')).toBe(subjectHref({ id: subject.id, label: subject.label.value }, 'en').href);
      const field = reader(row, m.library_copy_note());
      await act(async () => link.focus());
      await act(async () => h.user.tab());
      expect(window.document.activeElement).toBe(field.control);
      await act(async () => h.user.keyboard('{Enter}'));
      expect(field.control.getAttribute('aria-expanded')).toBe('true');
      await act(async () => h.user.keyboard(' '));
      expect(field.control.getAttribute('aria-expanded')).toBe('false');
      expect(window.document.activeElement).toBe(field.control);
      await act(async () => h.user.tab());
      expect(window.document.activeElement?.getAttribute('aria-label')).toBe(m.library_copy_more_actions());
      expect(h.navigations).toEqual([]);
      expect(window.location.pathname).toBe('/en/library/copies');
      expect(unexpectedIO).not.toHaveBeenCalled();
    } finally {
      await h.close();
    }
  });

  test('replacing the private loader page retires expanded text and starts a fresh reader lifetime', async () => {
    const item = copy(1, { note: exactNote });
    const h = await mount([item], false);
    try {
      const field = reader(h.rows()[0]!, m.library_copy_note());
      await h.click(field.control);
      await h.show([]);
      expect(h.host.textContent).not.toContain(exactNote);
      expect(field.control.isConnected).toBe(false);
      await h.show([item]);
      expect(reader(h.rows()[0]!, m.library_copy_note()).control.getAttribute('aria-expanded')).toBe('false');
      expect(unexpectedIO).not.toHaveBeenCalled();
    } finally {
      await h.close();
    }
  });
});
