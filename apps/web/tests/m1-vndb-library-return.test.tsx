import { expect, mock, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactNode } from 'react';
import { createVndbJourney } from '../src/library/personal-list-import/controller';
import type { VndbPort, VndbPreview, VndbRow } from '../src/library/personal-list-import/contract';
import { nativeVndbImport } from '../src/library/personal-list-import/native';
import { VndbConfirmPage } from '../src/library/personal-list-import/confirm';
import { VndbResultPage } from '../src/library/personal-list-import/results';
import type { VndbVisit } from '../src/library/personal-list-import/visit';
import { ImportLibraryView } from '../src/library/showcase-import-return/view';
import type { ImportLibraryPage } from '../src/library/showcase-import-return/read';
import { setLocale } from '../src/paraglide/runtime.js';

mock.module('cloudflare:workers', () => ({ env: {} }));
mock.module('../src/session/request', () => ({
  prepareSession: async () => false,
  sessionSubject: (request: Request) => request.headers.get('x-reader') ?? undefined,
  requestCsrfToken: (request: Request) => request.headers.get('x-csrf-token'),
  viewerCredential: (request: Request) => request.headers.get('authorization'),
}));
const { VndbReviewPage } = await import('../src/library/personal-list-import/review');
const { VndbUploadForm } = await import('../src/library/personal-list-import/upload');
const { loadImportLibrary } = await import('../src/library/showcase-import-return/read');

const uploadId = '00000000-0000-4000-8000-000000000001';
const targetId = '00000000-0000-4000-8000-000000000002';
const reviewId = '00000000-0000-4000-8000-000000000003';
const scoreReviewId = '00000000-0000-4000-8000-000000000004';
const question = {
  id: '00000000-0000-4000-8000-000000000005',
  revision: 1,
  meaning: 'enjoyment',
  label: 'Enjoyment',
  grain: 'work' as const,
  scale: { min: 0, max: 20, step: 1 },
  aggregateEffect: 'public-standard-aggregate' as const,
};
const currentVote = { state: 'absent' as const };
const nothing = () => {};
const preview: VndbPreview = {
  uploadId,
  rows: 2,
  limits: {
    bytes: 2097152,
    wireBytes: 12582976,
    depth: 32,
    rows: 5000,
    evidenceBytes: 16777216,
    page: 8,
    uploads: 4,
    lifetimeMs: 86400000,
    applyMs: 5000,
  },
};
const source: VndbRow = {
  ordinal: 0,
  kind: 'vn',
  title: 'とても長い原題 — 繁體中文與日本語を含む物語のタイトル',
  identifier: { provider: 'vndb', kind: 'vn', value: 'v123' },
  labels: ['Playing'],
  suggestedRole: 'active',
  fields: {
    score: { kind: 'value', raw: '07.0', value: 7, scale: { min: 1, max: 10, step: 0.1 } },
    notes: { kind: 'value', raw: 'Private source note', value: 'Private source note' },
  },
  retainedReason: '',
  evidence: { releases: [{ id: 'r456' }] },
  match: { status: 'matched', candidates: [targetId] },
  target: {
    targetId,
    states: [{ id: 'playing', labels: { en: 'Playing', 'zh-Hant': '遊玩中', ja: 'プレイ中' } }],
    baseline: null,
  },
  decision: null,
  scoreDecision: null,
  consumptionDateReview: null,
  consumptionDateOutcome: null,
  nativeScore: {
    question,
    currentVote,
    sourceReason: 'private source',
    exactUnits: 14,
    admission: { status: 'unavailable', reason: 'conditional-admission-unavailable' },
  },
  fieldsTreatment: { state: 'review', score: 'private source', other: 'retain' },
};
function visit(): VndbVisit {
  const controller = new AbortController();
  return {
    subject: targetId,
    csrfToken: 'test-csrf',
    controller,
    current: () => !controller.signal.aborted,
    retire: () => controller.abort(),
  };
}
function port(overrides: Partial<VndbPort>): VndbPort {
  const unavailable = async () => ({ kind: 'unavailable' as const, status: 503 });
  return {
    preview: unavailable,
    page: unavailable,
    source: unavailable,
    review: unavailable,
    apply: unavailable,
    cancel: unavailable,
    delete: unavailable,
    ...overrides,
  };
}
async function render(node: ReactNode) {
  const client = new QueryClient();
  const router = createRouter({
    routeTree: createRootRoute({ component: () => node }),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  });
  await router.load();
  const html = renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  client.clear();
  return html;
}

// Focused composition with generated native request/results; the seeded walkthrough is deferred to integration.
test('XML → exact target/state review → explicit selected apply → a separately read current Library in three locales', async () => {
  const requests: { path: string; body: unknown; url: string }[] = [];
  const entryPage: ImportLibraryPage = {
    libraryEntries: [
      {
        subjectId: targetId,
        state: 'playing',
        revision: 2,
        createdAt: '2026-11-04T00:00:00Z',
        updatedAt: '2026-11-04T00:01:00Z',
        subject: {
          id: targetId,
          creativeWork: true,
          type: 'schema:VideoGame',
          types: ['schema:VideoGame'],
          label: { value: '現在のライブラリの題名', language: 'ja' },
          cover: null,
        },
      },
    ],
    next: null,
  };
  const client = createKernelClient('http://example.invalid', {
    fetch: Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        const path = new URL(request.url).pathname;
        const body = request.method === 'POST' ? await request.json() : null;
        requests.push({ path, body, url: request.url });
        if (path.endsWith(':preview')) return Response.json(preview);
        if (path.endsWith(':review') && (body as { action?: string }).action === 'score')
          return Response.json({
            reviewId: scoreReviewId,
            status: 'reviewed',
            targetId,
            action: 'vote',
            units: 14,
            question,
            currentVote,
            consent: 'adopt-native-vote',
            sourceReason: 'exact source units',
            nativeAdmission: 'unavailable',
          });
        if (path.endsWith(':review'))
          return Response.json({
            reviewId,
            status: 'reviewed',
            targetId,
            state: 'playing',
            baseline: null,
            replace: false,
            action: 'state',
          });
        if (path.endsWith(':apply')) {
          const rows = (body as { rows: { ordinal: number; reviewId?: string; scoreReviewId?: string }[] }).rows;
          return Response.json({
            uploadId,
            outcomes: rows.map((row) =>
              row.scoreReviewId
                ? { ordinal: row.ordinal, scoreReviewId: row.scoreReviewId, status: 'unavailable' }
                : { ordinal: row.ordinal, reviewId: row.reviewId, status: 'applied' },
            ),
            stopped: null,
          });
        }
        if (path.endsWith('/libraryEntries')) return Response.json(entryPage);
        return Response.json({
          uploadId,
          state: 'active',
          expiresAt: '2099-01-01T00:00:00Z',
          total: 2,
          next: null,
          rows: [source, { ...source, ordinal: 1, match: { status: 'unmatched', candidates: [] }, target: null }],
        });
      },
      { preconnect: fetch.preconnect },
    ),
  });
  const route = nativeVndbImport(client)!;
  const uploaded = route({ uploadId });
  const journey = createVndbJourney({
    visit: visit(),
    port: port({
      preview: async (command) => ({
        kind: 'previewed',
        value: (await route.$preview.post({ xml: command.xml })).data!,
      }),
      page: async () => ({ kind: 'page', value: (await uploaded.get({ query: { offset: 0 } })).data! }),
      review: async (command) => ({ kind: 'reviewed', value: (await uploaded.$review.post(command.body)).data! }),
      apply: async (command) => ({ kind: 'applied', value: (await uploaded.$apply.post(command.body)).data! }),
    }),
  });
  const file = new File(
    ['<vndb-export version="1.0"><vns><vn id="v123"><title>原題</title><vote>7.0</vote></vn></vns></vndb-export>'],
    'vndb.xml',
  );
  await journey.preview(await file.text());
  expect(requests[0]?.body).toEqual({ xml: await file.text() });
  expect(journey.snapshot().selection).toEqual([]);
  for (const locale of ['en', 'zh-Hant', 'ja'] as const) {
    setLocale(locale, { reload: false });
    const upload = await render(<VndbUploadForm busy={false} onUpload={nothing} onReadFailure={nothing} />);
    expect(upload).toContain('type="file"');
    const review = await render(
      <VndbReviewPage
        snap={journey.snapshot()}
        busy={false}
        onReview={nothing}
        onNext={nothing}
        onPrevious={nothing}
        onRefresh={nothing}
        onConfirm={nothing}
        onSource={nothing}
        onHideSource={nothing}
      />,
    );
    expect(review).toContain(source.title);
    expect(review).toContain('v123');
    expect(review).toContain('r456');
    expect(review).toContain('07.0');
    expect(review).toContain('Enjoyment');
    expect(review).toContain('14');
    expect(review).toContain('data-vndb-score-review="pending"');
    expect(review).toContain('aria-pressed="false"');
  }
  setLocale('en', { reload: false });
  await journey.review({
    ordinal: 0,
    action: 'score',
    targetId,
    questionId: question.id,
    questionRevision: question.revision,
    selection: { kind: 'vote', units: 14 },
    consent: 'adopt-native-vote',
  });
  await journey.review({ ordinal: 0, action: 'state', targetId, state: 'playing', replace: false });
  expect(journey.snapshot().selectedEffects).toBe(2);
  const confirm = await render(
    <VndbConfirmPage snap={journey.openConfirm()} busy={false} onBack={nothing} onConfirm={nothing} />,
  );
  expect(confirm).toContain('data-vndb-confirm="0"');
  expect(confirm).not.toContain('data-vndb-confirm="1"');
  expect(requests.some((row) => row.path.endsWith(':apply'))).toBe(false);
  const result = await journey.confirm();
  expect(requests.filter((row) => row.path.endsWith(':apply')).map((row) => row.body)).toEqual([
    { rows: [{ ordinal: 0, reviewId }] },
    { rows: [{ ordinal: 0, scoreReviewId }] },
  ]);
  const results = await render(
    <VndbResultPage snap={result} busy={false} onResume={nothing} onReview={nothing} onDiscard={nothing} />,
  );
  expect(results).toContain('data-vndb-result="applied"');
  expect(results).toContain('data-vndb-result="unavailable"');
  expect(results).toContain(reviewId);
  expect(results).toContain(scoreReviewId);
  const request = new Request('https://example.invalid/library/import-return', {
    headers: { authorization: 'Bearer current-reader', 'x-reader': 'reader-1', 'x-csrf-token': 'csrf-1' },
  });
  const fresh = await loadImportLibrary(
    client,
    request,
    {},
    {
      expectedReader: 'reader-1',
      expectedCredential: 'csrf-1',
    },
  );
  expect(fresh.state).toBe('current');
  if (fresh.state !== 'current') throw new Error('Admitted Library read should be current');
  const denied = await loadImportLibrary(
    client,
    request,
    {},
    {
      expectedReader: 'another-reader',
      expectedCredential: 'csrf-1',
    },
  );
  expect(denied).toEqual({ state: 'denied' });
  const libraryRequests = requests.filter((row) => row.path.endsWith('/libraryEntries'));
  expect(libraryRequests).toHaveLength(1);
  const pageRequest = libraryRequests[0]!;
  expect(new URL(pageRequest.url).searchParams.get('limit')).toBe('8');
  const html = await render(<ImportLibraryView result={fresh} busy={false} onRead={nothing} />);
  expect(html).toContain('現在のライブラリの題名');
  expect(html).toContain('/library');
  expect(html).not.toContain('Private source note');
  expect(html).toContain('may not show every imported target');
  await journey.backToReview();
  expect(requests.filter((row) => row.path.endsWith(`/${uploadId}`))).toHaveLength(2);
});

test('refused apply and foreign receipts retain original operands; source replacement removes old review authority immediately', async () => {
  const commands: unknown[] = [];
  const selected = {
    ...source,
    decision: {
      reviewId,
      status: 'reviewed' as const,
      targetId,
      state: 'playing',
      baseline: null,
      replace: false,
      action: 'state' as const,
    },
  };
  const journey = createVndbJourney({
    visit: visit(),
    port: port({
      preview: async () => ({ kind: 'previewed', value: preview }),
      page: async () => ({
        kind: 'page',
        value: { uploadId, state: 'active', expiresAt: '2099-01-01T00:00:00Z', total: 1, next: null, rows: [selected] },
      }),
      apply: async (command) => {
        commands.push(command);
        return commands.length === 1
          ? { kind: 'denied', status: 403 }
          : {
              kind: 'applied',
              value: { uploadId, outcomes: [{ ordinal: 99, reviewId, status: 'applied' }], stopped: null },
            };
      },
    }),
  });
  await journey.preview('<vndb-export version="1.0"/>');
  journey.openConfirm();
  expect((await journey.confirm()).retryCommand).toBe('apply');
  await journey.review({ ordinal: 0, action: 'skip' });
  await journey.preview('<replacement/>');
  await journey.retryUnknown();
  expect(commands[1]).toBe(commands[0]);
  expect(journey.snapshot().outcomes).toEqual([]);
  expect(journey.snapshot().notice?.kind).toBe('unknown');
  const other = createVndbJourney({
    visit: visit(),
    port: port({
      preview: async () => ({ kind: 'previewed', value: preview }),
      page: async () => ({
        kind: 'page',
        value: { uploadId, state: 'active', expiresAt: '2099-01-01T00:00:00Z', total: 1, next: null, rows: [selected] },
      }),
    }),
  });
  await other.preview('<vndb-export version="1.0"/>');
  expect(other.replaceSource()).toMatchObject({
    stage: 'upload',
    rows: [],
    selection: [],
    page: null,
    reviewCurrent: false,
  });
  await other.backToReview();
  expect(other.snapshot().stage).toBe('upload');
});

const { createImportLibraryBrowser } = await import('../src/library/showcase-import-return/browser');
const { importLibraryRows, importLibraryLabels } = await import('../src/library/showcase-import-return/presentation');
const { importLibraryShelfHref, importLibraryWorkHref } =
  await import('../src/library/showcase-import-return/navigation');
const { subjectVisitReturn } = await import('../src/features/pages/subject-visit-navigation');
const recordedLibrary = (await import('../src/kernel/recorded/library-entries.json')).default;
const nativePage: ImportLibraryPage = { libraryEntries: recordedLibrary.libraryEntries.slice(0, 2), next: null };

test('prepared native read carries the exact opaque cursor and original order, and expired cursors require explicit recovery', async () => {
  const queries: URL[] = [];
  let expired = false;
  const client = createKernelClient('https://kernel.invalid', {
    fetch: Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        queries.push(new URL(request.url));
        expect(request.headers.get('authorization')).toBe('Bearer native-reader');
        expect(request.cache).toBe('no-store');
        return expired ? Response.json({ code: 'invalid_cursor' }, { status: 400 }) : Response.json(nativePage);
      },
      { preconnect: fetch.preconnect },
    ),
  });
  const session = { status: 'active', subject: targetId, csrfToken: 'original', accessToken: 'native-reader' };
  const env = {
    AUTH_ISSUER: 'https://auth.invalid',
    API_RESOURCE: 'api',
    WEBSITE_SCOPES: 'scopes',
    WEBSITE_CLIENT_ID: 'web',
    WEBSITE_CLIENT_KEY: 'key',
    SITE_ORIGINS: 'https://site.invalid',
    SESSIONS: { idFromName: (id: string) => id, get: () => ({ credentialIfFresh: async () => session }) },
  } as never;
  const request = () =>
    new Request('https://site.invalid/en/library/import-vndb', {
      headers: {
        cookie: `__Host-rezics_session=${'A'.repeat(43)}`,
        'x-reader': targetId,
        'x-csrf-token': session.csrfToken,
        authorization: 'Bearer native-reader',
      },
    });
  const expected = { expectedReader: targetId, expectedCredential: 'original' };
  expect((await loadImportLibrary(client, request(), env, expected, 'opaque+/=cursor')).state).toBe('current');
  expect(Object.fromEntries(queries[0]!.searchParams)).toEqual({
    view: 'FULL',
    limit: '8',
    cursor: 'opaque+/=cursor',
    orderBy: 'lastActivity',
    direction: 'desc',
  });
  expired = true;
  expect(await loadImportLibrary(client, request(), env, expected, 'opaque+/=cursor')).toEqual({ state: 'expired' });
  expect(queries).toHaveLength(2);
  session.csrfToken = 'replacement';
  expect(await loadImportLibrary(client, request(), env, expected)).toEqual({ state: 'denied' });
  expect(queries).toHaveLength(2);
  expect(
    await loadImportLibrary(client, new Request('https://site.invalid/en/library/import-vndb'), {}, expected),
  ).toEqual({ state: 'signed-out' });
});

test('native page replacement preserves duplicate associations, sparse continuation, exact retry, refresh and first-page restart', async () => {
  const cursors: (string | undefined)[] = [];
  const duplicate = { ...nativePage.libraryEntries[0]!, subjectId: nativePage.libraryEntries[1]!.subjectId };
  const first = {
    state: 'current' as const,
    page: { libraryEntries: [nativePage.libraryEntries[0]!, duplicate], next: 'next' },
  };
  const sparse = { state: 'current' as const, page: { libraryEntries: [], next: 'after-sparse' } };
  const pending = Promise.withResolvers<Awaited<ReturnType<typeof loadImportLibrary>>>();
  let nextAttempts = 0;
  const browser = createImportLibraryBrowser({
    current: () => true,
    read: async (cursor) => {
      cursors.push(cursor);
      if (!cursor) return first;
      if (cursor === 'next' && ++nextAttempts === 1) return pending.promise;
      return cursor === 'next' ? sparse : { state: 'current', page: nativePage };
    },
  });
  await browser.first();
  expect(browser.snapshot().visible?.page.libraryEntries).toHaveLength(2);
  const next = browser.next();
  expect(browser.snapshot().pending?.kind).toBe('next');
  expect(browser.snapshot().visible).toBe(first);
  pending.resolve({ state: 'unavailable' });
  await next;
  expect(browser.snapshot().visible).toBe(first);
  expect(browser.snapshot().cursor).toBeNull();
  const failed = await render(
    <ImportLibraryView result={null} busy={false} snapshot={browser.snapshot()} onRead={nothing} />,
  );
  expect(failed.match(/data-vndb-current-entry=/g)).toHaveLength(2);
  expect(failed).toContain('Retry the failed page');
  expect(failed).not.toContain('This native page has no continuation');
  expect(failed).not.toContain('Private source note');
  await browser.retry();
  expect(browser.snapshot()).toMatchObject({ cursor: 'next', previous: null, visible: sparse });
  const sparseHtml = await render(
    <ImportLibraryView result={null} busy={false} snapshot={browser.snapshot()} onRead={nothing} />,
  );
  expect(sparseHtml).toContain('data-vndb-browse-empty="sparse"');
  expect(sparseHtml).toContain('Next page');
  await browser.next();
  expect(browser.snapshot().visible?.page.libraryEntries).toHaveLength(2);
  await browser.refresh();
  await browser.previous();
  await browser.restart();
  expect(cursors).toEqual([undefined, 'next', 'next', 'after-sparse', 'after-sparse', 'next', undefined]);
  expect(browser.snapshot().previous).toBeUndefined();
  expect(browser.snapshot().visible).toBe(first);
});

test('current row presentation and public Work return keep native identities, localized labels and supplied progress separate from XML', async () => {
  const first = nativePage.libraryEntries[0]!;
  const page: ImportLibraryPage = {
    libraryEntries: [
      {
        ...first,
        state: 'undisplayed-native-state',
        activeProgressSession: {
          mode: 'scalar_amount',
          unit: 'page',
          amount: '3',
          total: '10',
          completedUnitCount: 0,
          locator: null,
        },
      },
      { ...first, subject: null },
    ],
    next: null,
  };
  for (const locale of ['en', 'zh-Hant', 'ja'] as const) {
    setLocale(locale, { reload: false });
    const labels = importLibraryLabels(page, locale);
    const rows = importLibraryRows(page, locale, labels);
    expect(rows[0]!.progress?.text).toBe('3 / 10');
    expect(rows[1]!.subject).toBeNull();
    expect(importLibraryWorkHref(rows[1]!, locale)).toBeUndefined();
    const href = new URL(importLibraryWorkHref(rows[0]!, locale)!, 'https://site.invalid');
    expect(href.pathname).toContain(`/subjects/${first.subject!.id}/`);
    expect(href.searchParams.get('via')).toBe(`/${locale}/library/import-vndb#vndb-current-library`);
    expect(
      subjectVisitReturn(`/${locale}/library/import-vndb?cursor=private#vndb-current-library`, locale),
    ).toBeUndefined();
    const shelf = new URL(importLibraryShelfHref(locale, 'grid', 'l'), 'https://site.invalid');
    expect(Object.fromEntries(shelf.searchParams)).toEqual({
      orderBy: 'lastActivity',
      direction: 'desc',
      layout: 'grid',
      size: 'l',
    });
    for (const layout of ['list', 'grid', 'table'] as const) {
      const html = await render(
        <ImportLibraryView result={{ state: 'current', page, labels }} busy={false} layout={layout} onRead={nothing} />,
      );
      expect(html.match(/data-vndb-current-entry=/g)).toHaveLength(2);
      expect(html).not.toContain('undisplayed-native-state');
      expect(html).not.toContain('07.3');
      expect(html).not.toContain('Private source note');
    }
  }
  setLocale('en', { reload: false });
});

test('old visit pages cannot attach after replacement, and native loss of access closes private rows', async () => {
  let current = true;
  const late = Promise.withResolvers<Awaited<ReturnType<typeof loadImportLibrary>>>();
  const browser = createImportLibraryBrowser({ current: () => current, read: () => late.promise });
  const reading = browser.first();
  current = false;
  expect(browser.current()).toBe(false);
  current = true;
  late.resolve({ state: 'current', page: nativePage });
  await reading;
  await browser.first();
  expect(browser.snapshot()).toMatchObject({ retired: true, visible: null, pending: null });
  for (const state of ['closed', 'denied', 'signed-out'] as const) {
    let first = true;
    const active = createImportLibraryBrowser({
      current: () => true,
      read: async () => {
        if (first) {
          first = false;
          return { state: 'current', page: nativePage };
        }
        return { state };
      },
    });
    await active.first();
    await active.refresh();
    expect(active.snapshot().visible).toBeNull();
    expect(active.snapshot().failed?.result.state).toBe(state);
  }
});
