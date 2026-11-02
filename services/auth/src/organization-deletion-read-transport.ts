import { AUTH_PAGE_OPERATION_CLIENT_ID, AUTH_PAGE_OPERATION_SCOPES, type SessionProof } from '@rezics/auth-contract';
import type { AuthService } from './index.ts';
import { readJsonObject, TransportDenied } from './account-operations-transport.ts';

export type OrganizationDeletionIdentity = {
  id: string;
  kind: 'organization';
  handle: string | null;
  displayName: string | null;
};
export type OrganizationDeletionRead =
  | { kind: 'ready'; account: OrganizationDeletionIdentity }
  | { kind: 'hidden' | 'denied' | 'missing' | 'unavailable' };
/** Private producer capability. The human comes only from Auth's live proof. */
export interface OrganizationDeletionAccess {
  readOrganizationForDeletion(input: {
    human: SessionProof;
    organizationId: string;
    deadline: number;
  }): Promise<OrganizationDeletionRead>;
}
export const ORGANIZATION_DELETION_READ_PATH = '/account-management/organizations/deletion-review';
export function organizationDeletionCaller(proof: SessionProof): boolean {
  return (
    proof.client_id === AUTH_PAGE_OPERATION_CLIENT_ID &&
    proof.scope.length === 1 &&
    proof.scope[0] === AUTH_PAGE_OPERATION_SCOPES.delete[0] &&
    proof.amr.length === 1 &&
    (proof.amr[0] === 'pwd' || proof.amr[0] === 'pop')
  );
}
export function organizationDeletionReadTransport(
  service: AuthService,
  fallback: (request: Request) => Promise<Response>,
  access: OrganizationDeletionAccess | undefined,
): (request: Request) => Promise<Response> {
  return async (request) => {
    const url = new URL(request.url);
    if (url.pathname !== ORGANIZATION_DELETION_READ_PATH) return fallback(request);
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
      const body = await readJsonObject(request);
      if (
        Object.keys(body).join(',') !== 'organizationId' ||
        typeof body.organizationId !== 'string' ||
        !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(body.organizationId)
      )
        throw new TransportDenied(400);
      if (!access) throw new TransportDenied(503);
      const organizationId = body.organizationId;
      const deadline = Date.now() + 3000;
      const result = await service.internal.withFreshHuman(
        { headers: request.headers, fresh: false },
        async (human) => {
          if (!organizationDeletionCaller(human) || human.account_id === organizationId) throw new TransportDenied(403);
          // Keep the exact session/profile live before and after all native I/O.
          await service.internal.accessTokenForProof(human);
          const read = await access.readOrganizationForDeletion({ human, organizationId, deadline });
          await service.internal.accessTokenForProof(human);
          if (Date.now() >= deadline) throw new TransportDenied(503);
          if (read.kind !== 'ready') {
            if (!['hidden', 'denied', 'missing', 'unavailable'].includes(read.kind)) throw new TransportDenied(503);
            return { kind: read.kind };
          }
          const row = read.account;
          if (
            row.id !== organizationId ||
            row.kind !== 'organization' ||
            (row.handle !== null && typeof row.handle !== 'string') ||
            (row.displayName !== null && typeof row.displayName !== 'string')
          )
            throw new TransportDenied(503);
          return {
            kind: 'ready',
            humanAccountId: human.account_id,
            account: { id: row.id, kind: row.kind, handle: row.handle, displayName: row.displayName },
          };
        },
      );
      return response(result);
    } catch (error) {
      const status = error && typeof error === 'object' && 'status' in error ? error.status : undefined;
      return response(
        { error: 'organization_deletion_read_denied' },
        typeof status === 'number' && [400, 401, 403, 413].includes(status) ? status : 503,
      );
    }
  };
}
