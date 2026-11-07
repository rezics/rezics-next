import {
  createShelfTypeWindowNavigation,
  readShelfTypeOwnerWindow,
  settingsLibraryTransport,
  shelfColumnIds,
  SHELF_TYPES_LIMIT,
  type SettingsLibraryTransport,
} from '../../library/settings-adapter';
import type { SettingsLibraryPort, ShelfTypeReadPort } from '../ports/library';

export {
  COLLECTION_OWNER_WINDOW_LIMIT,
  SHELF_TYPE_PREDECESSOR_LIMIT,
  SHELF_TYPES_LIMIT,
  collectionVisibilities,
  createShelfTypeWindowNavigation,
  dynamicCollectionTitle,
  libraryOrderFromShelf,
  libraryShelfType,
  readLibraryResult,
  readShelfTypeOwnerWindow,
  settingsLibraryTransport,
  shelfColumnIds,
  shelfColumnLabel,
  shelfHref,
  shelfLayouts,
  shelfOrderFromLibrary,
  shelfPreferenceColumns,
  shelfPreferenceLayouts,
  shelfPreferenceSortFields,
  shelfPreferenceTabs,
  unsupportedShelfColumns,
  unsupportedShelfSorts,
  type CollectionVisibility,
  type OwnedCollection,
  type OwnedCollectionsPage,
  type PersonalShelfColumnId,
  type SettingsLibraryTransport,
  type ShelfLayout,
  type ShelfPreferencePatch,
  type ShelfPreferenceSnapshot,
  type ShelfPreferenceSort,
  type ShelfPreferenceTab,
  type ShelfPreferences,
  type ShelfTypesCurrentRead,
  type ShelfTypesView,
} from '../../library/settings-adapter';

export const readSettingsShelfTypes: ShelfTypeReadPort = readShelfTypeOwnerWindow;

export function createSettingsShelfTypeFrontier() {
  return createShelfTypeWindowNavigation();
}

export function settingsLibraryPort(
  privacy: SettingsLibraryPort['privacy'],
  transport: SettingsLibraryTransport = settingsLibraryTransport(),
): SettingsLibraryPort {
  return {
    collectionTitle: (collection, locale) => transport.collectionTitle(collection, locale),
    readLibraryResult: transport.readLibraryResult,
    privacy,
    shelf: {
      columnIds: shelfColumnIds,
      columnLabel: transport.shelfColumnLabel,
      libraryShelfType: transport.libraryShelfType,
      href: (locale, view) => transport.shelfHref(locale, view),
      order: {
        fromPreference: transport.libraryOrderFromShelf,
        toPreference: transport.shelfOrderFromLibrary,
        unsupportedColumns: transport.unsupportedShelfColumns,
        unsupportedSorts: transport.unsupportedShelfSorts,
      },
      readTypes: transport.readShelfTypes,
      createTypeFrontier: transport.createTypeFrontier,
      typeWindowLimit: SHELF_TYPES_LIMIT,
    },
  };
}
