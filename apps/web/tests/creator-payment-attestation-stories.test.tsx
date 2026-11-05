import { expect, test } from 'bun:test';
import {
  CreatorPaymentAttempt,
  type PaymentAttestationInput,
  type PaymentAttestationResult,
} from '../src/checkout/creator-payment-attestation-state';
import { creatorStatementFixture } from '../src/kernel/fake/creator-statements';

const statement = creatorStatementFixture;
const subject = statement.creatorAccountId;
const saved = (input: PaymentAttestationInput): PaymentAttestationResult => ({
  kind: 'saved',
  statement: {
    id: input.statementId,
    state: 'paid',
    paidAt: '2026-11-03T10:00:00Z',
    paidReference: input.paidReference,
    revision: statement.revision + 1,
  },
});

test('correction starts a new command while an uncertain retry preserves the original command', async () => {
  const correction = new CreatorPaymentAttempt(statement.id, subject);
  const sent: PaymentAttestationInput[] = [];
  await correction.submit(
    'BANK/first reference',
    async (input) => {
      sent.push(input);
      return { kind: 'rejected' };
    },
    () => true,
  );
  expect(correction.correctionAvailable).toBe(true);
  expect(correction.beginCorrection()).toBe(true);
  correction.setCorrectionDraft('BANK/corrected reference');
  expect(correction.canSubmitCorrection('BANK/corrected reference')).toBe(true);
  await correction.submit(
    'BANK/corrected reference',
    async (input) => {
      sent.push(input);
      return saved(input);
    },
    () => true,
  );
  expect(sent.map(({ paidReference }) => paidReference)).toEqual(['BANK/first reference', 'BANK/corrected reference']);
  expect(sent[1]!.idempotencyKey).not.toBe(sent[0]!.idempotencyKey);
  expect(correction.result).toMatchObject({ kind: 'saved', statement: { paidReference: 'BANK/corrected reference' } });

  const retry = new CreatorPaymentAttempt(statement.id, subject);
  const replays: PaymentAttestationInput[] = [];
  await retry.submit(
    'BANK/original reference',
    async (input) => {
      replays.push(input);
      return { kind: 'uncertain' };
    },
    () => true,
  );
  const original = retry.request;
  await retry.submit(
    'BANK/edited while uncertain',
    async (input) => {
      replays.push(input);
      return saved(input);
    },
    () => true,
  );
  expect(replays[1]).toEqual(replays[0]);
  expect(retry.request).toBe(original);
  expect(retry.result).toMatchObject({ kind: 'saved', statement: { paidReference: 'BANK/original reference' } });
});
