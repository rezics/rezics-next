import type { KernelClient } from '@rezics/client';
import { createServerFn } from '@tanstack/react-start';
import { getRequest, setResponseHeader } from '@tanstack/react-start/server';
import { env } from 'cloudflare:workers';
import { kernelClient } from '../kernel/client';
import type { SessionEnv } from '../session/client';
import { prepareSession, sessionSubject, viewerCredential } from '../session/request';
import { UUID } from './price';
import {
  validPaymentReference,
  type PaymentAttestationInput,
  type PaymentAttestationResult,
  type PaymentEvidence,
} from './creator-payment-attestation-state';

export function paymentAttestationInput(value: unknown): PaymentAttestationInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid payment attestation');
  const row = value as Record<string, unknown>;
  if (
    Object.keys(row).some((key) => !['statementId', 'subject', 'paidReference', 'idempotencyKey'].includes(key)) ||
    typeof row.statementId !== 'string' ||
    !UUID.test(row.statementId) ||
    typeof row.subject !== 'string' ||
    !UUID.test(row.subject) ||
    typeof row.idempotencyKey !== 'string' ||
    !UUID.test(row.idempotencyKey) ||
    typeof row.paidReference !== 'string' ||
    !validPaymentReference(row.paidReference)
  )
    throw new Error('Invalid payment attestation');
  return {
    statementId: row.statementId,
    subject: row.subject,
    paidReference: row.paidReference,
    idempotencyKey: row.idempotencyKey,
  };
}

function evidence(value: unknown, input: PaymentAttestationInput): PaymentEvidence | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as Record<string, unknown>;
  if (
    row.id !== input.statementId ||
    row.state !== 'paid' ||
    row.paidReference !== input.paidReference ||
    typeof row.paidAt !== 'string' ||
    !Number.isFinite(Date.parse(row.paidAt)) ||
    typeof row.revision !== 'number' ||
    !Number.isSafeInteger(row.revision) ||
    row.revision < 1
  )
    return null;
  return {
    id: input.statementId,
    state: 'paid',
    paidReference: input.paidReference,
    paidAt: row.paidAt,
    revision: row.revision,
  };
}

/** Native markPaid owns authorization and receipt replay, including operator authority. */
export async function submitPaymentAttestation(
  client: KernelClient,
  request: Request,
  sessionEnv: Partial<SessionEnv>,
  value: PaymentAttestationInput,
): Promise<PaymentAttestationResult> {
  let input: PaymentAttestationInput;
  try {
    input = paymentAttestationInput(value);
  } catch {
    return { kind: 'rejected' };
  }
  try {
    if (await prepareSession(request, sessionEnv)) return { kind: 'denied' };
    const authorization = viewerCredential(request);
    // A delayed old form must not execute with a different signed-in person's credential.
    if (!authorization || sessionSubject(request) !== input.subject) return { kind: 'denied' };
    const headers = { authorization, 'idempotency-key': input.idempotencyKey };
    const result = await client.payoutStatements({ statementId: input.statementId }).$markPaid.post(
      { paidReference: input.paidReference },
      {
        headers,
        fetch: { cache: 'no-store', redirect: 'manual' },
      },
    );
    if (result.error) {
      if ([401, 403, 404].includes(result.status)) return { kind: 'denied' };
      if ([409, 422].includes(result.status)) return { kind: 'conflict' };
      if (result.status === 400) return { kind: 'rejected' };
      return { kind: 'uncertain' };
    }
    const statement = evidence(result.data?.statement, input);
    return statement ? { kind: 'saved', statement } : { kind: 'uncertain' };
  } catch {
    return { kind: 'uncertain' };
  }
}

export const attestCreatorPayment = createServerFn({ method: 'POST' })
  .validator(paymentAttestationInput)
  .handler(({ data }): Promise<PaymentAttestationResult> => {
    setResponseHeader('cache-control', 'private, no-store');
    setResponseHeader('x-robots-tag', 'noindex, nofollow');
    // The site's existing unsafe-request middleware validates origin and current session CSRF.
    return submitPaymentAttestation(kernelClient(), new Request(getRequest()), env as Partial<SessionEnv>, data);
  });
