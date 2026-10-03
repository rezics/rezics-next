import type { CanonicalAddress } from '@rezics/model/address';
import type { mainApiWithToken } from '../api/main.ts';
import { serviceOrigin } from '../api/origins.ts';
import { mainReadHeaders } from '../api/main-read.ts';
import { parseAddressSegment, type AddressLookup } from './path.ts';

type MainClient = ReturnType<typeof mainApiWithToken>;
type AddressResponse = NonNullable<
  Awaited<ReturnType<MainClient['v1']['addresses']['resolve']['get']>>['data']
>;

/** Main owns the response; the adapter validates its address grammar before
 * using the same canonical shape that resource summaries carry. */
export type ResolvedAddress = Extract<AddressResponse, { profile: 'address-resolution-v1' }> & {
  scope: AddressLookup['scope'];
  canonical: CanonicalAddress;
};
export type AddressRead =
  | { kind: 'resolved'; data: ResolvedAddress }
  | { kind: 'missing' }
  | { kind: 'retired' }
  | { kind: 'unavailable'; status?: 429; retryAfter?: string };
export const ADDRESS_HEADER = 'x-rezics-resolved-address';
const nativeIri = /^https:\/\/rezics\.com\/id\/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;

export const ADDRESS_CACHE_LIMITS = {
  entries: 256,
  entryBytes: 16_384,
  keyLength: 4096,
  maxAgeSeconds: 30,
} as const;
interface CachedAddress {
  data: ResolvedAddress;
  headers: Headers;
  expiresAt: number;
}
const publicAddresses = new Map<string, CachedAddress>();
const cacheVary = new Set(['authorization', 'accept-language', 'x-rezics-display-languages']);

function cacheLifetime(headers: Headers, startedAt: number, receivedAt: number): number | null {
  const directives = new Map(
    (headers.get('cache-control') ?? '').split(',').map((value) => {
      const [name, argument] = value.trim().split('=');
      return [name!.toLowerCase(), argument?.replace(/^"|"$/g, '')];
    }),
  );
  if (!directives.has('public') || ['private', 'no-store'].some((name) => directives.has(name)))
    return null;
  if (
    (headers.get('vary') ?? '')
      .split(',')
      .some((value) => value.trim() && !cacheVary.has(value.trim().toLowerCase()))
  )
    return null;
  const etag = headers.get('etag');
  if (!etag || !/^(?:W\/)?"[^"\r\n]*"$/.test(etag)) return null;
  const seconds = directives.get('s-maxage') ?? directives.get('max-age');
  if (!seconds || !/^\d+$/.test(seconds)) return null;
  const age = headers.get('age');
  if (age !== null && !/^\d+$/.test(age)) return null;
  // RFC 9111 §4.2.3: upstream age and response delay consume freshness too.
  // Never serve a stale address during an outage or extend Main's rename age.
  const date = Date.parse(headers.get('date') ?? '');
  const initialAge = Math.max(
    Number.isFinite(date) ? receivedAt - date : 0,
    Number(age ?? 0) * 1000 + Math.max(0, receivedAt - startedAt),
  );
  const lifetime = directives.has('no-cache')
    ? 0
    : Math.min(Number(seconds), ADDRESS_CACHE_LIMITS.maxAgeSeconds) * 1000;
  return Math.max(0, lifetime - initialAge);
}

function rememberAddress(
  key: string,
  data: ResolvedAddress,
  headers: Headers,
  startedAt: number,
): void {
  publicAddresses.delete(key);
  const receivedAt = Date.now();
  const lifetime = cacheLifetime(headers, startedAt, receivedAt);
  if (
    lifetime === null ||
    key.length > ADDRESS_CACHE_LIMITS.keyLength ||
    new TextEncoder().encode(JSON.stringify(data)).byteLength > ADDRESS_CACHE_LIMITS.entryBytes
  )
    return;
  publicAddresses.set(key, {
    data: structuredClone(data),
    headers,
    expiresAt: receivedAt + lifetime,
  });
  if (publicAddresses.size > ADDRESS_CACHE_LIMITS.entries)
    publicAddresses.delete(publicAddresses.keys().next().value!);
}

export function resolvedAddress(value: unknown): ResolvedAddress | null {
  if (!value || typeof value !== 'object') return null;
  const data = value as ResolvedAddress;
  const address = data.canonical;
  if (
    data.profile !== 'address-resolution-v1' ||
    data.status !== 'resolved' ||
    typeof data.scope !== 'string' ||
    !/^(?:agent|space|work|resource|concept|zone:https:\/\/rezics\.com\/id\/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/.test(
      data.scope,
    ) ||
    typeof data.key !== 'string' ||
    !['current', 'redirect'].includes(data.state) ||
    !nativeIri.test(data.holder) ||
    !address ||
    typeof address.key !== 'string' ||
    // A UUID is a legacy lookup, never a canonical policy. Refuse a malformed
    // Main answer instead of permanently redirecting to a lowercase UUID.
    !parseAddressSegment(address.key) ||
    parseAddressSegment(address.key)?.kind === 'uuid' ||
    typeof address.slugSource !== 'string' ||
    !/^\/(?:@|(?:a|r|z|w|e|concepts)\/|z\/[^/]+\/[^/]+\/)$/.test(address.prefix) ||
    (data.capabilities &&
      Object.values(data.capabilities).some(
        (value) => typeof value !== 'string' || !nativeIri.test(value),
      ))
  )
    return null;
  return data;
}

/** Anonymous, deterministic resolution: no cookie, bearer or private preference goes to Main. */
export async function readAddress(
  lookup: AddressLookup,
  languages: string,
  origin?: string,
  incoming?: Headers,
): Promise<AddressRead> {
  try {
    const query = new URLSearchParams({
      scope: lookup.scope,
      key: lookup.key,
      ...(lookup.route ? { route: lookup.route } : {}),
    });
    const url = `${origin ?? serviceOrigin('MAIN_ORIGIN')}/v1/addresses/resolve?${query}`;
    // Anonymous responses vary only by the lookup and public language request,
    // never by the ingress IP, session cookie or private preferences.
    const cacheKey = JSON.stringify([url, languages]);
    const cached = publicAddresses.get(cacheKey);
    if (cached && Date.now() < cached.expiresAt) {
      publicAddresses.delete(cacheKey);
      publicAddresses.set(cacheKey, cached);
      return { kind: 'resolved', data: structuredClone(cached.data) };
    }
    const headers = await mainReadHeaders(
      { 'accept-language': languages, 'x-rezics-display-languages': languages },
      incoming,
    );
    if (cached) headers.set('if-none-match', cached.headers.get('etag')!);
    const startedAt = Date.now();
    const response = await fetch(url, {
      headers,
      cache: 'no-store',
      redirect: 'manual',
      signal: AbortSignal.timeout(10_000),
    });
    // Any fresh non-hit invalidates the old hit, including a permission change
    // or outage. Expired data may supply a validator but is never a fallback.
    publicAddresses.delete(cacheKey);
    if (response.status === 304) {
      if (!cached) return { kind: 'unavailable' };
      const refreshed = new Headers(cached.headers);
      response.headers.forEach((value, name) => refreshed.set(name, value));
      if (!response.headers.has('date')) refreshed.delete('date');
      if (!response.headers.has('age')) refreshed.delete('age');
      rememberAddress(cacheKey, cached.data, refreshed, startedAt);
      return { kind: 'resolved', data: structuredClone(cached.data) };
    }
    if (response.status === 404 || response.status === 400 || response.status === 422)
      return { kind: 'missing' };
    if (response.status === 410) return { kind: 'retired' };
    if (response.status === 429) {
      const seconds = Number(response.headers.get('retry-after'));
      return {
        kind: 'unavailable',
        status: 429,
        retryAfter: String(Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds) : 60),
      };
    }
    if (!response.ok) return { kind: 'unavailable' };
    const data = resolvedAddress(await response.json());
    if (data?.scope !== lookup.scope) return { kind: 'unavailable' };
    if (data.key === lookup.key) rememberAddress(cacheKey, data, response.headers, startedAt);
    return { kind: 'resolved', data };
  } catch {
    return { kind: 'unavailable' };
  }
}
