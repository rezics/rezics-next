/** A Realm or Zone as the navigation lists it. */
export interface Community {
  id: string;
  kind: 'realm' | 'zone';
  /** The Realm itself, or the one behind a Zone, when known: following either follows the same community. */
  realm?: string;
  name: string;
  language: string;
  direction?: 'ltr' | 'rtl';
  icon: { kind: 'fallback'; key: string } | { kind: 'image'; url: string } | null;
  /** A page path; locale-prefixed when rendered. */
  href: string;
  /** Activity since the reader last looked: a dot for `new`; `unknown` where Main does not say. */
  activity: 'new' | 'none' | 'unknown';
  count?: { value: number; kind: 'exact' | 'lower-bound' };
}

/**
 * A Realm the reader manages (Main's `GET /v1/me/managed-realms`), with its
 * open queue. `href` opens it in Manage, by its Zone's address when it has one.
 */
export interface Managed { realm: string; open: number; more: boolean; href: string }
/** A managed Realm with its name, for lists that show it. */
export interface Moderated extends Managed { name: string; language?: string }

export interface CommunityNavigation {
  signedIn: boolean;
  avatarQuery: string;
  /** Null signed out, or when Main could not list the follows. */
  followed: { realms: Community[]; zones: Community[] } | null;
  official: Community[];
  moderated: Managed[];
}

/** How many of each list the navigation shows before "See all". */
export const NAV_COMMUNITIES = 8;

/** The Realm a community stands for: a followed Zone counts as following its Realm. */
export const realmOf = (community: Community): string | undefined =>
  community.realm ?? (community.kind === 'realm' ? community.id : undefined);

/** Every Realm the reader follows, directly or through its Zone. */
export function followedRealmIds(followed: { realms: readonly Community[]; zones: readonly Community[] }): string[] {
  return [...new Set([...followed.realms, ...followed.zones].map(realmOf).filter(id => id !== undefined))];
}

/** A Realm's address segment: its official Zone's (`fiction`) when it has one, as `/r/…` uses, else its UUID. */
export function realmSegment(realm: string, official: readonly Community[]): string {
  const zone = official.find(item => item.realm === realm);
  return zone ? zone.href.replace(/^\/r\//, '') : realm.slice(-36);
}

/** Each official Zone's Realm with its route segment, for links that should read `/r/fiction`. */
export function segmentsOf(official: readonly Community[]): Record<string, string> {
  return Object.fromEntries(official.flatMap(zone => zone.realm ? [[zone.realm, realmSegment(zone.realm, official)]] : []));
}

/** Where Manage opens: the one Realm the reader manages directly, or the list of them. */
export function manageHref(moderated: readonly Pick<Moderated, 'href'>[]): string {
  return moderated.length === 1 ? moderated[0]!.href : '/manage';
}
