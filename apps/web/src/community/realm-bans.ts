import { normalizeRealmBanTargetHandle, type BanTargetState } from './realm-ban-target';
import type { KernelClient } from '@rezics/client';
import { isPlatformClosedError, isPlatformClosedProblem } from '../kernel/platform-closed';
import { MediaProblem } from '../media/kernel';
import type { SessionEnv } from '../session/client';
import { prepareSession, viewerCredential } from '../session/request';

type NativeRealm = ReturnType<KernelClient['realms']>;
type NativeBanTarget = ReturnType<NativeRealm['bans']>;
export type InstalledRealmBanPage = NonNullable<Awaited<ReturnType<NativeRealm['bans']['get']>>['data']>;
export type RealmBanQuery = NonNullable<NonNullable<Parameters<NativeRealm['bans']['get']>[0]>['query']>;
type InstalledBan = InstalledRealmBanPage['items'][number];
// Standalone pre-composition fixtures retain their original four-field observations.
export type RealmBanRow = Pick<InstalledBan, 'accountId' | 'reason' | 'actor' | 'at'> &
  Partial<Omit<InstalledBan, 'accountId' | 'reason' | 'actor' | 'at'>>;
export type RealmBanPage = Pick<InstalledRealmBanPage, 'next'> &
  Partial<Omit<InstalledRealmBanPage, 'items' | 'next'>> & { items: RealmBanRow[] };
export type RealmBanReadInput = { realmId: string } & Pick<RealmBanQuery, 'cursor' | 'selectedAccountId'>;
export type RealmBanReceipt = NonNullable<Awaited<ReturnType<NativeBanTarget['put']>>['data']>['ban'];
export type BanReadState =
  | { state: 'ready'; page: RealmBanPage }
  | { state: 'loading' | 'signed-out' | 'forbidden' | 'closed' | 'unavailable' | 'invalid-cursor' };
export type BanWriteInput = {
  realmId: string;
  accountId: string;
  action: 'ban' | 'unban';
  reason: string;
  idempotencyKey: string;
};
export type BanWriteResult =
  | { ok: true; action: 'ban'; ban: RealmBanReceipt }
  | { ok: true; action: 'unban'; accountId: string }
  | {
      ok: false;
      reason: 'signed-out' | 'forbidden' | 'closed' | 'role-required' | 'conflict' | 'invalid' | 'unavailable';
    };

export const REALM_BANS_PAGE_LIMIT = 20;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function validateBanRead(input: RealmBanReadInput) {
  if (
    typeof input?.realmId !== 'string' ||
    !uuid.test(input.realmId) ||
    (input.cursor !== undefined && (typeof input.cursor !== 'string' || !input.cursor || input.cursor.length > 4096)) ||
    (input.selectedAccountId !== undefined &&
      (typeof input.selectedAccountId !== 'string' || !uuid.test(input.selectedAccountId)))
  )
    throw new Error('Invalid Realm bans request');
  return {
    realmId: input.realmId.toLowerCase(),
    ...(input.cursor ? { cursor: input.cursor } : {}),
    ...(input.selectedAccountId ? { selectedAccountId: input.selectedAccountId.toLowerCase() } : {}),
  };
}

export function validBanWrite(input: BanWriteInput): boolean {
  return (
    typeof input?.realmId === 'string' &&
    uuid.test(input.realmId) &&
    typeof input.accountId === 'string' &&
    uuid.test(input.accountId) &&
    (input.action === 'ban' || input.action === 'unban') &&
    typeof input.reason === 'string' &&
    input.reason.length <= 1024 &&
    !input.reason.includes('\0') &&
    typeof input.idempotencyKey === 'string' &&
    uuid.test(input.idempotencyKey)
  );
}

export function validateBanWrite(input: BanWriteInput): BanWriteInput {
  if (!validBanWrite(input)) throw new Error('Invalid Realm ban change');
  return {
    realmId: input.realmId.toLowerCase(),
    accountId: input.accountId.toLowerCase(),
    action: input.action,
    reason: input.reason,
    idempotencyKey: input.idempotencyKey,
  };
}

/** The list itself is the current native realm:ban check; no cached role or membership flag grants controls. */
export async function loadRealmBans(
  client: KernelClient,
  request: Request,
  env: Partial<SessionEnv>,
  input: RealmBanReadInput,
): Promise<BanReadState> {
  try {
    input = validateBanRead(input);
    const stale = await prepareSession(request, env);
    const authorization = viewerCredential(request);
    if (stale || !authorization) return { state: 'signed-out' };
    const result = await client.realms({ realmId: input.realmId }).bans.get({
      headers: { authorization },
      query: {
        limit: REALM_BANS_PAGE_LIMIT,
        ...(input.cursor ? { cursor: input.cursor } : {}),
        ...(input.selectedAccountId ? { selectedAccountId: input.selectedAccountId } : {}),
      } satisfies RealmBanQuery,
    });
    if (isPlatformClosedProblem(result.status, result.error?.value)) return { state: 'closed' };
    if (result.status === 401) return { state: 'signed-out' };
    if (result.status === 403 || result.status === 404) return { state: 'forbidden' };
    if (result.status === 400) return { state: 'invalid-cursor' };
    if (
      result.error ||
      result.status !== 200 ||
      !result.data ||
      !Array.isArray(result.data.items) ||
      result.data.items.length > REALM_BANS_PAGE_LIMIT ||
      (result.data.next !== null && typeof result.data.next !== 'string')
    )
      return { state: 'unavailable' };
    return { state: 'ready', page: result.data };
  } catch (error) {
    return { state: isPlatformClosedError(error) ? 'closed' : 'unavailable' };
  }
}

/** Session/CSRF validation precedes the ordinary native command; its receipt key survives ambiguous retries. */
export async function writeRealmBan(
  client: KernelClient,
  request: Request,
  env: Partial<SessionEnv>,
  input: BanWriteInput,
): Promise<BanWriteResult> {
  if (!validBanWrite(input)) return { ok: false, reason: 'invalid' };
  input = validateBanWrite(input);
  try {
    const stale = await prepareSession(request, env);
    const authorization = viewerCredential(request);
    if (stale || !authorization) return { ok: false, reason: 'signed-out' };
    const headers = { authorization, 'idempotency-key': JSON.stringify(input.idempotencyKey) };
    const target = client.realms({ realmId: input.realmId }).bans({ accountId: input.accountId });
    const result =
      input.action === 'ban'
        ? await target.put({ reason: input.reason }, { headers })
        : await target.delete(undefined, { headers });
    const body = result.error?.value;
    if (isPlatformClosedProblem(result.status, body)) return { ok: false, reason: 'closed' };
    if (result.status === 401) return { ok: false, reason: 'signed-out' };
    if (result.status === 403 || result.status === 404) return { ok: false, reason: 'forbidden' };
    if (
      result.status === 409 &&
      input.action === 'ban' &&
      body &&
      'detail' in body &&
      body.detail === 'Remove the Realm owner or moderator role first'
    )
      return { ok: false, reason: 'role-required' };
    if (result.status === 409 || (body && 'code' in body && body.code === 'idempotency_conflict'))
      return { ok: false, reason: 'conflict' };
    if (result.status === 400 || result.status === 422) return { ok: false, reason: 'invalid' };
    if (result.error) return { ok: false, reason: 'unavailable' };
    if (input.action === 'unban')
      return result.status === 204
        ? { ok: true, action: 'unban', accountId: input.accountId }
        : { ok: false, reason: 'unavailable' };
    if (
      result.status !== 200 ||
      !result.data ||
      !('ban' in result.data) ||
      result.data.ban.accountId !== input.accountId ||
      result.data.ban.realmId !== input.realmId ||
      (result.data.ban.workflowId !== null && typeof result.data.ban.workflowId !== 'string')
    )
      return { ok: false, reason: 'unavailable' };
    return { ok: true, action: 'ban', ban: result.data.ban };
  } catch (error) {
    if (isPlatformClosedError(error)) return { ok: false, reason: 'closed' };
    if (error instanceof MediaProblem && error.problem.status === 403) return { ok: false, reason: 'forbidden' };
    return { ok: false, reason: 'unavailable' };
  }
}

/** One exact native claim/forward/current identity read, never a public URL fetch or prefix search. */
export async function loadRealmBanTarget(
  client: KernelClient,
  request: Request,
  env: Partial<SessionEnv>,
  handle: string,
  signal: AbortSignal = request.signal,
): Promise<BanTargetState> {
  const normalized = normalizeRealmBanTargetHandle(handle);
  if (!normalized) return { state: 'invalid' };
  try {
    const stale = await prepareSession(request, env);
    const authorization = viewerCredential(request);
    if (stale || !authorization) return { state: 'signed-out' };
    const result = await client.accounts.get({
      query: { handle: normalized },
      headers: { authorization },
      fetch: { signal },
    });
    if (signal.aborted) return { state: 'unavailable' };
    if (result.status === 401) return { state: 'signed-out' };
    if (result.status === 403) return { state: 'refused' };
    if (result.status === 400 || result.status === 422) return { state: 'invalid' };
    if (result.status === 404) return { state: 'missing' };
    if (result.error || result.status !== 200 || !result.data || result.data.accounts.length > 1)
      return { state: 'unavailable' };
    const account = result.data.accounts[0];
    if (!account || account.state !== 'active') return { state: 'missing' };
    if (!account.handle || !normalizeRealmBanTargetHandle(account.handle)) return { state: 'unavailable' };
    const movedTo = 'movedTo' in account ? account.movedTo : undefined;
    if (
      (movedTo !== undefined && movedTo !== account.handle) ||
      (account.handle.toLowerCase() !== normalized && movedTo !== account.handle)
    )
      return { state: 'unavailable' };
    return { state: 'ready', target: { lookupHandle: normalized, account: { ...account, handle: account.handle } } };
  } catch {
    return { state: 'unavailable' };
  }
}
