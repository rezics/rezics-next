import { expect, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import { archiveBase64, ProgressRecoveryJourney } from '../src/library/archive-progress-recovery/controller';
import { progressRecoveryNative, type Review, type ReviewInput } from '../src/library/archive-progress-recovery/native';
import type { ProgressRecoveryPort as Port } from '../src/library/archive-progress-recovery/native';

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
