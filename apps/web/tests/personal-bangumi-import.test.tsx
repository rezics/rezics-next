import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import {
  BANGUMI_APPLY,
  BANGUMI_FORMAT,
  BANGUMI_PAGE,
  type BangumiImportPort,
  type BangumiPage,
  type BangumiReview,
  type BangumiRow,
} from '../src/library/personal-bangumi-import/contract';
import { bangumiCallTotal, expectedBangumiCalls } from '../src/library/personal-bangumi-import/cost';
import { createBangumiJourney } from '../src/library/personal-bangumi-import/controller';
import { libraryNavigation } from '../src/library/navigation';
import type { BangumiVisit } from '../src/library/personal-bangumi-import/visit';

mock.module('cloudflare:workers', () => ({ env: {} }));

const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
);
const window = new Window({ url: 'https://site.test/en/library/import-bangumi' });
for (const [key, value] of Object.entries({
  window,
  document: window.document,
  navigator: window.navigator,
  HTMLElement: window.HTMLElement,
  HTMLButtonElement: window.HTMLButtonElement,
  HTMLInputElement: window.HTMLInputElement,
  Element: window.Element,
  MouseEvent: window.MouseEvent,
  Event: window.Event,
  Node: window.Node,
  MutationObserver: window.MutationObserver,
  getComputedStyle: window.getComputedStyle.bind(window),
  requestAnimationFrame: window.requestAnimationFrame.bind(window),
  cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
  scrollTo: window.scrollTo.bind(window),
  IS_REACT_ACT_ENVIRONMENT: true,
}))
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
type Root = ReturnType<typeof createRoot>;
const { m } = await import('../src/paraglide/messages.js');
const { BangumiImportPortContext } = await import('../src/library/personal-bangumi-import/port');
const { PersonalBangumiImportPage } = await import('../src/library/personal-bangumi-import/page');

const id = '0192f3a0-6c1e-7b2a-9d4e-00000000aaaa';
const subject = '0192f3a0-6c1e-7b2a-9d4e-00000000bbbb';
const token = '0192f3a0-6c1e-7b2a-9d4e-00000000cccc';

const visit = (viewer = 'alice', csrf = 'csrf-1'): BangumiVisit => {
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

function envelope(rows: number): string {
  return JSON.stringify({
    format: BANGUMI_FORMAT,
    collections: Array.from({ length: rows }, (_, index) => ({
      subject_id: index + 1,
      subject_type: 2,
      type: 3,
      rate: index === 0 ? 0 : 8,
      ep_status: 0,
      vol_status: 0,
      comment: 'private',
      extra_unknown: 'keep',
      subject: { name: `Show ${index + 1}` },
    })),
  });
}

function evidence(index: number) {
  return {
    source: {
      subject_id: index + 1,
      subject_type: 2,
      type: 3,
      rate: index === 0 ? 0 : 8,
      ep_status: 0,
      extra_unknown: 'keep',
      subject: { name: `Show ${index + 1}` },
    },
    fields: [
      { field: 'subject_id', value: index + 1, meaning: 'known' as const, reason: 'Bangumi provider identifier; never a title match' },
      { field: 'rate', value: index === 0 ? 0 : 8, meaning: 'known' as const, reason: 'Bangumi 1–10 scale; no native vote or aggregate' },
      { field: 'ep_status', value: 0, meaning: 'known' as const, reason: 'episodes; no historical session inferred' },
      { field: 'extra_unknown', value: 'keep', meaning: 'unknown' as const, reason: 'No native field mapping; retained privately' },
    ],
    medium: 'anime',
    stateRole: 'active',
  };
}

function row(index: number, extra: Partial<BangumiRow> = {}): BangumiRow {
  return {
    ordinal: index,
    evidence: evidence(index),
    review: extra.review ?? null,
    outcome: extra.outcome ?? null,
    ...extra,
  };
}

function reviewed(index: number, changes: Partial<BangumiReview> = {}): BangumiReview {
  return {
    token,
    match: 'unmatched',
    candidates: [],
    target: null,
    guard: null,
    proposedState: 'active',
    current: null,
    conflict: false,
    ...changes,
  };
}

function pageOf(rows: BangumiRow[], extra: Partial<BangumiPage> = {}): BangumiPage {
  return { uploadId: id, cancelled: false, rows, next: null, ...extra };
}

function recordingPort(total: number, options: { failApplyOnce?: boolean; replace?: boolean } = {}): {
  port: BangumiImportPort;
  previews: string[];
  applies: unknown[];
  reviews: unknown[];
} {
  const previews: string[] = [];
  const applies: unknown[] = [];
  const reviews: unknown[] = [];
  const tokens = new Map<number, string>();
  let applyAttempts = 0;
  const stored = Array.from({ length: total }, (_, index) => row(index));
  const port: BangumiImportPort = {
    async preview(command) {
      previews.push(command.upload);
      return { kind: 'previewed', uploadId: id, count: total };
    },
    async page(command) {
      const start = command.after + 1;
      const slice = stored.slice(start, start + BANGUMI_PAGE);
      return {
        kind: 'page',
        page: pageOf(slice, { next: start + slice.length < total ? start + slice.length - 1 : null }),
      };
    },
    async review(command) {
      reviews.push(JSON.parse(JSON.stringify(command)));
      const current = stored[command.ordinal]!;
      const review = reviewed(command.ordinal, {
        token: `${token.slice(0, -1)}${command.ordinal % 10}`,
        match: command.target ? 'chosen' : 'unmatched',
        target: command.target ?? null,
        current: options.replace ? { state: 'planned', revision: 4 } : null,
        conflict: !!options.replace,
        proposedState: 'active',
      });
      tokens.set(command.ordinal, review.token);
      stored[command.ordinal] = { ...current, review };
      return { kind: 'reviewed', ordinal: command.ordinal, review };
    },
    async apply(command) {
      applies.push(JSON.parse(JSON.stringify(command)));
      applyAttempts += 1;
      if (options.failApplyOnce && applyAttempts === 1) return { kind: 'unknown', command };
      return {
        kind: 'applied',
        result: {
          uploadId: id,
          remaining: [],
          outcomes: command.body.rows.map((item, index) => ({
            ordinal: item.ordinal,
            status: index === command.body.rows.length - 1 && command.body.rows.length > 1 ? 'failed' : 'applied',
            applied: item.skip ? [] : ['type'],
            retained: ['rate', 'ep_status', 'extra_unknown', 'comment'],
          })),
        },
      };
    },
    async cancel() {
      return { kind: 'cancelled', uploadId: id };
    },
    async delete() {
      return { kind: 'deleted' };
    },
  };
  return { port, previews, applies, reviews };
}

let host: HTMLDivElement;
let root: Root;

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

async function mount(port: BangumiImportPort, current = visit()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const tree = createRootRoute({
    component: () => (
      <QueryClientProvider client={client}>
        <BangumiImportPortContext.Provider value={port}>
          <PersonalBangumiImportPage visit={current} />
        </BangumiImportPortContext.Provider>
      </QueryClientProvider>
    ),
  });
  const router = createRouter({
    routeTree: tree,
    history: createMemoryHistory({ initialEntries: ['/en/library/import-bangumi'] }),
  });
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

test('navigation, unrated score and unknown fields stay distinct from applied state', () => {
  expect(libraryNavigation.some((entry) => entry.id === 'library.import-bangumi')).toBe(true);
  expect(libraryNavigation.some((entry) => entry.id === 'library.import-mal')).toBe(true);
});

test('preview does not apply, explicit target replacement and exact uncertain retry keep operands', async () => {
  const { port, previews, applies, reviews } = recordingPort(1, { failApplyOnce: true, replace: true });
  await mount(port);
  expect(host.textContent).toContain(m.library_bangumi_intro());
  expect(host.textContent).toContain(m.library_bangumi_not_official());
  const file = new File([envelope(1)], 'collection.json', { type: 'application/json' });
  Object.defineProperty(host.querySelector('input[type="file"]') as HTMLInputElement, 'files', {
    configurable: true,
    value: [file],
  });
  await click(m.library_bangumi_upload());
  expect(previews).toHaveLength(1);
  expect(JSON.parse(previews[0]!).format).toBe(BANGUMI_FORMAT);
  expect(applies).toHaveLength(0);
  expect(host.textContent).toContain('Show 1');
  expect(host.textContent).toContain(m.library_bangumi_rate_none());
  expect(host.textContent).toContain(m.library_bangumi_unknown_summary());
  const target = host.querySelector('[data-bangumi-target]') as HTMLInputElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(target, subject);
    target.dispatchEvent(new window.Event('input', { bubbles: true }));
    await Promise.resolve();
  });
  await click(m.library_bangumi_save_review());
  expect(reviews[0]).toMatchObject({ ordinal: 0, target: subject });
  const replace = [...host.querySelectorAll('label')].find((item) => item.textContent === m.library_bangumi_replace());
  expect(replace).toBeDefined();
  await act(async () => {
    replace!.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await Promise.resolve();
  });
  await click(m.library_bangumi_continue_confirm());
  expect(host.textContent).toContain(subject);
  await click(m.library_bangumi_confirm());
  expect(host.textContent).toContain(m.library_bangumi_uncertain());
  await click(m.library_bangumi_retry_command());
  expect(applies).toHaveLength(2);
  expect(applies[0]).toEqual(applies[1]);
  expect(applies[1]).toMatchObject({
    body: { rows: [{ ordinal: 0, state: 'replace', skip: false }] },
  });
  expect(host.textContent).toContain(m.library_bangumi_result_applied());
  expect(host.textContent).toContain('type');
  expect(host.textContent).toContain('extra_unknown');
});

test('a changed account retires the upload and former-account callbacks', async () => {
  let pages = 0;
  const { port } = recordingPort(1);
  const wrapped: BangumiImportPort = {
    ...port,
    async page(command) {
      pages += 1;
      return port.page(command);
    },
  };
  await mount(wrapped, visit('alice', 'csrf-a'));
  const file = new File([envelope(1)], 'a.json', { type: 'application/json' });
  Object.defineProperty(host.querySelector('input[type="file"]') as HTMLInputElement, 'files', {
    configurable: true,
    value: [file],
  });
  await click(m.library_bangumi_upload());
  expect(host.textContent).toContain('Show 1');
  const seen = pages;
  await mount(wrapped, visit('bob', 'csrf-b'));
  expect(host.textContent).not.toContain('Show 1');
  expect(host.textContent).toContain(m.library_bangumi_upload());
  expect(pages).toBe(seen);
});

test('growth at 10, 50 and 100 rows stays within native page, apply and retained bounds', async () => {
  for (const total of [10, 50, 100]) {
    const { port, applies } = recordingPort(total);
    const journey = createBangumiJourney({ port, visit: visit() });
    await journey.preview(envelope(total));
    let snap = journey.snapshot();
    while (snap.next !== null) snap = await journey.nextPage();
    for (let ordinal = 0; ordinal < total; ordinal += 1) {
      snap = await journey.review(ordinal, ordinal === 0 ? subject : undefined);
      journey.choose(ordinal, { state: 'preserve', skip: false });
    }
    snap = await journey.confirm();
    expect(snap.page.length).toBeLessThanOrEqual(BANGUMI_PAGE);
    expect(snap.meta.length).toBe(total);
    const cost = snap.cost;
    const pages = Math.ceil(total / BANGUMI_PAGE);
    const batches = Math.ceil(total / BANGUMI_APPLY);
    expect(cost.maxPageRows).toBeLessThanOrEqual(BANGUMI_PAGE);
    expect(cost.maxApplyRows).toBeLessThanOrEqual(BANGUMI_APPLY);
    expect(cost.pagesVisited).toBe(pages);
    expect(cost.reviewed).toBe(total);
    expect(cost.applyBatches).toBe(batches);
    expect(cost.calls.preview).toBe(1);
    expect(cost.uploadBytes).toBe(0);
    expect(cost.pageBytes).toBeGreaterThan(0);
    expect(bangumiCallTotal(cost)).toBe(
      expectedBangumiCalls({
        pages: cost.pagesVisited,
        reviews: cost.reviewed,
        applyBatches: cost.applyBatches,
        lifecycle: cost.calls.cancel + cost.calls.delete,
        retries: cost.retries,
      }),
    );
    expect(applies.every((command) => (command as { body: { rows: unknown[] } }).body.rows.length <= BANGUMI_APPLY)).toBe(
      true,
    );
    const discarded = await journey.discard();
    expect(discarded.stage).toBe('removed');
    expect(discarded.page).toEqual([]);
  }
});
