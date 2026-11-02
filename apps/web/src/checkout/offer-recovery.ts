import * as v from 'valibot';
import { isPlatformClosedProblem } from '../kernel/platform-closed';
import { UUID } from './price';

const id = v.pipe(v.string(), v.regex(UUID));
const acquisitionProblem = v.object({
  type: v.string(),
  title: v.pipe(v.string(), v.minLength(1)),
  status: v.literal(409),
  code: v.picklist(['benefit_already_owned', 'acquisition_pending']),
  retryable: v.literal(false),
  effect_status: v.literal('not_applied'),
  request_id: v.pipe(v.string(), v.minLength(1)),
  entitlementId: v.optional(id),
  orderId: v.optional(id),
});
export type AcquisitionProblem = v.InferOutput<typeof acquisitionProblem>;

/** Decode the native Problem, stripping links/claims and validating IDs before either boundary uses them. */
export function decodeAcquisitionProblem(status: number, body: unknown): AcquisitionProblem | undefined {
  if (status !== 409) return;
  const parsed = v.safeParse(acquisitionProblem, body);
  if (!parsed.success) return;
  const problem = parsed.output;
  if (problem.type !== `https://rezics.com/problems/${problem.code}`) return;
  if (problem.code === 'acquisition_pending' ? !problem.orderId : !problem.entitlementId && !problem.orderId) return;
  return problem;
}

export type OfferIntent = Readonly<{ offerId: string; expectedOfferRevision: number; idempotencyKey: string }>;
export type CheckoutDestination = { checkoutUrl: string } | { orderId: string };

const checkoutOrder = v.object({
  id,
  offerId: id,
  settlement: v.picklist(['pending', 'paid', 'failed', 'unknown']),
  checkoutUrl: v.nullable(v.string()),
});
const destination = v.union([
  v.strictObject({ checkoutUrl: v.pipe(v.string(), v.minLength(1)) }),
  v.strictObject({ orderId: id }),
]);

/** The native create/replay result is authoritative; no second order read or new key is needed. */
export function checkoutDestination(order: unknown, offerId: string): CheckoutDestination | undefined {
  const parsed = v.safeParse(checkoutOrder, order);
  if (!parsed.success || parsed.output.offerId !== offerId) return;
  const current = parsed.output;
  // A settled or unresolved order belongs on its status page, even if it retains an old Session URL.
  if (current.settlement !== 'pending' || !current.checkoutUrl) return { orderId: current.id };
  try {
    const url = new URL(current.checkoutUrl);
    if (url.protocol === 'https:' || url.protocol === 'http:') return { checkoutUrl: url.href };
  } catch {
    // The known order remains reachable when its hosted destination cannot be used.
  }
  return { orderId: current.id };
}

export type OfferResult =
  | { kind: 'existing'; problem: AcquisitionProblem }
  | { kind: 'checkout'; url: string }
  | { kind: 'order'; orderId: string }
  | { kind: 'terms-changed' | 'unavailable' | 'closed' | 'retry' };

/** One deliberate submission. Only uncertainty may resend the same captured intent. */
export function createOfferRequest(intent: OfferIntent, send: (intent: OfferIntent) => Promise<Response>) {
  const captured = Object.freeze({ ...intent });
  let pending = false;
  let resolved: OfferResult | undefined;
  return async (isCurrent: () => boolean = () => true): Promise<OfferResult | undefined> => {
    if (pending) return;
    if (!isCurrent()) return { kind: 'retry' };
    if (resolved) return resolved;
    pending = true;
    try {
      const response = await send(captured);
      if (!isCurrent()) return { kind: 'retry' };
      const body: unknown = await response.json();
      if (!isCurrent()) return { kind: 'retry' };
      const problem = decodeAcquisitionProblem(response.status, body);
      const target = response.ok ? v.safeParse(destination, body) : undefined;
      const code = body && typeof body === 'object' && 'code' in body ? body.code : undefined;
      let result: OfferResult;
      if (problem) result = { kind: 'existing', problem };
      else if (response.status === 409 && code === 'offer_revision_conflict') result = { kind: 'terms-changed' };
      else if (response.status === 409 && code === 'offer_unavailable') result = { kind: 'unavailable' };
      else if (isPlatformClosedProblem(response.status, body)) result = { kind: 'closed' };
      else if (target?.success)
        result =
          'orderId' in target.output
            ? { kind: 'order', orderId: target.output.orderId }
            : { kind: 'checkout', url: target.output.checkoutUrl };
      else result = { kind: 'retry' };
      if (result.kind !== 'retry') resolved = result;
      return result;
    } catch {
      return { kind: 'retry' };
    } finally {
      pending = false;
    }
  };
}
