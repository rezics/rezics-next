import { createServerFn, createServerOnlyFn } from '@tanstack/react-start';
import { authPost } from './api';
import { readConsent } from './consent';
import { privateAuthRead } from './private-auth-read';
import type { SecurityPageEnvelope, SecurityAdvice } from '../../../services/auth/src/security-page';
export type { SecurityPageEnvelope, SecurityAdvice } from '../../../services/auth/src/security-page';

// Closed public DTOs from Auth's security inventory. Never keep native metadata.
export type OwnedClient = { client_id: string; display_name: string | null; disabled: boolean; scopes: string[] };
export type GrantedConsent = {
  client_id: string;
  display_name: string | null;
  granted: string[];
  status: 'current' | 'inactive' | 'unavailable';
  reducible: boolean;
  pending_reduction: boolean;
};
export type InventoryRows = { clients: OwnedClient; consents: GrantedConsent };
export type InventoryView = keyof InventoryRows;
type PublicPasskey = { id: string; name: string; created_at: string; last_used_at: string | null };
export type InventoryPage<V extends InventoryView> =
  | { kind: 'ready'; rows: InventoryRows[V][]; next: string | null }
  | { kind: 'signed-out' | 'denied' | 'unavailable' | 'expired' };

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

export function parseInventoryPage<V extends InventoryView>(view: V, body: unknown): InventoryPage<V> {
  if (
    !record(body) ||
    !Array.isArray(body[view]) ||
    (body.next !== null && (typeof body.next !== 'string' || !body.next)) ||
    body[view].length > 20
  )
    return { kind: 'unavailable' };
  const rows: InventoryRows[InventoryView][] = [];
  const seen = new Set<string>();
  for (const entry of body[view]) {
    if (
      !record(entry) ||
      typeof entry.client_id !== 'string' ||
      !entry.client_id ||
      seen.has(entry.client_id) ||
      (entry.display_name !== null && typeof entry.display_name !== 'string')
    )
      return { kind: 'unavailable' };
    seen.add(entry.client_id);
    const label = { client_id: entry.client_id, display_name: entry.display_name };
    if (view === 'clients') {
      if (typeof entry.disabled !== 'boolean' || !scopeSet(entry.scopes)) return { kind: 'unavailable' };
      rows.push({ ...label, disabled: entry.disabled, scopes: entry.scopes });
    } else {
      if (
        !scopeSet(entry.granted) ||
        !['current', 'inactive', 'unavailable'].includes(String(entry.status)) ||
        typeof entry.reducible !== 'boolean' ||
        typeof entry.pending_reduction !== 'boolean' ||
        (entry.status !== 'current' && entry.granted.length > 0)
      )
        return { kind: 'unavailable' };
      rows.push({
        ...label,
        granted: [...entry.granted],
        status: entry.status as GrantedConsent['status'],
        reducible: entry.reducible,
        pending_reduction: entry.pending_reduction,
      });
    }
  }
  return { kind: 'ready', rows: rows as InventoryRows[V][], next: body.next as string | null };
}

type InventoryInput = { view: InventoryView; cursor?: string };
export const issuerSecurityRequest = createServerOnlyFn(async (path: string, body?: unknown): Promise<Response> => {
  const { getRequest, setResponseHeader } = await import('@tanstack/react-start/server');
  const request = getRequest();
  setResponseHeader('Cache-Control', 'private, no-store');
  const origin = new URL(request.url).origin;
  const nativeOrigin = import.meta.env.DEV && __AUTH_ORIGIN__ ? new URL(__AUTH_ORIGIN__).origin : origin;
  if (
    (request.headers.get('origin') !== origin && request.headers.get('origin') !== nativeOrigin) ||
    request.headers.get('sec-fetch-site') === 'cross-site'
  )
    return new Response(null, { status: 403 });
  // The existing issuer origin serves host.handler and owns its pools/keys and
  // immutable accountOperations binding. No credentials leave this issuer.
  const response = await fetch(new URL(path, nativeOrigin), {
    method: body === undefined ? 'GET' : 'POST',
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      Accept: 'application/json',
      Origin: request.headers.get('origin')!,
      Cookie: request.headers.get('cookie') ?? '',
    },
    // workerd supports manual redirects; reject them without forwarding issuer cookies.
    redirect: 'manual',
    cache: 'no-store',
    signal: AbortSignal.any([request.signal, AbortSignal.timeout(5000)]),
  });
  if (response.status >= 300 && response.status < 400) throw new Error('Unexpected issuer redirect');
  return response;
});

// Browser GET cannot set Origin. Use the existing Start BFF and carry the
// originating POST's real Origin/cookie to the same issuer's declared GET API.
const readInventory = createServerFn({ method: 'POST' })
  .validator((value: unknown): InventoryInput => {
    if (
      !record(value) ||
      !['clients', 'consents'].includes(String(value.view)) ||
      Object.keys(value).some((key) => !['view', 'cursor'].includes(key)) ||
      (value.cursor !== undefined && (typeof value.cursor !== 'string' || !value.cursor || value.cursor.length > 8192))
    )
      throw new Error('Invalid inventory request');
    return value as InventoryInput;
  })
  .handler(async ({ data }): Promise<InventoryPage<InventoryView>> => {
    const query = data.cursor ? `?${new URLSearchParams({ cursor: data.cursor })}` : '';
    try {
      const response = await issuerSecurityRequest(`/${data.view}${query}`);
      if (response.status === 401) return { kind: 'signed-out' };
      if (response.status === 403) return { kind: 'denied' };
      if (response.status === 400 && data.cursor) return { kind: 'expired' };
      if (response.status !== 200) return { kind: 'unavailable' };
      return parseInventoryPage(data.view, await response.json());
    } catch {
      return { kind: 'unavailable' };
    }
  });

export async function loadInventory<V extends InventoryView>(
  view: V,
  cursor?: string,
  signal?: AbortSignal,
): Promise<InventoryPage<V>> {
  try {
    return await privateAuthRead(
      async (readSignal) =>
        (await readInventory({
          data: { view, ...(cursor ? { cursor } : {}) },
          signal: readSignal,
        })) as InventoryPage<V>,
      signal,
    );
  } catch {
    return { kind: 'unavailable' };
  }
}

// One current native composition, independent of browser WebAuthn support.
export function parseSecurityPage(body: unknown): SecurityPageEnvelope | null {
  const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
  const date = (value: unknown): value is string => text(value) && Number.isFinite(Date.parse(value));
  const advice = (value: unknown): value is SecurityAdvice =>
    ['allowed', 'step-up-required', 'last-credential', 'capacity', 'unavailable'].includes(String(value));
  if (
    !record(body) ||
    !record(body.viewer) ||
    !text(body.viewer.account_id) ||
    !text(body.viewer.session_id) ||
    !text(body.viewer.client_id) ||
    !record(body.actions) ||
    !advice(body.actions.change_password) ||
    !advice(body.actions.register_passkey)
  )
    return null;
  const viewer = {
    account_id: body.viewer.account_id,
    session_id: body.viewer.session_id,
    client_id: body.viewer.client_id,
  };
  function inventory(value: unknown, kind: 'sessions' | 'passkeys', limit: number) {
    if (!record(value)) return false;
    if (value.kind === 'unavailable') return true;
    if (
      value.kind !== 'ready' ||
      value.limit !== limit ||
      typeof value.truncated !== 'boolean' ||
      !Array.isArray(value.rows) ||
      value.rows.length > limit
    )
      return false;
    const seen = new Set<string>();
    for (const row of value.rows) {
      if (!record(row) || !text(row.id) || seen.has(row.id) || !date(row.created_at)) return false;
      seen.add(row.id);
      if (kind === 'sessions') {
        if (
          !text(row.client_id) ||
          !date(row.expires_at) ||
          typeof row.current !== 'boolean' ||
          row.current !== (row.id === viewer.session_id) ||
          !advice(row.revoke) ||
          (row.client_display_name !== null && typeof row.client_display_name !== 'string') ||
          (row.user_agent !== null && typeof row.user_agent !== 'string')
        )
          return false;
      } else if (
        typeof row.name !== 'string' ||
        !advice(row.remove) ||
        (row.last_used_at !== null && !date(row.last_used_at))
      )
        return false;
    }
    return kind !== 'sessions' || seen.has(viewer.session_id);
  }
  if (!inventory(body.sessions, 'sessions', 64) || !inventory(body.passkeys, 'passkeys', 32)) return null;
  // Copy only declared public fields; arbitrary native metadata never enters page state.
  const source = body as SecurityPageEnvelope;
  return {
    viewer,
    actions: { change_password: source.actions.change_password, register_passkey: source.actions.register_passkey },
    sessions:
      source.sessions.kind === 'unavailable'
        ? { kind: 'unavailable' }
        : {
            kind: 'ready',
            limit: 64,
            truncated: source.sessions.truncated,
            rows: source.sessions.rows.map(
              ({ id, client_id, client_display_name, created_at, expires_at, user_agent, current, revoke }) => ({
                id,
                client_id,
                client_display_name,
                created_at,
                expires_at,
                user_agent,
                current,
                revoke,
              }),
            ),
          },
    passkeys:
      source.passkeys.kind === 'unavailable'
        ? { kind: 'unavailable' }
        : {
            kind: 'ready',
            limit: 32,
            truncated: source.passkeys.truncated,
            rows: source.passkeys.rows.map(({ id, name, created_at, last_used_at, remove }) => ({
              id,
              name,
              created_at,
              last_used_at,
              remove,
            })),
          },
  };
}
export type NativeSecurityPage =
  | { kind: 'ready'; page: SecurityPageEnvelope }
  | { kind: 'signed-out' | 'denied' | 'unavailable' };
export const readNativeSecurityPage = createServerOnlyFn(async (): Promise<NativeSecurityPage> => {
  try {
    const response = await issuerSecurityRequest('/security-page');
    if (response.status === 401) return { kind: 'signed-out' };
    if (response.status === 403) return { kind: 'denied' };
    if (response.status !== 200) return { kind: 'unavailable' };
    const page = parseSecurityPage(await response.json());
    return page ? { kind: 'ready', page } : { kind: 'unavailable' };
  } catch {
    return { kind: 'unavailable' };
  }
});
const readPage = createServerFn({ method: 'POST' }).handler(async () => readNativeSecurityPage());
export async function loadSecurityPage(signal?: AbortSignal): Promise<NativeSecurityPage> {
  try {
    return await privateAuthRead((readSignal) => readPage({ signal: readSignal }), signal);
  } catch {
    return { kind: 'unavailable' };
  }
}

// The existing passkey GET has the same exact-Origin guard as inventory.
const readPasskeys = createServerFn({ method: 'POST' }).handler(
  async (): Promise<{ ok: true; body: { passkeys: PublicPasskey[] } } | { ok: false }> => {
    try {
      const response = await issuerSecurityRequest('/passkeys');
      if (response.status !== 200) return { ok: false };
      const body: unknown = await response.json();
      if (!record(body) || !Array.isArray(body.passkeys)) return { ok: false };
      const passkeys = [];
      for (const row of body.passkeys) {
        if (
          !record(row) ||
          typeof row.id !== 'string' ||
          typeof row.name !== 'string' ||
          typeof row.created_at !== 'string' ||
          (row.last_used_at !== null && typeof row.last_used_at !== 'string')
        )
          return { ok: false };
        passkeys.push({ id: row.id, name: row.name, created_at: row.created_at, last_used_at: row.last_used_at });
      }
      return { ok: true, body: { passkeys } };
    } catch {
      return { ok: false };
    }
  },
);
export async function loadPasskeyInventory(signal?: AbortSignal) {
  try {
    return await privateAuthRead((readSignal) => readPasskeys({ signal: readSignal }), signal);
  } catch {
    return { ok: false as const };
  }
}

export type ConsentReductionResult = {
  kind: 'accepted' | 'pending' | 'signed-out' | 'denied' | 'stale-review' | 'unknown' | 'unavailable';
};
/** The page lends its existing write boundary to a mounted consent review.
 * Acquisition is synchronous; release only ends the operation that acquired it.
 * An uncertain write keeps the lease and must never be automatically replayed.
 */
export type ConsentReviewOperation = {
  isCurrent: () => boolean;
  finish: () => void;
};
export type ConsentOperationBoundary = {
  blocked: boolean;
  begin: () => ConsentReviewOperation | null;
};
/** Closed, memory-only target. Native Auth remains the sole consent/barrier authority. */
export type ConsentReduction = Readonly<{
  clientId: string;
  current: readonly string[];
  retained: readonly string[];
}>;

function scopeSet(value: unknown): value is string[] {
  return strings(value) && value.every((scope) => scope.length > 0) && new Set(value).size === value.length;
}
function sameScopes(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((scope) => right.includes(scope));
}
export function createConsentReduction(consent: GrantedConsent, retained: readonly string[]): ConsentReduction | null {
  if (
    !consent.client_id ||
    !consent.reducible ||
    consent.pending_reduction ||
    consent.status !== 'current' ||
    !scopeSet(consent.granted) ||
    !scopeSet(retained) ||
    retained.length >= consent.granted.length ||
    retained.some((scope) => !consent.granted.includes(scope))
  )
    return null;
  return Object.freeze({
    clientId: consent.client_id,
    current: Object.freeze([...consent.granted]),
    retained: Object.freeze([...retained]),
  });
}

/** Existing exact consent replacement, with a native current read for retained scopes.
 * No tokens, receipts or returned scopes become a local grant or replay queue.
 */
export async function reduceConsent(
  consent: GrantedConsent,
  retained: readonly string[],
): Promise<ConsentReductionResult> {
  // Snapshot before the first await: caller edits cannot retarget an in-flight write.
  const target = createConsentReduction(consent, retained);
  if (!target) return { kind: 'denied' };
  // Empty replacement cannot add authority. Preserve the original remove-all
  // transport; SecurityInventory refreshes its current native DTO for either path.
  // A nonempty replacement also checks the exact native granted set so it cannot
  // restore a permission removed since the selection was made.
  if (target.retained.length > 0) {
    const current = await readConsent(target.clientId);
    if (!current.ok) {
      return {
        kind:
          current.status === 401
            ? 'signed-out'
            : current.status === 403 || current.status === 404
              ? 'denied'
              : 'unavailable',
      };
    }
    // This exact native read also refuses first-party, disabled/unready clients.
    // Do not turn a stale reduction into a consent expansion or unchanged write.
    if (
      !scopeSet(current.body.granted) ||
      !scopeSet(current.body.scopes) ||
      !sameScopes(current.body.granted, target.current) ||
      target.retained.some((scope) => !current.body.scopes.includes(scope))
    )
      return { kind: 'denied' };
  }
  const response = await authPost<unknown>('/consent', {
    client_id: target.clientId,
    scope: target.retained,
    ...(target.retained.length > 0 ? { reviewed_scopes: [...target.current] } : {}),
  });
  if (!response.ok) {
    if (response.status === 401) return { kind: 'signed-out' };
    if (response.status === 409 && response.code === 'stale_review') return { kind: 'stale-review' };
    if (response.status === 403 || response.status === 409) return { kind: 'denied' };
    // Once sent, an outage/ambiguous acknowledgement may have applied the barrier.
    return { kind: 'unknown' };
  }
  if (
    !record(response.body) ||
    Object.keys(response.body).sort().join(',') !== 'client_id,scope' ||
    response.body.client_id !== target.clientId ||
    !scopeSet(response.body.scope) ||
    !sameScopes(response.body.scope, target.retained)
  )
    return { kind: 'unknown' };
  return { kind: 'accepted' };
}

// Backwards-compatible remove-all entry point, using the identical native barrier.
export async function removeConsent(consent: GrantedConsent): Promise<ConsentReductionResult> {
  return reduceConsent(consent, []);
}
