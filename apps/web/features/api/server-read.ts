import { headers } from 'next/headers';
import { AsyncLocalStorage } from 'node:async_hooks';
import { serverFetch, deadlineFromHeaders, SERVER_READ_LIMITS, waitForServerRead, type ServerFetchOptions } from './server-fetch.ts';

const requestBoundary = new AsyncLocalStorage<{
  signal?: AbortSignal; deadlineAt?: number; detached?: true; documentStatus?: number;
}>();

/** Enter before normalization, refresh and admission; async page work inherits the same boundary. */
export function withServerRequest<T>(request: Request, run: () => T): T {
  if (requestBoundary.getStore()) return run();
  const transfer = new URL(request.url).pathname.startsWith('/api/main/v1/media/');
  return requestBoundary.run({ signal: request.signal,
    deadlineAt: Date.now() + (transfer ? SERVER_READ_LIMITS.transfer : SERVER_READ_LIMITS.page) }, run);
}

export function serverSignal(): AbortSignal | undefined { return requestBoundary.getStore()?.signal; }

/** A whole-page read failure must determine the initial document's status even
 * when React has already produced its loading shell. Region reads do not set it. */
export function setServerDocumentStatus(status: number): void {
  const boundary = requestBoundary.getStore();
  if (boundary && !boundary.detached) boundary.documentStatus = status;
}

/** The resource document's authority and member-name reads finish after its
 * loading shell. Hold those headers until render completes, within the same
 * request budget. RSC navigation and other streaming responses stay streaming. */
export async function serverDocumentResponse(request: Request, response: Response): Promise<Response> {
  const boundary = requestBoundary.getStore();
  if (!boundary || boundary.detached || request.method !== 'GET' ||
    !response.headers.get('content-type')?.startsWith('text/html')) return response;
  const reader = response.body?.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    boundary.signal?.throwIfAborted();
    if (reader) while (true) {
      const chunk = await waitForServerRead(reader.read(), boundary.deadlineAt, boundary.signal);
      if (chunk.done) break;
      chunks.push(chunk.value);
      length += chunk.value.byteLength;
    }
  } catch (error) {
    void reader?.cancel(error).catch(() => {});
    throw error;
  } finally { reader?.releaseLock(); }
  const status = boundary.documentStatus ?? response.status;
  const headers = new Headers(response.headers);
  if (boundary.documentStatus !== undefined) {
    headers.set('cache-control', 'no-store');
    if (status === 503 || status === 429) headers.set('retry-after', headers.get('retry-after') ?? '5');
  }
  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  return new Response(response.body ? body : null, { status, headers,
    ...(status === response.status ? { statusText: response.statusText } : {}) });
}

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
