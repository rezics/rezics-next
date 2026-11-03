import { isNotFound } from '@tanstack/react-router';
import { isPlatformClosedError } from '../kernel/platform-closed';
import { pageHead, type HeadContext } from './head';

type ErrorMatch = { status: string; error?: unknown; _notFound?: boolean };

function failureStatus(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 400 && value <= 599 ? value : undefined;
}

function errorStatus(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const value = error as { status?: unknown; statusCode?: unknown; problem?: { status?: unknown } };
  return failureStatus(value.status) ?? failureStatus(value.statusCode) ?? failureStatus(value.problem?.status);
}

/** Read only outcome metadata; causes and problem details never become page content. */
export function routeFailure(matches: readonly ErrorMatch[], nativeStatus = 200) {
  const failed = matches.find((match) => match.status === 'error');
  const closed = matches.some((match) => match.status === 'error' && isPlatformClosedError(match.error));
  const missing =
    (matches.length === 1 && !failed) ||
    matches.some((match) => match._notFound || match.status === 'notFound' || isNotFound(match.error));
  if (!failed && !missing) return undefined;
  const status = closed ? 403 : missing ? 404 : (failureStatus(nativeStatus) ?? errorStatus(failed?.error) ?? 500);
  const headers =
    failed?.error && typeof failed.error === 'object' && 'headers' in failed.error
      ? (failed.error.headers as HeadersInit | undefined)
      : undefined;
  const retryAfter = safeRetryAfter(headers);
  return { status, closed, missing, retryAfter };
}

export function errorPageHead(context: HeadContext) {
  const { origin, locale, path } = context;
  return pageHead({ robots: 'noindex' }, { origin, locale, path });
}

/** Read one installed response header. Invalid or arbitrary text never becomes UI or an HTTP header. */
function safeRetryAfter(headers: HeadersInit | undefined): string | null {
  if (!headers) return null;
  try {
    const value = new Headers(headers).get('retry-after');
    if (!value || value.length > 64) return null;
    if (/^\d{1,10}$/.test(value)) return value;
    if (/^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(value) && Number.isFinite(Date.parse(value)))
      return value;
  } catch {
    // A malformed header is unavailable metadata, not another route failure.
  }
  return null;
}

export type RouteRetryPolicy = {
  allowed: boolean;
  /** At most five minutes gets a local wake-up; longer native delays remain deferred. */
  delay: number;
  deferred: boolean;
};

/** Only typed outcome fields affect recovery; titles, messages, causes and private bodies are ignored. */
export function routeRetry(error: unknown, now = Date.now()): RouteRetryPolicy {
  const failure = routeFailure([{ status: 'error', error }]);
  const value = error && typeof error === 'object'
    ? error as { retryable?: unknown; problem?: { retryable?: unknown } }
    : undefined;
  const allowed = !failure?.closed && !failure?.missing && value?.retryable !== false && value?.problem?.retryable !== false;
  const after = failure?.retryAfter;
  const seconds = !after ? 0 : /^\d+$/.test(after) ? Number(after) : Math.max(0, Math.ceil((Date.parse(after) - now) / 1000));
  return { allowed, delay: seconds <= 300 ? seconds : 0, deferred: seconds > 300 };
}
