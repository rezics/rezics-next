import { expect, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MappingPanel } from '../src/library/archive-progress-recovery/mapping-panel';
import type { ProgressChoices } from '../src/library/progress-profile';
import { archiveBase64, ProgressRecoveryJourney } from '../src/library/archive-progress-recovery/controller';
import { progressRecoveryNative, type Review, type ReviewInput } from '../src/library/archive-progress-recovery/native';
import type { ProgressRecoveryPort as Port } from '../src/library/archive-progress-recovery/native';
import { observeArchiveProgressResponse } from './native/archive-progress-observation';

const id = '00000000-0000-4000-8000-000000000001';
const input: ReviewInput = {
  sessionId: id,
  subjectId: id,
  mode: 'scalar_amount',
  unit: 'chapter',
  additionalMeasures: [],
  unitIds: [],
};
const review: Review = {
  uploadId: id,
  reviewId: id,
  sourceSessionId: id,
  sourceSubjectId: id,
  subjectId: id,
  historical: {
    mode: 'scalar_amount',
    unit: 'chapter',
    total: '2.500',
    amount: '0',
    additionalMeasures: [],
    completedUnitCount: 0,
    episodeCompletedCount: 0,
    state: 'active',
    sourceRevision: 2,
    versionSubjectId: null,
    profilePin: null,
    sourceTimes: { startedAt: '2020-01-01', completedAt: null, lastChangedAt: '2020-01-01' },
  },
  current: {
    profile: { kind: 'supported', subjectId: id, acceptingType: 'ex:Work' },
    mode: 'scalar_amount',
    unit: 'chapter',
  },
  measures: [],
  completedUnits: [],
  unsupportedHistoricalDates: ['started_at'],
  unsupported: [],
  applicable: true,
  recovery: 'complete',
  expiresAt: '2099-01-01',
};
const upload = { uploadId: id, holdings: 0, progressRecords: 1, expiresAt: '2099-01-01' };
function port(apply: Port['apply']): Port {
  const unused = async (): Promise<never> => {
    throw new Error('Unexpected operation');
  };
  return {
    upload: async () => ({ kind: 'ok', value: upload }),
    holdings: async () => ({ kind: 'uncertain' }),
    occurrences: async () => ({ kind: 'uncertain' }),
    units: unused,
    choices: unused,
    review: async () => ({ kind: 'ok', value: review }),
    apply,
    result: async () => ({
      kind: 'ok',
      value: {
        uploadId: id,
        review,
        application: { state: 'partial', sessionId: id, acceptedSteps: 1, error: null },
        progressSession: null,
        completedEpisodes: null,
        expiresAt: '2099-01-01',
      },
    }),
    cancel: async () => ({ kind: 'ok', value: { uploadId: id, cancelled: true } }),
    remove: unused,
  };
}
async function prepare(journey: ProgressRecoveryJourney) {
  await journey.upload(new File(['{}'], 'archive.json'));
  await journey.review(input);
}

test('the Archive mapping action submits the current profile form', () => {
  const base = port(async () => {
    throw new Error('The unsubmitted fixture has no write');
  });
  const native: Port<ProgressChoices> = {
    ...base,
    choices: async () => ({ kind: 'ok', value: [] }),
  };
  const journey = new ProgressRecoveryJourney(native, crypto.randomUUID(), () => true);
  const html = renderToStaticMarkup(
    createElement(MappingPanel, {
      journey,
      snap: {
        ...journey.snapshot(),
        selected: {
          section: 'sessions',
          session_id: id,
          subject_id: id,
          subject_id_reference: { id, href: `/subjects/${id}` },
          version_subject_id: null,
          mode: 'scalar_amount',
          unit: 'page',
          total: '12',
          amount: '0',
          additional_measures: [],
          locator: null,
          position: null,
          completed_unit_count: 0,
          episode_completed_count: 0,
          state: 'active',
          revision: 1,
          library_profile_pin: null,
          started_at: '2024-02-01T00:00:00.000Z',
          completed_at: null,
          last_changed_at: '2024-02-01T00:00:00.000Z',
        },
      },
    }),
  );
  expect(html.match(/<form[\s\S]*?<\/form>/u)?.[0]).toMatch(/<button[^>]+type="submit"/u);
});

test('generated native transport sends original JSON bytes and quotes each logical key exactly once', async () => {
  const bytes = new TextEncoder().encode(' { "manifest": {},\n "records": ["🦊"] } ');
  const requests: Request[] = [];
  const client = createKernelClient('http://kernel.test', {
    fetch: (async (url, init) => {
      const request = new Request(url, init);
      requests.push(request);
      if (request.method === 'POST' && request.url.endsWith('libraryCopyArchives')) {
        expect(new Uint8Array(await request.arrayBuffer())).toEqual(bytes);
        expect(request.headers.get('content-type')).toBe('application/json');
        return Response.json(upload);
      }
      return Response.json(review);
    }) as typeof fetch,
  });
  const native = progressRecoveryNative(client, 'Bearer original');
  expect((await native.upload(archiveBase64(bytes), 'logical-upload')).kind).toBe('ok');
  await native.review(id, input, 'logical-review');
  await native.apply(id, id, 'logical-apply');
  expect(requests.map((request) => request.headers.get('idempotency-key'))).toEqual([
    '"logical-upload"',
    '"logical-review"',
    '"logical-apply"',
  ]);
  expect(requests.every((request) => request.headers.get('authorization') === 'Bearer original')).toBe(true);
  expect(requests[2]!.url).toEndWith(`/progressReviews/${id}:apply`);
});

test('Progress intake observations preserve response bodies and retain only counts, expiry and page ordinals', async () => {
  const headers = { 'cache-control': 'private, no-store' };
  const uploaded = Response.json(upload, { headers });
  expect(
    await observeArchiveProgressResponse(
      new Request('http://kernel.test/v1/libraryCopyArchives', { method: 'POST' }),
      uploaded,
    ),
  ).toEqual({
    operation: 'upload',
    firstPage: false,
    status: 200,
    json: true,
    privateNoStore: true,
    result: {
      expiry: 'future',
      holdings: 0,
      progressRecords: 1,
      state: null,
      rows: null,
      ordinals: null,
      sessionRows: null,
      hasNext: null,
    },
  });
  expect(await uploaded.json()).toEqual(upload);
  const page = {
    uploadId: id,
    state: 'inspecting',
    expiresAt: upload.expiresAt,
    manifest: { private: 'archive manifest' },
    coverage: [],
    occurrences: [{ ordinal: 3, evidence: { section: 'sessions', session_id: id, reflection: 'private reflection' } }],
    next: null,
  };
  const observed = await observeArchiveProgressResponse(
    new Request(`http://kernel.test/v1/libraryCopyArchives/${id}/progress?after=-1`),
    Response.json(page, { headers }),
  );
  expect(observed).toMatchObject({
    operation: 'occurrences',
    firstPage: true,
    result: { expiry: 'future', state: 'inspecting', rows: 1, ordinals: [3], sessionRows: true, hasNext: false },
  });
  const text = JSON.stringify(observed);
  for (const privateValue of [id, 'private reflection', 'archive manifest']) expect(text).not.toContain(privateValue);
  const emptyPage = await observeArchiveProgressResponse(
    new Request(`http://kernel.test/v1/libraryCopyArchives/${id}/progress?after=3`),
    Response.json({ ...page, occurrences: [], expiresAt: '2000-01-01T00:00:00Z' }, { headers }),
  );
  expect(emptyPage).toMatchObject({ firstPage: false, result: { expiry: 'expired', rows: 0, ordinals: [] } });
  const refusal = await observeArchiveProgressResponse(
    new Request(`http://kernel.test/v1/libraryCopyArchives/${id}`),
    Response.json({ detail: 'private refusal' }, { status: 403, headers }),
  );
  expect(refusal).toMatchObject({ operation: 'holdings', status: 403, result: null });
  expect(JSON.stringify(refusal)).not.toContain('private refusal');
  expect(
    await observeArchiveProgressResponse(
      new Request(`http://kernel.test/v1/libraryCopyArchives/${id}/progress/${id}/units`),
      Response.json(page),
    ),
  ).toBeUndefined();
});

test('recoverable replay uses original sender and key across visit replacement, cancellation reconciles without a new Session', async () => {
  const sent: unknown[][] = [];
  let attempts = 0,
    live = true;
  const original = port(async (...args) => {
    sent.push(args);
    return {
      kind: 'ok',
      value: {
        uploadId: id,
        reviewId: id,
        state: ++attempts === 1 ? 'recoverable' : 'partial',
        sessionId: attempts === 1 ? null : id,
        acceptedSteps: attempts === 1 ? 0 : 1,
        totalSteps: 3,
        error: null,
      },
    };
  });
  const binding = crypto.randomUUID();
  const first = new ProgressRecoveryJourney(original, binding, () => live);
  await prepare(first);
  await first.confirm(id);
  expect(first.snapshot()).toMatchObject({ pending: true, notice: 'recoverable', result: null });
  live = false;
  first.retire();
  expect(first.snapshot().review).toBeNull();
  const replacement = port(async () => {
    throw new Error('Replacement sender must not run');
  });
  const second = new ProgressRecoveryJourney(replacement, binding, () => true);
  await second.cancel();
  expect(sent).toHaveLength(2);
  expect(sent[1]).toEqual(sent[0]);
  expect(second.snapshot()).toMatchObject({
    pending: false,
    cancelled: true,
    application: { state: 'partial', acceptedSteps: 1 },
  });
});

test('lost review response retains normalized operands; refreshed review uses a new logical key', async () => {
  const bodies: ReviewInput[] = [],
    keys: string[] = [];
  let calls = 0;
  const native = port(async () => {
    throw new Error('No confirmation');
  });
  native.review = async (_id, body, key) => {
    bodies.push(structuredClone(body));
    keys.push(key);
    return ++calls === 1 ? { kind: 'uncertain' } : { kind: 'ok', value: { ...review, reviewId: String(calls) } };
  };
  const journey = new ProgressRecoveryJourney(native, crypto.randomUUID(), () => true);
  await journey.upload(new File(['{}'], 'archive.json'));
  const selection = {
    ...input,
    additionalMeasures: [
      { sourceUnit: 'z.page', unit: 'chapter' },
      { sourceUnit: 'a.page', unit: 'page' },
    ],
  };
  await journey.review(selection);
  selection.additionalMeasures[0]!.unit = 'mutated';
  await journey.retry();
  expect(bodies[1]).toEqual(bodies[0]);
  expect(bodies[0]!.additionalMeasures.map(({ sourceUnit }) => sourceUnit)).toEqual(['a.page', 'z.page']);
  expect(keys[1]).toBe(keys[0]);
  await journey.review(input);
  expect(keys[2]).not.toBe(keys[0]);
  expect(journey.snapshot().review?.reviewId).toBe('3');
});

test('cancel then restart reuses the original archive bytes under a new upload key', async () => {
  const keys: string[] = [];
  const native = port(async () => ({
    kind: 'ok' as const,
    value: {
      uploadId: id,
      reviewId: id,
      state: 'partial' as const,
      sessionId: id,
      acceptedSteps: 1,
      totalSteps: 3,
      error: null,
    },
  }));
  native.upload = async (_body, key) => {
    keys.push(key);
    return { kind: 'ok', value: upload };
  };
  const journey = new ProgressRecoveryJourney(native, crypto.randomUUID(), () => true);
  await journey.upload(new File(['{"manifest":{}}'], 'archive.json'));
  await journey.cancel();
  expect(journey.snapshot().cancelled).toBe(true);
  expect(journey.snapshot().hasOriginalArchive).toBe(true);
  journey.restart();
  expect(journey.snapshot().upload).toBeNull();
  await journey.adoptOriginal();
  expect(keys).toHaveLength(2);
  expect(keys[1]).not.toBe(keys[0]);
  expect(journey.snapshot().upload?.uploadId).toBe(id);
});

test('a refusal after response loss preserves apply custody, and lost cancellation remains pending after apply acknowledgement', async () => {
  const sent: unknown[][] = [];
  let acknowledgeCancel = false;
  const native = port(async (...args) => {
    sent.push(args);
    if (sent.length === 1) return { kind: 'uncertain' };
    if (sent.length === 2) return { kind: 'refused', status: 403 };
    return {
      kind: 'ok',
      value: {
        uploadId: id,
        reviewId: id,
        state: 'partial',
        sessionId: id,
        acceptedSteps: 1,
        totalSteps: 3,
        error: null,
      },
    };
  });
  native.cancel = async () =>
    acknowledgeCancel ? { kind: 'ok', value: { uploadId: id, cancelled: true } } : { kind: 'uncertain' };
  const journey = new ProgressRecoveryJourney(native, crypto.randomUUID(), () => true);
  await prepare(journey);
  await journey.confirm(id);
  await journey.retry();
  expect(journey.snapshot()).toMatchObject({ pending: true, refusal: 403, result: null });
  await journey.cancel();
  expect(journey.snapshot()).toMatchObject({ pending: true, notice: 'uncertain', application: { state: 'partial' } });
  expect(sent).toHaveLength(3);
  expect(sent[1]).toEqual(sent[0]);
  expect(sent[2]).toEqual(sent[0]);
  acknowledgeCancel = true;
  await journey.retry();
  expect(journey.snapshot()).toMatchObject({ pending: false, cancelled: true });
});
