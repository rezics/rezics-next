import {
  AUTH_PAGE_OPERATION_CLIENT_ID,
  AUTH_PAGE_OPERATION_SCOPES,
  ORGANIZATION_DELETION_MAX_DISPLAY_NAME_LENGTH,
  ORGANIZATION_DELETION_MAX_HANDLE_LENGTH,
  ORGANIZATION_DELETION_MAX_SESSION_PROOF_ID_LENGTH,
  type OrganizationDeletionResponse,
  type SessionProof,
} from '@rezics/auth-contract';
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
  | { kind: 'hidden' | 'denied' | 'missing' | 'changed' | 'unavailable' };
/** Private producer capability. The human comes only from Auth's live proof. */
export interface OrganizationDeletionAccess {
  readOrganizationForDeletion(input: {
    human: SessionProof;
    organizationId: string;
    deadline: number;
  }): Promise<OrganizationDeletionRead>;
}
/** Trusted page composition only; ordinary readiness is never a workflow port. */
export interface OrganizationDeletionPageAccess extends OrganizationDeletionAccess {
  readOrganizationDeletionPage(input: {
    human: SessionProof;
    organizationId: string;
    deadline: number;
  }): Promise<OrganizationDeletionRead | { kind: 'authentication-required' }>;
}
export type OrganizationDeletionPage = OrganizationDeletionResponse;
export const ORGANIZATION_DELETION_READ_PATH = '/account-management/organizations/deletion-review';

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validRead(
  value: unknown,
  organizationId: string,
): value is OrganizationDeletionRead | { kind: 'authentication-required' } {
  if (!record(value)) return false;
  if (
    ['hidden', 'denied', 'missing', 'changed', 'unavailable'].includes(String(value.kind)) &&
    Object.keys(value).join(',') === 'kind'
  )
    return true;
  if (value.kind === 'authentication-required') return Object.keys(value).join(',') === 'kind';
  if (value.kind !== 'ready' || Object.keys(value).sort().join(',') !== 'account,kind' || !record(value.account))
    return false;
  const account = value.account;
  return (
    Object.keys(account).sort().join(',') === 'displayName,handle,id,kind' &&
    account.id === organizationId &&
    account.kind === 'organization' &&
    (account.handle === null ||
      (typeof account.handle === 'string' &&
        account.handle.length <= ORGANIZATION_DELETION_MAX_HANDLE_LENGTH &&
        /^[a-z0-9][a-z0-9_-]{0,63}$/.test(account.handle))) &&
    (account.displayName === null ||
      (typeof account.displayName === 'string' &&
        account.displayName.length <= ORGANIZATION_DELETION_MAX_DISPLAY_NAME_LENGTH))
  );
}

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
  access: OrganizationDeletionPageAccess | undefined,
): (request: Request) => Promise<Response> {
  return async (request) => {
    const url = new URL(request.url);
    if (url.pathname !== ORGANIZATION_DELETION_READ_PATH) return fallback(request);
    const response = (body: OrganizationDeletionPage | { error: 'organization_deletion_read_denied' }, status = 200) =>
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
      const organizationId = body.organizationId;
      const deadline = Date.now() + 3000;
      const result = await boundedPageRead(deadline, () =>
        service.internal.withFreshHuman(
          { headers: request.headers, fresh: false },
          async (human): Promise<OrganizationDeletionPage> => {
            if (human.account_id === organizationId) return { kind: 'denied' };
            // Keep the exact session/profile live before and after all native I/O.
            await service.internal.accessTokenForProof(human);
            if (!access) return { kind: 'unavailable' };
            if (Date.now() >= deadline) throw new TransportDenied(503);
            const read: unknown = await access.readOrganizationDeletionPage({ human, organizationId, deadline });
            await service.internal.accessTokenForProof(human);
            if (Date.now() >= deadline) throw new TransportDenied(503);
            if (!validRead(read, organizationId)) return { kind: 'unavailable' };
            if (read.kind === 'authentication-required') {
              if (organizationDeletionCaller(human)) return { kind: 'unavailable' };
              if (human.account_id.length > ORGANIZATION_DELETION_MAX_SESSION_PROOF_ID_LENGTH)
                return { kind: 'unavailable' };
              return { kind: 'authentication-required', humanAccountId: human.account_id, action: 'authenticate' };
            }
            // A misbound producer cannot disclose a target to an ordinary profile.
            if (!organizationDeletionCaller(human)) return { kind: 'unavailable' };
            if (read.kind !== 'ready') return { kind: read.kind };
            if (human.account_id.length > ORGANIZATION_DELETION_MAX_SESSION_PROOF_ID_LENGTH)
              return { kind: 'unavailable' };
            const row = read.account;
            return {
              kind: 'ready',
              humanAccountId: human.account_id,
              action: 'confirm',
              account: { id: row.id, kind: row.kind, handle: row.handle, displayName: row.displayName },
            };
          },
        ),
      );
      return response(result);
    } catch (error) {
      const status = error && typeof error === 'object' && 'status' in error ? error.status : undefined;
      if (typeof status === 'number' && [400, 413].includes(status))
        return response({ error: 'organization_deletion_read_denied' }, status);
      return response({ kind: status === 401 ? 'signed-out' : status === 403 ? 'denied' : 'unavailable' });
    }
  };
}

/** Include Auth currentness and released native preparation in one response bound. */
async function boundedPageRead<T>(deadline: number, read: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      read(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new TransportDenied(503)), Math.max(0, deadline - Date.now()));
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
