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
  if (problem.code === 'acquisition_pending' ? !problem.orderId : !problem.entitlementId && !problem.orderId)
    return;
  return problem;
}

export type OfferIntent = Readonly<{ offerId: string; expectedOfferRevision: number; idempotencyKey: string }>;
export type OfferResult =
  | { kind: 'existing'; problem: AcquisitionProblem }
  | { kind: 'checkout'; url: string }
  | { kind: 'terms-changed' | 'unavailable' | 'closed' | 'retry' };

/** One deliberate submission. Only uncertainty may resend the same captured intent. */
export function createOfferRequest(intent: OfferIntent, send: (intent: OfferIntent) => Promise<Response>) {
  const captured = Object.freeze({ ...intent });
  let pending = false;
  let resolved: OfferResult | undefined;
  return async (): Promise<OfferResult | undefined> => {
    if (pending) return;
    if (resolved) return resolved;
    pending = true;
    try {
      const response = await send(captured);
      const body: unknown = await response.json();
      const problem = decodeAcquisitionProblem(response.status, body);
      const code = body && typeof body === 'object' && 'code' in body ? body.code : undefined;
      let result: OfferResult;
      if (problem) result = { kind: 'existing', problem };
      else if (response.status === 409 && code === 'offer_revision_conflict') result = { kind: 'terms-changed' };
      else if (response.status === 409 && code === 'offer_unavailable') result = { kind: 'unavailable' };
      else if (isPlatformClosedProblem(response.status, body)) result = { kind: 'closed' };
      else if (
        response.ok &&
        body &&
        typeof body === 'object' &&
        'checkoutUrl' in body &&
        typeof body.checkoutUrl === 'string' &&
        body.checkoutUrl
      )
        result = { kind: 'checkout', url: body.checkoutUrl };
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
