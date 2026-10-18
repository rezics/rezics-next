import { headers } from 'next/headers';
import { AsyncLocalStorage } from 'node:async_hooks';
import { serverFetch, deadlineFromHeaders, SERVER_READ_LIMITS, type ServerFetchOptions } from './server-fetch.ts';

const requestBoundary = new AsyncLocalStorage<{ signal?: AbortSignal; deadlineAt?: number; detached?: true }>();

/** Enter before normalization, refresh and admission; async page work inherits the same boundary. */
export function withServerRequest<T>(request: Request, run: () => T): T {
  if (requestBoundary.getStore()) return run();
  const transfer = new URL(request.url).pathname.startsWith('/api/main/v1/media/');
  return requestBoundary.run({ signal: request.signal,
    deadlineAt: Date.now() + (transfer ? SERVER_READ_LIMITS.transfer : SERVER_READ_LIMITS.page) }, run);
}

export function serverSignal(): AbortSignal | undefined { return requestBoundary.getStore()?.signal; }

/** Shared registry reads and token rotations own their explicit budget. Neither
 * this boundary nor the framework header fallback may attach a later waiter. */
export function withoutServerRequest<T>(run: () => T): T { return requestBoundary.run({ detached: true }, run); }

/** Proxy overwrites this internal header; a browser cannot extend its budget. */
export async function serverDeadline(incoming?: Headers): Promise<number | undefined> {
  const context = requestBoundary.getStore();
  if (context?.detached) return undefined;
  const boundary = context?.deadlineAt;
  try {
    const forwarded = deadlineFromHeaders(incoming ?? (await headers()));
    return boundary === undefined ? forwarded : Math.min(boundary, forwarded ?? Infinity);
  } catch {
    return boundary;
  } // CLI/test callers have no render context.
}

export async function serverRead(
  input: RequestInfo | URL,
  init?: RequestInit,
  options: ServerFetchOptions = {},
): Promise<Response> {
  const caller = init?.signal ?? (input instanceof Request ? input.signal : undefined);
  const boundary = serverSignal();
  const deadlineAt = Math.min(options.deadlineAt ?? Infinity, (await serverDeadline()) ?? Infinity);
  return serverFetch(input, { ...init,
    signal: caller && boundary ? AbortSignal.any([caller, boundary]) : caller ?? boundary }, {
    ...options,
    forwardDeadline: true,
    deadlineAt: Number.isFinite(deadlineAt) ? deadlineAt : undefined,
  });
}
