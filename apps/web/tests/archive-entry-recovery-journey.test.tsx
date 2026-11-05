import { expect, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { ArchiveEntryRecoveryJourney } from '../src/library/archive-entry-recovery/controller';
import {
  archiveRecoveryNative,
  type ArchiveRow,
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
  rows: 3,
  recordBytes: 330,
  coverage: [
    { section: 'entries', rows: 1, capture: 'present', treatment: 'requires-explicit-mapping' },
    { section: 'sessions', rows: 0, capture: 'empty', treatment: 'retained-unsupported' },
  ],
};

function fixture() {
  const calls: { path: string; body: string; authorization: string | null; key: string | null }[] = [];
  let revision = 0;
  let unknown = true;
  let stale = false;
  let refuseReplay = false;
  let current: typeof binding | null = binding;
  let applied = false;
  let resultReads = 0;
  let cancelUnknown = false;
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
      section: 'journals',
      evidence: { reflection: 'private' },
      status: 'unresolved',
      review: null,
      reviewRevision: 0,
    },
  ];
  const client = createKernelClient('https://kernel.test', {
    fetch: Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        const path = new URL(request.url).pathname;
        calls.push({
          path,
          body: await request.text(),
          authorization: request.headers.get('authorization'),
          key: request.headers.get('idempotency-key'),
        });
        if (path === '/v1/libraryArchiveMerges') return Response.json(status);
        if (path.endsWith('/preview'))
          return Response.json({ uploadId: id, state: 'ready', coverage: status.coverage, records: rows, next: null });
        if (path.endsWith('/review')) {
          revision++;
          const { items } = JSON.parse(calls.at(-1)!.body);
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
          return Response.json({
            uploadId: id,
            applied: [
              { ordinal: 0, status: 'acknowledged', result: { effect: 'entry.put', subjectId, state: 'planned' } },
              { ordinal: 1, status: 'acknowledged', result: { effect: 'label.create', labelId } },
            ],
          });
        }
        if (path.includes('/libraryEntries/'))
          return Response.json({ libraryEntry: { subjectId, state: 'in_progress', revision: 8 } });
        if (path.endsWith('/libraryLabelAssignments'))
          return Response.json({
            label: { id: labelId, name: 'Current renamed label', revision: 3 },
            assignments: [],
            next: null,
          });
        if (path.endsWith('/results'))
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
  };
}

// Transport fixtures exercise the mounted receiving composition; native artifact acceptance has its own fixture.
test('Original text, displayed revisions, original retry, cancellation and current readback stay distinct', async () => {
  const f = fixture();
  try {
    const raw = ' {"manifest":{}, "records":[]}\n';
    await f.journey.upload(new File([raw], 'completed.json'));
    expect(f.calls[0]!.body).toBe(raw);
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
    await f.journey.results();
    await f.journey.results(100);
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
  } finally {
    acknowledged.journey.retire();
  }
});
