import { AUTH_MANAGEMENT_CLIENT_ID, AUTH_MANAGEMENT_SCOPES, type SessionProof } from '@rezics/auth-contract';
import type { AuthService } from './index.ts';
import { readJsonObject, TransportDenied } from './account-operations-transport.ts';

export const ORGANIZATION_MEMBERSHIP_PAGE_PATH = '/account-management/organizations/page';
export type MembershipActionAdvice = 'allowed' | 'last-owner' | 'unavailable';
export type MembershipPublicIdentity = {
  id: string;
  kind: 'actor' | 'organization';
  handle: string | null;
  displayName: string | null;
};
export type OrganizationMembershipPage = {
  organizationId: string;
  viewer: { accountId: string; role: 'owner' | 'member'; leave: MembershipActionAdvice };
  members:
    | {
        state: 'ready';
        items: {
          accountId: string;
          account: MembershipPublicIdentity | null;
          role: 'owner' | 'member';
          actions: { changeRole: MembershipActionAdvice; remove: MembershipActionAdvice };
        }[];
        next: string | null;
      }
    | { state: 'unavailable' };
};
export interface OrganizationMembershipPageAccess {
  readOrganizationMembershipPage(input: {
    organizationId: string;
    cursor?: string;
    human: SessionProof;
    deadline: number;
  }): Promise<OrganizationMembershipPage>;
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const id = (value: unknown): value is string => typeof value === 'string' && uuid.test(value);
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function fields(value: Record<string, unknown>, names: string[]) {
  return Object.keys(value).length === names.length && names.every((name) => Object.hasOwn(value, name));
}
function text(value: unknown, max = 4096): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}
function advice(value: unknown): value is MembershipActionAdvice {
  return value === 'allowed' || value === 'last-owner' || value === 'unavailable';
}
function publicIdentity(value: unknown, accountId: string): value is MembershipPublicIdentity {
  return (
    record(value) &&
    fields(value, ['id', 'kind', 'handle', 'displayName']) &&
    value.id === accountId &&
    (value.kind === 'actor' || value.kind === 'organization') &&
    (value.handle === null || (typeof value.handle === 'string' && value.handle.length <= 256)) &&
    (value.displayName === null || (typeof value.displayName === 'string' && value.displayName.length <= 256))
  );
}

/** Project only the bounded public page fields across the Auth transport. */
export function organizationMembershipPage(
  value: unknown,
  organizationId: string,
  viewerAccountId: string,
): OrganizationMembershipPage {
  if (
    !record(value) ||
    !fields(value, ['organizationId', 'viewer', 'members']) ||
    value.organizationId !== organizationId ||
    !record(value.viewer) ||
    !fields(value.viewer, ['accountId', 'role', 'leave']) ||
    value.viewer.accountId !== viewerAccountId ||
    (value.viewer.role !== 'owner' && value.viewer.role !== 'member') ||
    !advice(value.viewer.leave) ||
    (value.viewer.role === 'member' && value.viewer.leave === 'last-owner') ||
    !record(value.members)
  )
    throw new TransportDenied(503);

  if (value.members.state === 'unavailable') {
    if (!fields(value.members, ['state'])) throw new TransportDenied(503);
    return {
      organizationId,
      viewer: {
        accountId: viewerAccountId,
        role: value.viewer.role,
        leave: value.viewer.leave,
      },
      members: { state: 'unavailable' },
    };
  }
  if (
    value.members.state !== 'ready' ||
    !fields(value.members, ['state', 'items', 'next']) ||
    !Array.isArray(value.members.items) ||
    value.members.items.length > 20 ||
    !(value.members.next === null || text(value.members.next))
  )
    throw new TransportDenied(503);
  const seen = new Set<string>();
  const items: Extract<OrganizationMembershipPage['members'], { state: 'ready' }>['items'] = [];
  for (const item of value.members.items) {
    if (
      !record(item) ||
      !fields(item, ['accountId', 'account', 'role', 'actions']) ||
      !id(item.accountId) ||
      seen.has(item.accountId) ||
      (item.role !== 'owner' && item.role !== 'member') ||
      !(item.account === null || publicIdentity(item.account, item.accountId)) ||
      !record(item.actions) ||
      !fields(item.actions, ['changeRole', 'remove']) ||
      !advice(item.actions.changeRole) ||
      !advice(item.actions.remove) ||
      (item.actions.changeRole === 'last-owner' && item.role !== 'owner') ||
      (item.actions.remove === 'last-owner' && item.role !== 'owner') ||
      (value.viewer.role === 'member' &&
        (item.actions.changeRole !== 'unavailable' || item.actions.remove !== 'unavailable'))
    )
      throw new TransportDenied(503);
    seen.add(item.accountId);
    items.push({
      accountId: item.accountId,
      account: item.account === null ? null : { ...item.account },
      role: item.role,
      actions: { changeRole: item.actions.changeRole, remove: item.actions.remove },
    });
  }
  return {
    organizationId,
    viewer: { accountId: viewerAccountId, role: value.viewer.role, leave: value.viewer.leave },
    members: { state: 'ready', items, next: value.members.next },
  };
}

/** Fresh-human Auth proof, same-origin request and closed native output only. */
export function organizationMembershipPageTransport(
  service: AuthService,
  fallback: (request: Request) => Promise<Response>,
  access: OrganizationMembershipPageAccess | undefined,
): (request: Request) => Promise<Response> {
  return async (request) => {
    const url = new URL(request.url);
    if (url.pathname !== ORGANIZATION_MEMBERSHIP_PAGE_PATH) return fallback(request);
    const response = (body: unknown, status = 200) =>
      Response.json(body, {
        status,
        headers: { 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' },
      });
    const refused = (status: number) =>
      response(
        { error: status === 503 ? 'organization_membership_page_unavailable' : 'organization_membership_page_denied' },
        status,
      );
    if (!access) return refused(503);
    if (
      request.method !== 'POST' ||
      url.search ||
      request.headers.get('origin') !== new URL(service.verifier.issuer).origin ||
      request.headers.get('sec-fetch-site') === 'cross-site' ||
      request.headers.has('authorization') ||
      request.headers.get('content-type')?.split(';')[0]?.trim() !== 'application/json'
    )
      return refused(400);
    try {
      const body = await readJsonObject(request);
      const allowedKeys = Object.keys(body);
      if (
        !id(body.organizationId) ||
        allowedKeys.some((key) => !['organizationId', 'cursor'].includes(key)) ||
        (Object.hasOwn(body, 'cursor') && !text(body.cursor))
      )
        return refused(400);
      const organizationId = body.organizationId;
      const cursor = body.cursor as string | undefined;
      const deadline = Date.now() + 8000;
      const page = await service.internal.withFreshHuman({ headers: request.headers, fresh: false }, async (human) => {
        if (
          human.client_id !== AUTH_MANAGEMENT_CLIENT_ID ||
          JSON.stringify(human.scope) !== JSON.stringify(AUTH_MANAGEMENT_SCOPES.membership) ||
          human.amr.length !== 1 ||
          (human.amr[0] !== 'pwd' && human.amr[0] !== 'pop')
        )
          throw new TransportDenied(403);
        return organizationMembershipPage(
          await access.readOrganizationMembershipPage({
            organizationId,
            ...(cursor ? { cursor } : {}),
            human,
            deadline,
          }),
          organizationId,
          human.account_id,
        );
      });
      return response(page);
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'step_up_required')
        return response({ error: 'step_up_required' }, 401);
      if (error && typeof error === 'object' && 'code' in error && error.code === 'invalid_cursor') return refused(400);
      if (error && typeof error === 'object' && 'code' in error && error.code === 'stale_cursor') return refused(409);
      const status = error && typeof error === 'object' && 'status' in error ? error.status : undefined;
      return refused(
        typeof status === 'number' && [400, 401, 403, 404, 409, 413, 415, 503].includes(status) ? status : 503,
      );
    }
  };
}
