import { afterEach, beforeEach, expect, test } from 'bun:test';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Window } from 'happy-dom';
import { m } from '../src/paraglide/messages.js';
import type { MalImportPort, MalPage, MalPreviewRow } from '../src/library/personal-mal-import';
import { MalImportPortContext } from '../src/library/personal-mal-import/port';
import { PersonalMalImportPage } from '../src/library/personal-mal-import/page';
import { malScoreLabel, malValueLabel } from '../src/library/personal-mal-import/meaning';
import { libraryNavigation } from '../src/library/navigation';
import type { MalVisit } from '../src/library/personal-mal-import/visit';

const window = new Window({ url: 'https://site.test/en/library/import-mal' });
for (const [key, value] of Object.entries({
  window,
  document: window.document,
  navigator: window.navigator,
  HTMLElement: window.HTMLElement,
  HTMLButtonElement: window.HTMLButtonElement,
  HTMLInputElement: window.HTMLInputElement,
  MouseEvent: window.MouseEvent,
  Node: window.Node,
  IS_REACT_ACT_ENVIRONMENT: true,
}))
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });

const id = '0192f3a0-6c1e-7b2a-9d4e-00000000aaaa';
const subject = '0192f3a0-6c1e-7b2a-9d4e-00000000bbbb';
const visit = (viewer = 'alice', csrf = 'csrf-1'): MalVisit => {
  const controller = new AbortController();
  let retired = false;
  return {
    subject: viewer,
    csrfToken: csrf,
    controller,
    retire() {
      retired = true;
      controller.abort();
    },
    current() {
      return !retired;
    },
  };
};

function value(kind: MalPreviewRow['status']['kind'], extra: Partial<MalPreviewRow['status']> = {}): MalPreviewRow['status'] {
  return { kind, ...extra };
}

function row(changes: Partial<MalPreviewRow> = {}): MalPreviewRow {
  return {
    index: 0,
    kind: 'manga',
    title: 'Private manga',
    identifier: { namespace: 'https://myanimelist.net/manga', source: 'mal_manga', value: '7' },
    status: value('value', { raw: 'Reading', value: 'Reading' }),
    role: 'active',
    score: value('zero', { value: 0, scale: { min: 1, max: 10, step: 1 } }),
    progress: { my_read_chapters: value('value', { value: 12 }), my_read_volumes: value('value', { value: 2 }) },
    dates: {
      started: value('value', { value: '2024', precision: 'year' }),
      finished: value('unknown', { raw: '0000-00-00' }),
    },
    notes: value('value', { value: 'secret note' }),
    tags: value('value', { value: 'a,b' }),
    repeats: value('value', { value: 3 }),
    privacy: value('value', { value: '1' }),
    timestamps: { my_last_updated: value('value', { value: '123' }) },
    fields: { manga_title: 'Private manga', my_comments: 'secret note', my_score: '0' },
    retained: [
      { field: 'my_comments', reason: 'private-note-only' },
      { field: 'my_score', reason: 'no-native-vote-admission' },
    ],
    target: null,
    candidates: [],
    match: 'unmatched',
    state: 'active',
    current: null,
    binding: null,
    source: { release: 'r1', epoch: '1', acceptingType: 'ex:Child' },
    review: null,
    outcome: null,
    ...changes,
  };
}

function pageOf(rows: MalPreviewRow[], extra: Partial<MalPage> = {}): MalPage {
  return {
    id,
    canceled: false,
    total: rows.length,
    rows,
    sourcePath: `/v1/libraryImports/mal/${id}/source`,
    next: null,
    limits: { bytes: 2_097_152, rows: 500, page: 20 },
    ...extra,
  };
}

let host: HTMLDivElement;
let root: Root;
let router: ReturnType<typeof createRouter>;

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function button(label: string) {
  return [...host.querySelectorAll('button')].find((item) => item.textContent === label);
}

async function click(label: string) {
  const target = button(label);
  expect(target).toBeDefined();
  await act(async () => {
    target!.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await Promise.resolve();
  });
  await settle();
}

async function mount(port: MalImportPort, current = visit()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const tree = createRootRoute({
    component: () => (
      <QueryClientProvider client={client}>
        <MalImportPortContext.Provider value={port}>
          <PersonalMalImportPage visit={current} />
        </MalImportPortContext.Provider>
      </QueryClientProvider>
    ),
  });
  router = createRouter({ routeTree: tree, history: createMemoryHistory({ initialEntries: ['/en/library/import-mal'] }) });
  await router.load();
  await act(async () => {
    root.render(<RouterProvider router={router} />);
  });
  await settle();
}

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

test('zero scores, unknown dates and independent chapter/volume measures stay distinct', () => {
  expect(malScoreLabel(value('zero', { value: 0, scale: { min: 1, max: 10, step: 1 } }))).toBe(m.library_mal_score_none());
  expect(malValueLabel(value('unknown', { raw: '0000-00-00' }))).toBe(m.library_mal_unknown());
  expect(malValueLabel(value('missing'))).toBe(m.library_mal_missing());
  expect(malValueLabel(value('value', { value: '2024', precision: 'year' }))).toBe(m.library_mal_precision_year({ value: '2024' }));
  expect(libraryNavigation.some((entry) => entry.id === 'library.import-mal')).toBe(true);
  expect(libraryNavigation.some((entry) => entry.id === 'library.discover-collections')).toBe(true);
  expect(libraryNavigation.some((entry) => entry.id === 'library.create-collection')).toBe(true);
});

test('explicit unmatched target, status selection, confirmation and partial results keep original retry', async () => {
  const previewXml: string[] = [];
  const reviews: unknown[] = [];
  const applies: unknown[] = [];
  let current = row();
  const port: MalImportPort = {
    async preview(command) {
      previewXml.push(command.xml);
      return { kind: 'previewed', id };
    },
    async page() {
      return { kind: 'page', page: pageOf([current]) };
    },
    async review(command) {
      reviews.push(command);
      current = {
        ...current,
        target: command.input.target,
        match: command.input.target ? 'matched' : current.match,
        review: {
          version: command.key,
          target: command.input.target,
          skip: command.input.skip,
          replace: command.input.replace,
          state: 'active',
          current: null,
          binding: null,
          source: current.source,
          conflict: false,
          unsupported: null,
        },
      };
      return { kind: 'reviewed', id };
    },
    async apply(command) {
      applies.push(JSON.parse(JSON.stringify(command)));
      if (applies.length === 1) return { kind: 'unknown', command };
      return {
        kind: 'applied',
        result: {
          id,
          stopped: true,
          remaining: [1],
          outcomes: [
            { row: 0, status: 'applied', applied: ['status'], retained: ['my_comments', 'my_score'], reason: null },
            { row: 2, status: 'failed', applied: [], retained: ['manga_title'], reason: 'native-command-unavailable-retry-original' },
          ],
        },
      };
    },
    async cancel() {
      return { kind: 'done', id };
    },
    async delete() {
      return { kind: 'done', id };
    },
  };
  await mount(port);
  expect(host.textContent).toContain(m.library_mal_intro());
  const file = new File(['<myanimelist><manga/></myanimelist>'], 'list.xml', { type: 'text/xml' });
  const input = host.querySelector('input[type="file"]') as HTMLInputElement;
  Object.defineProperty(input, 'files', { configurable: true, value: [file] });
  await click(m.library_mal_upload());
  expect(previewXml[0]).toContain('myanimelist');
  expect(host.textContent).toContain('Private manga');
  expect(host.textContent).toContain(m.library_mal_score_none());
  expect(host.textContent).toContain(m.library_mal_chapters());
  expect(host.textContent).toContain(m.library_mal_volumes());
  expect(host.textContent).toContain(m.library_mal_not_vote());
  expect(host.querySelector('[data-mal-kind="manga"]')).not.toBeNull();
  const target = host.querySelector('[data-mal-target]') as HTMLInputElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(target, subject);
    target.dispatchEvent(new window.Event('input', { bubbles: true }));
    await Promise.resolve();
  });
  await click(m.library_mal_save_review());
  expect(reviews).toHaveLength(1);
  expect(reviews[0]).toMatchObject({ input: { row: 0, target: subject, skip: false, replace: false } });
  await click(m.library_mal_continue_confirm());
  expect(host.textContent).toContain(subject);
  await click(m.library_mal_confirm());
  expect(host.textContent).toContain(m.library_mal_uncertain());
  await click(m.library_mal_retry_command());
  expect(applies).toHaveLength(2);
  expect(applies[0]).toEqual(applies[1]);
  expect(host.textContent).toContain(m.library_mal_result_applied());
  expect(host.textContent).toContain(m.library_mal_result_failed());
  expect(host.textContent).toContain(m.library_mal_result_unattempted());
  expect(host.querySelector('[data-mal-outcome="unattempted"]')).not.toBeNull();
});

test('a changed account retires the upload and former-account callbacks', async () => {
  let pages = 0;
  const port: MalImportPort = {
    async preview() {
      return { kind: 'previewed', id };
    },
    async page() {
      pages += 1;
      return { kind: 'page', page: pageOf([row({ match: 'matched', target: subject })]) };
    },
    async review() {
      return { kind: 'reviewed', id };
    },
    async apply() {
      return { kind: 'applied', result: { id, outcomes: [], remaining: [], stopped: false } };
    },
    async cancel() {
      return { kind: 'done', id };
    },
    async delete() {
      return { kind: 'done', id };
    },
  };
  await mount(port, visit('alice', 'csrf-a'));
  const file = new File(['<myanimelist/>'], 'a.xml', { type: 'text/xml' });
  Object.defineProperty(host.querySelector('input[type="file"]') as HTMLInputElement, 'files', {
    configurable: true,
    value: [file],
  });
  await click(m.library_mal_upload());
  expect(host.textContent).toContain('Private manga');
  const seen = pages;
  await mount(port, visit('bob', 'csrf-b'));
  expect(host.textContent).not.toContain('Private manga');
  expect(host.textContent).toContain(m.library_mal_upload());
  expect(pages).toBe(seen);
});
