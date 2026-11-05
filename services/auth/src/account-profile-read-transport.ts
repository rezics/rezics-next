import { managementOperationProfile, type SessionProof } from '@rezics/auth-contract';
import type { AuthService } from './index.ts';
import { readJsonObject, TransportDenied } from './account-operations-transport.ts';

type RenameAccountProfile = { profile: { id: string; kind: 'actor'; handle: string | null } };
/** Auth-local shape of Kernel's producer-owned private profile port. */
export interface AccountProfileAccess {
  readRenameAccountProfile(input: {
    human: SessionProof;
    accountId: string;
    deadline: number;
  }): Promise<RenameAccountProfile>;
}
const id = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.exec(value)?.[0] === value;

/** Keep the closed profile read bound to the same exact management proof. */
export function isExactRenameProfile(human: SessionProof, accountId: string): boolean {
  const profile = managementOperationProfile('rename');
  return (
    human.account_id === accountId &&
    human.client_id === profile.client_id &&
    JSON.stringify(human.scope) === JSON.stringify(profile.scope) &&
    human.amr.length === 1 &&
    (human.amr[0] === 'pwd' || human.amr[0] === 'pop')
  );
}

/** Disclosure is limited even if a composed source returns a broader profile. */
export function closedProfile(value: unknown, accountId: string): RenameAccountProfile {
  const profile = (value as RenameAccountProfile | null)?.profile;
  if (
    !profile ||
    profile.id !== accountId ||
    profile.kind !== 'actor' ||
    (profile.handle !== null &&
      (typeof profile.handle !== 'string' ||
        /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.exec(profile.handle)?.[0] !== profile.handle))
  )
    throw new TransportDenied(503);
  return { profile: { id: accountId, kind: 'actor', handle: profile.handle } };
}

export function accountProfileReadTransport(
  service: AuthService,
  fallback: (request: Request) => Promise<Response>,
  access: AccountProfileAccess | undefined,
): (request: Request) => Promise<Response> {
  return async (request) => {
    const url = new URL(request.url);
    if (url.pathname !== '/account-management/profile') return fallback(request);
    const response = (body: unknown, status = 200) =>
      Response.json(body, {
        status,
        headers: { 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' },
      });
    const refused = (status: number) => response({ error: 'account_profile_read_unavailable' }, status);
    if (
      request.method !== 'POST' ||
      url.search ||
      request.headers.has('authorization') ||
      request.headers.get('origin') !== new URL(service.verifier.issuer).origin ||
      request.headers.get('sec-fetch-site') === 'cross-site' ||
      request.headers.get('content-type')?.split(';')[0]?.trim() !== 'application/json'
    )
      return refused(400);
    try {
      const body = await readJsonObject(request);
      if (Object.keys(body).join(',') !== 'accountId' || !id(body.accountId)) return refused(400);
      if (!access) return refused(503);
      const accountId = body.accountId;
      const deadline = Date.now() + 3000;
      const result = await service.internal.withFreshHuman(
        { headers: request.headers, fresh: false },
        async (human) => {
          if (!isExactRenameProfile(human, accountId)) throw new TransportDenied(403);
          const result = closedProfile(
            await access.readRenameAccountProfile({ human, accountId, deadline }),
            accountId,
          );
          // Revalidate the same session, floor, client and consent after native I/O.
          // Approval still requires fresh authentication and its own native checks.
          await service.internal.accessTokenForProof(human);
          if (Date.now() >= deadline) throw new TransportDenied(503);
          return result;
        },
      );
      return response(result);
    } catch (error) {
      const status = error && typeof error === 'object' && 'status' in error ? error.status : undefined;
      return refused(typeof status === 'number' && [400, 401, 403, 409, 413, 415].includes(status) ? status : 503);
    }
  };
}
