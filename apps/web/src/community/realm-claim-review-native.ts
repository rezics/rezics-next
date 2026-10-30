import type { KernelClient } from '@rezics/client';
import { isPlatformClosedError, isPlatformClosedProblem } from '../kernel/platform-closed';
import { MediaProblem } from '../media/kernel';
import type { SessionEnv } from '../session/client';
import { prepareSession, viewerCredential } from '../session/request';
import {
  realmClaimApprovalReceipt,
  realmClaimReviewPage,
  validateRealmClaimApproval,
  validateRealmClaimReviewRead,
  type RealmClaimApprovalInput,
  type RealmClaimApprovalResult,
  type RealmClaimReviewRead,
} from './realm-claim-review';

export type RealmClaimReviewEnv = Partial<SessionEnv> & { KERNEL_ORIGIN?: string };

/** Consumer-local transport for the declared GET, until the original generated reader is delivered. */
export async function readRealmClaimReview(
  request: Request,
  env: RealmClaimReviewEnv,
  input: { realmId: string; cursor?: string },
  fetcher: typeof fetch = globalThis.fetch,
): Promise<RealmClaimReviewRead> {
  input = validateRealmClaimReviewRead(input);
  try {
    const stale = await prepareSession(request, env);
    const authorization = viewerCredential(request);
    if (stale || !authorization) return { kind: 'signed-out' };
    if (!env.KERNEL_ORIGIN) return { kind: 'unavailable' };
    const url = new URL(`/v1/realms/${input.realmId}/claimRequests`, env.KERNEL_ORIGIN);
    url.searchParams.set('limit', '20');
    if (input.cursor !== undefined) url.searchParams.set('cursor', input.cursor);
    const response = await fetcher(url, {
      method: 'GET',
      headers: { authorization, accept: 'application/json' },
      cache: 'no-store',
      credentials: 'omit',
      redirect: 'error',
    });
    if (response.status === 401) return { kind: 'signed-out' };
    if (response.status === 404) return { kind: 'denied' };
    if (response.status === 403) {
      const problem: unknown = await response.json().catch(() => null);
      return { kind: isPlatformClosedProblem(response.status, problem) ? 'closed' : 'denied' };
    }
    // A stale/invalid cursor (400), unavailable producer or unexpected response discloses no old page.
    if (response.status !== 200) return { kind: 'unavailable' };
    const body: unknown = await response.json();
    const page = realmClaimReviewPage(body, input.realmId);
    return page ? { kind: 'ready', page } : { kind: 'unavailable' };
  } catch (error) {
    return { kind: isPlatformClosedError(error) ? 'closed' : 'unavailable' };
  }
}

/** The real generated custom method delegates to Accounts' sole grant and currentGlobal authority. */
export async function approveRealmClaimReview(
  client: KernelClient,
  request: Request,
  env: Partial<SessionEnv>,
  input: RealmClaimApprovalInput,
): Promise<RealmClaimApprovalResult> {
  input = validateRealmClaimApproval(input);
  try {
    const stale = await prepareSession(request, env);
    const authorization = viewerCredential(request);
    if (stale || !authorization) return { kind: 'signed-out' };
    const headers = { authorization, 'idempotency-key': JSON.stringify(input.idempotencyKey) };
    const result = await client
      .realms({ realmId: input.realmId })
      .claimRequests({ requestId: input.requestId })
      .$approve.post({}, { headers });
    if (isPlatformClosedProblem(result.status, result.error?.value)) return { kind: 'closed' };
    if (result.status === 401) return { kind: 'signed-out' };
    if (result.status === 403 || result.status === 404) return { kind: 'denied' };
    if (result.status === 409 || result.status === 422) return { kind: 'conflict' };
    const claim = result.status === 200 && !result.error ? realmClaimApprovalReceipt(result.data, input) : null;
    return claim ? { kind: 'approved', claim } : { kind: 'unavailable' };
  } catch (error) {
    if (error instanceof MediaProblem && error.problem.status === 403) return { kind: 'denied' };
    return { kind: isPlatformClosedError(error) ? 'closed' : 'unavailable' };
  }
}
