import { createServerFn } from '@tanstack/react-start';
import {
  credentialEffectResponseByteBudgets,
  securityFixedResponseByteBudgets,
  type CredentialEffectErrorResponse,
} from '@rezics/auth-contract';
import { readNativeAccountSessionAuthority } from './account-session';
import { securityResponseLimits } from '@rezics/auth-contract';
import { privateAuthRead } from './private-auth-read';
import { AUTH_POST_TIMEOUT_MS, authPost, failureMessage } from './api';
import { readJsonBounded } from './private-auth-json';
import { m } from './paraglide/messages.js';
import {
  issuerSecurityJsonRequest,
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
  type PasswordChangeReply,
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

function isCredentialEffectError(value: unknown): value is CredentialEffectErrorResponse {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const body = value as Record<string, unknown>;
  return (
    Object.keys(body).length === 2 &&
    Object.hasOwn(body, 'error') &&
    Object.hasOwn(body, 'effect_status') &&
    (body.error === 'credential_effect_denied' || body.error === 'step_up_required') &&
    body.effect_status === 'not_applied'
  );
}

function parseUnambiguousJson(text: string): unknown {
  let position = 0;
  const whitespace = () => {
    while (position < text.length && /\s/.test(text[position]!)) position++;
  };
  const expect = (character: string) => {
    if (text[position] !== character) throw new SyntaxError('Invalid credential response JSON');
    position++;
  };
  const string = () => {
    const start = position;
    expect('"');
    while (position < text.length) {
      const character = text[position++]!;
      if (character === '"') return JSON.parse(text.slice(start, position)) as string;
      if (character === '\\') position++;
    }
    throw new SyntaxError('Invalid credential response JSON');
  };
  const value = (): void => {
    whitespace();
    const character = text[position];
    if (character === '"') {
      string();
      return;
    }
    if (character === '{') {
      position++;
      whitespace();
      const keys = new Set<string>();
      if (text[position] === '}') {
        position++;
        return;
      }
      for (;;) {
        whitespace();
        const key = string();
        if (keys.has(key)) throw new SyntaxError('Ambiguous credential response JSON');
        keys.add(key);
        whitespace();
        expect(':');
        value();
        whitespace();
        if (text[position] === '}') {
          position++;
          return;
        }
        expect(',');
      }
    }
    if (character === '[') {
      position++;
      whitespace();
      if (text[position] === ']') {
        position++;
        return;
      }
      for (;;) {
        value();
        whitespace();
        if (text[position] === ']') {
          position++;
          return;
        }
        expect(',');
      }
    }
    const literal = ['true', 'false', 'null'].find((candidate) => text.startsWith(candidate, position));
    if (literal) {
      position += literal.length;
      return;
    }
    const number = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(text.slice(position));
    if (!number) throw new SyntaxError('Invalid credential response JSON');
    position += number[0].length;
  };

  value();
  whitespace();
  if (position !== text.length) throw new SyntaxError('Invalid credential response JSON');
  return JSON.parse(text) as unknown;
}

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
  | { kind: 'ready'; passkeys: SecurityPasskey[]; truncated: boolean }
  | { kind: 'signed-out' }
  | { kind: 'denied' }
  | { kind: 'unavailable' };

const passwordChangeLimitsRead = createServerFn({ method: 'POST' }).handler(
  async (): Promise<PasswordChangeLimits | null> => {
    try {
      const { response, body } = await issuerSecurityJsonRequest(
        '/registration-page',
        securityFixedResponseByteBudgets.registrationPage,
      );
      if (response.status !== 200) return null;
      if (!body || typeof body !== 'object' || Array.isArray(body) || !('requirements' in body)) return null;
      const requirements = body.requirements;
      if (
        !requirements ||
        typeof requirements !== 'object' ||
        Array.isArray(requirements) ||
        !('password' in requirements)
      )
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
  },
);

export async function loadPasswordChangeLimits(signal?: AbortSignal): Promise<PasswordChangeLimits | null> {
  try {
    return await privateAuthRead((readSignal) => passwordChangeLimitsRead({ signal: readSignal }), signal);
  } catch {
    return null;
  }
}

const registrationReview = createServerFn({ method: 'POST' })
  .validator((accountId: string) => {
    if (typeof accountId !== 'string' || !accountId || accountId.length > securityResponseLimits.id)
      throw new Error('Invalid account');
    return accountId;
  })
  .handler(async ({ data }): Promise<PasskeyRegistrationReview> => {
    // All reads carry one fixed BFF request cookie; never adopt another account's list.
    async function authority(): Promise<'current' | 'signed-out' | 'denied' | 'unavailable'> {
      const session = await readNativeAccountSessionAuthority();
      if (session.kind === 'signed-out' || session.kind === 'denied') return session.kind;
      if (session.kind !== 'ready') return 'unavailable';
      return session.accountId === data ? 'current' : 'denied';
    }
    try {
      const before = await authority();
      if (before !== 'current') return { kind: before };
      const { response, body } = await issuerSecurityJsonRequest(
        '/passkeys',
        securityFixedResponseByteBudgets.passkeys,
      );
      if (response.status === 401) return { kind: 'signed-out' };
      if (response.status === 403) return { kind: 'denied' };
      if (response.status !== 200) return { kind: 'unavailable' };
      const passkeys = parseSecurityPasskeys(body);
      if (!passkeys) return { kind: 'unavailable' };
      const bodyRecord = body && typeof body === 'object' ? (body as Record<string, unknown>) : null;
      const hasTruncationFlag = Boolean(bodyRecord && 'truncated' in bodyRecord);
      const explicitTruncation = bodyRecord?.truncated;
      if (hasTruncationFlag && typeof explicitTruncation !== 'boolean') return { kind: 'unavailable' };
      // The legacy list is bounded at 32; without an explicit completeness flag, a full page may be truncated.
      const truncated =
        (hasTruncationFlag && explicitTruncation === true) || (!hasTruncationFlag && passkeys.length === 32);
      const after = await authority();
      return after === 'current' ? { kind: 'ready', passkeys, truncated } : { kind: after };
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
  const controller = new AbortController();
  const payload = JSON.stringify(body);
  const interruptedToken = Symbol('password phase interrupted');
  let settleInterrupted!: () => void;
  let interrupted = false;
  const interruption = new Promise<typeof interruptedToken>((resolve) => {
    settleInterrupted = () => resolve(interruptedToken);
  });
  const interrupt = () => {
    if (interrupted) return;
    interrupted = true;
    controller.abort();
    settleInterrupted();
  };
  const onCallerAbort = () => interrupt();
  signal?.addEventListener('abort', onCallerAbort, { once: true });
  if (signal?.aborted) {
    signal.removeEventListener('abort', onCallerAbort);
    return { kind: 'cancelled', attempt };
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  let received: PasswordChangeReply | typeof interruptedToken;
  try {
    // This one absolute lifetime includes both fetch headers and bounded body
    // admission; caller retirement and timeout settle even when fetch ignores abort.
    timer = setTimeout(interrupt, AUTH_POST_TIMEOUT_MS);
    if (signal?.aborted) return { kind: 'cancelled', attempt };
    const pending: Promise<PasswordChangeReply> = (async () => {
      const response = await fetch(path, {
        method: 'POST',
        credentials: 'same-origin',
        redirect: 'error',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: payload,
        signal: controller.signal,
      });
      const budget = credentialEffectResponseByteBudgets[attempt.phase];
      const received = await readJsonBounded(
        response,
        response.status === 200 ? budget.success : budget.error,
        controller.signal,
        parseUnambiguousJson,
      );
      if (response.status === 200) return { ok: true, body: received };

      if (isCredentialEffectError(received))
        return {
          ok: false,
          status: response.status,
          code: received.error,
          effectStatus: 'not_applied',
        };
      return { ok: false, status: response.status, code: '' };
    })();
    received = await Promise.race([pending, interruption]);
  } catch {
    // A dispatched mutation with unreadable output may have completed natively.
    return { kind: 'unknown', attempt: { ...attempt, uncertain: true } };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    signal?.removeEventListener('abort', onCallerAbort);
  }
  if (received === interruptedToken || interrupted || signal?.aborted)
    return { kind: 'unknown', attempt: { ...attempt, uncertain: true } };
  return classifyPasswordChangeReply(attempt, received);
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
