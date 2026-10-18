import { serviceOrigin } from '../api/origins.ts';
import { mainReadHeaders } from '../api/main-read.ts';
import { serverRead, serverDeadline, serverSignal, withoutServerRequest } from '../api/server-read.ts';
import { SERVER_READ_LIMITS, waitForServerRead } from '../api/server-fetch.ts';
import { seedTypes, type TypeRegistry } from './types.ts';

// Main answers `GET /v1/types` with a one-digest ETag and `max-age=300`; the web holds the last
// body and revalidates with `If-None-Match`, so a stale registry costs one empty 304.
interface Served {
  registry: TypeRegistry;
  tag: string | null;
  checkedAt: number;
  ttl: number;
}
let served: Served | null = null;
interface RegistryRead {
  result: Promise<TypeRegistry | null>;
  controller: AbortController;
  waiters: number;
  settled: boolean;
}
let inflight: RegistryRead | null = null;
/** When the last read failed with nothing held, so the next renders do not each wait on a down Main. */
let failedAt: number | null = null;
const DEFAULT_TTL_MS = 300_000;
const RETRY_MS = 10_000;

function ttlOf(header: string | null): number {
  const seconds = /max-age=(\d+)/.exec(header ?? '')?.[1];
  return seconds === undefined ? DEFAULT_TTL_MS : Number(seconds) * 1000;
}

/** Main could not answer: keep the last registry and look again shortly, rather than on every render. */
function keep(now: () => number): TypeRegistry | null {
  if (!served) failedAt = now();
  if (served) served = { ...served, checkedAt: now(), ttl: RETRY_MS };
  return served?.registry ?? null;
}

async function revalidate(
  fetcher: typeof fetch,
  now: () => number,
  signal: AbortSignal,
  deadlineAt?: number,
): Promise<TypeRegistry | null> {
  try {
    const response = await serverRead(
      `${serviceOrigin('MAIN_ORIGIN')}/v1/types`,
      {
        cache: 'no-store',
        signal,
        headers: await mainReadHeaders(served?.tag ? { 'if-none-match': served.tag } : {}),
      },
      { fetch: fetcher, timeoutMs: SERVER_READ_LIMITS.metadata, deadlineAt },
    );
    if (signal.aborted) return served?.registry ?? null;
    if (response.status === 304 && served) {
      served = { ...served, checkedAt: now(), ttl: ttlOf(response.headers.get('cache-control')) };
      return served.registry;
    }
    if (!response.ok) return keep(now);
    const registry = (await response.json()) as TypeRegistry;
    served = {
      registry,
      tag: response.headers.get('etag'),
      checkedAt: now(),
      ttl: ttlOf(response.headers.get('cache-control')),
    };
    failedAt = null;
    seedTypes(registry);
    return registry;
  } catch {
    // A departing last waiter says nothing about Main's health. The next
    // request must be able to start a fresh read immediately.
    return signal.aborted ? served?.registry ?? null : keep(now);
  }
}

async function waitForTypes(owner: RegistryRead, deadline: number | undefined | Promise<number | undefined>,
  signal?: AbortSignal): Promise<TypeRegistry | null> {
  owner.waiters++;
  try { return await waitForServerRead(owner.result, await deadline, signal); }
  catch { return served?.registry ?? null; }
  finally {
    owner.waiters--;
    if (!owner.settled && owner.waiters === 0) {
      if (inflight === owner) inflight = null;
      owner.controller.abort(new DOMException('Registry read has no remaining waiters', 'AbortError'));
    }
  }
}

/**
 * The served registry, read once per Main's cache lifetime and revalidated by
 * ETag after it. One in-flight read is shared; when Main cannot answer, the
 * last registry stays in use. Call it before rendering anything that looks up a type.
 */
export async function readTypes(
  fetcher: typeof fetch = fetch,
  now: () => number = Date.now,
): Promise<TypeRegistry | null> {
  if (served && now() - served.checkedAt < served.ttl) {
    seedTypes(served.registry);
    return served.registry;
  }
  if (!served && failedAt !== null && now() - failedAt < RETRY_MS) return null;
  // Reserve a joined waiter before yielding to the framework deadline lookup.
  // A departing request must not cancel a reader that has already joined.
  if (inflight) return waitForTypes(inflight, serverDeadline(), serverSignal());
  const deadlineAt = await serverDeadline();
  if (serverSignal()?.aborted) return served?.registry ?? null;
  if (!inflight) {
    const controller = new AbortController();
    const owner: RegistryRead = { controller, waiters: 0, settled: false,
      result: withoutServerRequest(() => revalidate(fetcher, now, controller.signal, deadlineAt)).finally(() => {
        owner.settled = true;
        if (inflight === owner) inflight = null;
      }),
    };
    inflight = owner;
    // The owner enforces the first request's deadline. A competing waiter
    // timer must not return before the owner evicts a failed read.
    return waitForTypes(owner, undefined, serverSignal());
  }
  return waitForTypes(inflight, deadlineAt, serverSignal());
}

/** Forgets the held body and its ETag, for tests that start from an unread registry. */
export function forgetServedTypes(): void {
  inflight?.controller.abort();
  served = null;
  inflight = null;
  failedAt = null;
}
