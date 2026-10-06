import type { FilterDocument } from '../../../../model/definitions/filter-document-v1.ts';
import type { MainClient } from '../feed/types.ts';

// Main's Saved Filter shapes (`services/main/src/modules/saved-filter/contract.ts`), taken from
// the typed Eden client so a contract change breaks this build.

type Ok<Call> = Call extends (...args: never[]) => Promise<{ data: infer Data }> ? NonNullable<Data> : never;
type SavedFiltersRoute = MainClient['v1']['me']['saved-filters'];

export type SavedFiltersPage = Ok<SavedFiltersRoute['get']>;
/** One Saved Filter as Main lists it; `filter` is its FilterDocument with exact Facet DefinitionRefs. */
export type SavedFilter = Omit<SavedFiltersPage['items'][number], 'filter'> & { filter: FilterDocument };
export type SavedFilterReceipt = Ok<SavedFiltersRoute['post']>;
export type ConceptSearchItem = Ok<MainClient['v1']['concepts']['get']>['items'][number];
export type ConceptDetail = Ok<ReturnType<MainClient['v1']['concepts']>['get']>;

/** A reader's filters as Home needs them: the pinned tabs in order, the rest, and the revision a reorder names. */
export interface SavedFilters {
  revision: string | null;
  pinned: SavedFilter[];
  unpinned: SavedFilter[];
}

/**
 * Why a Saved Filter command did not apply: `stale` when the filters changed
 * first (refresh and try again), `full` when Home already has eight tabs,
 * `followed` for a followed Concept's filter, which unfollowing removes,
 * `unsupported` for a filter Home cannot show, `closed` when the platform has not opened Saved Filters for the
 * reader (the surface goes away; it is not an error).
 */
export type CommandFailure = 'stale' | 'full' | 'followed' | 'unsupported' | 'closed' | 'sign-in' | 'unavailable';
export type CommandResult<T> = { ok: true; data: T } | { ok: false; failure: CommandFailure };
