import type { SearchParams } from '../discover/scope.ts';

// A release filter as a Zone's browse URL states it: one release of a Work must meet every chosen
// condition (Main's `where` group over releases, G-851). The URL keeps the choices short and
// readable (`?releaseLanguage=en&releasePlatform=Windows`), every change is a link or a GET form,
// and the page never matches releases itself: it sends this group to Main and shows what Main matched.

/** The fields a reader can choose, each one Main facet inside the release group. */
export const releaseFields = ['language', 'platform', 'completeness', 'origin'] as const;
export type ReleaseField = (typeof releaseFields)[number];

export const completenessValues = ['complete', 'partial', 'trial', 'unknown'] as const;
export const originValues = ['official', 'unofficial'] as const;

/** URL parameter of each field; also the name of the form control that sets it. */
export const releaseParams: Record<ReleaseField, string> = { language: 'releaseLanguage',
  platform: 'releasePlatform', completeness: 'releaseCompleteness', origin: 'releaseOrigin' };

export interface ReleaseFilterState {
  language: string | null;
  platform: string | null;
  completeness: (typeof completenessValues)[number] | null;
  origin: (typeof originValues)[number] | null;
  cursor: string | null;
}

/** Main's `releaseLanguage` pattern; a tag outside the interface languages (`th`) is as valid as `en`. */
const LANGUAGE = /^[a-z]{2,3}(-[A-Za-z0-9]{1,8})*$/;
/** Main's `releasePlatform` accepts one to 120 characters; the URL keeps it printable and short. */
const PLATFORM = /^[\p{L}\p{N}][\p{L}\p{N} .+\-/()]{0,63}$/u;

const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value)?.trim();
const oneOf = <T extends string>(values: readonly T[], value: string | undefined): T | null =>
  values.find(item => item === value) ?? null;

export const noReleaseFilter: ReleaseFilterState = { language: null, platform: null, completeness: null,
  origin: null, cursor: null };

/** The URL's release filter. A value Main would refuse is dropped, so an old link opens, only wider. */
export function parseReleaseFilter(params: SearchParams): ReleaseFilterState {
  const language = first(params[releaseParams.language]);
  const platform = first(params[releaseParams.platform]);
  const cursor = first(params.cursor);
  return { language: language && LANGUAGE.test(language) ? language : null,
    platform: platform && PLATFORM.test(platform) ? platform : null,
    completeness: oneOf(completenessValues, first(params[releaseParams.completeness])),
    origin: oneOf(originValues, first(params[releaseParams.origin])),
    cursor: cursor && cursor.length <= 2048 ? cursor : null };
}

/** Whether the reader chose any condition; with none, the Zone's ordinary browse applies. */
export const releaseFilterActive = (state: ReleaseFilterState): boolean =>
  releaseFields.some(field => state[field] !== null);

/** How many conditions the reader chose, for a "Filters (3)" label. */
export const releaseFilterCount = (state: ReleaseFilterState): number =>
  releaseFields.filter(field => state[field] !== null).length;

/** The page's address for a state; a changed filter starts from the first page. */
export function releaseFilterHref(base: string, state: ReleaseFilterState): string {
  const query = new URLSearchParams();
  for (const field of releaseFields) {
    const value = state[field];
    if (value) query.set(releaseParams[field], value);
  }
  if (state.cursor) query.set('cursor', state.cursor);
  const search = query.toString();
  return search ? `${base}?${search}` : base;
}

/** The state without one condition, as a removable chip's link. */
export const without = (state: ReleaseFilterState, field: ReleaseField): ReleaseFilterState =>
  ({ ...state, [field]: null, cursor: null });

/** The one `where` group Main compares on a single release; absent when nothing is chosen. */
export type ReleaseCondition = { facet: string; any: string[] };
export interface ReleaseGroup { facet: 'release'; where: { all: ReleaseCondition[] } }

/**
 * The Query condition for a state. Releases that are withdrawn, cancelled or virtual are never an
 * answer to "can I play or read this", so the group always names the usable statuses unless the
 * reader chose official or fan translation.
 */
export function releaseGroup(state: ReleaseFilterState): ReleaseGroup | null {
  if (!releaseFilterActive(state)) return null;
  const all: ReleaseCondition[] = [];
  if (state.language) all.push({ facet: 'releaseLanguage', any: [state.language] });
  if (state.platform) all.push({ facet: 'releasePlatform', any: [state.platform] });
  if (state.completeness) all.push({ facet: 'releaseCompleteness', any: [state.completeness] });
  all.push({ facet: 'releaseStatus', any: state.origin ? [state.origin] : [...originValues] });
  return { facet: 'release', where: { all } };
}
