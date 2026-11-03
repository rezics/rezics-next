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

export type RealmClaimReviewEnv = Partial<SessionEnv>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function cursorFailure(status: number, value: unknown): RealmClaimReviewRead | null {
  if ((status !== 400 && status !== 409) || !isRecord(value)) return null;
  if (value.code === 'invalid_cursor') return { kind: 'invalid-cursor' };
  if (value.code === 'stale_cursor') return { kind: 'stale-cursor' };
  return null;
}

/** Use the installed, typed bounded reader; its native page remains the permission and disclosure authority. */
export async function readRealmClaimReview(
  client: KernelClient,
  request: Request,
  env: RealmClaimReviewEnv,
  input: { realmId: string; cursor?: string },
): Promise<RealmClaimReviewRead> {
  input = validateRealmClaimReviewRead(input);
  try {
    const stale = await prepareSession(request, env);
    const authorization = viewerCredential(request);
    if (stale || !authorization) return { kind: 'signed-out' };
    const result = await client.realms({ realmId: input.realmId }).claimRequests.get({
      query: { limit: 20, ...(input.cursor !== undefined ? { cursor: input.cursor } : {}) },
      headers: { authorization },
    });
    if (isPlatformClosedProblem(result.status, result.error?.value)) return { kind: 'closed' };
    if (result.status === 401) return { kind: 'signed-out' };
    if (result.status === 404) return { kind: 'denied' };
    if (result.status === 403) return { kind: 'denied' };
    const cursorError = cursorFailure(result.status, result.error?.value);
    if (cursorError) return cursorError;
    if (result.status !== 200 || result.error || !result.data) return { kind: 'unavailable' };
    const page = realmClaimReviewPage(result.data, input.realmId);
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
