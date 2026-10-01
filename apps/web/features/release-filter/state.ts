import type { SearchParams } from '../discover/scope.ts';
import { admits, type ResolvedReleaseFilter } from './registry.ts';

// A release filter as a Zone's browse URL states it: one release of a Work must meet every chosen condition
// (Main's `where` group over releases, G-851). The URL names each choice by its registry facet
// (`?releaseLanguage=en&releasePlatform=Windows`), every change is a link or a GET form, and the page never
// matches releases itself: it sends this group to Main and shows what Main matched.

export interface ReleaseFilterState {
  /** The chosen value for each registry facet the reader set. */
  conditions: Readonly<Record<string, string>>;
  cursor: string | null;
}

export const noReleaseFilter: ReleaseFilterState = { conditions: {}, cursor: null };

const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value)?.trim();

/** The URL's release filter. A value the registry would refuse is dropped, so an old link opens, only wider. */
export function parseReleaseFilter(params: SearchParams, filter: ResolvedReleaseFilter): ReleaseFilterState {
  const conditions: Record<string, string> = {};
  for (const field of filter.fields) {
    const value = first(params[field.facet]);
    if (value && admits(field, value)) conditions[field.facet] = value;
  }
  const cursor = first(params.cursor);
  return { conditions, cursor: cursor && cursor.length <= 2048 ? cursor : null };
}

/** Whether the reader chose any condition; with none, the Zone's ordinary browse applies. */
export const releaseFilterActive = (state: ReleaseFilterState): boolean => Object.keys(state.conditions).length > 0;

/** The page's address for a state; a changed filter starts from the first page. */
export function releaseFilterHref(base: string, state: ReleaseFilterState): string {
  const query = new URLSearchParams(Object.entries(state.conditions));
  if (state.cursor) query.set('cursor', state.cursor);
  const search = query.toString();
  return search ? `${base}?${search}` : base;
}

/** The state without one condition, as a removable chip's link. */
export function without(state: ReleaseFilterState, facet: string): ReleaseFilterState {
  const { [facet]: _removed, ...conditions } = state.conditions;
  return { conditions, cursor: null };
}

/** The one `where` group Main compares on a single release; absent when nothing is chosen. */
export type ReleaseCondition = { facet: string; any: string[] };
export interface ReleaseGroup { facet: string; where: { all: ReleaseCondition[] } }

/**
 * The Query condition for a state: each field's chosen value, or the values the Zone applies while it is
 * unchosen (usable statuses, say). The group and every facet in it are the registry's names.
 */
export function releaseGroup(state: ReleaseFilterState, filter: ResolvedReleaseFilter): ReleaseGroup | null {
  if (!releaseFilterActive(state)) return null;
  const all = filter.fields.flatMap((field): ReleaseCondition[] => {
    const chosen = state.conditions[field.facet];
    const values = chosen ? [chosen] : field.unchosen;
    return values.length ? [{ facet: field.facet, any: values }] : [];
  });
  return { facet: filter.group, where: { all } };
}
