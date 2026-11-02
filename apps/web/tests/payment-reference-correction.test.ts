import { expect, test } from 'bun:test';
import { creatorStatementFixture as statement } from '../src/kernel/fake/creator-statements';
import {
  CreatorPaymentAttempt,
  type PaymentAttestationInput,
  type PaymentAttestationResult,
  type PaymentEvidence,
} from '../src/checkout/creator-payment-attestation-state';

const subject = statement.creatorAccountId;
const reference = '  BANK/Rejected é  ';
const corrected = '  BANK/Corrected é  ';
const evidence: PaymentEvidence = {
  id: statement.id,
  state: 'paid',
  paidAt: '2026-11-01T12:00:00Z',
  paidReference: corrected,
  revision: 4,
};

test('a first definitive rejection opens explicit correction with the exact rejected reference and a fresh key', async () => {
  const attempt = new CreatorPaymentAttempt(statement.id, subject);
  const sent: PaymentAttestationInput[] = [];
  const execute = async (input: PaymentAttestationInput): Promise<PaymentAttestationResult> => {
    sent.push(input);
    return sent.length === 1 ? { kind: 'rejected' } : { kind: 'saved', statement: evidence };
  };

  await attempt.submit(reference, execute, () => true);
  expect(attempt.beginCorrection()).toBe(true);
  expect(attempt.correctionDraft).toBe(reference);
  attempt.setCorrectionDraft(corrected);
  await attempt.submit(attempt.correctionDraft, execute, () => true);

  expect(sent.map(({ paidReference }) => paidReference)).toEqual([reference, corrected]);
  expect(sent[1]!.idempotencyKey).not.toBe(sent[0]!.idempotencyKey);
  expect(attempt.request).toBe(sent[1]);
  expect(attempt.result?.kind).toBe('saved');
});

test('later rejection or denial after uncertainty preserves the original command and cannot enable correction', async () => {
  for (const later of [{ kind: 'rejected' }, { kind: 'denied' }] as const) {
    const attempt = new CreatorPaymentAttempt(statement.id, subject);
    const sent: PaymentAttestationInput[] = [];
    const original = async (input: PaymentAttestationInput): Promise<PaymentAttestationResult> => {
      sent.push(input);
      return { kind: 'uncertain' };
    };
    await attempt.submit(reference, original, () => true);
    const captured = attempt.request!;
    await attempt.submit('different reference', async (input) => {
      sent.push(input);
      return later;
    }, () => true);

    expect(sent).toEqual([captured, captured]);
    expect(attempt.request).toBe(captured);
    expect(attempt.result?.kind).toBe('uncertain');
    expect(attempt.beginCorrection()).toBe(false);
  }
});

test('saved and conflicted attempts stay immutable, and retired rejection completions stay hidden', async () => {
  for (const result of [
    { kind: 'saved', statement: evidence },
    { kind: 'conflict' },
  ] as const) {
    const attempt = new CreatorPaymentAttempt(statement.id, subject);
    let calls = 0;
    await attempt.submit(reference, async () => {
      calls++;
      return result;
    }, () => true);
    const captured = attempt.request;
    await attempt.submit(corrected, async () => {
      calls++;
      return { kind: 'rejected' };
    }, () => true);
    expect(calls).toBe(1);
    expect(attempt.request).toBe(captured);
    expect(attempt.beginCorrection()).toBe(false);
  }

  const retired = new CreatorPaymentAttempt(statement.id, subject);
  await retired.submit(reference, async () => ({ kind: 'rejected' }), () => false);
  expect(retired.result?.kind).toBe('uncertain');
  expect(retired.beginCorrection()).toBe(false);
});
