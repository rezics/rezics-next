import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import {
  ANILIST_APPLY,
  ANILIST_PAGE,
  type AniListImportPort,
  type AniListPage,
  type AniListReview,
  type AniListRow,
} from '../src/library/personal-anilist-import/contract';
import { aniListCallTotal, expectedAniListCalls } from '../src/library/personal-anilist-import/cost';
import { createAniListJourney } from '../src/library/personal-anilist-import/controller';
import { libraryNavigation } from '../src/library/navigation';
import type { AniListVisit } from '../src/library/personal-anilist-import/visit';

mock.module('cloudflare:workers', () => ({ env: {} }));

const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
);
const window = new Window({ url: 'https://site.test/en/library/import-anilist' });
for (const [key, value] of Object.entries({
  window,
  document: window.document,
  navigator: window.navigator,
  HTMLElement: window.HTMLElement,
  HTMLButtonElement: window.HTMLButtonElement,
  HTMLInputElement: window.HTMLInputElement,
  HTMLSelectElement: window.HTMLSelectElement,
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
const { AniListImportPortContext } = await import('../src/library/personal-anilist-import/port');
const { PersonalAniListImportPage } = await import('../src/library/personal-anilist-import/page');

const id = '0192f3a0-6c1e-7b2a-9d4e-00000000aaaa';
const subject = '0192f3a0-6c1e-7b2a-9d4e-00000000bbbb';
const reviewId = '0192f3a0-6c1e-7b2a-9d4e-00000000cccc';

const visit = (viewer = 'alice', csrf = 'csrf-1'): AniListVisit => {
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

function envelope(rows: number, extra: { chunk?: boolean; groups?: boolean } = {}): string {
  const entries = Array.from({ length: rows }, (_, index) => ({
    mediaId: extra.groups ? Math.floor(index / 2) + 1 : index + 1,
    status: index % 7 === 6 ? 'REPEATING' : 'CURRENT',
    score: index === 0 ? 0 : 8,
    progress: 0,
    progressVolumes: 0,
    notes: 'private',
    extra_unknown: 'keep',
    media: {
      id: extra.groups ? Math.floor(index / 2) + 1 : index + 1,
      type: index % 2 ? 'MANGA' : 'ANIME',
      title: { userPreferred: `Show ${index + 1}` },
      ...(index === 1 ? { idMal: 99 } : {}),
    },
  }));
  if (extra.groups) {
    return JSON.stringify({
      data: {
        MediaListCollection: {
          hasNextChunk: extra.chunk === true,
          lists: [
            { name: 'Watching', isCustomList: false, entries: entries.filter((_, index) => index % 2 === 0) },
            { name: 'Watching again', isCustomList: true, entries: entries.filter((_, index) => index % 2 === 1) },
          ],
        },
      },
    });
  }
  return JSON.stringify(
    extra.chunk ? { MediaListCollection: { hasNextChunk: true, lists: [{ name: 'Watching', entries }] } } : entries,
  );
}

function source(index: number, group: Record<string, unknown> | null = null): AniListRow['source'] {
  return {
    evidence: {
      mediaId: index + 1,
      status: index % 7 === 6 ? 'REPEATING' : 'CURRENT',
      score: index === 0 ? 0 : 8,
      progress: 0,
      extra_unknown: 'keep',
      notes: 'private',
      media: { id: index + 1, type: index % 2 ? 'MANGA' : 'ANIME', title: { userPreferred: `Show ${index + 1}` } },
    },
    group,
    identifiers: [
      { source: 'anilist', externalId: String(index + 1) },
      ...(index === 1 ? [{ source: 'myanimelist' as const, externalId: '99' }] : []),
    ],
    fields: [
      { field: 'mediaId', validity: 'valid', reason: 'AniList media identifier; never a list entry id' },
      { field: 'status', validity: 'valid', reason: 'Review native state role mapping' },
      { field: 'score', validity: 'valid', reason: 'Original POINT_10; no local vote admission' },
      { field: 'progress', validity: 'valid', reason: 'Original episodes; no historical session admission' },
      { field: 'notes', validity: 'valid', reason: 'No native admission for this field; retained privately' },
      { field: 'extra_unknown', validity: 'unknown', reason: 'No native admission for this field; retained privately' },
    ],
  };
}

function row(index: number, extra: Partial<AniListRow> = {}): AniListRow {
  return {
    ordinal: index,
    source: extra.source ?? source(index),
    match: extra.match ?? { state: 'unmatched', candidates: [], fingerprint: `fp-${index}` },
    proposal: extra.proposal ?? null,
    review: extra.review ?? null,
    started: extra.started ?? false,
    outcome: extra.outcome ?? null,
    ...extra,
  };
}

function reviewed(index: number, changes: Partial<AniListReview> = {}): AniListReview {
  return {
    id: `${reviewId.slice(0, -1)}${index % 10}`,
    commandKey: `cmd-${index}`,
    clientId: 'client-1',
    requestedBy: null,
    match: { state: 'unmatched', candidates: [], fingerprint: `fp-${index}` },
    observation: {
      subjectId: subject,
      epoch: '1',
      pin: null,
      proposedState: 'active',
      current: null,
      states: [{ id: 'active', role: 'active' }],
    },
    input: { fields: ['status'], replace: false, subjectId: subject },
    ...changes,
  };
}

function pageOf(rows: AniListRow[], extra: Partial<AniListPage> = {}): AniListPage {
  return {
    importId: id,
    header: {
      document: null,
      rawUpload: '',
      scoreFormat: 'POINT_10',
      count: rows.length,
      cancelled: false,
    },
    completeness: { wrapper: 'array', hasNextChunk: false, listedGroups: 0 },
    rows,
    next: null,
    ...extra,
  };
}

function recordingPort(
  total: number,
  options: { failApplyOnce?: boolean; replace?: boolean; chunk?: boolean; groups?: boolean; partial?: boolean } = {},
): {
  port: AniListImportPort;
  previews: { upload: string; scoreFormat?: string }[];
  applies: unknown[];
  reviews: unknown[];
  cancels: unknown[];
} {
  const previews: { upload: string; scoreFormat?: string }[] = [];
  const applies: unknown[] = [];
  const reviews: unknown[] = [];
  const cancels: unknown[] = [];
  const tokens = new Map<number, string>();
  let applyAttempts = 0;
  const stored = Array.from({ length: total }, (_, index) =>
    row(index, {
      source: source(index, options.groups ? { name: index % 2 ? 'Watching again' : 'Watching' } : null),
    }),
  );
  const port: AniListImportPort = {
    async preview(command) {
      previews.push({ upload: command.upload, ...(command.scoreFormat ? { scoreFormat: command.scoreFormat } : {}) });
      return { kind: 'previewed', importId: id, count: total };
    },
    async page(command) {
      const start = command.after + 1;
      const slice = stored.slice(start, start + ANILIST_PAGE);
      return {
        kind: 'page',
        page: pageOf(slice, {
          header: {
            document: options.chunk
              ? { MediaListCollection: { hasNextChunk: true, lists: [{ name: 'Watching', entries: [] }] } }
              : stored.map((_, index) => ({ mediaId: index + 1 })),
            rawUpload: envelope(total, { chunk: options.chunk, groups: options.groups }),
            scoreFormat: 'POINT_10',
            count: total,
            cancelled: false,
          },
          completeness: {
            wrapper: options.chunk ? 'MediaListCollection' : options.groups ? 'data' : 'array',
            hasNextChunk: options.chunk === true,
            listedGroups: options.groups ? 2 : 0,
          },
          next: start + slice.length < total ? start + slice.length - 1 : null,
        }),
      };
    },
    async review(command) {
      reviews.push(JSON.parse(JSON.stringify(command)));
      const current = stored[command.ordinal]!;
      const review = reviewed(command.ordinal, {
        match: command.subjectId
          ? { state: 'unmatched', candidates: [], fingerprint: `fp-${command.ordinal}` }
          : current.match,
        observation: {
          subjectId: command.subjectId ?? subject,
          epoch: '1',
          pin: null,
          proposedState: 'active',
          current: options.replace ? { state: 'planned', revision: 4, incarnationId: null } : null,
          states: [{ id: 'active', role: 'active' }],
        },
        input: {
          fields: command.fields,
          replace: command.replace,
          ...(command.skip ? { skip: true } : {}),
          ...(command.subjectId ? { subjectId: command.subjectId } : {}),
        },
      });
      tokens.set(command.ordinal, review.id);
      stored[command.ordinal] = { ...current, review };
      return { kind: 'reviewed', ordinal: command.ordinal, review };
    },
    async apply(command) {
      applies.push(JSON.parse(JSON.stringify(command)));
      applyAttempts += 1;
      if (options.failApplyOnce && applyAttempts === 1) return { kind: 'unknown', command };
      const last = command.body.confirmations.at(-1);
      const outcomes = command.body.confirmations.map((item) => ({
        ordinal: item.ordinal,
        status: options.partial && item.ordinal === last?.ordinal ? ('failed' as const) : ('applied' as const),
        retained: ['mediaId', 'score', 'progress', 'notes', 'extra_unknown'],
      }));
      return {
        kind: 'applied',
        result: { outcomes: options.partial ? outcomes.slice(0, -1) : outcomes, complete: !options.partial },
      };
    },
    async admitSource() {
      return { kind: 'admitted' as const };
    },
    async cancel(command) {
      cancels.push(JSON.parse(JSON.stringify(command)));
      return { kind: 'cancelled', removed: command.remove };
    },
  };
  return { port, previews, applies, reviews, cancels };
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

async function clickLabel(label: string) {
  const target = [...host.querySelectorAll('label')].find((item) => item.textContent === label);
  expect(target).toBeDefined();
  await act(async () => {
    target!.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await Promise.resolve();
  });
  await settle();
}

async function mount(port: AniListImportPort, current = visit()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const tree = createRootRoute({
    component: () => (
      <QueryClientProvider client={client}>
        <AniListImportPortContext.Provider value={port}>
          <PersonalAniListImportPage visit={current} />
        </AniListImportPortContext.Provider>
      </QueryClientProvider>
    ),
  });
  const router = createRouter({
    routeTree: tree,
    history: createMemoryHistory({ initialEntries: ['/en/library/import-anilist'] }),
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

test('navigation keeps a distinct AniList entry beside Bangumi and MyAnimeList', () => {
  expect(libraryNavigation.some((entry) => entry.id === 'library.import-anilist')).toBe(true);
  expect(libraryNavigation.some((entry) => entry.id === 'library.import-bangumi')).toBe(true);
  expect(libraryNavigation.some((entry) => entry.id === 'library.import-mal')).toBe(true);
});

test('preview does not apply, explicit replacement and exact uncertain retry keep operands', async () => {
  const { port, previews, applies, reviews } = recordingPort(1, { failApplyOnce: true, replace: true });
  await mount(port);
  expect(host.textContent).toContain(m.library_anilist_intro());
  expect(host.textContent).toContain(m.library_anilist_not_official());
  expect(host.textContent).toContain(m.library_anilist_whose_upload());
  const file = new File([envelope(1)], 'collection.json', { type: 'application/json' });
  Object.defineProperty(host.querySelector('input[type="file"]') as HTMLInputElement, 'files', {
    configurable: true,
    value: [file],
  });
  const score = host.querySelector('[data-anilist-score-format]') as HTMLSelectElement;
  await act(async () => {
    score.value = 'POINT_10';
    score.dispatchEvent(new window.Event('change', { bubbles: true }));
    await Promise.resolve();
  });
  await click(m.library_anilist_upload());
  expect(previews).toHaveLength(1);
  expect(previews[0]!.scoreFormat).toBe('POINT_10');
  expect(applies).toHaveLength(0);
  expect(host.textContent).toContain('Show 1');
  expect(host.textContent).toContain(m.library_anilist_score_none());
  expect(host.textContent).toContain(m.library_anilist_unknown_summary());
  const target = host.querySelector('[data-anilist-target]') as HTMLInputElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(target, subject);
    target.dispatchEvent(new window.Event('input', { bubbles: true }));
    await Promise.resolve();
  });
  await click(m.library_anilist_save_review());
  expect(reviews[0]).toMatchObject({ ordinal: 0, subjectId: subject, fields: ['status'], replace: false });
  const replace = [...host.querySelectorAll('label')].find((item) => item.textContent === m.library_anilist_replace());
  expect(replace).toBeDefined();
  await act(async () => {
    replace!.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await Promise.resolve();
  });
  await click(m.library_anilist_save_review());
  expect(reviews[1]).toMatchObject({ replace: true, fields: ['status'], subjectId: subject });
  await click(m.library_anilist_continue_confirm());
  expect(host.textContent).toContain(subject);
  expect(host.textContent).toContain(m.library_anilist_confirm_replace());
  await clickLabel(m.library_import_source_privacy_confirm());
  await clickLabel(m.library_import_source_timestamps_confirm());
  await click(m.library_anilist_confirm());
  expect(host.textContent).toContain(m.library_anilist_uncertain());
  await click(m.library_anilist_retry_command());
  expect(applies).toHaveLength(2);
  expect(applies[0]).toEqual(applies[1]);
  expect(applies[1]).toMatchObject({
    body: { confirmations: [{ ordinal: 0, reviewId: `${reviewId.slice(0, -1)}0` }] },
  });
  expect(host.textContent).toContain(m.library_anilist_result_applied());
  expect(host.textContent).toContain('status');
  expect(host.textContent).toContain('extra_unknown');
});

test('a changed account retires the upload and former-account callbacks', async () => {
  let pages = 0;
  const { port } = recordingPort(1);
  const wrapped: AniListImportPort = {
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
  await click(m.library_anilist_upload());
  expect(host.textContent).toContain('Show 1');
  const seen = pages;
  await mount(wrapped, visit('bob', 'csrf-b'));
  expect(host.textContent).not.toContain('Show 1');
  expect(host.textContent).toContain(m.library_anilist_upload());
  expect(pages).toBe(seen);
});

test('repeated groups stay distinct and an incomplete wrapper is never a complete account', async () => {
  const { port } = recordingPort(2, { chunk: true, groups: true });
  await mount(port);
  const file = new File([envelope(2, { chunk: true, groups: true })], 'chunk.json', { type: 'application/json' });
  Object.defineProperty(host.querySelector('input[type="file"]') as HTMLInputElement, 'files', {
    configurable: true,
    value: [file],
  });
  await click(m.library_anilist_upload());
  expect(host.textContent).toContain(m.library_anilist_slice());
  expect(host.textContent).toContain(m.library_anilist_completeness_chunk());
  expect(host.querySelectorAll('[data-anilist-row]').length).toBe(2);
  expect(host.textContent).toContain('Watching');
  expect(host.textContent).toContain('Watching again');
});

test('partial acknowledgement, cancellation and evidence removal stay independent', async () => {
  const { port, applies, cancels } = recordingPort(2, { partial: true });
  const journey = createAniListJourney({ port, visit: visit() });
  await journey.preview(envelope(2), 'POINT_10');
  await journey.review(0, subject);
  await journey.review(1, subject);
  const snap = await journey.confirm();
  expect(snap.outcomes.map((item) => item.status)).toEqual(['applied']);
  expect(snap.remaining).toEqual([1]);
  expect(applies[0]).toMatchObject({ body: { confirmations: [{ ordinal: 0 }, { ordinal: 1 }] } });
  const cancelled = await journey.cancelAdmission();
  expect(cancelled.stage).toBe('results');
  expect(cancels[0]).toMatchObject({ remove: false });
  const removed = await journey.discard();
  expect(removed.stage).toBe('removed');
  expect(removed.page).toEqual([]);
  expect(cancels[1]).toMatchObject({ remove: true });
});

test('growth at 20, 100 and 200 rows stays within native page, apply and retained bounds', async () => {
  for (const total of [20, 100, 200]) {
    const { port, applies } = recordingPort(total);
    const journey = createAniListJourney({ port, visit: visit() });
    await journey.preview(envelope(total), 'POINT_10');
    let snap = journey.snapshot();
    while (snap.next !== null) snap = await journey.nextPage();
    for (let ordinal = 0; ordinal < total; ordinal += 1) {
      snap = await journey.review(ordinal, ordinal === 0 ? subject : undefined);
      journey.choose(ordinal, { skip: false, replace: false, applyStatus: true });
    }
    snap = await journey.confirm();
    expect(snap.page.length).toBeLessThanOrEqual(ANILIST_PAGE);
    expect(snap.meta.length).toBe(total);
    const cost = snap.cost;
    const pages = Math.ceil(total / ANILIST_PAGE);
    const batches = Math.ceil(total / ANILIST_APPLY);
    expect(cost.maxPageRows).toBeLessThanOrEqual(ANILIST_PAGE);
    expect(cost.maxApplyRows).toBeLessThanOrEqual(ANILIST_APPLY);
    expect(cost.pagesVisited).toBe(pages);
    expect(cost.reviewed).toBe(total);
    expect(cost.applyBatches).toBe(batches);
    expect(cost.calls.preview).toBe(1);
    expect(cost.uploadBytes).toBe(0);
    expect(cost.pageBytes).toBeGreaterThan(0);
    expect(cost.processed).toBeGreaterThan(total);
    expect(aniListCallTotal(cost)).toBe(
      expectedAniListCalls({
        pages: cost.pagesVisited,
        reviews: cost.reviewed,
        applyBatches: cost.applyBatches,
        lifecycle: cost.calls.cancel,
        retries: cost.retries,
      }),
    );
    expect(
      applies.every(
        (command) => (command as { body: { confirmations: unknown[] } }).body.confirmations.length <= ANILIST_APPLY,
      ),
    ).toBe(true);
    const discarded = await journey.discard();
    expect(discarded.stage).toBe('removed');
    expect(discarded.page).toEqual([]);
    expect(discarded.cost.retainedBytes).toBe(0);
  }
});
