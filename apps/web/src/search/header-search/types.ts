export type SearchScopeKind = 'Library' | 'Collection' | 'Realm' | 'Zone' | 'Agent';

/** A removable context label; a scoped route must be provided before submitting within it. */
export type SearchScope = {
  kind: SearchScopeKind;
  id: string;
  name: string;
  image?: string;
  /** Localized route that already enforces this scope. Without it, scoped submission stays unavailable. */
  searchAction?: string;
};
