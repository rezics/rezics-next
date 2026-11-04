import { createServerFn } from '@tanstack/react-start';
import { privateAuthRead } from './private-auth-read';
import { authPost, failureMessage, type AuthPostResult } from './api';
import { m } from './paraglide/messages.js';
import {
  issuerSecurityRequest,
  loadSecurityPage,
  type SecurityPageEnvelope,
  type SecurityAdvice,
} from './security-inventory';
import { parseSecurityPasskeys, performSecurityAction } from './security-reconciliation';

export type SecuritySession = {
  id: string;
  client_id: string;
  created_at: string;
  expires_at: string;
  user_agent: string | null;
  current: boolean;
  client_display_name?: string | null;
  revoke?: SecurityAdvice;
};

export type SecurityPasskey = {
  id: string;
  name: string;
  created_at: string;
  last_used_at: string | null;
  remove?: SecurityAdvice;
};

// Browser support only limits ceremonies; native inventory and permission remain visible.
export type PasskeysLoad =
  | { kind: 'hidden' }
  | { kind: 'ready'; passkeys: SecurityPasskey[] }
  | { kind: 'failure'; message: string };

export type SecurityLoadResult =
  | {
      kind: 'ready';
      accountId: string;
      sessions: SecuritySession[];
      passkeys: PasskeysLoad;
      page?: SecurityPageEnvelope;
    }
  | { kind: 'signed-out' }
  | { kind: 'failure'; message: string };

export type PasskeyRegistrationReview =
  | { kind: 'ready'; passkeys: SecurityPasskey[] }
  | { kind: 'signed-out' }
  | { kind: 'denied' }
  | { kind: 'unavailable' };

const registrationReview = createServerFn({ method: 'POST' })
  .validator((accountId: string) => {
    if (typeof accountId !== 'string' || !accountId) throw new Error('Invalid account');
    return accountId;
  })
  .handler(async ({ data }): Promise<PasskeyRegistrationReview> => {
    // All reads carry one fixed BFF request cookie; never adopt another account's list.
    async function authority(): Promise<'current' | 'signed-out' | 'denied' | 'unavailable'> {
      const response = await issuerSecurityRequest('/session');
      if (response.status === 401) return 'signed-out';
      if (response.status === 403) return 'denied';
      if (response.status !== 200) return 'unavailable';
      const body: unknown = await response.json();
      if (!body || typeof body !== 'object' || !('account_id' in body) || typeof body.account_id !== 'string')
        return 'unavailable';
      return body.account_id === data ? 'current' : 'denied';
    }
    try {
      const before = await authority();
      if (before !== 'current') return { kind: before };
      const response = await issuerSecurityRequest('/passkeys');
      if (response.status === 401) return { kind: 'signed-out' };
      if (response.status === 403) return { kind: 'denied' };
      if (response.status !== 200) return { kind: 'unavailable' };
      const passkeys = parseSecurityPasskeys(await response.json());
      if (!passkeys) return { kind: 'unavailable' };
      const after = await authority();
      return after === 'current' ? { kind: 'ready', passkeys } : { kind: after };
    } catch {
      return { kind: 'unavailable' };
    }
  });

export async function reviewPasskeyRegistration(
  accountId: string,
  signal?: AbortSignal,
): Promise<PasskeyRegistrationReview> {
  try {
    return await privateAuthRead((readSignal) => registrationReview({ data: accountId, signal: readSignal }), signal);
  } catch {
    return { kind: 'unavailable' };
  }
}

type EffectStage = {
  effectRef: string;
  key: string;
  subjectId: string;
  purpose: string;
  digest: string;
};
type EffectApproval = { reference: string; expiresAt: string };

export async function loadSecurity(_withPasskeys: boolean, signal?: AbortSignal): Promise<SecurityLoadResult> {
  const result = await loadSecurityPage(signal);
  if (result.kind === 'signed-out') return { kind: 'signed-out' };
  if (result.kind !== 'ready') return { kind: 'failure', message: failureMessage(503, 'unavailable', null) };
  const { page } = result;
  return {
    kind: 'ready',
    accountId: page.viewer.account_id,
    page,
    sessions: page.sessions.kind === 'ready' ? page.sessions.rows : [],
    passkeys:
      page.passkeys.kind === 'ready'
        ? { kind: 'ready', passkeys: page.passkeys.rows }
        : { kind: 'failure', message: m.auth_security_passkeys_failed() },
  };
}

async function postEffect<Body>(path: string, body: unknown, signal?: AbortSignal): Promise<AuthPostResult<Body>> {
  if (signal?.aborted) return { ok: false, status: 503, code: 'unavailable', retryAfter: null };
  const result = await authPost<Body>(path, body);
  if (!signal?.aborted && !result.ok && result.status === 503 && result.code === 'unavailable')
    return authPost<Body>(path, body);
  return result;
}

function hasEffectDenial(status: number, code: string): boolean {
  return code === 'credential_effect_denied' && [400, 401, 403, 409, 413, 415, 503].includes(status);
}

export type PasswordChangeResult = { ok: true } | { ok: false; reason: 'step-up' | 'failure'; message?: string };

export async function changePassword(
  subjectId: string,
  password: string,
  signal?: AbortSignal,
): Promise<PasswordChangeResult> {
  const key = crypto.randomUUID();
  const staged = await postEffect<EffectStage>(
    '/credential-effects/stage',
    {
      key,
      subjectId,
      credential: { kind: 'password', password },
    },
    signal,
  );
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

  const approved = await postEffect<EffectApproval>(
    '/credential-effects/approve',
    {
      key,
      subjectId,
      effectRef: staged.body.effectRef,
    },
    signal,
  );
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

  const applied = await postEffect<{ receiptId: string; replayed: boolean }>(
    '/credential-effects/apply',
    {
      key,
      subjectId,
      effectRef: staged.body.effectRef,
      reference: approved.body.reference,
    },
    signal,
  );
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

export async function revokeSession(sessionId: string, accountId: string) {
  return performSecurityAction({ kind: 'session', id: sessionId, accountId });
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
