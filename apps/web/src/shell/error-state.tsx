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
    matches.length === 1 ||
    matches.some((match) => match._notFound || match.status === 'notFound' || isNotFound(match.error));
  if (!failed && !missing) return undefined;
  const status = closed ? 403 : missing ? 404 : (failureStatus(nativeStatus) ?? errorStatus(failed?.error) ?? 500);
  const headers =
    failed?.error && typeof failed.error === 'object' && 'headers' in failed.error
      ? (failed.error.headers as HeadersInit | undefined)
      : undefined;
  const retryAfter = headers ? new Headers(headers).get('retry-after') : null;
  return { status, closed, missing, retryAfter };
}

export function errorPageHead(context: HeadContext) {
  const { origin, locale, path } = context;
  return pageHead({ robots: 'noindex' }, { origin, locale, path });
}
