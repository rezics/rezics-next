import type { DetailFailure } from './managed-account-contract';
import type { ManagedAccountActionsResult } from './managed-account-vocabulary';

export function detailFailure(status: number | null, body?: unknown, headers?: HeadersInit): DetailFailure {
  const code =
    body && typeof body === 'object' && 'code' in body && typeof body.code === 'string' ? body.code : undefined;
  const retryAfter = new Headers(headers).get('retry-after') ?? undefined;
  const retryable =
    body && typeof body === 'object' && 'retryable' in body && typeof body.retryable === 'boolean'
      ? body.retryable
      : undefined;
  const requestId =
    body && typeof body === 'object' && 'request_id' in body && typeof body.request_id === 'string'
      ? body.request_id
      : undefined;
  return {
    status,
    ...(code ? { code } : {}),
    ...(retryAfter ? { retryAfter } : {}),
    ...(retryable === undefined ? {} : { retryable }),
    ...(requestId ? { requestId } : {}),
    transient:
      (status === null || status === 408 || status === 429 || (status >= 500 && status <= 599)) &&
      code !== 'platform_closed' &&
      retryable !== false,
  };
}

export function managedActionFailure(
  status: number | null,
  body?: unknown,
  headers?: HeadersInit,
): Extract<ManagedAccountActionsResult, { state: 'denied' | 'unavailable' }> {
  const metadata = detailFailure(status, body, headers);
  return {
    state: status !== null && [401, 403, 404, 410].includes(status) ? 'denied' : 'unavailable',
    status,
    code: metadata.code ?? null,
    ...(metadata.retryAfter ? { retryAfter: metadata.retryAfter } : {}),
  };
}
