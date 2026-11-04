import { createServerFn } from '@tanstack/react-start';
import * as contract from '@rezics/auth-contract';
import { authPost } from './api';
import { loadAccountSession, type AccountSessionResult } from './account-operations';
import { membershipReservationMatches, sameMembershipCommand } from './membership-recovery';

export type MembershipOperation = Readonly<{
  kind: 'membership';
  organizationId: string;
  memberAccountId: string;
  role: 'owner' | 'member' | null;
  reservationId?: string;
}>;
export type MembershipActionAdvice = 'allowed' | 'last-owner' | 'unavailable';
export type MembershipIdentity = {
  id: string;
  kind: 'actor' | 'organization';
  handle: string | null;
  displayName: string | null;
};
export type Holder = {
  accountId: string;
  account: MembershipIdentity | null;
  role: 'owner' | 'member';
  actions: { changeRole: MembershipActionAdvice; remove: MembershipActionAdvice };
};
export type MembershipPage =
  | {
      kind: 'ready';
      organizationId: string;
      viewer: { accountId: string; role: 'owner' | 'member'; leave: MembershipActionAdvice };
      members: { state: 'ready'; holders: Holder[]; next: string | null } | { state: 'unavailable' };
    }
  | { kind: 'signed-out' | 'denied' | 'missing' | 'preparing' | 'conflict' | 'unavailable' };
export type MembershipOutcome =
  | 'acknowledged'
  | 'step-up'
  | 'denied'
  | 'conflict'
  | 'preparing'
  | 'unknown'
  | 'unavailable';
export type MembershipCommand = {
  accountId: string;
  operationKey: string;
  operation: MembershipOperation;
  reference?: string;
  unresolved: boolean;
};
const storageKey = 'rezics.organization-membership.command';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function membershipId(value: unknown): value is string {
  return typeof value === 'string' && uuid.test(value);
}
function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function closed(value: Record<string, unknown>, fields: string[]) {
  return Object.keys(value).every((key) => fields.includes(key));
}
function text(value: unknown, max = 4096): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}
function role(value: unknown): value is Holder['role'] {
  return value === 'owner' || value === 'member';
}
function advice(value: unknown): value is MembershipActionAdvice {
  return value === 'allowed' || value === 'last-owner' || value === 'unavailable';
}
function identity(value: unknown, accountId: string): value is MembershipIdentity {
  return (
    record(value) &&
    closed(value, ['id', 'kind', 'handle', 'displayName']) &&
    value.id === accountId &&
    (value.kind === 'actor' || value.kind === 'organization') &&
    (value.handle === null || (typeof value.handle === 'string' && value.handle.length <= 256)) &&
    (value.displayName === null || (typeof value.displayName === 'string' && value.displayName.length <= 256))
  );
}
export function isMembershipOperation(value: unknown): value is MembershipOperation {
  return (
    record(value) &&
    closed(value, ['kind', 'organizationId', 'memberAccountId', 'role', 'reservationId']) &&
    value.kind === 'membership' &&
    membershipId(value.organizationId) &&
    membershipId(value.memberAccountId) &&
    (role(value.role) || value.role === null) &&
    (value.reservationId === undefined || text(value.reservationId)) &&
    (value.role !== null || text(value.reservationId))
  );
}

/** The management client is supplied by the shared Auth owner. Absent exports
 * remain unavailable; never substitute the login or account-operation client.
 * The default adapter consumes AUTH_MANAGEMENT_CLIENT_ID and
 * AUTH_MANAGEMENT_SCOPES.membership from the installed shared contract.
 */
export function membershipProfile(
  source: unknown = {
    AUTH_PAGE_MANAGEMENT_CLIENT_ID: contract.AUTH_MANAGEMENT_CLIENT_ID,
    AUTH_PAGE_MANAGEMENT_SCOPES: contract.AUTH_MANAGEMENT_SCOPES,
  },
): { client_id: string; scope: ['organization:membership'] } | null {
  if (!record(source) || !text(source.AUTH_PAGE_MANAGEMENT_CLIENT_ID) || !record(source.AUTH_PAGE_MANAGEMENT_SCOPES))
    return null;
  const scopes = source.AUTH_PAGE_MANAGEMENT_SCOPES.membership;
  if (
    source.AUTH_PAGE_MANAGEMENT_CLIENT_ID === 'login' ||
    source.AUTH_PAGE_MANAGEMENT_CLIENT_ID === contract.AUTH_PAGE_OPERATION_CLIENT_ID ||
    !Array.isArray(scopes) ||
    scopes.length !== 1 ||
    scopes[0] !== 'organization:membership'
  )
    return null;
  return { client_id: source.AUTH_PAGE_MANAGEMENT_CLIENT_ID, scope: ['organization:membership'] };
}
export function membershipSessionMatches(session: AccountSessionResult, accountId: string): boolean {
  const profile = membershipProfile();
  return (
    session.kind === 'ready' &&
    session.accountId === accountId &&
    profile !== null &&
    session.clientId === profile.client_id &&
    session.scopes?.length === 1 &&
    session.scopes[0] === profile.scope[0]
  );
}

/** The roster and action advice are presentation only. Command metadata always
 * comes from the exact selected-member point below. */
export function parseMembershipPage(body: unknown, organizationId: string, accountId: string): MembershipPage {
  const unavailable = { kind: 'unavailable' } as const;
  if (
    !record(body) ||
    !closed(body, ['organizationId', 'viewer', 'members']) ||
    body.organizationId !== organizationId ||
    !record(body.viewer) ||
    !closed(body.viewer, ['accountId', 'role', 'leave']) ||
    body.viewer.accountId !== accountId ||
    !role(body.viewer.role) ||
    !advice(body.viewer.leave) ||
    (body.viewer.role === 'member' && body.viewer.leave === 'last-owner') ||
    !record(body.members) ||
    !(body.members.state === 'ready' || body.members.state === 'unavailable')
  )
    return unavailable;
  if (body.members.state === 'unavailable') {
    if (!closed(body.members, ['state'])) return unavailable;
    return {
      kind: 'ready',
      organizationId,
      viewer: { accountId, role: body.viewer.role, leave: body.viewer.leave },
      members: { state: 'unavailable' },
    };
  }
  if (
    !closed(body.members, ['state', 'items', 'next']) ||
    !Array.isArray(body.members.items) ||
    body.members.items.length > 20 ||
    !(body.members.next === null || text(body.members.next))
  )
    return unavailable;
  const holders: Holder[] = [];
  for (const item of body.members.items) {
    if (
      !record(item) ||
      !closed(item, ['accountId', 'account', 'role', 'actions']) ||
      !membershipId(item.accountId) ||
      !role(item.role) ||
      !(item.account === null || identity(item.account, item.accountId)) ||
      holders.some((row) => row.accountId === item.accountId) ||
      !record(item.actions) ||
      !closed(item.actions, ['changeRole', 'remove']) ||
      !advice(item.actions.changeRole) ||
      !advice(item.actions.remove) ||
      (item.actions.changeRole === 'last-owner' && item.role !== 'owner') ||
      (item.actions.remove === 'last-owner' && item.role !== 'owner') ||
      (body.viewer.role === 'member' &&
        (item.actions.changeRole !== 'unavailable' || item.actions.remove !== 'unavailable'))
    )
      return unavailable;
    holders.push({
      accountId: item.accountId,
      account: item.account === null ? null : { ...item.account },
      role: item.role,
      actions: { changeRole: item.actions.changeRole, remove: item.actions.remove },
    });
  }
  return {
    kind: 'ready',
    organizationId,
    viewer: { accountId, role: body.viewer.role, leave: body.viewer.leave },
    members: { state: 'ready', holders, next: body.members.next as string | null },
  };
}
function readFailure(status: number): Exclude<MembershipPage, { kind: 'ready' }> {
  if (status === 401) return { kind: 'signed-out' };
  if (status === 403) return { kind: 'denied' };
  if (status === 404) return { kind: 'missing' };
  if (status === 202) return { kind: 'preparing' };
  if (status === 409 || status === 400) return { kind: 'conflict' };
  return { kind: 'unavailable' };
}
const readPage = createServerFn({ method: 'POST' })
  .validator((value: unknown): { organizationId: string; accountId: string; cursor?: string } => {
    if (
      !record(value) ||
      !closed(value, ['organizationId', 'accountId', 'cursor']) ||
      !membershipId(value.organizationId) ||
      !membershipId(value.accountId) ||
      (value.cursor !== undefined && !text(value.cursor))
    )
      throw new Error('Invalid membership page');
    return value as { organizationId: string; accountId: string; cursor?: string };
  })
  .handler(async ({ data }): Promise<MembershipPage> => {
    const { getRequest, setResponseHeader } = await import('@tanstack/react-start/server');
    setResponseHeader('Cache-Control', 'private, no-store');
    try {
      const request = getRequest();
      const origin = new URL(request.url).origin;
      const issuer = import.meta.env.DEV && __AUTH_ORIGIN__ ? new URL(__AUTH_ORIGIN__).origin : origin;
      if (
        request.headers.get('sec-fetch-site') === 'cross-site' ||
        (request.headers.get('origin') !== origin && request.headers.get('origin') !== issuer)
      )
        return { kind: 'denied' };
      const headers = {
        Accept: 'application/json',
        Origin: issuer,
        Cookie: request.headers.get('cookie') ?? '',
      };
      const sessionResponse = await fetch(new URL('/session', issuer), {
        headers,
        redirect: 'error',
        cache: 'no-store',
        signal: AbortSignal.timeout(5000),
      });
      if (sessionResponse.status !== 200) return readFailure(sessionResponse.status);
      const session: unknown = await sessionResponse.json();
      if (!record(session) || session.account_id !== data.accountId) return { kind: 'denied' };
      // Auth binds the fresh management proof to its trusted native page port.
      // The caller cannot supply a principal, client, scope or kernel target.
      const pageResponse = await fetch(new URL('/account-management/organizations/page', issuer), {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ organizationId: data.organizationId, ...(data.cursor ? { cursor: data.cursor } : {}) }),
        redirect: 'error',
        cache: 'no-store',
        signal: AbortSignal.timeout(8000),
      });
      return pageResponse.status === 200
        ? parseMembershipPage(await pageResponse.json(), data.organizationId, data.accountId)
        : readFailure(pageResponse.status);
    } catch {
      return { kind: 'unavailable' };
    }
  });
export async function loadMembershipPage(
  organizationId: string,
  accountId: string,
  cursor?: string,
): Promise<MembershipPage> {
  try {
    return await readPage({ data: { organizationId, accountId, ...(cursor ? { cursor } : {}) } });
  } catch {
    return { kind: 'unavailable' };
  }
}

export type SelectedMembership =
  | {
      kind: 'ready';
      organizationId: string;
      memberAccountId: string;
      membership: null | { role: 'owner' | 'member'; reservationId: string };
    }
  | Exclude<MembershipPage, { kind: 'ready' }>;
export function parseSelectedMembership(
  body: unknown,
  organizationId: string,
  memberAccountId: string,
): SelectedMembership {
  if (
    !record(body) ||
    !closed(body, ['organizationId', 'memberAccountId', 'membership']) ||
    body.organizationId !== organizationId ||
    body.memberAccountId !== memberAccountId
  )
    return { kind: 'unavailable' };
  if (body.membership === null) return { kind: 'ready', organizationId, memberAccountId, membership: null };
  const current = body.membership;
  if (
    !record(current) ||
    !closed(current, ['role', 'reservationId']) ||
    !role(current.role) ||
    !membershipId(current.reservationId)
  )
    return { kind: 'unavailable' };
  return {
    kind: 'ready',
    organizationId,
    memberAccountId,
    membership: { role: current.role, reservationId: current.reservationId },
  };
}
export async function loadSelectedMembership(
  organizationId: string,
  memberAccountId: string,
): Promise<SelectedMembership> {
  if (!membershipId(organizationId) || !membershipId(memberAccountId)) return { kind: 'unavailable' };
  const response = await authPost('/account-management/organizations/member', { organizationId, memberAccountId });
  return response.ok
    ? parseSelectedMembership(response.body, organizationId, memberAccountId)
    : readFailure(response.status);
}
export function membershipReadback(command: MembershipCommand, current: SelectedMembership): boolean {
  return (
    current.kind === 'ready' &&
    current.organizationId === command.operation.organizationId &&
    current.memberAccountId === command.operation.memberAccountId &&
    (command.operation.role === null
      ? current.membership === null
      : current.membership?.role === command.operation.role &&
        (command.operation.reservationId === undefined ||
          current.membership.reservationId === command.operation.reservationId))
  );
}

function validCommand(value: unknown): value is MembershipCommand {
  return (
    record(value) &&
    closed(value, ['accountId', 'operationKey', 'operation', 'reference', 'unresolved']) &&
    membershipId(value.accountId) &&
    typeof value.operationKey === 'string' &&
    /^[a-f0-9]{32}$/.test(value.operationKey) &&
    isMembershipOperation(value.operation) &&
    typeof value.unresolved === 'boolean' &&
    (value.reference === undefined || text(value.reference))
  );
}
export function readMembershipCommand(): MembershipCommand | null | 'invalid' {
  try {
    const raw = window.sessionStorage.getItem(storageKey);
    if (raw === null) return null;
    const value: unknown = JSON.parse(raw);
    return validCommand(value) ? { ...value, operation: Object.freeze(value.operation) } : 'invalid';
  } catch {
    return 'invalid';
  }
}
export function saveMembershipCommand(command: MembershipCommand): boolean {
  if (!validCommand(command)) return false;
  try {
    window.sessionStorage.setItem(storageKey, JSON.stringify(command));
    return true;
  } catch {
    return false;
  }
}
export function clearMembershipCommand() {
  window.sessionStorage.removeItem(storageKey);
}
export function clearMembershipCommandIfMatches(command: MembershipCommand): boolean {
  const saved = readMembershipCommand();
  if (saved === 'invalid') return false;
  if (saved === null) return true;
  if (!sameMembershipCommand(saved, command)) return false;
  try {
    window.sessionStorage.removeItem(storageKey);
    return true;
  } catch {
    return false;
  }
}
export function newMembershipCommand(accountId: string, operation: MembershipOperation): MembershipCommand {
  return {
    accountId,
    operation: Object.freeze({ ...operation }),
    operationKey: Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
      byte.toString(16).padStart(2, '0'),
    ).join(''),
    unresolved: false,
  };
}
function outcome(status: number, code: string): MembershipOutcome {
  if (status === 401 && code === 'step_up_required') return 'step-up';
  if (status === 409) return 'conflict';
  if (status === 401 || status === 403) return 'denied';
  if (status === 202 || code === 'preparing') return 'preparing';
  return 'unavailable';
}
/** Persist before dispatch. A lost execute response keeps the same immutable
 * operation, approval and key. No reapproval or operation replacement on retry.
 */
export async function submitMembership(
  command: MembershipCommand,
  isActive: () => boolean = () => true,
): Promise<MembershipOutcome> {
  if (!isActive() || !validCommand(command)) return 'denied';
  const session = await loadAccountSession();
  if (!isActive()) return 'unavailable';
  if (!membershipSessionMatches(session, command.accountId)) return 'denied';
  if (command.unresolved && !command.reference) return 'unknown';
  if (command.unresolved) {
    const current = await loadSelectedMembership(command.operation.organizationId, command.operation.memberAccountId);
    if (!isActive()) return 'unavailable';
    if (current.kind !== 'ready')
      return current.kind === 'denied' || current.kind === 'signed-out' ? 'denied' : 'unavailable';
    if (!membershipReservationMatches(command, current)) return 'conflict';
  }
  if (!command.reference) {
    const current = await loadSelectedMembership(command.operation.organizationId, command.operation.memberAccountId);
    if (!isActive()) return 'unavailable';
    if (current.kind !== 'ready') return current.kind === 'denied' ? 'denied' : 'unavailable';
    if ((current.membership?.reservationId ?? undefined) !== command.operation.reservationId) return 'conflict';
    const approved = await authPost<unknown>('/account-operations/approve', {
      accountId: command.accountId,
      operationKey: command.operationKey,
      operation: command.operation,
    });
    if (!isActive()) return 'unavailable';
    if (!approved.ok) return outcome(approved.status, approved.code);
    if (
      !record(approved.body) ||
      !closed(approved.body, ['reference', 'expiresAt']) ||
      !text(approved.body.reference) ||
      typeof approved.body.expiresAt !== 'string' ||
      Date.parse(approved.body.expiresAt) <= Date.now() ||
      !Number.isFinite(Date.parse(approved.body.expiresAt))
    )
      return 'unavailable';
    command.reference = approved.body.reference;
  }
  // Only undispatched browser stages end with the page. Once execute starts,
  // retain its original command regardless of navigation or a lost response.
  command.unresolved = true;
  if (!saveMembershipCommand(command)) return 'unavailable';
  const executed = await authPost<unknown>('/account-operations/execute', {
    accountId: command.accountId,
    operationKey: command.operationKey,
    operation: command.operation,
    reference: command.reference,
  });
  if (!executed.ok) {
    // Even a later refusal cannot disprove an earlier lost execution.
    if (executed.status >= 500) return 'unknown';
    return outcome(executed.status, executed.code);
  }
  return record(executed.body) &&
    closed(executed.body, ['accountId']) &&
    executed.body.accountId === command.operation.memberAccountId
    ? 'acknowledged'
    : 'unknown';
}

/** Fresh native sign-in only establishes the exact initiating human/profile.
 * The page requires another explicit submit to request approval and execute.
 */
export async function reauthenticateMembership(
  command: MembershipCommand,
  email: string,
  password: string,
  isActive: () => boolean = () => true,
): Promise<boolean> {
  if (!isActive()) return false;
  const saved = readMembershipCommand();
  if (!saved || saved === 'invalid' || JSON.stringify(saved) !== JSON.stringify(command)) return false;
  return reauthenticateMembershipSession(command.accountId, email, password, isActive);
}
export async function reauthenticateMembershipSession(
  accountId: string,
  email: string,
  password: string,
  isActive: () => boolean = () => true,
): Promise<boolean> {
  const profile = membershipProfile();
  if (!isActive() || !profile) return false;
  const response = await authPost('/signin', { email, password, ...profile });
  if (!isActive() || !response.ok) return false;
  const session = await loadAccountSession();
  return isActive() && membershipSessionMatches(session, accountId);
}
