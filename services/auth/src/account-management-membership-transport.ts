import { AUTH_MANAGEMENT_CLIENT_ID, AUTH_MANAGEMENT_SCOPES, type SessionProof } from '@rezics/auth-contract';
import type { AuthService } from './index.ts';
import { readJsonObject, TransportDenied } from './account-operations-transport.ts';

export type MembershipSelection = { organizationId: string; memberAccountId: string };
export type MembershipCommandState = MembershipSelection & {
  membership: null | { role: 'owner' | 'member'; reservationId: string };
};
/** Explicit local adapter until this read port is part of generated bindings. */
export interface ManagementMembershipAccess {
  readOrganizationMembershipCommandState(
    input: MembershipSelection & { human: SessionProof; deadline: number },
  ): Promise<MembershipCommandState>;
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const id = (value: unknown): value is string => typeof value === 'string' && uuid.test(value);
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function fields(value: Record<string, unknown>, names: string[]) {
  return Object.keys(value).length === names.length && names.every((name) => Object.hasOwn(value, name));
}
/** Closed output even if an unavailable/misconfigured adapter returns extra data. */
export function membershipCommandState(value: unknown, selection: MembershipSelection): MembershipCommandState {
  if (
    !record(value) ||
    !fields(value, ['organizationId', 'memberAccountId', 'membership']) ||
    !id(value.organizationId) ||
    !id(value.memberAccountId) ||
    value.organizationId !== selection.organizationId ||
    value.memberAccountId !== selection.memberAccountId
  )
    throw new TransportDenied(503);
  const membership = value.membership;
  if (membership === null) return { ...selection, membership: null };
  if (
    !record(membership) ||
    !fields(membership, ['role', 'reservationId']) ||
    (membership.role !== 'owner' && membership.role !== 'member') ||
    !id(membership.reservationId)
  )
    throw new TransportDenied(503);
  return { ...selection, membership: { role: membership.role, reservationId: membership.reservationId } };
}

/** No Auth-local ownership/role evaluator: only the native command formula. */
export function accountManagementMembershipTransport(
  service: AuthService,
  fallback: (request: Request) => Promise<Response>,
  access: ManagementMembershipAccess | undefined,
): (request: Request) => Promise<Response> {
  return async (request) => {
    const url = new URL(request.url);
    if (url.pathname !== '/account-management/organizations/member') return fallback(request);
    const response = (body: unknown, status = 200) =>
      Response.json(body, {
        status,
        headers: { 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' },
      });
    const denied = (status: number) => response({ error: 'membership_command_state_denied' }, status);
    if (!access) return denied(503);
    if (
      request.method !== 'POST' ||
      url.search ||
      request.headers.get('origin') !== new URL(service.verifier.issuer).origin ||
      request.headers.get('sec-fetch-site') === 'cross-site' ||
      request.headers.get('content-type')?.split(';')[0]?.trim() !== 'application/json'
    )
      return denied(400);
    try {
      const body = await readJsonObject(request);
      if (!fields(body, ['organizationId', 'memberAccountId']) || !id(body.organizationId) || !id(body.memberAccountId))
        return denied(400);
      const selection = { organizationId: body.organizationId, memberAccountId: body.memberAccountId };
      const deadline = Date.now() + 3000;
      const result = await service.internal.withFreshHuman(
        { headers: request.headers, fresh: false },
        async (human) => {
          if (
            human.client_id !== AUTH_MANAGEMENT_CLIENT_ID ||
            JSON.stringify(human.scope) !== JSON.stringify(AUTH_MANAGEMENT_SCOPES.membership) ||
            human.amr.length !== 1 ||
            (human.amr[0] !== 'pwd' && human.amr[0] !== 'pop')
          )
            throw new TransportDenied(403);
          return membershipCommandState(
            await access.readOrganizationMembershipCommandState({
              ...selection,
              human,
              deadline,
            }),
            selection,
          );
        },
      );
      return response(result);
    } catch (error) {
      const status = error && typeof error === 'object' && 'status' in error ? error.status : undefined;
      return denied(typeof status === 'number' && [400, 401, 403, 409, 413, 415, 503].includes(status) ? status : 503);
    }
  };
}
