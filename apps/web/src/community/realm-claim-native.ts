import type { KernelClient } from '@rezics/client';
import type { ReadCredentialMode } from '../kernel/credential';
import { isPlatformClosedError, isPlatformClosedProblem } from '../kernel/platform-closed';
import { MediaProblem } from '../media/kernel';
import type { SessionEnv } from '../session/client';
import { prepareSession, viewerCredential } from '../session/request';
import {
  realmClaimSnapshot,
  sameRealmClaimSource,
  validateRealmClaimInput,
  validateRealmClaimRead,
  type RealmClaimInput,
  type RealmClaimRead,
  type RealmClaimResult,
} from './realm-claim';

/** Fixed native point reads, no request lists, candidates or ownership inference. */
export async function readRealmClaim(
  client: KernelClient,
  request: Request,
  env: Partial<SessionEnv>,
  input: { realmId: string; credentialMode: ReadCredentialMode },
): Promise<RealmClaimRead> {
  const { realmId } = validateRealmClaimRead(input);
  try {
    let authorization: string | null = null;
    if (input.credentialMode === 'session') {
      const stale = await prepareSession(request, env);
      if (!stale) authorization = viewerCredential(request);
    }
    const auth = authorization ? { headers: { authorization } } : {};
    const target = client.realms({ realmId });
    const before = await target.get(auth);
    if (isPlatformClosedProblem(before.status, before.error?.value)) return { kind: 'closed' };
    if (before.status === 403 || before.status === 404) return { kind: 'denied' };
    const snapshot =
      !before.error && before.status === 200 && before.data ? realmClaimSnapshot(before.data.realm) : null;
    if (!snapshot || snapshot.realmId !== realmId) return { kind: 'unavailable' };
    if (!authorization) return { kind: 'ready', snapshot, admission: 'signed-out' };
    const participation = await target.participation.get(auth);
    let admission: 'allowed' | 'denied' | 'unavailable' = 'unavailable';
    if (isPlatformClosedProblem(participation.status, participation.error?.value)) return { kind: 'closed' };
    if (participation.status === 204 && !participation.error) admission = 'allowed';
    else if (participation.status === 403) admission = 'denied';
    const final = await target.get(auth);
    if (isPlatformClosedProblem(final.status, final.error?.value)) return { kind: 'closed' };
    if (final.status === 403 || final.status === 404) return { kind: 'denied' };
    const current = !final.error && final.status === 200 && final.data ? realmClaimSnapshot(final.data.realm) : null;
    if (!current || !sameRealmClaimSource(snapshot, current)) return { kind: 'unavailable' };
    return { kind: 'ready', snapshot: current, admission };
  } catch (error) {
    return { kind: isPlatformClosedError(error) ? 'closed' : 'unavailable' };
  }
}

/** Existing BFF session/CSRF checks precede the real empty-body native command. */
export async function writeRealmClaim(
  client: KernelClient,
  request: Request,
  env: Partial<SessionEnv>,
  input: RealmClaimInput,
): Promise<RealmClaimResult> {
  input = validateRealmClaimInput(input);
  try {
    const stale = await prepareSession(request, env);
    const authorization = viewerCredential(request);
    if (stale || !authorization) return { kind: 'signed-out' };
    const headers = { authorization, 'idempotency-key': JSON.stringify(input.idempotencyKey) };
    const result = await client.realms({ realmId: input.realmId }).claimRequests.post({}, { headers });
    if (isPlatformClosedProblem(result.status, result.error?.value)) return { kind: 'closed' };
    if (result.status === 401) return { kind: 'signed-out' };
    if (result.status === 403 || result.status === 404) return { kind: 'denied' };
    if (result.status === 409 || result.status === 422) return { kind: 'conflict' };
    if (result.error || result.status !== 202 || !result.data || result.data.realmId !== input.realmId)
      return { kind: 'unavailable' };
    return { kind: 'pending', request: result.data };
  } catch (error) {
    if (error instanceof MediaProblem && error.problem.status === 403) return { kind: 'denied' };
    return { kind: isPlatformClosedError(error) ? 'closed' : 'unavailable' };
  }
}
