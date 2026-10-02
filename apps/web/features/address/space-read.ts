import type { Discovery, JoinPage } from '../manage/settings-api.ts';
import type { RealmHeader } from '../realm/types.ts';
import { serviceOrigin } from '../api/origins.ts';
import type { ResolvedAddress } from './client.ts';
import { parseAddressSegment } from './path.ts';

export type SpacePage =
  | { kind: 'realm'; header: RealmHeader }
  | { kind: 'join'; page: JoinPage }
  | { kind: 'missing' | 'unavailable' };

/** Main's limited landing read is the only exception to a denied header.
 * Legacy Realm identities/handles remain usable until the address resolver
 * admits private Space identities and returns their capability mapping. */
export async function readSpacePage(
  key: string,
  languages: string,
  options: {
    address?: ResolvedAddress;
    token?: string;
    actingSubject?: string;
    origin?: string;
  } = {},
): Promise<SpacePage> {
  const origin = options.origin ?? serviceOrigin('MAIN_ORIGIN');
  const headers = { 'accept-language': languages, 'x-rezics-display-languages': languages };
  const read = (path: string, personal = false) =>
    fetch(`${origin}${path}`, {
      headers: {
        ...headers,
        ...(personal && options.token ? { authorization: `Bearer ${options.token}` } : {}),
      },
      redirect: 'manual',
      cache: 'no-store',
      signal: AbortSignal.timeout(10_000),
    });
  try {
    let realm = options.address?.capabilities?.realm?.slice(-36);
    if (options.address && !realm) return { kind: 'missing' };
    if (!realm) {
      const parsed = parseAddressSegment(key);
      if (!parsed) return { kind: 'missing' };
      if (parsed.kind !== 'name') realm = parsed.id;
      else {
        const named = await read(`/v1/realms/by-handle/${encodeURIComponent(parsed.key)}`);
        if ([400, 404, 422].includes(named.status)) return { kind: 'missing' };
        if (!named.ok) return { kind: 'unavailable' };
        const data = (await named.json()) as { realm: string };
        const identity = parseAddressSegment(data.realm?.slice(-36));
        if (!identity || identity.kind === 'name') return { kind: 'unavailable' };
        realm = identity.id;
      }
    }
    const query =
      options.token && options.actingSubject
        ? `?${new URLSearchParams({ actingSubject: options.actingSubject })}`
        : '';
    const header = await read(`/v1/realms/${realm}${query}`, Boolean(query));
    if (header.ok) {
      const data = (await header.json()) as RealmHeader;
      return data.profile === 'realm-read-v1' && data.id === `https://rezics.com/id/${realm}`
        ? { kind: 'realm', header: data }
        : { kind: 'unavailable' };
    }
    if (![401, 403, 404].includes(header.status)) return { kind: 'unavailable' };
    const landing = await read(`/v1/realms/${realm}/join-page`);
    if ([401, 403, 404].includes(landing.status)) return { kind: 'missing' };
    if (!landing.ok) return { kind: 'unavailable' };
    const page = (await landing.json()) as JoinPage;
    return page.profile === 'realm-join-page-v1' &&
      page.id === `https://rezics.com/id/${realm}` &&
      page.action.kind === 'request'
      ? { kind: 'join', page }
      : { kind: 'unavailable' };
  } catch {
    return { kind: 'unavailable' };
  }
}

/** Private pages also suppress referrers when Main's older policy omits it. */
export function privateDiscovery(discovery?: Discovery): Discovery {
  return { ...discovery, indexable: false, robots: 'noindex', referrerPolicy: 'no-referrer' };
}

export function realmDiscovery(
  header: Pick<RealmHeader, 'visibility' | 'listing' | 'discovery'>,
): Discovery | null {
  return header.visibility === 'private' || header.listing === 'unlisted'
    ? privateDiscovery(header.discovery)
    : (header.discovery ?? null);
}
