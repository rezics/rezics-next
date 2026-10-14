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
