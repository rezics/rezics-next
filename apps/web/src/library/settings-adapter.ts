import { readLibraryResult } from './reads';
import { dynamicCollectionTitle } from './dynamic-collection';
import { shelfColumnLabel } from './shelf-column-label';
import { libraryShelfType, shelfHref } from './shelf-params';
import {
  libraryOrderFromShelf,
  shelfOrderFromLibrary,
  unsupportedShelfColumns,
  unsupportedShelfSorts,
} from './shelf-preferences';
import { readShelfTypesCurrent } from './shelf-types-read';
import {
  SHELF_TYPES_LIMIT,
  ShelfTypeWindowNavigation,
  type PersonalShelfColumnId,
  type ShelfTypesCurrentRead,
} from './settings-contract';

export {
  COLLECTION_OWNER_WINDOW_LIMIT,
  SHELF_TYPE_PREDECESSOR_LIMIT,
  SHELF_TYPE_WINDOW_LIMIT,
  SHELF_TYPES_LIMIT,
  collectionVisibilities,
  shelfColumnIds,
  shelfLayouts,
  shelfPreferenceColumns,
  shelfPreferenceLayouts,
  shelfPreferenceSortFields,
  shelfPreferenceTabs,
  ShelfTypeWindowNavigation,
  type CollectionOccurrence,
  type CollectionOwnerWindow,
  type CollectionVisibility,
  type OwnedCollection,
  type OwnedCollectionsPage,
  type PersonalShelfColumnId,
  type ShelfLayout,
  type ShelfPreferencePatch,
  type ShelfPreferenceSnapshot,
  type ShelfPreferenceSort,
  type ShelfPreferenceTab,
  type ShelfPreferences,
  type ShelfTypeFrontierTarget,
  type ShelfTypesCurrentRead,
  type ShelfTypesView,
} from './settings-contract';

export {
  readLibraryResult,
  dynamicCollectionTitle,
  shelfColumnLabel,
  libraryShelfType,
  shelfHref,
  libraryOrderFromShelf,
  shelfOrderFromLibrary,
  unsupportedShelfColumns,
  unsupportedShelfSorts,
  readShelfTypesCurrent,
};

export function createShelfTypeWindowNavigation() {
  return new ShelfTypeWindowNavigation();
}

export async function readShelfTypeOwnerWindow(cursor?: string): Promise<ShelfTypesCurrentRead> {
  return readShelfTypesCurrent({ data: cursor ? { cursor } : {} });
}

export type SettingsLibraryTransport = {
  readLibraryResult: typeof readLibraryResult;
  collectionTitle: typeof dynamicCollectionTitle;
  shelfColumnLabel: (id: PersonalShelfColumnId) => string;
  libraryShelfType: typeof libraryShelfType;
  shelfHref: typeof shelfHref;
  libraryOrderFromShelf: typeof libraryOrderFromShelf;
  shelfOrderFromLibrary: typeof shelfOrderFromLibrary;
  unsupportedShelfColumns: typeof unsupportedShelfColumns;
  unsupportedShelfSorts: typeof unsupportedShelfSorts;
  readShelfTypes: (cursor?: string) => Promise<ShelfTypesCurrentRead>;
  createTypeFrontier: () => ShelfTypeWindowNavigation;
  typeWindowLimit: typeof SHELF_TYPES_LIMIT;
};

export function settingsLibraryTransport(): SettingsLibraryTransport {
  return {
    readLibraryResult,
    collectionTitle: dynamicCollectionTitle,
    shelfColumnLabel,
    libraryShelfType,
    shelfHref,
    libraryOrderFromShelf,
    shelfOrderFromLibrary,
    unsupportedShelfColumns,
    unsupportedShelfSorts,
    readShelfTypes: readShelfTypeOwnerWindow,
    createTypeFrontier: createShelfTypeWindowNavigation,
    typeWindowLimit: SHELF_TYPES_LIMIT,
  };
}
