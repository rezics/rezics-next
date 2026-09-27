/** A Realm or Zone as the navigation lists it. */
export interface Community {
  id: string;
  kind: 'realm' | 'zone';
  name: string;
  language: string;
  icon: { kind: 'fallback'; key: string } | { kind: 'image'; url: string } | null;
  /** A page path; locale-prefixed when rendered. */
  href: string;
  /** Activity since the reader last looked: a dot for `new`; `unknown` where Main does not say. */
  activity: 'new' | 'none' | 'unknown';
  count?: { value: number; kind: 'exact' | 'lower-bound' };
}

/** A Realm whose moderation queue the reader can open. */
export interface Moderated { realm: string; name: string; open: number; more: boolean }

export interface CommunityNavigation {
  signedIn: boolean;
  avatarQuery: string;
  /** Null signed out, or when Main could not list the follows. */
  followed: { realms: Community[]; zones: Community[] } | null;
  official: Community[];
  moderated: Moderated[];
}

/** How many of each list the navigation shows before "See all". */
export const NAV_COMMUNITIES = 8;
