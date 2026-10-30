import { authPost, failureMessage, type AuthPostResult } from './api';
import { m } from './paraglide/messages.js';
import { loadPasskeyInventory } from './security-inventory';

export type SecuritySession = {
  id: string;
  client_id: string;
  created_at: string;
  expires_at: string;
  user_agent: string | null;
  current: boolean;
  client_display_name?: string;
};

export type SecurityPasskey = {
  id: string;
  name: string;
  created_at: string;
  last_used_at: string | null;
};

// `hidden` when the browser has no WebAuthn, so the page shows no passkey controls and Auth is not asked.
export type PasskeysLoad =
  | { kind: 'hidden' }
  | { kind: 'ready'; passkeys: SecurityPasskey[] }
  | { kind: 'failure'; message: string };

export type SecurityLoadResult =
  | { kind: 'ready'; accountId: string; sessions: SecuritySession[]; passkeys: PasskeysLoad }
  | { kind: 'signed-out' }
  | { kind: 'failure'; message: string };

type SessionResponse = { account_id?: unknown };
type SessionsResponse = { sessions?: unknown };
type EffectStage = {
  effectRef: string;
  key: string;
  subjectId: string;
  purpose: string;
  digest: string;
};
type EffectApproval = { reference: string; expiresAt: string };

async function authGet<Body>(
  path: string,
): Promise<{ ok: true; body: Body } | { ok: false; status: number; code: string }> {
  try {
    const response = await fetch(path, {
      method: 'GET',
      credentials: 'same-origin',
      redirect: 'error',
      cache: 'no-store',
      headers: { Accept: 'application/json' },
    });
    if (response.status === 200) return { ok: true, body: (await response.json()) as Body };
    const body: unknown = await response.json().catch(() => null);
    const code =
      body && typeof body === 'object'
        ? 'error' in body && typeof body.error === 'string'
          ? body.error
          : 'code' in body && typeof body.code === 'string'
            ? body.code
            : ''
        : '';
    return { ok: false, status: response.status, code };
  } catch {
    return { ok: false, status: 503, code: 'unavailable' };
  }
}

// One read of the person's own passkeys; entries that do not have the documented shape are dropped.
async function loadPasskeys(): Promise<PasskeysLoad> {
  const listed = await loadPasskeyInventory();
  if (!listed.ok) return { kind: 'failure', message: m.auth_security_passkeys_failed() };
  if (!Array.isArray(listed.body.passkeys)) return { kind: 'failure', message: m.auth_security_passkeys_failed() };
  const passkeys = listed.body.passkeys.flatMap((entry: unknown): SecurityPasskey[] => {
    if (!entry || typeof entry !== 'object') return [];
    const { id, name, created_at: createdAt, last_used_at: lastUsedAt } = entry as Record<string, unknown>;
    if (typeof id !== 'string' || typeof name !== 'string' || typeof createdAt !== 'string') return [];
    return [{ id, name, created_at: createdAt, last_used_at: typeof lastUsedAt === 'string' ? lastUsedAt : null }];
  });
  return { kind: 'ready', passkeys };
}

export async function loadSecurity(withPasskeys: boolean): Promise<SecurityLoadResult> {
  const session = await authGet<SessionResponse>('/session');
  if (!session.ok) {
    if (session.status === 401) return { kind: 'signed-out' };
    return { kind: 'failure', message: failureMessage(session.status, session.code, null) };
  }
  if (typeof session.body.account_id !== 'string' || !session.body.account_id)
    return { kind: 'failure', message: failureMessage(503, 'unavailable', null) };

  const [listed, passkeys] = await Promise.all([
    authGet<SessionsResponse>('/sessions'),
    withPasskeys ? loadPasskeys() : Promise.resolve<PasskeysLoad>({ kind: 'hidden' }),
  ]);
  if (!listed.ok) {
    if (listed.status === 401) return { kind: 'signed-out' };
    const message =
      listed.status === 503 && listed.code === 'unavailable'
        ? failureMessage(listed.status, listed.code, null)
        : m.auth_security_sessions_failed();
    return { kind: 'failure', message };
  }
  if (!Array.isArray(listed.body.sessions))
    return { kind: 'failure', message: failureMessage(503, 'unavailable', null) };

  return {
    kind: 'ready',
    accountId: session.body.account_id,
    sessions: (listed.body.sessions as SecuritySession[]).slice(0, 64),
    passkeys,
  };
}

async function postEffect<Body>(path: string, body: unknown): Promise<AuthPostResult<Body>> {
  const result = await authPost<Body>(path, body);
  if (!result.ok && result.status === 503 && result.code === 'unavailable') return authPost<Body>(path, body);
  return result;
}

function hasEffectDenial(status: number, code: string): boolean {
  return code === 'credential_effect_denied' && [400, 401, 403, 409, 413, 415, 503].includes(status);
}

export type PasswordChangeResult = { ok: true } | { ok: false; reason: 'step-up' | 'failure'; message?: string };

export async function changePassword(subjectId: string, password: string): Promise<PasswordChangeResult> {
  const key = crypto.randomUUID();
  const staged = await postEffect<EffectStage>('/credential-effects/stage', {
    key,
    subjectId,
    credential: { kind: 'password', password },
  });
  if (!staged.ok) {
    if (staged.status === 401 && staged.code === 'step_up_required') return { ok: false, reason: 'step-up' };
    return {
      ok: false,
      reason: 'failure',
      message: hasEffectDenial(staged.status, staged.code)
        ? m.auth_security_password_failed()
        : failureMessage(staged.status, staged.code, staged.retryAfter),
    };
  }
  if (
    typeof staged.body.effectRef !== 'string' ||
    !staged.body.effectRef ||
    staged.body.key !== key ||
    staged.body.subjectId !== subjectId ||
    typeof staged.body.purpose !== 'string' ||
    typeof staged.body.digest !== 'string'
  )
    return { ok: false, reason: 'failure', message: failureMessage(503, 'unavailable', null) };

  const approved = await postEffect<EffectApproval>('/credential-effects/approve', {
    key,
    subjectId,
    effectRef: staged.body.effectRef,
  });
  if (!approved.ok) {
    if (approved.status === 401 && approved.code === 'step_up_required') return { ok: false, reason: 'step-up' };
    return {
      ok: false,
      reason: 'failure',
      message: hasEffectDenial(approved.status, approved.code)
        ? m.auth_security_password_failed()
        : failureMessage(approved.status, approved.code, approved.retryAfter),
    };
  }
  if (
    typeof approved.body.reference !== 'string' ||
    !approved.body.reference ||
    typeof approved.body.expiresAt !== 'string'
  )
    return { ok: false, reason: 'failure', message: failureMessage(503, 'unavailable', null) };

  const applied = await postEffect<{ receiptId: string; replayed: boolean }>('/credential-effects/apply', {
    key,
    subjectId,
    effectRef: staged.body.effectRef,
    reference: approved.body.reference,
  });
  if (!applied.ok) {
    if (applied.status === 401 && applied.code === 'step_up_required') return { ok: false, reason: 'step-up' };
    return {
      ok: false,
      reason: 'failure',
      message: hasEffectDenial(applied.status, applied.code)
        ? m.auth_security_password_failed()
        : failureMessage(applied.status, applied.code, applied.retryAfter),
    };
  }
  if (typeof applied.body.receiptId !== 'string' || typeof applied.body.replayed !== 'boolean')
    return { ok: false, reason: 'failure', message: failureMessage(503, 'unavailable', null) };
  return { ok: true };
}

export async function revokeSession(sessionId: string): Promise<{ ok: true } | { ok: false; message: string }> {
  const result = await authPost('/sessions/revoke', { session_id: sessionId });
  return result.ok
    ? { ok: true }
    : { ok: false, message: failureMessage(result.status, result.code, result.retryAfter) };
}

export function securityDevice(userAgent: string | null): { browser: string; system: string } | null {
  if (!userAgent) return null;
  const browser = /(?:Edg|EdgA|EdgiOS)\//.test(userAgent)
    ? 'Microsoft Edge'
    : /(?:Firefox|FxiOS)\//.test(userAgent)
      ? 'Firefox'
      : /(?:Chrome|CriOS)\//.test(userAgent)
        ? 'Google Chrome'
        : userAgent.includes('Safari/') && userAgent.includes('Version/')
          ? 'Safari'
          : null;
  const system = /Windows NT/i.test(userAgent)
    ? 'Windows'
    : /Android/i.test(userAgent)
      ? 'Android'
      : /iPhone|iPad|iPod/i.test(userAgent)
        ? 'iOS'
        : /Mac OS X/i.test(userAgent)
          ? 'macOS'
          : /Linux/i.test(userAgent)
            ? 'Linux'
            : null;
  return browser && system ? { browser, system } : null;
}

export function formatSecurityDate(value: string, locale: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}
