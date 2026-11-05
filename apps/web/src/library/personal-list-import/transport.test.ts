import { expect, mock, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import { vndbApplyBody, vndbReviewBody } from './requests';
import type { VndbCommand, VndbReviewInput, VndbScoreDecision } from './contract';

const owner = '00000000-0000-4000-8000-000000000001';
const targetId = '00000000-0000-4000-8000-000000000002';
const uploadId = '00000000-0000-4000-8000-000000000003';
const reviewId = '00000000-0000-4000-8000-000000000004';
let reader: string | undefined = owner;
mock.module('../../session/request', () => ({
  prepareSession: async () => {},
  sessionSubject: () => reader,
  viewerCredential: () => 'Bearer authored-owner',
}));
const { kernelVndbPort } = await import('./native');

test('request boundary preserves deliberate zero, clear, explicit occurrence and both review identities', () => {
  const common = { ordinal: 0, action: 'score' as const, targetId, questionId: targetId, questionRevision: 1 };
  for (const [selection, consent] of [
    [{ kind: 'vote', units: 0 }, 'adopt-native-vote'],
    [{ kind: 'clear' }, 'clear-native-vote'],
  ] as const)
    expect(vndbReviewBody({ ...common, selection, consent })).toEqual({ ...common, selection, consent });
  const progress = {
    occurrence: { kind: 'existing', sessionId: targetId },
    measures: [{ field: 'minutes', action: 'adopt', replace: true }],
  } satisfies Extract<VndbReviewInput, { action: 'progress' }>['progress'];
  const body = { ordinal: 1, action: 'progress' as const, targetId, progress };
  expect(vndbReviewBody(body)).toEqual(body);
  expect(vndbReviewBody({ ...body, action: 'state', state: 'playing', replace: false })).toEqual({
    ...body,
    action: 'state',
    state: 'playing',
    replace: false,
  });
  const rows = [{ ordinal: 0, reviewId, scoreReviewId: targetId }];
  expect(vndbApplyBody({ rows })).toEqual({ rows });
  for (const selection of [
    { kind: 'vote', units: -1 },
    { kind: 'vote', units: 7.3 },
    { kind: 'vote', units: 21 },
  ])
    expect(() => vndbReviewBody({ ...common, selection, consent: 'adopt-native-vote' })).toThrow();
  expect(() => vndbReviewBody({ ...common, selection: { kind: 'clear' }, consent: 'adopt-native-vote' })).toThrow();
  expect(() =>
    vndbApplyBody({
      rows: Array.from({ length: 5 }, (_, ordinal) => ({ ordinal, reviewId, scoreReviewId: targetId })),
    }),
  ).toThrow();
});

test('authenticated generated transport accepts conditional score and native Progress without losing command bytes', async () => {
  const calls: { path: string; authorization: string | null; key: string | null; body: unknown }[] = [];
  const score: VndbScoreDecision = {
    reviewId,
    status: 'reviewed',
    targetId,
    action: 'vote',
    units: 0,
    nativeAdmission: 'conditional',
    question: {
      id: targetId,
      revision: 1,
      meaning: 'enjoyment',
      label: 'Enjoyment',
      grain: 'work',
      scale: { min: 0, max: 20, step: 1 },
      aggregateEffect: 'public-standard-aggregate',
    },
    currentVote: { state: 'absent' },
    consent: 'adopt-native-vote',
    sourceReason: 'deliberate native units',
  };
  const client = createKernelClient('https://kernel.invalid', {
    fetch: (async (input, init) => {
      const request = new Request(input, init);
      const path = new URL(request.url).pathname;
      calls.push({
        path,
        authorization: request.headers.get('authorization'),
        key: request.headers.get('idempotency-key'),
        body: request.method === 'POST' ? await request.json() : null,
      });
      return Response.json(
        path.endsWith(':review')
          ? score
          : path.endsWith('/source')
            ? { xml: '<private />' }
            : {
                uploadId,
                outcomes: [
                  { ordinal: 0, scoreReviewId: reviewId, status: 'applied', currentVote: { state: 'set', units: 0 } },
                ],
                stopped: null,
              },
      );
    }) as typeof fetch,
  });
  const port = kernelVndbPort(client, new Request('https://web.invalid'), {}, true, owner);
  const command: Extract<VndbCommand, { kind: 'review' }> = {
    kind: 'review',
    uploadId,
    key: 'original-key',
    body: {
      ordinal: 0,
      action: 'score',
      targetId,
      questionId: targetId,
      questionRevision: 1,
      selection: { kind: 'vote', units: 0 },
      consent: 'adopt-native-vote',
    },
  };
  expect(await port.review(command)).toEqual({ kind: 'reviewed', value: score });
  const progress: Extract<VndbCommand, { kind: 'review' }> = {
    kind: 'review',
    uploadId,
    key: 'progress-key',
    body: {
      ordinal: 1,
      action: 'progress',
      targetId,
      progress: {
        occurrence: { kind: 'existing', sessionId: reviewId },
        measures: [{ field: 'minutes', action: 'adopt', replace: true }],
      },
    },
  };
  await port.review(progress);
  expect(calls[1]).toMatchObject({
    authorization: 'Bearer authored-owner',
    key: '"progress-key"',
    body: progress.body,
  });
  const apply = { kind: 'apply' as const, uploadId, body: { rows: [{ ordinal: 0, scoreReviewId: reviewId }] } };
  expect(await port.apply(apply)).toMatchObject({
    kind: 'applied',
    value: { outcomes: [{ status: 'applied', currentVote: { units: 0 } }] },
  });
  expect(await port.source({ kind: 'source', uploadId })).toEqual({ kind: 'source', xml: '<private />' });
  expect(calls[0]).toEqual({
    path: `/v1/libraryImports/vndb/${uploadId}:review`,
    authorization: 'Bearer authored-owner',
    key: '"original-key"',
    body: command.body,
  });
  reader = undefined;
  expect(await port.review(command)).toEqual({ kind: 'denied', status: 401 });
  expect(calls).toHaveLength(4);
  reader = owner;
});

test('lost transport keeps the original command', async () => {
  const command = { kind: 'apply' as const, uploadId, body: { rows: [{ ordinal: 0, reviewId }] } };
  const client = createKernelClient('https://kernel.invalid', {
    fetch: (async () => {
      throw new TypeError('lost acknowledgement');
    }) as unknown as typeof fetch,
  });
  const port = kernelVndbPort(client, new Request('https://web.invalid'), {}, true, owner);
  expect(await port.apply(command)).toEqual({ kind: 'unknown', command });
});
