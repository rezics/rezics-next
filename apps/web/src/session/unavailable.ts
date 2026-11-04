import { locales, type Locale } from '../paraglide/runtime.js';

export const SESSION_UNAVAILABLE_CODE = 'session_unavailable';
export const DEPENDENCY_UNAVAILABLE_CODE = 'dependency_unavailable';
export const LOGIN_RETURN_COOKIE = 'rezics_login_return';
export const LOGIN_RETURN_LIMIT = 1024;

/** A bounded navigation hint retained only for recovering a consumed login callback. */
export function safeRecoveryReturn(value: string | null | undefined, origin: string): string | undefined {
  if (
    !value ||
    value.length > 2048 ||
    !value.startsWith('/') ||
    value.startsWith('//') ||
    value.includes('\\') ||
    /%5c/i.test(value) ||
    /[\u0000-\u0020\u007f]/.test(value)
  )
    return undefined;
  try {
    const target = new URL(value, origin);
    if (
      target.origin !== origin ||
      target.username ||
      target.password ||
      target.pathname.length > LOGIN_RETURN_LIMIT
    )
      return undefined;
    const localPath = target.pathname.replace(/^\/(?:en|zh-Hant|zh-Hans|ja|ko|de|fr|es)(?=\/|$)/, '') || '/';
    if (/^\/(?:auth|api|media|_serverFn|_native)(?:\/|$)/.test(localPath)) return undefined;
    return target.pathname;
  } catch {
    return undefined;
  }
}

export function recoveryReturnLocale(value: string | undefined): Locale | undefined {
  if (!value) return undefined;
  const candidate = value.split('/')[1];
  return locales.find((locale) => locale === candidate);
}

/** Recovery pages recognize typed dependency outcomes only; arbitrary causes and messages stay private. */
export function isDependencyUnavailableError(error: unknown): boolean {
  const pending: unknown[] = [error];
  const seen = new Set<object>();
  while (pending.length) {
    const value = pending.pop();
    if (typeof value !== 'object' || value === null || seen.has(value)) continue;
    seen.add(value);
    if (
      ('name' in value && value.name === 'SessionUnavailableError') ||
      ('code' in value && (value.code === SESSION_UNAVAILABLE_CODE || value.code === DEPENDENCY_UNAVAILABLE_CODE))
    )
      return true;
    pending.push(
      'problem' in value ? value.problem : undefined,
      'data' in value ? value.data : undefined,
      'cause' in value ? value.cause : undefined,
    );
  }
  return false;
}

export class SessionUnavailableError extends Error {
  readonly status = 503;
  readonly statusCode = 503;
  readonly code = SESSION_UNAVAILABLE_CODE;
  readonly retryable = true;
  readonly problem = {
    type: 'https://rezics.com/problems/session_unavailable',
    title: 'Session Unavailable',
    status: 503,
    code: SESSION_UNAVAILABLE_CODE,
    retryable: true,
  };
  readonly headers = { 'cache-control': 'private, no-store' };

  constructor() {
    super(SESSION_UNAVAILABLE_CODE);
    this.name = 'SessionUnavailableError';
  }
}

/** Recognize only the session boundary's explicit dependency failure through server-function wrappers. */
export function isSessionUnavailableError(error: unknown): boolean {
  const pending: unknown[] = [error];
  const seen = new Set<object>();

  while (pending.length) {
    const value = pending.pop();
    if (typeof value !== 'object' || value === null || seen.has(value)) continue;
    seen.add(value);
    if (
      ('name' in value && value.name === 'SessionUnavailableError') ||
      ('code' in value && value.code === SESSION_UNAVAILABLE_CODE)
    )
      return true;
    pending.push(
      'problem' in value ? value.problem : undefined,
      'data' in value ? value.data : undefined,
      'cause' in value ? value.cause : undefined,
    );
  }

  return false;
}
