import type { ShelfPreferences, ShelfPreferenceSort, ShelfPreferenceTab } from '../settings/preferences';
import {
  shelfColumns,
  shelfDisplay,
  shelfSort,
  type PersonalShelfColumnId,
  type ShelfSearch,
  type ShelfSort,
} from './shelf-params';

const nativeColumn = {
  cover: 'cover',
  title: 'title',
  creator: undefined,
  type: 'type',
  status: 'status',
  progress: 'progress',
  rating: undefined,
  added: 'added',
  started: undefined,
  finished: 'finished',
  last_activity: 'lastActivity',
} as const satisfies Record<NonNullable<ShelfPreferences['tableColumns']>[number], PersonalShelfColumnId | undefined>;

const shelfSortTab: Record<string, ShelfPreferenceTab | undefined> = {
  in_progress: 'in_progress',
  'in-progress': 'in_progress',
  planned: 'planned',
  completed: 'completed',
  paused: 'paused',
  dropped: 'dropped',
  all: 'all',
};

export function shelfTabForState(state: string | undefined): ShelfPreferenceTab | undefined {
  return state === undefined ? 'all' : shelfSortTab[state];
}

export function libraryOrderFromShelf(sort: ShelfPreferenceSort | undefined): ShelfSort | undefined {
  if (!sort) return undefined;
  const orderBy =
    sort.field === 'last_activity'
      ? 'lastActivity'
      : sort.field === 'added'
        ? 'createdAt'
        : sort.field === 'finished'
          ? 'finishedAt'
          : sort.field === 'rating'
            ? 'personalScore'
            : undefined;
  return orderBy ? { orderBy, direction: sort.direction } : undefined;
}

export function shelfOrderFromLibrary(sort: ShelfSort): ShelfPreferenceSort {
  return {
    field:
      sort.orderBy === 'personalScore'
        ? 'rating'
        : sort.orderBy === 'createdAt'
          ? 'added'
          : sort.orderBy === 'finishedAt'
            ? 'finished'
            : 'last_activity',
    direction: sort.direction,
  };
}

function columnsFromShelf(shelf: ShelfPreferences): string | undefined {
  if (!shelf.tableColumns) return undefined;
  const columns = shelf.tableColumns.flatMap((column) => {
    const supported = nativeColumn[column];
    return supported ? [supported] : [];
  });
  return shelfColumns(['title', ...columns].join(','));
}

function typeScope(type: string | undefined): string | undefined {
  return type && /^[A-Za-z][A-Za-z0-9+.-]*:\S+$/.test(type) ? type : undefined;
}

export type ShelfPresentationResolution = {
  search: ShelfSearch;
  display: ReturnType<typeof shelfDisplay>;
  sort: ShelfSort;
  cursorInvalidated: boolean;
};

/** Resolve one bounded preference snapshot without changing its unsupported native values. */
export function resolveShelfPresentation(
  search: ShelfSearch,
  shelf: ShelfPreferences | undefined,
): ShelfPresentationResolution {
  const saved = shelf ?? {};
  const fallbackSort = shelfSort(search);
  const tab = shelfTabForState(search.state);
  const savedSort = tab ? libraryOrderFromShelf(saved.sorts?.[tab]) : undefined;
  const orderBy = search.orderBy ?? savedSort?.orderBy ?? fallbackSort.orderBy;
  const direction = search.direction ?? (search.orderBy === 'priority' ? fallbackSort.direction : savedSort?.direction ?? fallbackSort.direction);
  const usedChangedSavedSort =
    !!savedSort &&
    ((search.orderBy === undefined && savedSort.orderBy !== fallbackSort.orderBy) ||
      (search.direction === undefined && search.orderBy !== 'priority' && savedSort.direction !== fallbackSort.direction));
  const cursorInvalidated = !!search.cursor && usedChangedSavedSort;
  const scope = typeScope(search.type);
  const base = shelfDisplay(search);
  const layout = search.layout ?? (scope ? saved.layouts?.[scope] : undefined) ?? saved.layouts?.all ?? base.layout;
  const size =
    search.size ??
    (saved.gridSize === 'small'
      ? 's'
      : saved.gridSize === 'large'
        ? 'l'
        : saved.gridSize === 'medium'
          ? 'm'
          : base.size);
  const columns = search.columns ?? columnsFromShelf(saved);
  const { cursor, ...withoutCursor } = search;
  return {
    search: {
      ...withoutCursor,
      orderBy,
      direction,
      ...(!cursorInvalidated && cursor ? { cursor } : {}),
    },
    display: {
      ...base,
      layout,
      size,
      ...(columns !== undefined ? { columns } : {}),
      layoutExplicit: search.layout !== undefined,
      layoutSource:
        search.layout !== undefined
          ? 'url'
          : scope && saved.layouts?.[scope]
            ? 'type'
            : saved.layouts?.all
              ? 'all'
              : 'application',
      sizeExplicit: search.size !== undefined,
      columnsExplicit: search.columns !== undefined,
    },
    sort: { orderBy, direction },
    cursorInvalidated,
  };
}

export function unsupportedShelfSorts(shelf: ShelfPreferences): Array<{ tab: ShelfPreferenceTab; field: string }> {
  return (Object.entries(shelf.sorts ?? {}) as Array<[ShelfPreferenceTab, ShelfPreferenceSort]>).flatMap(
    ([tab, sort]) => {
      const intent = libraryOrderFromShelf(sort);
      // Recognizing a saved address does not admit a native whole-shelf order.
      return intent && intent.orderBy !== 'personalScore' ? [] : [{ tab, field: sort.field.replaceAll('_', ' ') }];
    },
  );
}

export function unsupportedShelfColumns(shelf: ShelfPreferences): string[] {
  return (shelf.tableColumns ?? []).filter((column) => nativeColumn[column] === undefined);
}
