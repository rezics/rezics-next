import { serviceOrigin } from '../api/origins.ts';
import { seedTypes, type TypeRegistry } from './types.ts';

// Main answers `GET /v1/types` with a one-digest ETag and `max-age=300`; the web holds the last
// body and revalidates with `If-None-Match`, so a stale registry costs one empty 304.
interface Served { registry: TypeRegistry; tag: string | null; checkedAt: number; ttl: number }
let served: Served | null = null;
let inflight: Promise<TypeRegistry | null> | null = null;
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

async function revalidate(fetcher: typeof fetch, now: () => number): Promise<TypeRegistry | null> {
  try {
    const response = await fetcher(`${serviceOrigin('MAIN_ORIGIN')}/v1/types`, { cache: 'no-store',
      signal: AbortSignal.timeout(5000), headers: served?.tag ? { 'if-none-match': served.tag } : {} });
    if (response.status === 304 && served) {
      served = { ...served, checkedAt: now(), ttl: ttlOf(response.headers.get('cache-control')) };
      return served.registry;
    }
    if (!response.ok) return keep(now);
    const registry = await response.json() as TypeRegistry;
    served = { registry, tag: response.headers.get('etag'), checkedAt: now(),
      ttl: ttlOf(response.headers.get('cache-control')) };
    failedAt = null;
    seedTypes(registry);
    return registry;
  } catch { return keep(now); }
}

/**
 * The served registry, read once per Main's cache lifetime and revalidated by
 * ETag after it. One in-flight read is shared; when Main cannot answer, the
 * last registry stays in use. Call it before rendering anything that looks up a type.
 */
export async function readTypes(fetcher: typeof fetch = fetch, now: () => number = Date.now):
  Promise<TypeRegistry | null> {
  if (served && now() - served.checkedAt < served.ttl) { seedTypes(served.registry); return served.registry; }
  if (!served && failedAt !== null && now() - failedAt < RETRY_MS) return null;
  inflight ??= revalidate(fetcher, now).finally(() => { inflight = null; });
  return inflight;
}

/** Forgets the held body and its ETag, for tests that start from an unread registry. */
export function forgetServedTypes(): void {
  served = null;
  inflight = null;
  failedAt = null;
}
