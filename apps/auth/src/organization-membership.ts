import { createServerFn } from '@tanstack/react-start';
import * as contract from '@rezics/auth-contract';
import { authPost } from './api';
import { loadAccountSession, type AccountSessionResult } from './account-operations';

export type MembershipOperation = Readonly<{
  kind: 'membership';
  organizationId: string;
  memberAccountId: string;
  role: 'owner' | 'member' | null;
  reservationId?: string;
}>;
export type Holder = { accountId: string; role: 'owner' | 'member'; reservationId?: string };
export type MembershipPage =
  | { kind: 'ready'; organizationId: string; role: 'owner' | 'member'; holders: Holder[]; next: string | null }
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
function text(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 4096;
}
function role(value: unknown): value is Holder['role'] {
  return value === 'owner' || value === 'member';
}
function identity(value: unknown): boolean {
  return (
    record(value) &&
    closed(value, ['id', 'kind', 'handle', 'displayName']) &&
    membershipId(value.id) &&
    ['actor', 'organization'].includes(String(value.kind)) &&
    (value.handle === null || typeof value.handle === 'string') &&
    (value.displayName === null || typeof value.displayName === 'string')
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
 * Required exports: AUTH_PAGE_MANAGEMENT_CLIENT_ID and
 * AUTH_PAGE_MANAGEMENT_SCOPES.membership = ['organization:membership'].
 */
export function membershipProfile(
  source: unknown = contract,
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

/** Project only native current holders. The installed management DTO currently
 * omits membership reservation IDs: removal/role CAS must stay unavailable until
 * its owner supplies members.items[].reservationId from current native membership.
 * relation.version/reservationId describe an operator and are NEVER member proof.
 * The shared owner must also preserve an authenticated native management read
 * before/after step-up: the installed read requires account:read, whereas this
 * mutation profile must remain exactly organization:membership. Do not widen it.
 */
export function parseMembershipPage(body: unknown, organizationId: string): MembershipPage {
  const unavailable = { kind: 'unavailable' } as const;
  if (
    !record(body) ||
    !closed(body, ['account', 'self', 'role', 'operator', 'relation', 'members', 'responsibilities']) ||
    !identity(body.account) ||
    !record(body.account) ||
    body.account.id !== organizationId ||
    body.account.kind !== 'organization' ||
    typeof body.self !== 'boolean' ||
    !(role(body.role) || body.role === null) ||
    !record(body.members) ||
    !closed(body.members, ['state', 'items', 'next']) ||
    !Array.isArray(body.members.items) ||
    body.members.items.length > 20 ||
    !(body.members.next === null || text(body.members.next))
  )
    return unavailable;
  if (body.members.state === 'denied' || body.role === null) return { kind: 'denied' };
  if (body.members.state !== 'ready') return unavailable;
  const holders: Holder[] = [];
  for (const item of body.members.items) {
    if (
      !record(item) ||
      !closed(item, ['accountId', 'account', 'role', 'reservationId']) ||
      !membershipId(item.accountId) ||
      !role(item.role) ||
      !(item.account === null || identity(item.account)) ||
      (record(item.account) && item.account.id !== item.accountId) ||
      holders.some((row) => row.accountId === item.accountId) ||
      (item.reservationId !== undefined && !text(item.reservationId))
    )
      return unavailable;
    holders.push({
      accountId: item.accountId,
      role: item.role,
      ...(item.reservationId === undefined ? {} : { reservationId: item.reservationId }),
    });
  }
  return { kind: 'ready', organizationId, role: body.role, holders, next: body.members.next as string | null };
}
function readFailure(status: number): MembershipPage {
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
        Origin: request.headers.get('origin')!,
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
      // Real native cookie-to-bearer issuance, exclusively on the server. No
      // caller-controlled principal, client, scope or destination is accepted.
      const tokenResponse = await fetch(new URL('/token', issuer), {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: '{}',
        redirect: 'error',
        cache: 'no-store',
        signal: AbortSignal.timeout(5000),
      });
      if (tokenResponse.status !== 200) return readFailure(tokenResponse.status);
      const token: unknown = await tokenResponse.json();
      if (!record(token) || !text(token.access_token) || token.token_type !== 'Bearer') return { kind: 'unavailable' };
      const { env } = await import('cloudflare:workers');
      const kernelOrigin = (env as { KERNEL_ORIGIN?: string }).KERNEL_ORIGIN;
      if (!kernelOrigin) return { kind: 'unavailable' };
      const kernel = new URL(kernelOrigin);
      if (
        kernel.username ||
        kernel.password ||
        kernel.search ||
        kernel.hash ||
        kernel.pathname !== '/' ||
        !(
          kernel.protocol === 'https:' ||
          (import.meta.env.DEV &&
            kernel.protocol === 'http:' &&
            ['localhost', '127.0.0.1', '[::1]'].includes(kernel.hostname))
        )
      )
        return { kind: 'unavailable' };
      const url = new URL(`/v1/accounts/${data.organizationId}/management`, kernel);
      if (data.cursor) url.searchParams.set('membersCursor', data.cursor);
      const response = await fetch(url, {
        headers: { Accept: 'application/json', Authorization: `Bearer ${token.access_token}` },
        redirect: 'error',
        cache: 'no-store',
        signal: AbortSignal.timeout(5000),
      });
      return response.status === 200
        ? parseMembershipPage(await response.json(), data.organizationId)
        : readFailure(response.status);
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
export async function submitMembership(command: MembershipCommand): Promise<MembershipOutcome> {
  if (!validCommand(command) || !membershipSessionMatches(await loadAccountSession(), command.accountId))
    return 'denied';
  if (command.unresolved && !command.reference) return 'unknown';
  if (!command.reference) {
    const approved = await authPost<unknown>('/account-operations/approve', {
      operationKey: command.operationKey,
      operation: command.operation,
    });
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
  command.unresolved = true;
  if (!saveMembershipCommand(command)) return 'unavailable';
  const executed = await authPost<unknown>('/account-operations/execute', {
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
): Promise<boolean> {
  const saved = readMembershipCommand();
  if (!saved || saved === 'invalid' || JSON.stringify(saved) !== JSON.stringify(command)) return false;
  const profile = membershipProfile();
  if (!profile) return false;
  const response = await authPost('/signin', { email, password, ...profile });
  return response.ok && membershipSessionMatches(await loadAccountSession(), command.accountId);
}
