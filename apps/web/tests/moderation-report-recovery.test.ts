import { expect, mock, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import { createReportReviewAction } from '../src/moderation/reports-view-action';

mock.module('cloudflare:workers', () => ({ env: {} }));
const { sendModerationAppealResolution } = await import('../src/moderation/actions');

test('uncertain report retries retain their original sender and exact request', async () => {
  const review = createReportReviewAction();
  const sent: unknown[] = [];
  const original = async (input: unknown) => {
    sent.push(input);
    if (sent.length === 1) throw new TypeError('Failed to fetch');
    return { ok: true as const };
  };
  expect(await review.submit({ action: 'dismiss', reportId: 'report' }, original)).toEqual({
    ok: false,
    state: 'uncertain',
  });
  expect(
    await review.retry(async () => {
      throw new Error('Replacement sender must not run');
    }),
  ).toEqual({ ok: true });
  expect(sent[1]).toBe(sent[0]);
  expect(review.receipt).toBe(true);
});

test('appeal resolution receives the native problem envelope and matches the acknowledgement ID', async () => {
  const input = {
    id: 'appeal94bb',
    outcome: 'reverse' as const,
    statement: 'Independent review.',
    idempotencyKey: crypto.randomUUID(),
  };
  const problem = {
    type: 'https://rezics.com/problems/idempotency_conflict',
    title: 'Idempotency Key Reused',
    status: 422,
    code: 'idempotency_conflict',
    retryable: false,
    effect_status: 'not_applied',
    request_id: 'request',
  };
  let response = Response.json(problem, { status: 422 });
  const client = createKernelClient('https://kernel.test', { fetch: async () => response });
  expect(await sendModerationAppealResolution(client, input, 'Bearer original')).toEqual({ state: 'conflict' });
  response = Response.json({ id: 'different-appeal' });
  await expect(sendModerationAppealResolution(client, input, 'Bearer original')).rejects.toThrow(
    'acknowledgement does not match',
  );
  response = Response.json({ id: input.id });
  expect(await sendModerationAppealResolution(client, input, 'Bearer original')).toEqual({
    state: 'resolved',
    outcome: 'reverse',
    statement: input.statement,
  });
});
