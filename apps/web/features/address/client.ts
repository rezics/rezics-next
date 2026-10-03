import type { CanonicalAddress } from '@rezics/model/address';
import type { mainApiWithToken } from '../api/main.ts';
import { serviceOrigin } from '../api/origins.ts';
import type { AddressLookup } from './path.ts';

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
  | { kind: 'missing' | 'retired' | 'unavailable' };
export const ADDRESS_HEADER = 'x-rezics-resolved-address';
const nativeIri = /^https:\/\/rezics\.com\/id\/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;

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
): Promise<AddressRead> {
  try {
    const query = new URLSearchParams({
      scope: lookup.scope,
      key: lookup.key,
      ...(lookup.route ? { route: lookup.route } : {}),
    });
    const response = await fetch(
      `${origin ?? serviceOrigin('MAIN_ORIGIN')}/v1/addresses/resolve?${query}`,
      {
        headers: { 'accept-language': languages, 'x-rezics-display-languages': languages },
        cache: 'no-store',
        redirect: 'manual',
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (response.status === 404 || response.status === 400 || response.status === 422)
      return { kind: 'missing' };
    if (response.status === 410) return { kind: 'retired' };
    if (!response.ok) return { kind: 'unavailable' };
    const data = resolvedAddress(await response.json());
    return data?.scope === lookup.scope ? { kind: 'resolved', data } : { kind: 'unavailable' };
  } catch {
    return { kind: 'unavailable' };
  }
}
