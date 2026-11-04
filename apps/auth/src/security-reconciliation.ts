import { privateAuthRead } from './private-auth-read';
import { waitForSecurityAction } from './security-target-operation';
import { createServerFn } from '@tanstack/react-start';
import {
  parseSecurityPage,
  issuerSecurityRequest,
  readNativeSecurityPage,
  type SecurityPageEnvelope,
} from './security-inventory';
import type { SecurityLoadResult, SecurityPasskey, SecuritySession } from './security';

// Only this exact target is retained, in page memory. No cookie, proof, nonce or row metadata.
export type SecurityTarget = { accountId: string; kind: 'session' | 'passkey'; id: string };
export type SecurityActionResult =
  | { kind: 'accepted' | 'unknown'; sessionEnded?: boolean }
  | { kind: 'signed-out' | 'denied' | 'step-up' | 'last-credential' }
  | { kind: 'failure' };
export type SecurityReadback =
  | {
      kind: 'ready';
      sessions: SecuritySession[];
      passkeys: SecurityPasskey[] | null;
      presence: 'present' | 'absent' | 'unknown';
      page?: SecurityPageEnvelope;
    }
  | { kind: 'signed-out' }
  | { kind: 'denied' }
  | { kind: 'unavailable' };

// A fixed, typed presentation seam matching the existing inventory source pattern.
export type SecuritySource = {
  load?: (withPasskeys: boolean) => Promise<SecurityLoadResult>;
  read: (target: SecurityTarget, signal?: AbortSignal) => Promise<SecurityReadback>;
  act: (target: SecurityTarget, signal?: AbortSignal) => Promise<SecurityActionResult>;
};

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function text(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}
function date(value: unknown): value is string {
  return text(value) && Number.isFinite(Date.parse(value));
}
function target(value: unknown): SecurityTarget {
  if (
    !record(value) ||
    !text(value.accountId) ||
    !text(value.id) ||
    !['session', 'passkey'].includes(String(value.kind)) ||
    Object.keys(value).some((key) => !['accountId', 'kind', 'id'].includes(key))
  )
    throw new Error('Invalid security target');
  return value as SecurityTarget;
}

// Reject the entire inventory on malformed/duplicate rows; dropping rows could fabricate absence.
export function parseSecuritySessions(body: unknown): SecuritySession[] | null {
  if (!record(body) || !Array.isArray(body.sessions) || body.sessions.length > 64) return null;
  const rows: SecuritySession[] = [];
  const seen = new Set<string>();
  for (const row of body.sessions) {
    if (
      !record(row) ||
      !text(row.id) ||
      seen.has(row.id) ||
      !text(row.client_id) ||
      !date(row.created_at) ||
      !date(row.expires_at) ||
      typeof row.current !== 'boolean' ||
      (row.user_agent !== null && typeof row.user_agent !== 'string') ||
      (row.client_display_name !== undefined &&
        row.client_display_name !== null &&
        typeof row.client_display_name !== 'string')
    )
      return null;
    seen.add(row.id);
    rows.push({
      id: row.id,
      client_id: row.client_id,
      created_at: row.created_at,
      expires_at: row.expires_at,
      current: row.current,
      user_agent: row.user_agent,
      ...(typeof row.client_display_name === 'string' ? { client_display_name: row.client_display_name } : {}),
    });
  }
  if (rows.filter((row) => row.current).length > 1) return null;
  return rows;
}

export function parseSecurityPasskeys(body: unknown): SecurityPasskey[] | null {
  if (!record(body) || !Array.isArray(body.passkeys) || body.passkeys.length > 32) return null;
  const rows: SecurityPasskey[] = [];
  const seen = new Set<string>();
  for (const row of body.passkeys) {
    if (
      !record(row) ||
      !text(row.id) ||
      seen.has(row.id) ||
      !text(row.name) ||
      !date(row.created_at) ||
      (row.last_used_at !== null && !date(row.last_used_at))
    )
      return null;
    seen.add(row.id);
    rows.push({ id: row.id, name: row.name, created_at: row.created_at, last_used_at: row.last_used_at });
  }
  return rows;
}

export function targetPresence(rows: { id: string }[], id: string, limit: number) {
  // Native lists are capped, not paginated. A full window cannot prove absence.
  return rows.some((row) => row.id === id)
    ? ('present' as const)
    : rows.length < limit
      ? ('absent' as const)
      : ('unknown' as const);
}

async function currentAccount(accountId: string): Promise<'current' | 'signed-out' | 'denied' | 'unavailable'> {
  const response = await issuerSecurityRequest('/session');
  if (response.status === 401) return 'signed-out';
  if (response.status === 403) return 'denied';
  if (response.status !== 200) return 'unavailable';
  const body: unknown = await response.json();
  if (!record(body) || !text(body.account_id)) return 'unavailable';
  return body.account_id === accountId ? 'current' : 'denied';
}

const readback = createServerFn({ method: 'POST' })
  .validator(target)
  .handler(async ({ data }): Promise<SecurityReadback> => {
    try {
      const result = await readNativeSecurityPage();
      if (result.kind !== 'ready') return result;
      const { page } = result;
      if (page.viewer.account_id !== data.accountId) return { kind: 'denied' };
      const inventory = data.kind === 'session' ? page.sessions : page.passkeys;
      if (inventory.kind !== 'ready' || page.sessions.kind !== 'ready') return { kind: 'unavailable' };
      return {
        kind: 'ready',
        page,
        sessions: page.sessions.rows,
        passkeys: page.passkeys.kind === 'ready' ? page.passkeys.rows : null,
        presence: inventory.rows.some((row) => row.id === data.id)
          ? 'present'
          : inventory.truncated
            ? 'unknown'
            : 'absent',
      };
    } catch {
      return { kind: 'unavailable' };
    }
  });

// The cookie is fixed by this one BFF request. The expected account is checked
// against native current authority before dispatch, never used as native proof.
// These are the existing exact-key commands, with no replay key or automatic retry.
const act = createServerFn({ method: 'POST' })
  .validator(target)
  .handler(async ({ data }): Promise<SecurityActionResult> => {
    try {
      const authority = await currentAccount(data.accountId).catch(() => 'unavailable' as const);
      if (authority !== 'current') return { kind: authority === 'unavailable' ? 'failure' : authority };
      const response = await issuerSecurityRequest(
        data.kind === 'session' ? '/sessions/revoke' : '/passkeys/remove',
        data.kind === 'session' ? { session_id: data.id } : { id: data.id },
      );
      const { setResponseHeader } = await import('@tanstack/react-start/server');
      const cookies = response.headers.getSetCookie();
      if (cookies.length) setResponseHeader('Set-Cookie', cookies);
      const body: unknown = await response.json().catch(() => null);
      if (response.status === 200) {
        const valid =
          record(body) && (data.kind === 'session' ? Object.keys(body).length === 0 : body.success === true);
        return { kind: valid ? 'accepted' : 'unknown', sessionEnded: cookies.length > 0 };
      }
      if (response.status >= 500) return { kind: 'unknown' };
      if (response.status === 401)
        return { kind: record(body) && body.error === 'step_up_required' ? 'step-up' : 'signed-out' };
      if (response.status === 403 || response.status === 404) return { kind: 'denied' };
      if (response.status === 409 && data.kind === 'passkey') return { kind: 'last-credential' };
      return { kind: 'failure' };
    } catch {
      // Dispatch may have reached the native writer. Do not send it twice.
      return { kind: 'unknown' };
    }
  });

// The browser boundary is kept separate from source injection: both callers
// still use the same finite wait, cancellation and acknowledgement handling.
export const securityTargetBrowserTransport = {
  read: (value: SecurityTarget, signal: AbortSignal) => readback({ data: value, signal }),
  act: (value: SecurityTarget, signal: AbortSignal) => act({ data: value, signal }),
};

export async function readSecurityTarget(value: SecurityTarget, signal?: AbortSignal): Promise<SecurityReadback> {
  try {
    const result = await privateAuthRead((signal) => securityTargetBrowserTransport.read(value, signal), signal);
    if (!result || typeof result !== 'object') return { kind: 'unavailable' };
    if (result.kind !== 'ready')
      return ['signed-out', 'denied', 'unavailable'].includes(result.kind) ? result : { kind: 'unavailable' };
    const page = parseSecurityPage(result.page);
    if (!page) return { kind: 'unavailable' };
    if (page.viewer.account_id !== value.accountId) return { kind: 'denied' };
    const inventory = value.kind === 'session' ? page.sessions : page.passkeys;
    if (inventory.kind !== 'ready' || page.sessions.kind !== 'ready') return { kind: 'unavailable' };
    return {
      kind: 'ready',
      page,
      sessions: page.sessions.rows,
      passkeys: page.passkeys.kind === 'ready' ? page.passkeys.rows : null,
      presence: inventory.rows.some((row) => row.id === value.id)
        ? 'present'
        : inventory.truncated
          ? 'unknown'
          : 'absent',
    };
  } catch {
    return { kind: 'unavailable' };
  }
}
export async function performSecurityAction(
  value: SecurityTarget,
  signal?: AbortSignal,
): Promise<SecurityActionResult> {
  return waitForSecurityAction((signal) => securityTargetBrowserTransport.act(value, signal), signal);
}
