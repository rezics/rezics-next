import { searchRetryAt } from '../../search/search-recovery-retry';

export type ConfiguredListRetryAdmission = { retryAt: number };

/** Admit only the native minimum-delay deadline; the response headers themselves stay private. */
export function configuredListRetryAdmission(
  status: number,
  headers: HeadersInit | undefined,
  now = Date.now(),
): ConfiguredListRetryAdmission | undefined {
  if (status === 200 || headers === undefined) return;
  const retryAt = searchRetryAt(new Headers(headers).get('retry-after'), now);
  return retryAt === undefined ? undefined : { retryAt };
}

export function configuredListRetryWaiting(retryAt: number | undefined, now = Date.now()): boolean {
  return retryAt !== undefined && retryAt > now;
}
