import { expect, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { ArchiveEntryRecoveryJourney } from '../src/library/archive-entry-recovery/controller';
import {
  archiveRecoveryNative,
  type ArchiveReviewItem,
  type ArchiveRow,
  type NativeArchivePreview,
  type NativeArchiveResults,
  type NativeArchiveStatus,
} from '../src/library/archive-entry-recovery/native';
import { ArchiveEntryRecoveryView } from '../src/library/archive-entry-recovery/page';

const id = '019a1b2c-3d4e-7f00-8a00-000000000001';
const subjectId = '019a1b2c-3d4e-7f00-8a00-000000000002';
const labelId = '019a1b2c-3d4e-7f00-8a00-000000000003';
const binding = {
  viewer: 'owner',
  credentialEpoch: 'epoch',
  csrfEpoch: 'epoch',
  admission: 'admission-1',
  source: 'archive',
  route: '/library/recover-archive',
  locale: 'en',
  exposure: 'open',
};
const status: NativeArchiveStatus = {
  uploadId: id,
  createdAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
  state: 'ready',
  rows: 6,
  recordBytes: 330,
  coverage: [
    { section: 'entries', rows: 1, capture: 'present', treatment: 'requires-explicit-mapping' },
    { section: 'labels', rows: 1, capture: 'present', treatment: 'requires-explicit-mapping' },
    { section: 'assignments', rows: 1, capture: 'present', treatment: 'requires-explicit-mapping' },
    { section: 'annotations', rows: 1, capture: 'present', treatment: 'requires-explicit-mapping' },
    { section: 'journals', rows: 2, capture: 'present', treatment: 'requires-explicit-mapping' },
    { section: 'sessions', rows: 0, capture: 'empty', treatment: 'retained-unsupported' },
  ],
};
const previewPage = (records: ArchiveRow[], next: number | null): NativeArchivePreview => ({
  uploadId: id,
  state: 'ready',
  coverage: status.coverage,
  records,
  next,
});
const resultPage = (results: NativeArchiveResults['results'], next: number | null): NativeArchiveResults => ({
  uploadId: id,
  state: 'ready',
  results,
  next,
});

function fixture() {
  const calls: {
    path: string;
    method: string;
    body: string;
    authorization: string | null;
    key: string | null;
    query?: string;
    after?: number;
  }[] = [];
  let revision = 0;
  let unknown = true;
  let stale = false;
  let refuseReplay = false;
  let current: typeof binding | null = binding;
  let applied = false;
  let resultReads = 0;
  let cancelUnknown = false;
  let previewPages: ReadonlyMap<number, NativeArchivePreview> | null = null;
  let resultPages: ReadonlyMap<number, NativeArchiveResults> | null = null;
  const previewFailures = new Map<number, number>();
  const resultFailures = new Map<number, number>();
  const rows: ArchiveRow[] = [
    {
      ordinal: 0,
      section: 'entries',
      evidence: { subject_id: 'old-source', state: 'old-state' },
      status: 'unresolved',
      review: null,
      reviewRevision: 0,
    },
    {
      ordinal: 1,
      section: 'labels',
      evidence: { name: 'Old name' },
      status: 'unresolved',
      review: null,
      reviewRevision: 0,
    },
    {
      ordinal: 2,
      section: 'assignments',
      evidence: { subject_id: 'old-source', label_id: 'old-label' },
      status: 'unresolved',
      review: null,
      reviewRevision: 0,
    },
    {
      ordinal: 3,
      section: 'annotations',
      evidence: {
        subject_id: subjectId,
        incarnation_id: '019a1b2c-3d4e-7f00-8a00-000000000005',
        note: 'Archived note',
        priority: 4,
      },
      status: 'unresolved',
      review: null,
      reviewRevision: 0,
    },
    {
      ordinal: 4,
      section: 'journals',
      evidence: {
        subject_id: subjectId,
        session_id: '019a1b2c-3d4e-7f00-8a00-000000000006',
        start_date: { year: 2005 },
        finish_date: { year: 2006, month: 2 },
        reflection: 'Exact archived reflection',
      },
      status: 'unresolved',
      review: null,
      reviewRevision: 0,
    },
    {
      ordinal: 5,
      section: 'journals',
      evidence: {
        subject_id: subjectId,
        session_id: '019a1b2c-3d4e-7f00-8a00-000000000004',
        start_date: { year: 2004 },
        reflection: 'private',
      },
      status: 'unresolved',
      review: null,
      reviewRevision: 0,
    },
  ];
  let reviewedItems: ArchiveReviewItem[] = [];
  const client = createKernelClient('https://kernel.test', {
    fetch: Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        const url = new URL(request.url);
        const path = url.pathname;
        calls.push({
          path,
          method: request.method,
          body: await request.text(),
          authorization: request.headers.get('authorization'),
          key: request.headers.get('idempotency-key'),
          ...(url.search ? { query: url.search } : {}),
          ...(url.searchParams.has('after') ? { after: Number(url.searchParams.get('after')) } : {}),
        });
        if (path === '/v1/libraryArchiveMerges') return Response.json(status);
        if (path.endsWith('/preview')) {
          const after = Number(url.searchParams.get('after'));
          if (previewFailures.get(after)) {
            previewFailures.set(after, previewFailures.get(after)! - 1);
            return Response.json({ code: 'temporarily_unavailable' }, { status: 503 });
          }
          return Response.json(previewPages?.get(after) ?? previewPage(rows, null));
        }
        if (path.endsWith('/review')) {
          revision++;
          const { items } = JSON.parse(calls.at(-1)!.body);
          reviewedItems = items;
          for (const item of items) {
            const index = rows.findIndex((candidate) => candidate.ordinal === item.ordinal);
            const row = rows[index]!;
            rows[index] = {
              ...row,
              review:
                item.kind === 'annotation'
                  ? { current: { note: 'Current note', priority: 0, annotationRevision: 8 } }
                  : item.kind === 'journal'
                    ? {
                        current: {
                          startDate: null,
                          finishDate: null,
                          reflection: 'Current reflection',
                          assessment: { meaningRevision: 1, units: 0 },
                          revision: 3,
                        },
                      }
                    : { current: { revision: 8 } },
              status: 'current_conflict',
              reviewRevision: revision,
            };
          }
          return Response.json({
            uploadId: id,
            reviewed: items.map(({ ordinal }: { ordinal: number }) => ({
              ordinal,
              reviewRevision: revision,
              status: 'current_conflict',
            })),
          });
        }
        if (path.endsWith('/apply')) {
          if (refuseReplay || stale) return Response.json({ code: 'conflict' }, { status: 409 });
          applied = true;
          if (unknown) return Response.json({ code: 'temporarily_unavailable' }, { status: 503 });
          const { items } = JSON.parse(calls.at(-1)!.body) as { items: { ordinal: number }[] };
          return Response.json({
            uploadId: id,
            applied: items.map(({ ordinal }) => {
              const item = reviewedItems.find((item) => item.ordinal === ordinal)!;
              return {
                ordinal,
                status: 'acknowledged',
                result:
                  item.kind === 'entry'
                    ? { effect: 'entry.put', subjectId, state: 'planned' }
                    : item.kind === 'label'
                      ? { effect: 'label.create', labelId }
                      : item.kind === 'assignment'
                        ? { effect: 'label.assign', subjectId }
                        : item.kind === 'annotation'
                          ? { subjectId: item.subjectId, incarnationId: item.incarnationId, annotationRevision: 9 }
                          : { subjectId: item.subjectId, sessionId: item.sessionId, revision: 4 },
              };
            }),
          });
        }
        if (path.endsWith('/personal'))
          return Response.json({
            personalEntry: {
              subjectId,
              annotationRevision: 9,
              note: 'Current note',
              priority: 0,
              annotationUpdatedAt: null,
              sourceObservations: [],
            },
          });
        if (path.endsWith('/journal'))
          return Response.json({
            journal: {
              sessionId: '019a1b2c-3d4e-7f00-8a00-000000000006',
              revision: 4,
              startDate: { year: 2005 },
              finishDate: { year: 2006, month: 2 },
              reflection: 'Exact archived reflection',
              assessment: { meaningRevision: 1, units: 0 },
            },
          });
        if (path.includes('/libraryEntries/'))
          return Response.json({ libraryEntry: { subjectId, state: 'in_progress', revision: 8 } });
        if (path.endsWith('/libraryLabelAssignments'))
          return Response.json({
            label: { id: labelId, name: 'Current renamed label', revision: 3 },
            assignments: [],
            next: null,
          });
        if (path.endsWith('/results')) {
          const after = Number(url.searchParams.get('after'));
          if (resultFailures.get(after)) {
            resultFailures.set(after, resultFailures.get(after)! - 1);
            return Response.json({ code: 'temporarily_unavailable' }, { status: 503 });
          }
          if (resultPages) return Response.json(resultPages.get(after)!);
          return Response.json({
            uploadId: id,
            state: 'ready',
            results:
              applied && resultReads++ === 0
                ? [
                    {
                      ordinal: 0,
                      section: 'entries',
                      status: 'acknowledged',
                      result: { effect: 'entry.put', subjectId },
                    },
                  ]
                : [],
            next: null,
          });
        }
        if (request.method === 'DELETE' && cancelUnknown)
          return Response.json({ code: 'temporarily_unavailable' }, { status: 503 });
        return Response.json(status);
      },
      { preconnect: fetch.preconnect },
    ),
  });
  const journey = new ArchiveEntryRecoveryJourney(
    archiveRecoveryNative(client, 'Bearer original-sender'),
    () => current,
    Date.now() + 60_000,
  );
  return {
    journey,
    calls,
    applied: () => applied,
    acknowledge: () => {
      unknown = false;
    },
    cancellation: (unknown: boolean) => {
      cancelUnknown = unknown;
    },
    stale: () => {
      stale = true;
    },
    refuse: () => {
      refuseReplay = true;
    },
    retire: () => {
      current = null;
    },
    pages: (
      previews: ReadonlyMap<number, NativeArchivePreview>,
      results: ReadonlyMap<number, NativeArchiveResults>,
    ) => {
      previewPages = previews;
      resultPages = results;
    },
    failPreviewOnce: (after: number) => previewFailures.set(after, 1),
    failResultsOnce: (after: number) => resultFailures.set(after, 1),
  };
}

// Transport fixtures exercise the mounted receiving composition; native artifact acceptance has its own fixture.
test('Original text, displayed revisions, original retry, cancellation and current readback stay distinct', async () => {
  const f = fixture();
  try {
    const raw = ' {"manifest":{}, "records":[]}\n';
    await f.journey.upload(new File([raw], 'completed.json'));
    expect(f.calls[0]!.body).toBe(raw);
    expect(f.calls[0]).toMatchObject({
      path: '/v1/libraryArchiveMerges',
      method: 'POST',
      authorization: 'Bearer original-sender',
    });
    expect(f.calls[0]!.key).not.toBeNull();
    f.journey.choose({ ordinal: 0, kind: 'entry', subjectId, stateId: 'planned', action: 'update' });
    f.journey.choose({ ordinal: 1, kind: 'label', target: { mode: 'create' } });
    await f.journey.review();
    const firstReview = f.journey.snapshot().state!.review;
    await f.journey.review();
    expect(f.journey.snapshot().state!.review!.body.items[0]!.reviewRevision).toBe(2);
    expect(firstReview!.body.items[0]!.reviewRevision).toBe(1);
    const html = renderToStaticMarkup(<ArchiveEntryRecoveryView journey={f.journey} />);
    expect(html).toContain('reviewRevision');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Apply confirmed changes/);
    await f.journey.apply();
    expect(f.applied()).toBe(true);
    expect(f.journey.snapshot().state!.phase).toBe('uncertain');
    const original = f.calls.find((call) => call.path.endsWith('/apply'))!;
    await f.journey.results('refresh');
    await f.journey.results('refresh');
    expect(f.journey.snapshot().state!.results!.rows[0]).toMatchObject({
      ordinal: 0,
      status: 'acknowledged',
      subjectId,
    });
    await f.journey.readCurrent(0);
    expect(f.journey.snapshot().readback?.value).toMatchObject({ libraryEntry: { state: 'in_progress' } });
    expect(f.journey.snapshot().state!.phase).toBe('uncertain');
    await f.journey.cancel();
    expect(f.journey.snapshot().state!.phase).toBe('cancelling');
    f.refuse();
    await f.journey.apply();
    expect(f.journey.snapshot().state!.phase).toBe('cancelling');
    expect(f.calls.filter((call) => call.path.endsWith('/apply')).at(-1)).toEqual(original);
  } finally {
    f.journey.retire();
  }
});

test('Independent archive readers commit exact windows and keep choices and acknowledged destinations', async () => {
  const f = fixture();
  const entry: ArchiveRow = {
    ordinal: 0,
    section: 'entries',
    evidence: { subject_id: 'old-entry', state: 'planned' },
    status: 'unresolved',
    review: null,
    reviewRevision: 0,
  };
  const label: ArchiveRow = {
    ordinal: 1,
    section: 'labels',
    evidence: { name: 'Old label' },
    status: 'unresolved',
    review: null,
    reviewRevision: 0,
  };
  const assignment: ArchiveRow = {
    ordinal: 2,
    section: 'assignments',
    evidence: { subject_id: 'old-entry', label_id: 'old-label' },
    status: 'unresolved',
    review: null,
    reviewRevision: 0,
  };
  const entryResult: NativeArchiveResults['results'][number] = {
    ordinal: 0,
    section: 'entries',
    status: 'acknowledged',
    result: { effect: 'entry.put', subjectId },
  };
  const labelResult: NativeArchiveResults['results'][number] = {
    ordinal: 1,
    section: 'labels',
    status: 'acknowledged',
    result: { effect: 'label.create', labelId },
  };
  f.pages(
    new Map([
      [-1, previewPage([entry], 0)],
      [0, previewPage([label], 1)],
      [1, previewPage([assignment], null)],
    ]),
    new Map([
      [-1, resultPage([], 0)],
      [0, resultPage([entryResult], 1)],
      [1, resultPage([labelResult], null)],
    ]),
  );
  try {
    await f.journey.upload(new File(['{}'], 'archive.json'));
    expect(f.calls.filter((call) => call.path.endsWith('/preview'))[0]).toMatchObject({
      after: -1,
      query: expect.stringContaining('limit=100'),
    });
    f.journey.choose({ ordinal: 0, kind: 'entry', subjectId, action: 'preserve' });
    f.failPreviewOnce(0);
    await f.journey.page('next');
    expect(f.journey.snapshot().state!.page!.rows.map(({ ordinal }) => ordinal)).toEqual([0]);
    expect(f.journey.snapshot().state!.pageNavigation).toMatchObject({
      current: -1,
      previous: [],
      staged: { after: 0, direction: 'next', failed: true },
    });
    await f.journey.page('retry');
    expect(f.calls.filter((call) => call.path.endsWith('/preview')).map(({ after }) => after)).toEqual([-1, 0, 0]);
    f.journey.choose({ ordinal: 1, kind: 'label', target: { mode: 'existing', labelId } });
    await f.journey.page('next');
    await f.journey.page('previous');
    expect(f.journey.snapshot().state!.pageNavigation).toMatchObject({ current: 0, previous: [-1] });
    await f.journey.page('next');
    expect(f.journey.snapshot().state!.pageNavigation).toMatchObject({ current: 1, previous: [-1, 0] });
    await f.journey.page('previous');
    await f.journey.page('first');
    expect(f.journey.snapshot().state!.pageNavigation).toMatchObject({ current: -1, previous: [] });
    await f.journey.page('next');
    f.journey.choose({ ordinal: 1, kind: 'label', target: { mode: 'create' } });
    await f.journey.review();
    const confirmed = f.journey.snapshot().state!.review;
    expect(confirmed!.body.items.map(({ ordinal }) => ordinal)).toEqual([0, 1]);
    expect(f.journey.snapshot().state!.choices.find(({ ordinal }) => ordinal === 1)!.choice).toMatchObject({
      target: { mode: 'create' },
    });
    const reviewedCoordinate = f.journey.snapshot().state!.pageNavigation.current;
    await f.journey.page('refresh');
    expect(f.journey.snapshot().state!.review).toBe(confirmed);
    expect(f.journey.snapshot().state!.pageNavigation.current).toBe(reviewedCoordinate);
    expect(f.calls.filter((call) => call.path.endsWith('/preview')).at(-1)!.after).toBe(reviewedCoordinate);

    await f.journey.results('first');
    expect(f.journey.snapshot().state!.results!.rows).toEqual([]);
    expect(f.journey.snapshot().state!.results!.context.next).toBe(0);
    await f.journey.results('next');
    expect(f.journey.snapshot().state!.results!.rows).toEqual([]);
    expect(f.journey.snapshot().state!.results!.context.next).toBe(1);
    await f.journey.results('next');
    expect(f.journey.snapshot().state!.results!.rows).toEqual([]);
    expect(f.journey.snapshot().state!.results!.context.next).toBeNull();
    expect(f.journey.snapshot().state!.resultsNavigation.previous).toEqual([-1, 0]);
    expect(f.journey.snapshot().state!.pageNavigation.current).toBe(reviewedCoordinate);
    expect(renderToStaticMarkup(<ArchiveEntryRecoveryView journey={f.journey} />)).toContain('Previous');
    await f.journey.results('previous');
    expect(f.journey.snapshot().state!.resultsNavigation).toMatchObject({ current: 0, previous: [-1] });
    await f.journey.results('first');
    expect(f.journey.snapshot().state!.resultsNavigation).toMatchObject({ current: -1, previous: [] });
    expect(f.journey.snapshot().state!.pageNavigation.current).toBe(reviewedCoordinate);

    f.acknowledge();
    await f.journey.apply();
    const applyCall = f.calls.find((call) => call.path.endsWith('/apply'))!;
    expect(JSON.parse(applyCall.body)).toEqual({
      items: [
        { ordinal: 0, reviewRevision: 1 },
        { ordinal: 1, reviewRevision: 1 },
      ],
    });
    expect(f.journey.snapshot().state!.results!.rows).toEqual(
      expect.arrayContaining([
        { ordinal: 0, section: 'entries', status: 'acknowledged', subjectId },
        { ordinal: 1, section: 'labels', status: 'acknowledged', subjectId: null, labelId },
      ]),
    );
    await f.journey.results('refresh');
    expect(f.journey.snapshot().state!.results!.context.next).toBe(0);
    await f.journey.results('next');
    expect(f.journey.snapshot().state!.results!.rows).toMatchObject([
      { ordinal: 0, status: 'acknowledged', subjectId },
      { ordinal: 1, status: 'acknowledged', labelId },
    ]);
    await f.journey.results('next');
    expect(f.journey.snapshot().state!.results!.context.next).toBeNull();
    f.failResultsOnce(1);
    await f.journey.results('refresh');
    expect(f.journey.snapshot().state!.resultsNavigation).toMatchObject({
      current: 1,
      staged: { after: 1, direction: 'refresh', failed: true },
    });
    await f.journey.results('retry');
    expect(f.calls.filter((call) => call.path.endsWith('/results')).map(({ after }) => after)).toEqual([
      -1, 0, 1, 0, -1, -1, 0, 1, 1, 1,
    ]);
    await f.journey.readCurrent(1);
    expect(f.calls.at(-1)).toMatchObject({
      path: '/v1/libraryLabelAssignments',
      method: 'GET',
      authorization: 'Bearer original-sender',
      query: expect.stringContaining('view=FULL'),
    });
    expect(f.journey.snapshot().readback?.value).toMatchObject({ label: { name: 'Current renamed label' } });

    await f.journey.page('next');
    f.journey.unselect(0);
    f.journey.unselect(1);
    expect(f.journey.snapshot().state!.results!.rows).toContainEqual({
      ordinal: 1,
      section: 'labels',
      status: 'acknowledged',
      subjectId: null,
      labelId,
    });
    f.journey.choose({ ordinal: 2, kind: 'assignment', subjectId, action: 'assign' });
    await f.journey.review();
    const reviewCalls = f.calls.filter((call) => call.path.endsWith('/review'));
    expect(JSON.parse(reviewCalls[0]!.body).items.map(({ ordinal }: { ordinal: number }) => ordinal)).toEqual([0, 1]);
    expect(JSON.parse(reviewCalls[1]!.body).items.map(({ ordinal }: { ordinal: number }) => ordinal)).toEqual([2]);
    expect(f.journey.snapshot().state!.pageNavigation.current).toBe(1);
    expect(f.calls.filter((call) => call.path.endsWith('/results')).map(({ after }) => after)).toEqual([
      -1, 0, 1, 0, -1, -1, 0, 1, 1, 1,
    ]);
  } finally {
    f.journey.retire();
  }
});

test('Acknowledged matching receipts allow actual current label readback and changed facts require fresh review', async () => {
  const f = fixture();
  try {
    await f.journey.upload(new File(['{}'], 'archive.json'));
    f.journey.choose({ ordinal: 0, kind: 'entry', subjectId, action: 'preserve' });
    f.journey.choose({ ordinal: 1, kind: 'label', target: { mode: 'create' } });
    await f.journey.review();
    f.stale();
    await f.journey.apply();
    expect(f.journey.snapshot().state!.phase).toBe('stale');
    expect(f.journey.snapshot().state!.review).toBeNull();
    expect(() => f.journey.visit.startApply()).toThrow('fresh_review_required');
    f.retire();
    expect(f.journey.snapshot().state).toBeNull();
  } finally {
    f.journey.retire();
  }
  const acknowledged = fixture();
  try {
    await acknowledged.journey.upload(new File(['{}'], 'archive.json'));
    acknowledged.journey.choose({ ordinal: 0, kind: 'entry', subjectId, action: 'preserve' });
    acknowledged.journey.choose({ ordinal: 1, kind: 'label', target: { mode: 'create' } });
    await acknowledged.journey.review();
    acknowledged.acknowledge();
    await acknowledged.journey.apply();
    await acknowledged.journey.readCurrent(1);
    expect(acknowledged.journey.snapshot().readback?.value).toMatchObject({
      label: { name: 'Current renamed label', revision: 3 },
    });
    acknowledged.cancellation(true);
    await acknowledged.journey.cancel();
    expect(acknowledged.journey.snapshot().state!.phase).toBe('cancelling');
    expect(acknowledged.journey.snapshot().retryOriginal).toBe(false);
    acknowledged.cancellation(false);
    await acknowledged.journey.cancel();
    expect(acknowledged.journey.snapshot().state!.phase).toBe('cancelled');
    expect(acknowledged.journey.snapshot().state!.resultsNavigation).toMatchObject({ current: -1, previous: [] });
    await acknowledged.journey.results('refresh');
    expect(acknowledged.journey.snapshot().state!.results!.rows).toContainEqual({
      ordinal: 1,
      section: 'labels',
      status: 'acknowledged',
      subjectId: null,
      labelId,
    });
  } finally {
    acknowledged.journey.retire();
  }
});

test('Annotation and one combined journal row review current facts and read actual native targets', async () => {
  const f = fixture();
  try {
    await f.journey.upload(new File(['{}'], 'archive-v3.json'));
    const sessionId = '019a1b2c-3d4e-7f00-8a00-000000000006';
    f.journey.choose({
      ordinal: 3,
      kind: 'annotation',
      subjectId,
      incarnationId: '019a1b2c-3d4e-7f00-8a00-000000000005',
      fields: { note: 'set', priority: 'preserve' },
    });
    f.journey.choose({
      ordinal: 4,
      kind: 'journal',
      subjectId,
      sessionId,
      fields: { startDate: 'set', finishDate: 'set', reflection: 'set' },
    });
    await f.journey.review();
    const reviewHtml = renderToStaticMarkup(<ArchiveEntryRecoveryView journey={f.journey} />);
    expect(reviewHtml).toContain('Current note');
    expect(reviewHtml).toContain('Current reflection');
    expect(reviewHtml).toContain('A missing assessment is not zero');
    expect(reviewHtml).not.toContain('name="assessment"');
    const review = JSON.parse(f.calls.find((call) => call.path.endsWith('/review'))!.body);
    expect(review.items).toEqual([
      {
        ordinal: 3,
        kind: 'annotation',
        subjectId,
        incarnationId: '019a1b2c-3d4e-7f00-8a00-000000000005',
        fields: { note: 'set', priority: 'preserve' },
      },
      {
        ordinal: 4,
        kind: 'journal',
        subjectId,
        sessionId,
        fields: { startDate: 'set', finishDate: 'set', reflection: 'set' },
      },
    ]);
    f.acknowledge();
    await f.journey.apply();
    expect(f.journey.snapshot().state!.results!.rows).toMatchObject([
      { ordinal: 3, section: 'annotations', status: 'acknowledged', subjectId },
      { ordinal: 4, section: 'journals', status: 'acknowledged', subjectId, sessionId },
    ]);
    await f.journey.readCurrent(3);
    expect(f.journey.snapshot().readback?.value).toMatchObject({
      note: 'Current note',
      priority: 0,
      annotationRevision: 9,
    });
    await f.journey.readCurrent(4);
    expect(f.journey.snapshot().readback?.value).toMatchObject({
      sessionId,
      revision: 4,
      reflection: 'Exact archived reflection',
    });
    await f.journey.cancel();
    await f.journey.results('refresh');
    await f.journey.readCurrent(4);
    expect(f.journey.snapshot().readback?.value).toMatchObject({ sessionId, revision: 4 });
    expect(f.calls.some((call) => call.path.endsWith('/personal'))).toBe(true);
    expect(f.calls.some((call) => call.path.endsWith('/journal'))).toBe(true);
  } finally {
    f.journey.retire();
  }
});

test('Retained source observation evidence explains that privacy and timestamps are not applied', async () => {
  const f = fixture();
  try {
    const row: ArchiveRow = {
      ordinal: 6,
      section: 'provenance',
      status: 'unsupported',
      review: null,
      reviewRevision: 0,
      evidence: { observation: { provider: 'source', recordId: 'record', sourceCreated: '2005-02' } },
    };
    f.pages(new Map([[-1, previewPage([row], null)]]), new Map());
    await f.journey.upload(new File(['{}'], 'archive-v3.json'));
    const html = renderToStaticMarkup(<ArchiveEntryRecoveryView journey={f.journey} />);
    expect(html).toContain('Privacy and source timestamps are not applied.');
    expect(html).toContain('2005-02');
    expect(html).not.toContain('<form');
    expect(f.journey.snapshot().state!.choices).toEqual([]);
  } finally {
    f.journey.retire();
  }
});

test('cancel then restart reuses the original archive text under a new upload key', async () => {
  const f = fixture();
  try {
    const raw = ' {"manifest":{},"records":[]}\n';
    await f.journey.upload(new File([raw], 'completed.json'));
    await f.journey.cancel();
    expect(f.journey.snapshot().state!.phase).toBe('cancelled');
    f.journey.restart();
    expect(f.journey.snapshot()).toMatchObject({
      hasOriginalArchive: true,
      state: { upload: null, phase: 'idle' },
    });
    await f.journey.adoptOriginal();
    const uploads = f.calls.filter((call) => call.path === '/v1/libraryArchiveMerges');
    expect(uploads).toHaveLength(2);
    expect(uploads[0]!.body).toBe(raw);
    expect(uploads[1]!.body).toBe(raw);
    expect(uploads[1]!.key).not.toBe(uploads[0]!.key);
    expect(f.journey.snapshot().state!.upload?.id).toBe(id);
    f.journey.retire();
    expect(f.journey.snapshot().hasOriginalArchive).toBe(false);
  } finally {
    f.journey.retire();
  }
});

test('reviewable provenance uses observation identity and preserve fields, never assignment controls', async () => {
  const f = fixture();
  try {
    const row: ArchiveRow = {
      ordinal: 6,
      section: 'provenance',
      status: 'unresolved',
      review: null,
      reviewRevision: 0,
      evidence: {
        subjectId,
        observation: {
          provider: 'vndb',
          recordId: 'v1',
          privacy: { status: 'unknown' },
          sourceCreated: { status: 'absent' },
          sourceUpdated: { status: 'cleared' },
        },
      },
    };
    f.pages(new Map([[-1, previewPage([row], null)]]), new Map());
    await f.journey.upload(new File(['{}'], 'original-v4.json'));
    const html = renderToStaticMarkup(<ArchiveEntryRecoveryView journey={f.journey} />);
    expect(html).toContain('archive-observation-6');
    expect(html).toContain('name="revision"');
    expect(html).toContain('name="privacy"');
    expect(html).toContain('name="sourceCreated"');
    expect(html).toContain('name="sourceUpdated"');
    expect(html).toContain('value="preserve" selected');
    expect(html).not.toContain('value="assign"');
    expect(html).not.toContain('name="labelId"');
    expect(f.journey.snapshot().state!.choices).toEqual([]);
  } finally {
    f.journey.retire();
  }
});
