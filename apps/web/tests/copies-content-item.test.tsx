import { afterAll, describe, expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act } from 'react';
import * as start from '../.storybook/react-start';
import recording from '../src/kernel/recorded/library-copies.json';
import type { CopiesOrigin } from '../src/library/copies-page';
import type { CopiesPageData, CopyItem } from '../src/library/copies-read';

// UNRUN: composed assertions with installed shared UI; browser/native acceptance remains deferred.
const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
);
const window = new Window({ url: 'https://site.test/en/library/copies', width: 1280, height: 900 });
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
  throw new Error('Copy presentation must use its supplied page and originating detail reader');
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
const recorded = recording.copies[1]!;
const subject = {
  ...subjectOf(recorded.subject)!,
  label: { value: 'こころ — 文庫版', language: 'ja' },
  typeLabel: 'Novel edition',
};
const copy = (n: number, changes: Partial<CopyItem> = {}): CopyItem => ({
  ...recorded,
  id: id(n),
  idempotencyKey: id(n + 100),
  subject,
  kind: 'paper',
  kindLabel: '紙本',
  kindLabelLanguage: 'zh-Hant',
  statusLabel: 'Besitz',
  statusLabelLanguage: 'de',
  meaning: 'known',
  ...changes,
});

async function mount(copies: CopyItem[], locale: 'en' | 'zh-Hans' = 'en') {
  setLocale(locale, { reload: false });
  window.document.documentElement.lang = locale;
  unexpectedIO.mockClear();
  const host = window.document.createElement('main');
  window.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  client.setQueryData(sessionQuery.queryKey, { state: 'signed-in', subject: 'owner', csrfToken: 'csrf' });
  client.setQueryData(exposureQuery.queryKey, ['personal_library']);
  client.setQueryData(['exposure', 'anonymous'], []);
  const readDetail = mock(async (id: string) => ({ ok: true as const, copy: copies.find((copy) => copy.id === id)! }));
  const originating: CopiesOrigin = {
    isCurrent: () => true,
    headers: () => ({ 'x-csrf-token': 'csrf' }),
    readDetail,
    readSubject: unexpectedIO,
  };
  const show = async (items = copies) => {
    const page: CopiesPageData = { signedIn: true, subjectId: null, copies: items, next: null, addKey: id(200) };
    await act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <CopiesPage page={page} originating={originating} />
        </QueryClientProvider>,
      ),
    );
  };
  await show();
  const user = userEvent.setup({ document: window.document as unknown as Document });
  return {
    host,
    show,
    readDetail,
    body: within(window.document.body as unknown as HTMLElement),
    rows: () => [...host.querySelectorAll<HTMLLIElement>('ul > li')],
    click: (element: Element) => act(async () => user.click(element as HTMLElement)),
    close: async () => {
      await act(async () => root.unmount());
      client.clear();
      host.remove();
      setLocale('en', { reload: false });
    },
  };
}

describe('Copy items retain exact edition identity historical disclosure and independent editor controls', () => {
  test('localized visible headings name exact subject links and retain supplied cover labels and dates', async () => {
    const item = copy(1, { disposedOn: '2026-01-01' });
    const h = await mount([item], 'zh-Hans');
    try {
      const row = h.rows()[0]!;
      const ui = within(row as unknown as HTMLElement);
      const heading = ui.getByRole('heading', { level: 2, name: subject.label.value });
      const link = ui.getByRole('link', { name: subject.label.value, exact: true });
      expect(heading.getAttribute('aria-hidden')).toBeNull();
      expect(heading.getAttribute('lang')).toBe('ja');
      expect(link.getAttribute('lang')).toBe('ja');
      expect(link.getAttribute('aria-labelledby')).toBe(heading.id);
      expect(link.getAttribute('href')).toBe(
        subjectHref({ id: subject.id, label: subject.label.value }, 'zh-Hans').href,
      );
      expect(row.querySelectorAll('[data-content-item-slot="title"]')).toHaveLength(1);
      expect(row.querySelectorAll('a')).toHaveLength(1);
      const cover = row.querySelector('[data-content-item-slot="visual"] [data-slot="cover"]')!;
      expect(cover.parentElement?.classList.contains('w-[72px]')).toBe(true);
      expect(cover.parentElement?.classList.contains('sm:w-24')).toBe(true);
      expect(cover.getAttribute('data-ratio')).toBe('5:7');
      expect(cover.getAttribute('data-size')).toBe('fill');
      expect(row.querySelector('img')?.getAttribute('src')).toContain(recorded.subject.cover!.media);
      expect(row.querySelector('img')?.getAttribute('alt')).toBe('');
      expect(ui.getByText('紙本').getAttribute('lang')).toBe('zh-Hant');
      expect(ui.getByText('Besitz').getAttribute('lang')).toBe('de');
      const date = (value: string) =>
        new Intl.DateTimeFormat('zh-Hans', { dateStyle: 'medium', timeZone: 'UTC' }).format(
          new Date(`${value}T12:00:00Z`),
        );
      const facts = row.querySelector('[data-content-item-slot="metadata"]')!;
      for (const text of [
        subject.typeLabel,
        m.library_copy_acquired(),
        date(item.acquiredOn!),
        item.location!,
        item.source!,
        m.library_copy_disposed(),
        date(item.disposedOn!),
        item.note!,
      ])
        expect(facts.textContent).toContain(text);
      expect(row.querySelector('details')).toBeNull();
      expect(h.readDetail).not.toHaveBeenCalled();
      expect(unexpectedIO).not.toHaveBeenCalled();
    } finally {
      await h.close();
    }
  });

  test('unavailable subjects stay unlinked and duplicate edition copies keep their separate identity on reorder', async () => {
    const first = copy(1, { note: 'First physical copy' });
    const second = copy(2, { note: 'Second physical copy' });
    const unavailable = copy(3, { subject: null, note: 'Unavailable edition copy' });
    const h = await mount([first, second, unavailable]);
    try {
      const rows = h.rows();
      expect(rows).toHaveLength(3);
      expect(rows.slice(0, 2).map((row) => row.querySelector('h2')?.textContent)).toEqual([
        subject.label.value,
        subject.label.value,
      ]);
      expect(rows[0]!.querySelector('a')?.getAttribute('href')).toBe(rows[1]!.querySelector('a')?.getAttribute('href'));
      expect(rows[0]!.textContent).toContain(first.note);
      expect(rows[1]!.textContent).toContain(second.note);
      expect(rows[0]!.querySelector('h2')?.id).not.toBe(rows[1]!.querySelector('h2')?.id);
      const hidden = within(rows[2]! as unknown as HTMLElement);
      expect(hidden.getByRole('heading', { level: 2, name: m.library_subject_unavailable() })).toBeDefined();
      expect(hidden.queryByRole('link')).toBeNull();
      expect(rows[2]!.querySelector('[data-slot="cover"]')).not.toBeNull();
      expect(hidden.getByRole('button', { name: m.library_copy_more_actions() })).toBeDefined();
      await h.show([second, unavailable, first]);
      expect(h.rows()[0]).toBe(rows[1]);
      expect(h.rows()[1]).toBe(rows[2]);
      expect(h.rows()[2]).toBe(rows[0]);
      expect(unexpectedIO).not.toHaveBeenCalled();
    } finally {
      await h.close();
    }
  });

  test('native history disclosure preserves raw values while the independent menu edits only its chosen copy', async () => {
    const first = copy(1, {
      meaning: 'unknown',
      kind: 'retired-format',
      status: 'historic-status',
      kindLabel: undefined,
      statusLabel: undefined,
    });
    const second = copy(2, { meaning: 'unavailable', kind: null, status: 'unmapped-status', kindLabel: undefined });
    const h = await mount([first, second]);
    const anchorClicks: string[] = [];
    h.host.addEventListener('click', (event) => {
      const anchor = (event.target as Element).closest('a');
      if (anchor) {
        anchorClicks.push(anchor.href);
        event.preventDefault();
      }
    });
    try {
      const rows = h.rows();
      const details = rows[0]!.querySelector('details')!;
      const summary = details.querySelector('summary')!;
      expect(summary.textContent).toBe(m.library_copy_history_details());
      expect(summary.classList.contains('min-h-11')).toBe(true);
      expect(summary.closest('[data-slot="list-row-control"]')?.classList.contains('z-10')).toBe(true);
      expect(details.open).toBe(false);
      await h.click(summary);
      expect(details.open).toBe(true);
      expect(details.textContent).toContain(m.library_copy_meaning_unknown());
      expect([...details.querySelectorAll('code')].map((code) => code.textContent)).toEqual([first.kind, first.status]);
      expect(rows[1]!.querySelector('details')?.textContent).toContain(m.library_history_unavailable());
      expect([...rows[1]!.querySelectorAll('details code')].map((code) => code.textContent)).toEqual([
        'null',
        second.status,
      ]);
      expect(h.readDetail).not.toHaveBeenCalled();
      const trigger = within(rows[1]! as unknown as HTMLElement).getByRole('button', {
        name: m.library_copy_more_actions(),
      });
      expect(trigger.classList.contains('size-11')).toBe(true);
      expect(trigger.closest('[data-content-item-slot="trailing"]')?.getAttribute('data-slot')).toBe(
        'list-row-control',
      );
      expect(rows[1]!.querySelector('a button, a summary, a a')).toBeNull();
      await h.click(trigger);
      await h.click(h.body.getByRole('menuitem', { name: m.library_copy_edit(), exact: true }));
      expect(h.readDetail).toHaveBeenCalledTimes(1);
      expect(h.readDetail).toHaveBeenCalledWith(second.id);
      const form = h.body.getByRole('form', { name: m.library_copy_edit() });
      expect(form.getAttribute('data-idempotency-key')).toBe(second.idempotencyKey);
      expect(form.textContent).toContain(second.statusLabel);
      expect(details.open).toBe(true);
      expect(rows[1]!.querySelector('details')?.open).toBe(false);
      expect(anchorClicks).toEqual([]);
      expect(window.location.pathname).toBe('/en/library/copies');
      expect(unexpectedIO).not.toHaveBeenCalled();
    } finally {
      await h.close();
    }
  });
});

describe('Received-page exact-copy comparison', () => {
  test('keeps distinct copies in native order, bounds selection and labels only supplied observations', async () => {
    const first = copy(11, {
      location: null,
      source: null,
      note: null,
      acquiredOn: null,
      disposedOn: null,
      kindLabel: undefined,
      statusLabel: undefined,
      meaning: 'unknown',
      readingContext: { state: 'withheld' },
    });
    const second = copy(12, {
      note: 'Line one\nLine two\nLine three',
      source: 'Shop\nReceipt',
      readingContext: { state: 'unsupported', facts: [] },
    });
    const hidden = copy(13, { subject: null, readingContext: { state: 'missing' } });
    const fourth = copy(14, { readingContext: { state: 'unavailable' } });
    const outside = copy(15, { note: 'Unselected observation' });
    const h = await mount([first, second, hidden, fourth, outside]);
    try {
      const select = (position: number) =>
        within(h.rows()[position]! as unknown as HTMLElement).getByRole('button', { name: /^Compare copy/ });
      await h.click(select(1));
      await h.click(select(0));
      await h.click(select(2));
      await h.click(select(3));
      expect(select(4).hasAttribute('disabled')).toBe(true);
      await h.click(h.body.getByRole('button', { name: m.library_copy_compare_open() }));
      const region = h.body.getByRole('region', { name: m.library_copy_compare_heading() });
      const cards = [...region.querySelectorAll<HTMLElement>('article')];
      expect(cards.map((card) => card.dataset.copyComparisonId)).toEqual([first.id, second.id, hidden.id, fourth.id]);
      expect(cards[0]!.querySelector('h3')?.textContent).toBe(cards[1]!.querySelector('h3')?.textContent);
      expect(cards[0]!.textContent).toContain(m.library_copy_compare_not_recorded());
      expect(cards[0]!.textContent).toContain(m.library_copy_compare_label_missing());
      expect(cards[0]!.textContent).toContain(m.library_copy_meaning_unknown());
      expect(cards[0]!.textContent).toContain(m.library_copy_reading_context_withheld());
      expect(cards[1]!.textContent).toContain(m.library_copy_reading_context_unsupported());
      expect(cards[2]!.textContent).toContain(m.library_copy_reading_context_missing());
      expect(cards[3]!.textContent).toContain(m.library_copy_reading_context_unavailable());
      expect(cards[2]!.querySelector('a')).toBeNull();
      expect(region.textContent).not.toContain(outside.note);
      expect(region.textContent).toContain(m.library_copy_compare_different());
      expect(region.textContent).toContain(m.library_copy_compare_same());
      const secondUI = within(cards[1]!);
      await h.click(secondUI.getByRole('button', { name: m.library_copy_note_reader_expand_note() }));
      expect(
        secondUI
          .getByRole('button', { name: m.library_copy_note_reader_collapse_note() })
          .getAttribute('aria-expanded'),
      ).toBe('true');
      expect(cards[1]!.textContent).toContain(second.note);
      await h.show([fourth, hidden, second, first, outside]);
      expect([...region.querySelectorAll<HTMLElement>('article')].map((card) => card.dataset.copyComparisonId)).toEqual(
        [fourth.id, hidden.id, second.id, first.id],
      );
      await h.click(
        within(region.querySelector('article')!).getByRole('button', { name: m.library_copy_compare_remove() }),
      );
      expect(select(4).hasAttribute('disabled')).toBe(false);
      expect(h.readDetail).not.toHaveBeenCalled();
      expect(unexpectedIO).not.toHaveBeenCalled();
    } finally {
      await h.close();
    }
  });
});

describe('Received comparison replacement and focus', () => {
  test('requires deliberate revision reselection, forgets missing rows and returns only to a connected originating row', async () => {
    const first = copy(21, { note: 'Before replacement' });
    const second = copy(22, { note: 'Retained other record' });
    const h = await mount([first, second]);
    try {
      const select = (position: number) =>
        within(h.rows()[position]! as unknown as HTMLElement).getByRole('button', { name: /^Compare copy/ });
      const firstTrigger = select(0);
      await h.click(firstTrigger);
      await h.click(h.body.getByRole('button', { name: m.library_copy_compare_open() }));
      await h.click(h.body.getByRole('button', { name: m.library_copy_compare_close() }));
      expect(window.document.activeElement).toBe(firstTrigger);
      await h.click(select(1));
      await h.click(h.body.getByRole('button', { name: m.library_copy_compare_open() }));
      const current = { ...first, revision: first.revision + 1, note: 'Current replacement' };
      await h.show([current]);
      const region = h.body.getByRole('region', { name: m.library_copy_compare_heading() });
      expect(region.querySelectorAll('article')).toHaveLength(0);
      expect(region.textContent).toContain(m.library_copy_compare_changed());
      expect(region.textContent).toContain(m.library_copy_compare_missing());
      expect(region.textContent).not.toContain('Before replacement');
      await h.show([current, second]);
      expect(region.querySelectorAll('article')).toHaveLength(0);
      expect(select(0).getAttribute('aria-pressed')).toBe('false');
      await h.click(h.body.getAllByRole('button', { name: m.library_copy_compare_find_row() })[0]!);
      expect(window.document.activeElement).toBe(select(0));
      expect(region.querySelectorAll('article')).toHaveLength(0);
      await h.click(select(0));
      expect(region.querySelector('article')?.textContent).toContain('Current replacement');
      await h.show([second]);
      await h.click(h.body.getByRole('button', { name: m.library_copy_compare_close() }));
      expect(firstTrigger.isConnected).toBe(false);
      expect(window.document.activeElement).not.toBe(firstTrigger);
      expect(h.readDetail).not.toHaveBeenCalled();
      expect(unexpectedIO).not.toHaveBeenCalled();
    } finally {
      await h.close();
    }
  });
});
