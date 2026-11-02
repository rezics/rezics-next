import { reviewWithin } from './request';
import type { AccessSnapshot, AccessState, Grant, WriteResult } from './data';
import { routedId } from './data';

export const realmOwnerRole = 'community.realm.owner';
export type OwnerTransfer = Readonly<{
  kind: 'realm-owner-transfer';
  resource: Readonly<{ route: number; id: string }>;
  fromAccountId: string;
  toAccountId: string;
  previousValid: string;
  key: string;
}>;
export type TransferResult = WriteResult & { current: AccessState };

/** Presentation consumes private current decisions; the command independently reauthorizes. */
export function transferableOwner(page: AccessSnapshot, grant: Grant): boolean {
  return (
    page.resource.type === 'community.realm' &&
    page.mutationState === 'ready' &&
    grant.kind === 'role' &&
    grant.state === 'active' &&
    grant.subject.kind === 'account' &&
    grant.role === realmOwnerRole &&
    grant.manageable &&
    page.roles.some((role) => role.id === realmOwnerRole && role.delegable)
  );
}

export function parseOwnerTransfer(value: unknown): OwnerTransfer {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid owner transfer');
  const v = value as Record<string, unknown>;
  const r = v.resource as Record<string, unknown> | undefined;
  if (
    Object.keys(v).length !== 6 ||
    v.kind !== 'realm-owner-transfer' ||
    !r ||
    typeof r !== 'object' ||
    Array.isArray(r) ||
    Object.keys(r).length !== 2 ||
    !routedId(r.id) ||
    !Number.isInteger(r.route) ||
    Number(r.route) < 0 ||
    Number(r.route) > 65535 ||
    !routedId(v.fromAccountId) ||
    !routedId(v.toAccountId) ||
    v.fromAccountId === v.toAccountId ||
    typeof v.previousValid !== 'string' ||
    !v.previousValid ||
    v.previousValid.length > 256 ||
    typeof v.key !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(v.key)
  )
    throw new Error('Invalid owner transfer');
  return Object.freeze({
    kind: 'realm-owner-transfer',
    resource: Object.freeze({ route: Number(r.route), id: r.id }),
    fromAccountId: v.fromAccountId,
    toAccountId: v.toAccountId,
    previousValid: v.previousValid,
    key: v.key,
  });
}

type TransferReceipt = {
  roleGrant: {
    resource: { route: number; id: string };
    subject: { kind: 'account'; id: string };
    role: string;
    valid: string;
  };
};
function isReceipt(value: unknown, input: OwnerTransfer): value is TransferReceipt {
  if (!value || typeof value !== 'object' || !('roleGrant' in value)) return false;
  const grant = value.roleGrant;
  if (
    !grant ||
    typeof grant !== 'object' ||
    !('resource' in grant) ||
    !('subject' in grant) ||
    !('role' in grant) ||
    !('valid' in grant)
  )
    return false;
  const { resource, subject } = grant;
  return (
    !!resource &&
    typeof resource === 'object' &&
    'id' in resource &&
    'route' in resource &&
    resource.id === input.resource.id &&
    resource.route === input.resource.route &&
    !!subject &&
    typeof subject === 'object' &&
    'kind' in subject &&
    'id' in subject &&
    subject.kind === 'account' &&
    subject.id === input.toAccountId &&
    grant.role === realmOwnerRole &&
    typeof grant.valid === 'string' &&
    grant.valid.length > 0
  );
}

/** Exact local transport until generated client declarations include this native custom method.
 * No receipt substitutes for a fresh private read, including after a successful replay. */
export async function transferOwner(
  origin: string | undefined,
  authorization: string,
  input: OwnerTransfer,
  read: (session?: string, signal?: AbortSignal) => Promise<AccessState>,
  fetcher: typeof fetch = fetch,
  caller?: AbortSignal,
): Promise<TransferResult> {
  const current = async (session?: string): Promise<AccessState> => {
    try {
      return await reviewWithin((signal) => read(session, signal), caller);
    } catch {
      return { status: 'unavailable' };
    }
  };
  const before = await current();
  if (before.status !== 'ready')
    return { status: before.status === 'denied' ? 'denied' : 'uncertain', current: before };
  if (
    before.page.resource.id !== input.resource.id ||
    before.page.resource.route !== input.resource.route ||
    before.page.resource.type !== 'community.realm'
  )
    return { status: 'refused', current: before };
  if (!origin || before.page.mutationState !== 'ready') return { status: 'uncertain', current: before };
  let status: WriteResult['status'] = 'uncertain';
  let session: string | undefined;
  try {
    const body = {
      resource: input.resource,
      fromAccountId: input.fromAccountId,
      toAccountId: input.toAccountId,
      previousValid: input.previousValid,
    };
    status = await reviewWithin(async (signal): Promise<WriteResult['status']> => {
      const response = await fetcher(new URL('/v1/roleGrants:transferRealmOwner', origin), {
        method: 'POST',
        signal,
        cache: 'no-store',
        headers: { authorization, 'content-type': 'application/json', 'idempotency-key': JSON.stringify(input.key) },
        body: JSON.stringify(body),
      });
      session = response.headers.get('rezics-session-token') ?? undefined;
      if (response.ok && isReceipt(await response.json(), input)) return 'saved';
      if (response.status === 401) return 'denied';
      if (response.status === 403 || response.status === 400) return 'refused';
      if (response.status === 409 || response.status === 422) return 'conflict';
      return 'uncertain';
    }, caller);
  } catch {
    /* The original key and body remain pending after an ambiguous response. */
  }
  return { status, current: status === 'denied' ? { status: 'denied' } : await current(session) };
}
