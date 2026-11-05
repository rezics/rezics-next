import { privateAuthRead } from './private-auth-read';
import { waitForSecurityAction } from './security-target-operation';
import { createServerFn } from '@tanstack/react-start';
import { securityActionResponseByteBudgets, securityResponseLimits } from '@rezics/auth-contract';
import { readJsonBounded } from './private-auth-json';
import { readNativeAccountSession } from './account-session';
import { parseSecurityPage, readNativeSecurityPage, type SecurityPageEnvelope } from './security-inventory';
import { readSecurityIssuerResponse } from './security-response-config';
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
    value.accountId.length > securityResponseLimits.id ||
    !text(value.id) ||
    value.id.length > securityResponseLimits.id ||
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

export { parseSecurityPasskeys } from './security-inventory';

export function targetPresence(rows: { id: string }[], id: string, limit: number) {
  // Native lists are capped, not paginated. A full window cannot prove absence.
  return rows.some((row) => row.id === id)
    ? ('present' as const)
    : rows.length < limit
      ? ('absent' as const)
      : ('unknown' as const);
}

function exactFields(value: unknown, fields: string[]): value is Record<string, unknown> {
  return (
    record(value) && Object.keys(value).length === fields.length && fields.every((field) => Object.hasOwn(value, field))
  );
}

function sessionRemovalError(value: unknown): value is { error: 'authentication_denied'; code?: 'stale_review' } {
  return (
    (exactFields(value, ['error']) && value.error === 'authentication_denied') ||
    (exactFields(value, ['error', 'code']) && value.error === 'authentication_denied' && value.code === 'stale_review')
  );
}

function passkeyStepUp(value: unknown): boolean {
  return (
    exactFields(value, ['error', 'effect_status']) &&
    value.error === 'step_up_required' &&
    value.effect_status === 'not_applied'
  );
}

function passkeyDenied(value: unknown): boolean {
  return (
    exactFields(value, ['error', 'effect_status']) &&
    value.error === 'credential_effect_denied' &&
    value.effect_status === 'not_applied'
  );
}

function classifySecurityActionResponse(
  kind: SecurityTarget['kind'],
  status: number,
  body: unknown,
): SecurityActionResult {
  if (status === 200) {
    if (kind === 'session' && exactFields(body, [])) return { kind: 'accepted' };
    if (kind === 'passkey' && exactFields(body, ['success']) && body.success === true) return { kind: 'accepted' };
    return { kind: 'unknown' };
  }
  if (status >= 500) return { kind: 'unknown' };
  if (kind === 'session' && sessionRemovalError(body)) {
    if (status === 401 && !('code' in body)) return { kind: 'signed-out' };
    if ([400, 403, 404].includes(status) || (status === 409 && body.code === 'stale_review')) return { kind: 'denied' };
    return { kind: 'unknown' };
  }
  if (kind === 'passkey') {
    if (status === 401 && passkeyStepUp(body)) return { kind: 'step-up' };
    if ([400, 401, 403, 404, 409].includes(status) && passkeyDenied(body)) return { kind: 'denied' };
    // The native attempt wrapper refuses before dispatch with this exact 429 envelope.
    if (status === 429 && exactFields(body, ['error']) && body.error === 'authentication_denied')
      return { kind: 'failure' };
  }
  return { kind: 'unknown' };
}

/** Receive one native command response within its producer-derived endpoint budget. */
export async function receiveSecurityActionResponse(
  kind: SecurityTarget['kind'],
  response: Response,
  signal: AbortSignal,
): Promise<SecurityActionResult> {
  try {
    const body = await readJsonBounded(response, securityActionResponseByteBudgets[kind], signal);
    return classifySecurityActionResponse(kind, response.status, body);
  } catch {
    return { kind: 'unknown' };
  }
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
    let authority: Awaited<ReturnType<typeof readNativeAccountSession>>;
    try {
      authority = await readNativeAccountSession();
    } catch {
      return { kind: 'failure' };
    }
    if (authority.kind === 'signed-out') return { kind: 'signed-out' };
    if (authority.kind !== 'ready') return { kind: 'failure' };
    if (authority.accountId !== data.accountId) return { kind: 'denied' };

    let commandStarted = false;
    let sessionEnded = false;
    try {
      return await readSecurityIssuerResponse(
        data.kind === 'session' ? '/sessions/revoke' : '/passkeys/remove',
        data.kind === 'session' ? { session_id: data.id } : { id: data.id },
        async (response, signal) => {
          const { setResponseHeader } = await import('@tanstack/react-start/server');
          const cookies = response.headers.getSetCookie();
          sessionEnded = cookies.length > 0;
          if (sessionEnded) setResponseHeader('Set-Cookie', cookies);
          const result = await receiveSecurityActionResponse(data.kind, response, signal);
          return sessionEnded ? { ...result, sessionEnded: true } : result;
        },
        () => {
          commandStarted = true;
        },
      );
    } catch {
      // Once the shared issuer transport starts its one fetch, a lost reply may have committed.
      return commandStarted
        ? { kind: 'unknown', ...(sessionEnded ? { sessionEnded: true } : {}) }
        : { kind: 'failure' };
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
