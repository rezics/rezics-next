import type { KernelClient } from '@rezics/client';
import { isPlatformClosedError, isPlatformClosedProblem } from '../kernel/platform-closed';
import type { SessionEnv } from '../session/client';
import { prepareSession, viewerCredential } from '../session/request';
import { realmClaimSnapshot, sameRealmClaimSource } from './realm-claim';
import {
  realmClaimStatusResponse,
  validateRealmClaimStatusRead,
  type RealmClaimStatusInput,
  type RealmClaimStatusRead,
} from './realm-claim-status';

export type RealmClaimStatusEnv = Partial<SessionEnv> & { KERNEL_ORIGIN?: string };

/** Isolated consumer transport until the original generated requester GETs are available. */
export async function readRealmClaimStatus(
  client: KernelClient,
  request: Request,
  env: RealmClaimStatusEnv,
  input: RealmClaimStatusInput,
  fetcher: typeof fetch = globalThis.fetch,
): Promise<RealmClaimStatusRead> {
  input = validateRealmClaimStatusRead(input);
  try {
    const stale = await prepareSession(request, env);
    const authorization = viewerCredential(request);
    if (stale || !authorization) return { kind: 'signed-out' };
    if (!env.KERNEL_ORIGIN) return { kind: 'unavailable' };
    const target = client.realms({ realmId: input.realmId });
    const auth = { headers: { authorization } };
    async function access(): Promise<RealmClaimStatusRead> {
      const realm = await target.get(auth);
      if (isPlatformClosedProblem(realm.status, realm.error?.value)) return { kind: 'closed' };
      if (realm.status === 401) return { kind: 'signed-out' };
      if (realm.status === 403 || realm.status === 404) return { kind: 'denied' };
      const source = realm.status === 200 && !realm.error && realm.data ? realmClaimSnapshot(realm.data.realm) : null;
      if (!source || source.realmId !== input.realmId) return { kind: 'unavailable' };
      const participation = await target.participation.get(auth);
      if (isPlatformClosedProblem(participation.status, participation.error?.value)) return { kind: 'closed' };
      if (participation.status === 401) return { kind: 'signed-out' };
      if (participation.status === 403 || participation.status === 404) return { kind: 'denied' };
      if (participation.status !== 204 || participation.error) return { kind: 'unavailable' };
      return { kind: 'ready', source, claimRequest: null };
    }
    const before = await access();
    if (before.kind !== 'ready') return before;
    if (input.requestId === undefined && before.source.ownershipState !== 'orphaned') return { kind: 'unavailable' };
    const url = new URL(`/v1/realms/${input.realmId}/claimRequests/${input.requestId ?? 'mine'}`, env.KERNEL_ORIGIN);
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
    if (response.status !== 200) return { kind: 'unavailable' };
    const claimRequest = realmClaimStatusResponse(await response.json(), input);
    if (claimRequest === undefined) return { kind: 'unavailable' };
    const final = await access();
    if (final.kind !== 'ready') return final;
    if (!sameRealmClaimSource(before.source, final.source)) return { kind: 'unavailable' };
    if (
      claimRequest?.currentEpisode &&
      final.source.ownershipState === 'orphaned' &&
      claimRequest.orphanedAt !== final.source.orphanedAt
    )
      return { kind: 'unavailable' };
    return { kind: 'ready', source: final.source, claimRequest };
  } catch (error) {
    return { kind: isPlatformClosedError(error) ? 'closed' : 'unavailable' };
  }
}
