import { reviewWithin } from './request';
import type { OwnerTransfer, TransferResult } from './owner-transfer.ts';
import type { KernelClient } from '@rezics/client';

export type AccessSnapshot = NonNullable<Awaited<ReturnType<KernelClient['grants']['get']>>['data']>;
export type Grant = AccessSnapshot['grants'][number];
export type Subject = Grant['subject'];
export type Identity = AccessSnapshot['identities'][number];
export type AccessState =
  | { status: 'ready'; page: AccessSnapshot }
  | {
      status: 'denied' | 'unavailable' | 'preparing' | 'loading';
    };
export type Change = {
  resourceId: string;
  operation: 'create' | 'change' | 'revoke';
  kind: 'direct' | 'role';
  subject: Exclude<Subject, { kind: 'realm' }>;
  role: string | null;
  actions: string[];
  valid: string;
  previous?: { role: string | null; actions: string[]; valid: string };
  key: string;
};
export type WriteResult = { status: 'saved' | 'denied' | 'conflict' | 'refused' | 'uncertain' | 'preparing' };
export type AccessIO = {
  read(cursor?: string, signal?: AbortSignal): Promise<AccessState>;
  save(change: Change, signal?: AbortSignal): Promise<WriteResult>;
  /** Null confirms no eligible recipient; unavailable reads reject for the form's retry path. */
  lookup(handle: string, signal?: AbortSignal): Promise<Identity | null>;
  transfer?(input: OwnerTransfer, signal?: AbortSignal): Promise<TransferResult>;
};

export function routedId(value: unknown): value is string {
  return (
    typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[78][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)
  );
}

export function parseChange(value: unknown): Change | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  const subject = v.subject as Subject | undefined;
  const previous = v.previous as Change['previous'];
  const actionList = (items: unknown): items is string[] =>
    Array.isArray(items) &&
    items.length <= 1000 &&
    items.every((item) => typeof item === 'string' && /^[a-z][a-z0-9_]*:[a-z][a-z0-9_]*$/.test(item));
  if (
    !routedId(v.resourceId) ||
    !['create', 'change', 'revoke'].includes(String(v.operation)) ||
    !['direct', 'role'].includes(String(v.kind)) ||
    typeof v.valid !== 'string' ||
    v.valid.length > 256 ||
    typeof v.key !== 'string' ||
    !/^[0-9a-f-]{36}$/.test(v.key) ||
    !subject ||
    !(
      subject.kind === 'active_accounts' ||
      (subject.kind === 'account' && routedId(subject.id)) ||
      (subject.kind === 'organization' && routedId(subject.id) && ['owner', 'member'].includes(subject.role))
    ) ||
    !actionList(v.actions) ||
    !(v.role === null || (typeof v.role === 'string' && /^[a-z][a-z0-9_.-]*$/.test(v.role))) ||
    (v.kind === 'role' ? !v.role : v.actions.length === 0) ||
    (v.operation === 'change' &&
      (!previous ||
        typeof previous.valid !== 'string' ||
        previous.valid.length > 256 ||
        !actionList(previous.actions) ||
        (v.kind === 'role' && typeof previous.role !== 'string')))
  )
    return null;
  return {
    resourceId: v.resourceId,
    operation: v.operation as Change['operation'],
    kind: v.kind as Change['kind'],
    subject:
      subject.kind === 'active_accounts'
        ? { kind: 'active_accounts' }
        : subject.kind === 'account'
          ? { kind: 'account', id: subject.id }
          : { kind: 'organization', id: subject.id, role: subject.role },
    role: v.role as string | null,
    actions: [...v.actions],
    valid: v.valid,
    key: v.key,
    ...(v.operation === 'change' && previous
      ? {
          previous: {
            role: typeof previous.role === 'string' ? previous.role : null,
            actions: [...previous.actions],
            valid: previous.valid,
          },
        }
      : {}),
  };
}

export function interval(startsAt: string, endsAt: string): string | null {
  const start = startsAt ? new Date(startsAt) : null;
  const end = endsAt ? new Date(endsAt) : null;
  if (
    (start && !Number.isFinite(start.getTime())) ||
    (end && !Number.isFinite(end.getTime())) ||
    (start && end && end <= start)
  )
    return null;
  return `[${start ? `"${start.toISOString()}"` : ''},${end ? `"${end.toISOString()}"` : ''})`;
}

type Result = { status: number; data: unknown; error: unknown };
function codeOf(result: Result): string | null {
  const error = result.error as { value?: { type?: unknown } } | null;
  const type = error?.value?.type;
  return typeof type === 'string' ? (type.split('/').at(-1) ?? null) : null;
}

export async function loadAccess(
  client: KernelClient,
  authorization: string,
  resourceId: string,
  cursor?: string,
  session?: string,
  caller?: AbortSignal,
): Promise<AccessState> {
  try {
    const result = await reviewWithin(
      (signal) =>
        client.grants.get({
          query: { resourceId, ...(cursor ? { cursor } : {}) },
          headers: { authorization, ...(session ? { 'rezics-session-token': session } : {}) },
          fetch: { signal },
        }),
      caller,
    );
    if (!result.error && result.data) return { status: 'ready', page: result.data };
    if ([400, 401, 403, 404].includes(result.status)) return { status: 'denied' };
    return {
      status: result.status === 503 && codeOf(result) !== 'dependency_unavailable' ? 'preparing' : 'unavailable',
    };
  } catch {
    return { status: 'unavailable' };
  }
}

/** A fresh management read supplies current type, client-scope and delegated-principal decisions.
 * The original command still reauthorizes at its own T, before receipt replay. */
export async function writeAccess(
  client: KernelClient,
  authorization: string,
  change: Change,
  caller?: AbortSignal,
): Promise<WriteResult> {
  const current = await loadAccess(client, authorization, change.resourceId, undefined, undefined, caller);
  if (current.status !== 'ready') return { status: current.status === 'denied' ? 'denied' : 'preparing' };
  if (current.page.mutationState !== 'ready') return { status: 'preparing' };
  const resource = { route: current.page.resource.route, id: change.resourceId };
  const subject = change.subject;
  try {
    const result = await reviewWithin(async (signal): Promise<Result> => {
      const options = { headers: { authorization, 'idempotency-key': change.key }, fetch: { signal } };
      let result: Result;
      if (change.kind === 'role') {
        const body = { resource, subject, role: change.role!, valid: change.valid };
        result =
          change.operation === 'create'
            ? await client.roleGrants.post(body, options)
            : change.operation === 'revoke'
              ? await client.roleGrants.$revoke.post(body, options)
              : await client.roleGrants.$change.post(
                  { ...body, previous: { role: change.previous!.role!, valid: change.previous!.valid } },
                  options,
                );
      } else {
        const body = { resource, subject, actions: change.actions, valid: change.valid };
        result =
          change.operation === 'create'
            ? await client.grants.post(body, options)
            : change.operation === 'revoke'
              ? await client.grants.$revoke.post(body, options)
              : await client.grants.$change.post(
                  { ...body, previous: { actions: change.previous!.actions, valid: change.previous!.valid } },
                  options,
                );
      }
      return result;
    }, caller);
    if (!result.error && result.data && result.status < 300) return { status: 'saved' };
    if (result.status === 409 || result.status === 422) return { status: 'conflict' };
    // Native grants deliberately use the same refusal for stale intervals and authorization loss.
    if (result.status === 403) return { status: 'refused' };
    if (result.status === 401) return { status: 'denied' };
    if (result.status === 400) return { status: 'refused' };
    return { status: 'uncertain' };
  } catch {
    return { status: 'uncertain' };
  }
}

/** Check current management disclosure before making the single public identity lookup.
 * A failed prerequisite is a rejected read, never evidence that the recipient is absent. */
export async function lookupAccessIdentity(
  client: KernelClient,
  authorization: string,
  resourceId: string,
  handle: string,
  caller?: AbortSignal,
): Promise<Identity | null> {
  const current = await loadAccess(client, authorization, resourceId, undefined, undefined, caller);
  if (current.status !== 'ready') throw new Error('Resource access unavailable');
  return lookupIdentity(client, authorization, handle, caller);
}

export async function lookupIdentity(
  client: KernelClient,
  authorization: string,
  handle: string,
  caller?: AbortSignal,
): Promise<Identity | null> {
  const result = await reviewWithin(
    (signal) =>
      client.accounts.get({
        query: { handle: handle.replace(/^@/, '').trim() },
        headers: { authorization },
        fetch: { signal },
      }),
    caller,
  );
  // Only a successful native read can establish an empty or ineligible result.
  // Leave transport rejections intact so both forms retain their draft and offer lookup again.
  if (result.error || result.status >= 300 || !result.data) {
    throw new Error('Identity lookup unavailable');
  }
  const account = result.data?.accounts[0];
  return account?.state === 'active' ? account : null;
}
