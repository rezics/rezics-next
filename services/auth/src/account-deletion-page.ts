import type { Pool } from 'pg';
import { AUTH_PAGE_OPERATION_CLIENT_ID, AUTH_PAGE_OPERATION_SCOPES, type SessionProof } from '@rezics/auth-contract';
import type { AuthService } from './index.ts';
import { readNativeAccountIdentity } from './account-identity.ts';
import { readJsonObject, TransportDenied } from './account-operations-transport.ts';

export interface AccountDeletionPageAccess {
  readAccountDeletionAdvice(input: {
    human: SessionProof;
    deadline: number;
  }): Promise<{ kind: 'available' | 'refused' | 'changed' | 'unavailable' }>;
}
export const ACCOUNT_DELETION_PAGE_PATH = '/account-management/deletion-page';
export type AccountDeletionPage =
  | { kind: 'authentication-required'; accountId: string }
  | {
      kind: 'review';
      accountId: string;
      email: string | null;
      action: 'available' | 'refused';
      policy: 'personal-deletion';
    }
  | { kind: 'signed-out' | 'refused' | 'changed' | 'unavailable' };

/** One closed issuer read; caller input can select neither identity nor authority. */
export function accountDeletionPageTransport(
  service: AuthService,
  fallback: (request: Request) => Promise<Response>,
  database: Pool,
  access: AccountDeletionPageAccess | undefined,
): (request: Request) => Promise<Response> {
  return async (request) => {
    const url = new URL(request.url);
    if (url.pathname !== ACCOUNT_DELETION_PAGE_PATH) return fallback(request);
    const response = (body: unknown, status = 200) =>
      Response.json(body, {
        status,
        headers: { 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' },
      });
    try {
      if (
        request.method !== 'POST' ||
        url.search ||
        request.headers.has('authorization') ||
        request.headers.get('origin') !== new URL(service.verifier.issuer).origin ||
        request.headers.get('sec-fetch-site') === 'cross-site' ||
        request.headers.get('content-type')?.split(';')[0]?.trim() !== 'application/json'
      )
        throw new TransportDenied(400);
      if (Object.keys(await readJsonObject(request)).length) throw new TransportDenied(400);
      const deadline = Date.now() + 3000;
      const result = await service.internal.withFreshHuman(
        { headers: request.headers, fresh: false },
        async (human): Promise<AccountDeletionPage> => {
          await service.internal.accessTokenForProof(human);
          const profile = { client_id: AUTH_PAGE_OPERATION_CLIENT_ID, scope: [...AUTH_PAGE_OPERATION_SCOPES.delete] };
          if (human.client_id !== profile.client_id || JSON.stringify(human.scope) !== JSON.stringify(profile.scope))
            return { kind: 'authentication-required', accountId: human.account_id };
          if (!access) return { kind: 'unavailable' };
          const advice = await access.readAccountDeletionAdvice({ human, deadline });
          if (advice.kind === 'changed') return { kind: 'changed' };
          await service.internal.accessTokenForProof(human);
          if (Date.now() >= deadline) return { kind: 'unavailable' };
          if (advice.kind === 'unavailable') return { kind: 'unavailable' };
          if (advice.kind !== 'available' && advice.kind !== 'refused') return { kind: 'unavailable' };
          // Privileged display is read only after exact native human admission.
          const identity = await readNativeAccountIdentity(database, human.account_id);
          await service.internal.accessTokenForProof(human);
          if (Date.now() >= deadline) return { kind: 'unavailable' };
          return {
            kind: 'review',
            accountId: identity.account_id,
            email: identity.email,
            action: advice.kind,
            policy: 'personal-deletion',
          };
        },
      );
      return response(result);
    } catch (error) {
      const status = error && typeof error === 'object' && 'status' in error ? error.status : undefined;
      if (typeof status === 'number' && [400, 413, 415].includes(status))
        return response({ error: 'account_deletion_page_denied' }, status);
      return response({ kind: status === 401 ? 'signed-out' : status === 403 ? 'refused' : 'unavailable' });
    }
  };
}
