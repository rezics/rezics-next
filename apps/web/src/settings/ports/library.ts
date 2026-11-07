import type { SettingsLibraryTransport } from '../../library/settings-adapter';
import type {
  CollectionVisibility,
  OwnedCollection,
  OwnedCollectionsPage,
  PersonalShelfColumnId,
  ShelfLayout,
  ShelfPreferenceSort,
  ShelfPreferenceTab,
  ShelfPreferences,
  ShelfTypesCurrentRead,
  ShelfTypesView,
  ShelfTypeWindowNavigation,
} from '../../library/settings-contract';

export {
  COLLECTION_OWNER_WINDOW_LIMIT,
  SHELF_TYPE_PREDECESSOR_LIMIT,
  SHELF_TYPES_LIMIT,
  collectionVisibilities,
  shelfColumnIds,
  shelfLayouts,
  shelfPreferenceColumns,
  shelfPreferenceLayouts,
  shelfPreferenceSortFields,
  shelfPreferenceTabs,
} from '../../library/settings-contract';

export type {
  CollectionOccurrence,
  CollectionOwnerWindow,
  CollectionVisibility,
  OwnedCollection,
  OwnedCollectionBuiltin,
  OwnedCollectionsPage,
  PersonalShelfColumnId,
  ShelfLayout,
  ShelfPreferencePatch,
  ShelfPreferenceSnapshot,
  ShelfPreferenceSort,
  ShelfPreferenceTab,
  ShelfPreferences,
  ShelfTypeFrontierTarget,
  ShelfTypesCurrentRead,
  ShelfTypesView,
} from '../../library/settings-contract';

export type VisibilityAttempt = Readonly<{
  collectionId: string;
  revision: number;
  visibility: CollectionVisibility;
  idempotencyKey: string;
}>;

export type CollectionCommandFailure = {
  status: number | null;
  code?: string;
  retryable?: boolean;
  requestId?: string;
  retryAfter?: string;
};

export type CollectionVisibilityWrite =
  | { ok: true; collection: OwnedCollection }
  | {
      ok: false;
      reason: 'closed' | 'conflict' | 'forbidden' | 'invalid' | 'unavailable';
      failure?: CollectionCommandFailure;
    };

export type CollectionPrivacyFailure = 'closed' | 'forbidden' | 'unavailable';
export type CollectionPrivacyRead<T> =
  | { ok: true; value: T }
  | { ok: false; reason: CollectionPrivacyFailure; failure?: CollectionCommandFailure };

export type CollectionPrivacyCommandPort = {
  save: (input: VisibilityAttempt) => Promise<CollectionVisibilityWrite>;
  read: (id: string) => Promise<CollectionPrivacyRead<OwnedCollection>>;
};

export type CollectionPrivacyWindowPort = (
  cursor: string | null,
) => Promise<CollectionPrivacyRead<OwnedCollectionsPage>>;

export type ShelfTypeReadPort = (cursor?: string) => Promise<ShelfTypesCurrentRead>;
export type ShelfTypeFrontierPort = () => ShelfTypeWindowNavigation;
export type ShelfColumnLabelPort = (id: PersonalShelfColumnId) => string;
export type ShelfHrefPort = (locale: string, view: { type: string; layout?: ShelfLayout }) => string;
export type ShelfOrderPort = {
  fromPreference: (sort: ShelfPreferenceSort | undefined) =>
    | {
        orderBy: 'lastActivity' | 'createdAt' | 'finishedAt' | 'title' | 'personalScore' | 'priority';
        direction: 'asc' | 'desc';
      }
    | undefined;
  toPreference: (sort: {
    orderBy: 'lastActivity' | 'createdAt' | 'finishedAt' | 'title' | 'personalScore' | 'priority';
    direction: 'asc' | 'desc';
  }) => ShelfPreferenceSort;
  unsupportedColumns: (shelf: ShelfPreferences) => string[];
  unsupportedSorts: (shelf: ShelfPreferences) => Array<{ tab: ShelfPreferenceTab; field: string }>;
};

/** Narrow Settings consumer of private Collection owner window, privacy command/readback and Shelf preferences. */
export type SettingsLibraryPort = {
  collectionTitle: SettingsLibraryTransport['collectionTitle'];
  readLibraryResult: SettingsLibraryTransport['readLibraryResult'];
  privacy: {
    save: CollectionPrivacyCommandPort['save'];
    read: CollectionPrivacyCommandPort['read'];
    ownerWindow: CollectionPrivacyWindowPort;
  };
  shelf: {
    columnIds: readonly PersonalShelfColumnId[];
    columnLabel: ShelfColumnLabelPort;
    libraryShelfType: (value: unknown) => string | undefined;
    href: ShelfHrefPort;
    order: ShelfOrderPort;
    readTypes: ShelfTypeReadPort;
    createTypeFrontier: ShelfTypeFrontierPort;
    typeWindowLimit: number;
  };
};

export type SettingsLibraryShelfTypes = ShelfTypesView;
