import { createServerFn } from '@tanstack/react-start';
import { privateAuthRead } from './private-auth-read';
import { authPost, failureMessage } from './api';
import { m } from './paraglide/messages.js';
import {
  issuerSecurityRequest,
  loadSecurityPage,
  type SecurityPageEnvelope,
  type SecurityAdvice,
} from './security-inventory';
import { parseSecurityPasskeys, performSecurityAction } from './security-reconciliation';
import {
  classifyPasswordChangeReply,
  passwordChangeRequest,
  type PasswordChangeAttempt,
  type PasswordChangeLimits,
  type PasswordChangeReplyResult,
} from './password-change-attempt';

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
      passwordLimits?: PasswordChangeLimits | null;
    }
  | { kind: 'signed-out' }
  | { kind: 'failure'; message: string };

export type PasskeyRegistrationReview =
  | { kind: 'ready'; passkeys: SecurityPasskey[] }
  | { kind: 'signed-out' }
  | { kind: 'denied' }
  | { kind: 'unavailable' };

const passwordChangeLimitsRead = createServerFn({ method: 'POST' }).handler(async (): Promise<PasswordChangeLimits | null> => {
  try {
    const response = await issuerSecurityRequest('/registration-page');
    if (response.status !== 200) return null;
    const body: unknown = await response.json();
    if (!body || typeof body !== 'object' || Array.isArray(body) || !('requirements' in body)) return null;
    const requirements = body.requirements;
    if (!requirements || typeof requirements !== 'object' || Array.isArray(requirements) || !('password' in requirements))
      return null;
    const password = requirements.password;
    if (!password || typeof password !== 'object' || Array.isArray(password)) return null;
    if (
      !('minLength' in password) ||
      !('maxLength' in password) ||
      !Number.isSafeInteger(password.minLength) ||
      !Number.isSafeInteger(password.maxLength) ||
      Number(password.minLength) < 1 ||
      Number(password.maxLength) < Number(password.minLength)
    )
      return null;
    return { minLength: Number(password.minLength), maxLength: Number(password.maxLength) };
  } catch {
    return null;
  }
});

export async function loadPasswordChangeLimits(signal?: AbortSignal): Promise<PasswordChangeLimits | null> {
  try {
    return await privateAuthRead((readSignal) => passwordChangeLimitsRead({ signal: readSignal }), signal);
  } catch {
    return null;
  }
}

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

export async function loadSecurity(_withPasskeys: boolean, signal?: AbortSignal): Promise<SecurityLoadResult> {
  const [result, passwordLimits] = await Promise.all([loadSecurityPage(signal), loadPasswordChangeLimits(signal)]);
  if (result.kind === 'signed-out') return { kind: 'signed-out' };
  if (result.kind !== 'ready') return { kind: 'failure', message: failureMessage(503, 'unavailable', null) };
  const { page } = result;
  return {
    kind: 'ready',
    accountId: page.viewer.account_id,
    page,
    passwordLimits,
    sessions: page.sessions.kind === 'ready' ? page.sessions.rows : [],
    passkeys:
      page.passkeys.kind === 'ready'
        ? { kind: 'ready', passkeys: page.passkeys.rows }
        : { kind: 'failure', message: m.auth_security_passkeys_failed() },
  };
}

export async function dispatchPasswordChangePhase(
  attempt: PasswordChangeAttempt,
  signal?: AbortSignal,
): Promise<PasswordChangeReplyResult> {
  if (signal?.aborted) return { kind: 'cancelled', attempt };
  const { path, body } = passwordChangeRequest(attempt);
  const result = await authPost(path, body);
  if (signal?.aborted) return { kind: 'unknown', attempt: { ...attempt, uncertain: true } };
  return classifyPasswordChangeReply(attempt, result);
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
