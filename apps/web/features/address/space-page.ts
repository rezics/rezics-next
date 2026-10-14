import type { ResolvedAddress } from './client.ts';
import { parseAddressSegment } from './path.ts';
import type { Discovery, JoinPage } from '../manage/settings-api.ts';
import type { RealmHeader } from '../realm/types.ts';

/** Private pages also suppress referrers when Main's older policy omits it. */
export function privateDiscovery(discovery?: Discovery): Discovery {
  return { ...discovery, indexable: false, robots: 'noindex', referrerPolicy: 'no-referrer' };
}

/** What a Realm address read resolves to: the Realm, its request landing, or neither. */
export type ClassifiedSpacePage =
  | { kind: 'realm'; header: RealmHeader }
  | { kind: 'join'; page: JoinPage }
  | { kind: 'missing' | 'unavailable' };

/**
 * The community route's decision after the Realm header and, when that header
 * is denied, the limited join page. Callers fetch; this only classifies, so the
 * route and a recorded page cannot disagree about which answer is shown.
 */
export function classifyRealmSpacePage(realm: string, header: { ok: boolean; status: number; body: unknown },
  landing: { ok: boolean; status: number; body: unknown } | null): ClassifiedSpacePage {
  if (header.ok) {
    const data = header.body as RealmHeader | null;
    return data?.profile === 'realm-read-v1' && data.id === `https://rezics.com/id/${realm}`
      ? { kind: 'realm', header: data }
      : { kind: 'unavailable' };
  }
  if (![401, 403, 404].includes(header.status) || !landing) return { kind: 'unavailable' };
  if ([401, 403, 404].includes(landing.status)) return { kind: 'missing' };
  if (!landing.ok) return { kind: 'unavailable' };
  const page = landing.body as JoinPage | null;
  return page?.profile === 'realm-join-page-v1' && page.id === `https://rezics.com/id/${realm}` && page.action?.kind === 'request'
    ? { kind: 'join', page }
    : { kind: 'unavailable' };
}

/** The private header and bounded request landing, shared by host reads and story transports. */
export async function readRealmSpacePage(key: string, options: {
  address?: ResolvedAddress; token?: string; actingSubject?: string; throwReadErrors?: boolean;
}, read: (path: string, personal?: boolean) => Promise<Response>): Promise<ClassifiedSpacePage> {
  try {
    let realm = options.address?.capabilities?.realm?.slice(-36);
    if (options.address && !realm) return { kind: 'missing' };
    if (!realm) {
      const parsed = parseAddressSegment(key);
      // The merged API has one alias resolver and no per-Realm handle lookup.
      // A denied alias cannot be mapped to a Realm through a second resolver.
      if (!parsed || parsed.kind === 'alias') return { kind: 'missing' };
      realm = parsed.id;
    }
    const query =
      options.token && options.actingSubject
        ? `?${new URLSearchParams({ actingSubject: options.actingSubject })}`
        : '';
    const header = await read(`/v1/realms/${realm}${query}`, Boolean(query));
    const headerBody = header.ok ? await header.json() : null;
    const denied = !header.ok && [401, 403, 404].includes(header.status);
    const landing = denied ? await read(`/v1/realms/${realm}/join-page`) : null;
    const landingBody = landing?.ok ? await landing.json() : null;
    return classifyRealmSpacePage(realm, { ok: header.ok, status: header.status, body: headerBody },
      landing ? { ok: landing.ok, status: landing.status, body: landingBody } : null);
  } catch (error) {
    if (options.throwReadErrors) throw error;
    if (error instanceof Error && /Unmatched recorded request|Expected one recorded sample/.test(error.message)) throw error;
    return { kind: 'unavailable' };
  }
}
