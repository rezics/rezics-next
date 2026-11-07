/** Pure Settings/Library vocabulary: visibility, occurrence, frontier and preference. */

export const collectionVisibilities = ['private', 'unlisted', 'public'] as const;
export type CollectionVisibility = (typeof collectionVisibilities)[number];

export type CollectionOccurrence = {
  id: string;
  revision: number | null;
};

export type CollectionOwnerWindow = {
  cursor: string | null;
  next: string | null;
  limit: 20;
};

export const COLLECTION_OWNER_WINDOW_LIMIT = 20;
export const SHELF_TYPE_WINDOW_LIMIT = 20;
export const SHELF_TYPE_PREDECESSOR_LIMIT = 8;

export type OwnedCollectionBuiltin =
  | { kind: 'everything' | 'liked' }
  | { kind: 'state'; profileId: string; stateSetId: string; stateId: string };

export type OwnedCollection = CollectionOccurrence & {
  title: string;
  kind: 'curated' | 'dynamic' | 'builtin';
  membershipKind: 'curated' | 'dynamic';
  builtinKind?: 'everything' | 'state' | 'liked';
  builtin?: OwnedCollectionBuiltin;
  visibility: CollectionVisibility;
  allowedVisibilityActions: CollectionVisibility[];
};

export type OwnedCollectionsPage = {
  collections: OwnedCollection[];
  next: string | null;
};

export const shelfLayouts = ['grid', 'list', 'table'] as const;
export type ShelfLayout = (typeof shelfLayouts)[number];

export const shelfColumnIds = [
  'cover',
  'title',
  'type',
  'status',
  'progress',
  'added',
  'finished',
  'lastActivity',
] as const;
export type PersonalShelfColumnId = (typeof shelfColumnIds)[number];

export const shelfPreferenceLayouts = ['grid', 'list', 'table'] as const;
export const shelfPreferenceTabs = ['in_progress', 'planned', 'completed', 'paused', 'dropped', 'all'] as const;
export const shelfPreferenceSortFields = [
  'last_activity',
  'added',
  'finished',
  'title',
  'rating',
  'release_date',
  'progress',
] as const;
export const shelfPreferenceColumns = [
  'cover',
  'title',
  'creator',
  'type',
  'status',
  'progress',
  'rating',
  'added',
  'started',
  'finished',
  'last_activity',
] as const;

export type ShelfPreferenceTab = (typeof shelfPreferenceTabs)[number];
export type ShelfPreferenceSort = {
  field: (typeof shelfPreferenceSortFields)[number];
  direction: 'asc' | 'desc';
};
export type ShelfPreferences = {
  layouts?: Record<string, (typeof shelfPreferenceLayouts)[number]>;
  sorts?: Partial<Record<ShelfPreferenceTab, ShelfPreferenceSort>>;
  gridSize?: 'small' | 'medium' | 'large';
  tableColumns?: (typeof shelfPreferenceColumns)[number][];
};
export type ShelfPreferencePatch = {
  layouts?: Record<string, (typeof shelfPreferenceLayouts)[number] | null> | null;
  sorts?: Partial<
    Record<
      ShelfPreferenceTab,
      { field?: ShelfPreferenceSort['field'] | null; direction?: ShelfPreferenceSort['direction'] | null } | null
    >
  > | null;
  gridSize?: ShelfPreferences['gridSize'] | null;
  tableColumns?: ShelfPreferences['tableColumns'] | null;
};

export type ShelfPreferenceSnapshot = {
  generation: string;
  accountId: string | null;
  csrfToken: string | null;
  shelf: ShelfPreferences | null;
};

export const SHELF_TYPES_LIMIT = SHELF_TYPE_WINDOW_LIMIT;
export type ShelfTypesView =
  | { state: 'loaded'; types: { type: string; label?: string }[]; next: string | null }
  | { state: 'signed-out' | 'denied' | 'closed' | 'preparing' | 'unavailable' };

export type ShelfTypesCurrentRead = {
  sessionSubject: string | null;
  authorizationAgrees: boolean;
  requested: { cursor: string | null; limit: typeof SHELF_TYPES_LIMIT; locale: string };
  page: ShelfTypesView;
};

export type ShelfTypeFrontierTarget = {
  cursor: string | undefined;
  movement: 'next' | 'previous' | 'first' | 'read';
};

/** Coordinates only. The owner retains the single current DTO and admits responses before commit. */
export class ShelfTypeWindowNavigation {
  private previous: (string | undefined)[] = [];
  private accepted = false;
  private coordinate: string | undefined;
  private target: ShelfTypeFrontierTarget | undefined;
  private pending = false;

  get hasPrevious() {
    return this.previous.length > 0;
  }
  get hasFirst() {
    return this.coordinate !== undefined || this.target?.cursor !== undefined;
  }

  stage(movement: 'next' | 'previous' | 'first' | 'read' | 'retry', next?: string) {
    if (this.pending) return undefined;
    if (movement === 'retry' && this.target) {
      this.pending = true;
      return this.target;
    }
    if (movement === 'previous' && !this.hasPrevious) return undefined;
    const cursor =
      movement === 'previous'
        ? this.previous.at(-1)
        : movement === 'first'
          ? undefined
          : movement === 'next'
            ? next
            : this.coordinate;
    this.target = { cursor, movement: movement === 'retry' ? 'read' : movement };
    this.pending = true;
    return this.target;
  }

  settle(admitted: boolean) {
    const target = this.target!;
    this.pending = false;
    if (!admitted) return;
    if (target.movement === 'first') this.previous = [];
    else if (target.movement === 'previous') this.previous.pop();
    else if (target.movement === 'next' && this.accepted) {
      this.previous.push(this.coordinate);
      this.previous = this.previous.slice(-SHELF_TYPE_PREDECESSOR_LIMIT);
    }
    this.coordinate = target.cursor;
    this.accepted = true;
    this.target = undefined;
  }
}
