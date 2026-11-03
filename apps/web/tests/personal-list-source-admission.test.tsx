import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import type { AniListImportPort, AniListRow } from '../src/library/personal-anilist-import/contract';
import { createAniListJourney } from '../src/library/personal-anilist-import/controller';
import { aniListCallTotal, expectedAniListCalls } from '../src/library/personal-anilist-import/cost';
import { aniListSourcePreview } from '../src/library/personal-anilist-import/source';
import type { AniListVisit } from '../src/library/personal-anilist-import/visit';
import type { BangumiImportPort, BangumiRow } from '../src/library/personal-bangumi-import/contract';
import { createBangumiJourney } from '../src/library/personal-bangumi-import/controller';
import { bangumiCallTotal, expectedBangumiCalls } from '../src/library/personal-bangumi-import/cost';
import { bangumiSourcePreview } from '../src/library/personal-bangumi-import/source';
import type { BangumiVisit } from '../src/library/personal-bangumi-import/visit';
import type { MalImportPort, MalPage, MalPreviewRow } from '../src/library/personal-mal-import/contract';
import { malSourcePreview } from '../src/library/personal-mal-import/source';
import type { MalVisit } from '../src/library/personal-mal-import/visit';
import { sourceAdmissionBody } from '../src/library/rich-private-entry/admission';

mock.module('cloudflare:workers', () => ({ env: {} }));

const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
);
const window = new Window({ url: 'https://site.test/en/library/import-mal' });
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
const { MalImportPortContext } = await import('../src/library/personal-mal-import/port');
const { PersonalMalImportPage } = await import('../src/library/personal-mal-import/page');

const id = '0192f3a0-6c1e-7b2a-9d4e-00000000aaaa';
const subject = '0192f3a0-6c1e-7b2a-9d4e-00000000bbbb';
const reviewId = '0192f3a0-6c1e-7b2a-9d4e-00000000cccc';
const token = '0192f3a0-6c1e-7b2a-9d4e-00000000dddd';

function visit(): AniListVisit & BangumiVisit & MalVisit {
  const controller = new AbortController();
  let retired = false;
  return {
    subject: 'alice',
    csrfToken: 'csrf-1',
    controller,
    retire() {
      retired = true;
      controller.abort();
    },
    current() {
      return !retired;
    },
  };
}

test('AniList, Bangumi and MAL keep independent identities and honest timestamp precision', () => {
  const anilistId: AniListRow = {
    ordinal: 0,
    source: {
      evidence: { id: 11, private: true, createdAt: 1_700_000_000, updatedAt: null },
      group: null,
      identifiers: [{ source: 'anilist', externalId: '1' }],
      fields: [],
    },
    match: { state: 'unmatched', candidates: [], fingerprint: 'fp' },
    proposal: null,
    review: null,
    started: false,
    outcome: null,
  };
  const anilistMedia: AniListRow = {
    ...anilistId,
    ordinal: 1,
    source: {
      evidence: {},
      group: null,
      identifiers: [{ source: 'anilist', externalId: '22' }],
      fields: [],
    },
  };
  const anilistPreview = aniListSourcePreview(anilistId);
  const mediaPreview = aniListSourcePreview(anilistMedia);
  expect(anilistPreview.recordId).toBe('11');
  expect(mediaPreview.recordId).toBe('22');
  expect(anilistPreview.provider).toBe('anilist');
  expect(sourceAdmissionBody(anilistPreview)).toMatchObject({
    provider: 'anilist',
    recordId: '11',
    confirmReviewed: true,
    privacy: { status: 'known', meaning: 'private' },
    sourceCreated: { status: 'unknown', sourceValue: '1700000000' },
    sourceUpdated: { status: 'unknown' },
  });
  expect(sourceAdmissionBody(mediaPreview)?.privacy).toEqual({ status: 'absent' });

  const bangumiKnown: BangumiRow = {
    ordinal: 0,
    evidence: {
      source: { subject_id: 42, private: false, created_at: '2024-02-29', updated_at: '2024-02-29T23:59:01+08:00' },
      fields: [],
      medium: 'anime',
      stateRole: 'active',
    },
    review: null,
    outcome: null,
  };
  const bangumiBad: BangumiRow = {
    ...bangumiKnown,
    evidence: { ...bangumiKnown.evidence, source: { subject_id: 43, created_at: '2024-02-30' } },
  };
  const known = bangumiSourcePreview(bangumiKnown);
  expect(known.recordId).toBe('42');
  expect(sourceAdmissionBody(known)).toMatchObject({
    provider: 'bangumi',
    recordId: '42',
    privacy: { status: 'known', meaning: 'source_visible' },
    sourceCreated: { status: 'known', value: '2024-02-29' },
    sourceUpdated: { status: 'known', value: '2024-02-29T23:59:01+08:00' },
  });
  expect(sourceAdmissionBody(bangumiSourcePreview(bangumiBad))).toBeNull();

  const malRow: MalPreviewRow = {
    index: 0,
    kind: 'manga',
    title: 'Private manga',
    identifier: { namespace: 'https://myanimelist.net/manga', source: 'mal_manga', value: '7' },
    status: { kind: 'value', value: 'Reading' },
    role: 'active',
    score: { kind: 'zero', value: 0 },
    progress: {},
    dates: {},
    notes: { kind: 'missing' },
    tags: { kind: 'missing' },
    repeats: { kind: 'missing' },
    privacy: { kind: 'value', value: 'private' },
    timestamps: { my_last_updated: { kind: 'value', value: '2024-01-02' } },
    fields: { my_privacy: 'private' },
    retained: [],
    target: subject,
    candidates: [],
    match: 'matched',
    state: 'active',
    current: null,
    binding: null,
    source: null,
    review: null,
    outcome: null,
  };
  const mal = malSourcePreview(malRow);
  expect(mal.recordId).toBe('manga/7');
  expect(sourceAdmissionBody(mal)).toMatchObject({
    provider: 'mal',
    recordId: 'manga/7',
    privacy: { status: 'known', meaning: 'private' },
    sourceCreated: { status: 'absent' },
    sourceUpdated: { status: 'known', value: '2024-01-02' },
  });
});

test('AniList and Bangumi admit after apply, retry the original admission, and skip import cost', async () => {
  const admits: unknown[] = [];
  let admitAttempts = 0;
  const aniPort: AniListImportPort = {
    async preview() {
      return { kind: 'previewed', importId: id, count: 1 };
    },
    async page() {
      return {
        kind: 'page',
        page: {
          importId: id,
          header: { document: null, rawUpload: '', scoreFormat: 'POINT_10', count: 1, cancelled: false },
          completeness: { wrapper: 'array', hasNextChunk: false, listedGroups: 0 },
          rows: [
            {
              ordinal: 0,
              source: {
                evidence: { id: 11, private: true, createdAt: 1_700_000_000 },
                group: null,
                identifiers: [{ source: 'anilist', externalId: '1' }],
                fields: [],
              },
              match: { state: 'unmatched', candidates: [], fingerprint: 'fp' },
              proposal: null,
              review: null,
              started: false,
              outcome: null,
            },
          ],
          next: null,
        },
      };
    },
    async review(command) {
      return {
        kind: 'reviewed',
        ordinal: 0,
        review: {
          id: reviewId,
          commandKey: command.key,
          clientId: 'client-1',
          requestedBy: null,
          match: { state: 'unmatched', candidates: [], fingerprint: 'fp' },
          observation: {
            subjectId: subject,
            epoch: '1',
            pin: null,
            proposedState: 'active',
            current: null,
            states: [{ id: 'active', role: 'active' }],
          },
          input: { fields: ['status'], replace: false, subjectId: subject },
        },
      };
    },
    async apply() {
      return {
        kind: 'applied',
        result: { outcomes: [{ ordinal: 0, status: 'applied', retained: [] }], complete: true },
      };
    },
    async admitSource(command) {
      admits.push(JSON.parse(JSON.stringify(command)));
      admitAttempts += 1;
      if (admitAttempts === 1) return { kind: 'unknown', command };
      if (admitAttempts === 2) return { kind: 'conflict' };
      return { kind: 'admitted' };
    },
    async cancel() {
      return { kind: 'cancelled', removed: true };
    },
  };
  const aniVisit = visit();
  const ani = createAniListJourney({ port: aniPort, visit: aniVisit });
  await ani.preview('[]', 'POINT_10');
  await ani.review(0, subject);
  ani.openConfirm();
  ani.confirmSource({ privacy: true, timestamps: true });
  let snap = await ani.confirm();
  expect(snap.notice).toMatchObject({ kind: 'unknown' });
  expect(admits).toHaveLength(1);
  const first = admits[0] as { key: string; body: { recordId: string } };
  expect(first.body.recordId).toBe('11');
  snap = await ani.retryUnknown();
  expect(admits).toHaveLength(2);
  expect((admits[1] as { key: string }).key).toBe(first.key);
  expect(snap.meta[0]?.sourceAdmission).toEqual({ status: 'conflict' });
  expect(aniListCallTotal(snap.cost)).toBe(
    expectedAniListCalls({
      pages: snap.cost.pagesVisited,
      reviews: snap.cost.reviewed,
      applyBatches: snap.cost.applyBatches,
      lifecycle: snap.cost.calls.cancel,
      retries: snap.cost.retries,
    }),
  );
  aniVisit.retire();
  await ani.retryUnknown();
  expect(admits).toHaveLength(2);

  const bangumiAdmits: unknown[] = [];
  const bangumiPort: BangumiImportPort = {
    async preview() {
      return { kind: 'previewed', uploadId: id, count: 2 };
    },
    async page() {
      return {
        kind: 'page',
        page: {
          uploadId: id,
          cancelled: false,
          rows: [
            {
              ordinal: 0,
              evidence: {
                source: { subject_id: 42, private: true, created_at: '2024-02-29', updated_at: '2024-02-29' },
                fields: [],
                medium: 'anime',
                stateRole: 'active',
              },
              review: null,
              outcome: null,
            },
            {
              ordinal: 1,
              evidence: {
                source: { subject_id: 43, created_at: '2024-02-30' },
                fields: [],
                medium: 'anime',
                stateRole: 'active',
              },
              review: null,
              outcome: null,
            },
          ],
          next: null,
        },
      };
    },
    async review(command) {
      return {
        kind: 'reviewed',
        ordinal: command.ordinal,
        review: {
          token: `${token.slice(0, -1)}${command.ordinal}`,
          match: 'chosen',
          candidates: [],
          target: subject,
          guard: null,
          proposedState: 'active',
          current: null,
          conflict: false,
        },
      };
    },
    async apply(command) {
      return {
        kind: 'applied',
        result: {
          uploadId: id,
          remaining: [],
          outcomes: command.body.rows.map((row) => ({
            ordinal: row.ordinal,
            status: 'applied' as const,
            applied: ['type'],
            retained: [],
          })),
        },
      };
    },
    async admitSource(command) {
      bangumiAdmits.push(JSON.parse(JSON.stringify(command)));
      return { kind: 'admitted' };
    },
    async cancel() {
      return { kind: 'cancelled', uploadId: id };
    },
    async delete() {
      return { kind: 'deleted' };
    },
  };
  const bangumi = createBangumiJourney({ port: bangumiPort, visit: visit() });
  await bangumi.preview('{"format":"rezics.bangumi-collection.v1","collections":[]}');
  await bangumi.review(0, subject);
  await bangumi.review(1, subject);
  bangumi.openConfirm();
  bangumi.confirmSource({ privacy: true, timestamps: true });
  const bangumiSnap = await bangumi.confirm();
  expect(bangumiAdmits).toHaveLength(1);
  expect((bangumiAdmits[0] as { body: { recordId: string } }).body.recordId).toBe('42');
  expect(bangumiSnap.meta[1]?.sourceAdmission?.status).toBe('unsupported');
  expect(bangumiCallTotal(bangumiSnap.cost)).toBe(
    expectedBangumiCalls({
      pages: bangumiSnap.cost.pagesVisited,
      reviews: bangumiSnap.cost.reviewed,
      applyBatches: bangumiSnap.cost.applyBatches,
      lifecycle: bangumiSnap.cost.calls.cancel + bangumiSnap.cost.calls.delete,
      retries: bangumiSnap.cost.retries,
    }),
  );
});

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

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

test('MAL confirmation requires privacy and timestamp checks on keyboard-sized controls', async () => {
  const admits: unknown[] = [];
  let current: MalPreviewRow = {
    index: 0,
    kind: 'anime',
    title: 'Private anime',
    identifier: { namespace: 'https://myanimelist.net/anime', source: 'mal_anime', value: '9' },
    status: { kind: 'value', value: 'Watching' },
    role: 'active',
    score: { kind: 'zero', value: 0 },
    progress: {},
    dates: {},
    notes: { kind: 'missing' },
    tags: { kind: 'missing' },
    repeats: { kind: 'missing' },
    privacy: { kind: 'value', value: '1' },
    timestamps: { my_last_updated: { kind: 'value', value: '2024-03-04' } },
    fields: { my_privacy: '1' },
    retained: [],
    target: null,
    candidates: [],
    match: 'unmatched',
    state: 'active',
    current: null,
    binding: null,
    source: null,
    review: null,
    outcome: null,
  };
  const pageOf = (row: MalPreviewRow): MalPage => ({
    id,
    canceled: false,
    total: 1,
    rows: [row],
    sourcePath: `/v1/libraryImports/mal/${id}/source`,
    next: null,
    limits: { bytes: 2_097_152, rows: 500, page: 20 },
  });
  const port: MalImportPort = {
    async preview() {
      return { kind: 'previewed', id };
    },
    async page() {
      return { kind: 'page', page: pageOf(current) };
    },
    async review(command) {
      current = {
        ...current,
        target: command.input.target,
        match: 'matched',
        review: {
          version: command.key,
          target: command.input.target,
          skip: false,
          replace: false,
          state: 'active',
          current: null,
          binding: null,
          source: null,
          conflict: false,
          unsupported: null,
        },
      };
      return { kind: 'reviewed', id };
    },
    async apply() {
      return {
        kind: 'applied',
        result: {
          id,
          stopped: false,
          remaining: [],
          outcomes: [{ row: 0, status: 'applied', applied: ['status'], retained: [], reason: null }],
        },
      };
    },
    async admitSource(command) {
      admits.push(JSON.parse(JSON.stringify(command)));
      return { kind: 'admitted' };
    },
    async cancel() {
      return { kind: 'done', id };
    },
    async delete() {
      return { kind: 'done', id };
    },
  };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const tree = createRootRoute({
    component: () => (
      <QueryClientProvider client={client}>
        <MalImportPortContext.Provider value={port}>
          <PersonalMalImportPage visit={visit()} />
        </MalImportPortContext.Provider>
      </QueryClientProvider>
    ),
  });
  const router = createRouter({
    routeTree: tree,
    history: createMemoryHistory({ initialEntries: ['/en/library/import-mal'] }),
  });
  await router.load();
  await act(async () => {
    root.render(<RouterProvider router={router} />);
  });
  await settle();
  const file = new File(['<myanimelist/>'], 'list.xml', { type: 'text/xml' });
  Object.defineProperty(host.querySelector('input[type="file"]') as HTMLInputElement, 'files', {
    configurable: true,
    value: [file],
  });
  await click(m.library_mal_upload());
  const target = host.querySelector('[data-mal-target]') as HTMLInputElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(target, subject);
    target.dispatchEvent(new window.Event('input', { bubbles: true }));
    await Promise.resolve();
  });
  await click(m.library_mal_save_review());
  await click(m.library_mal_continue_confirm());
  expect(host.querySelector('[data-import-source-record="anime/9"]')).not.toBeNull();
  expect(button(m.library_mal_confirm())?.hasAttribute('disabled')).toBe(true);
  expect([...host.querySelectorAll('[data-slot="checkbox"]')].every((item) => item.className.includes('size-11'))).toBe(
    true,
  );
  expect(host.querySelector('label[for="mal-source-privacy"]')?.className).toContain('min-h-11');
  expect(host.querySelector('label[for="mal-source-timestamps"]')?.className).toContain('min-h-11');
  await clickLabel(m.library_import_source_privacy_confirm());
  expect(button(m.library_mal_confirm())?.hasAttribute('disabled')).toBe(true);
  await clickLabel(m.library_import_source_timestamps_confirm());
  await click(m.library_mal_confirm());
  expect(admits).toHaveLength(1);
  expect(admits[0]).toMatchObject({
    body: {
      provider: 'mal',
      recordId: 'anime/9',
      privacy: { status: 'known', meaning: 'private' },
      sourceCreated: { status: 'absent' },
      sourceUpdated: { status: 'known', value: '2024-03-04' },
    },
  });
  expect(host.querySelector('[data-import-source-admission="admitted"]')).not.toBeNull();
});
