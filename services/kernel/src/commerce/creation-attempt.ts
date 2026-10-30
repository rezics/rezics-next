import type { createCommerceCommands, CheckoutOutcome } from './commands.ts';
import { checkoutUrlsForOrder } from './config.ts';
import { StripeRejectedError, StripeUnavailableError, type CheckoutRequest, type StripePort } from './model.ts';

/** A private native projection, never part of the buyer Order DTO. */
export type CheckoutCreationAttempt = Readonly<{
  firstAttemptId: string;
  firstAttemptAt: string;
  providerKey: string;
  request: CheckoutRequest;
  retried: boolean;
}>;
export type CheckoutCreationAdmission =
  | { kind: 'ready'; attempt: CheckoutCreationAttempt; first: boolean; observedAt: string }
  | { kind: 'finished' | 'failed' | 'unknown' };

// Leave time for the entire bounded provider operation before either validity limit.
export const CREATION_SAFE_WINDOW_MS = 23 * 60 * 60 * 1000;
const PROVIDER_BUDGET_MS = 20_000;
export function creationRetryUntil(attempt: CheckoutCreationAttempt): number {
  return (
    Math.min(
      Date.parse(attempt.firstAttemptAt) + CREATION_SAFE_WINDOW_MS,
      attempt.request.expiresAt * 1000 - 30 * 60 * 1000,
    ) - PROVIDER_BUDGET_MS
  );
}

/** Both HTTP replay and durable work use this native admission and the same immutable request. */
export async function createCheckoutForOrder(
  {
    commands,
    stripe,
    urls,
  }: {
    commands: ReturnType<typeof createCommerceCommands>;
    stripe: StripePort;
    urls: { successUrl: string; cancelUrl: string };
  },
  orderId: string,
): Promise<CheckoutOutcome | null> {
  const started = performance.now();
  const admission = await commands.beginCheckoutCreation(orderId, {
    ...checkoutUrlsForOrder(urls, orderId),
    managedPayments: stripe.managedPayments ?? false,
  });
  if (admission.kind === 'finished') return null;
  if (admission.kind === 'failed') {
    const outcome = { kind: 'failed' } as const;
    await commands.recordCheckout(orderId, outcome);
    return outcome;
  }
  async function uncertain(): Promise<never> {
    await commands.recordCheckout(orderId, { kind: 'unknown' });
    throw new StripeUnavailableError('Checkout creation requires reconciliation');
  }
  if (admission.kind !== 'ready') return uncertain();
  const { attempt } = admission;
  // Admission committed and released every native connection. A delayed continuation cannot
  // refresh the deadline; use the later of the native observation and the local clock.
  const now = Math.max(Date.now(), Date.parse(admission.observedAt) + performance.now() - started);
  if (now >= creationRetryUntil(attempt)) return uncertain();
  // This process-local one-use admission expires with the actual released sale
  // preparation. A receipt/workflow replay or delayed continuation cannot reuse it.
  commands.consumeCheckoutCreationAdmission(orderId, admission);
  let outcome: CheckoutOutcome;
  try {
    outcome = { session: await stripe.createCheckoutSession(attempt.request, attempt.providerKey) };
  } catch (error) {
    if (error instanceof StripeRejectedError && admission.first) {
      outcome = { kind: 'failed', creationAttemptId: attempt.firstAttemptId };
      const recorded = await commands.recordCheckout(orderId, outcome);
      if ('value' in recorded && recorded.value.settlement === 'failed') return outcome;
      return uncertain();
    }
    // A rejection on a replay cannot erase an earlier execution, even when the later
    // request was rejected before execution. Network loss and cached failures also stay unknown.
    if (error instanceof StripeRejectedError || error instanceof StripeUnavailableError) return uncertain();
    throw error;
  }
  await commands.recordCheckout(orderId, outcome);
  return outcome;
}
