import { CONTENT_LANGUAGE_LIMIT } from '../../i18n/display-languages.ts';
import { languageTag } from '../onboarding/languages.ts';
import type { FeedQuery } from './types.ts';

// The feed a reader is looking at, kept in the URL so every view has an
// address, survives reload and works without JavaScript. Only choices that
// differ from the defaults appear in it.

const feedTabs = ['following', 'all'] as const;
/** Following, All, or one of the Saved Filters the reader pinned (docs/plan/frontend.md, Home). */
export type FeedTab = (typeof feedTabs)[number] | 'pinned';
const feedSorts = ['best', 'new', 'top'] as const;
export type FeedSort = (typeof feedSorts)[number];
export const topWindows = ['week', 'month', 'all'] as const;
type TopWindow = (typeof topWindows)[number];

/** Languages offered to a signed-out reader. A signed-in reader's filter is the list Main keeps. */
export const contentLanguages = ['en', 'zh-Hans', 'zh-Hant', 'ja', 'ko', 'de', 'fr', 'es'] as const;

export interface FeedState {
  tab: FeedTab;
  /** The pinned Saved Filter's UUID on a pinned tab; null on Following and All. */
  filter: string | null;
  sort: FeedSort;
  /** Top's window; ignored by Best and New. */
  window: TopWindow;
  /** Following and All only: a pinned filter carries its own Conditions. */
  languages: string[];
  realms: string[];
}

/** A reader's default view: Following or All; a pinned tab is always chosen. */
export interface FeedDefaults { tab: Exclude<FeedTab, 'pinned'>; sort: FeedSort }

const realmId = /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_REALMS = 8;

type Params = URLSearchParams | Record<string, string | string[] | undefined>;

function all(params: Params, name: string): string[] {
  if (params instanceof URLSearchParams) return params.getAll(name);
  const value = params[name];
  return value === undefined ? [] : Array.isArray(value) ? value : [value];
}

const oneOf = <T extends string>(values: readonly T[], value: string | undefined): T | undefined =>
  values.find(item => item === value);

/**
 * The feed a URL asks for. Signed out there is only All. `tab` names
 * Following, All or a pinned filter's UUID. Following has no Top (Main ranks
 * Top only across REZICS), so it falls back to Best. Unknown values are
 * dropped rather than failing the page, including the retired `kind`.
 */
export function parseFeedState(params: Params, signedIn: boolean,
  defaults: FeedDefaults = { tab: signedIn ? 'following' : 'all', sort: 'best' }): FeedState {
  const requested = all(params, 'tab')[0];
  const filter = signedIn && requested && uuid.test(requested) ? requested : null;
  const tab: FeedTab = filter ? 'pinned' : signedIn ? oneOf(feedTabs, requested) ?? defaults.tab : 'all';
  let sort = oneOf(feedSorts, all(params, 'sort')[0]) ?? defaults.sort;
  if (tab === 'following' && sort === 'top') sort = 'best';
  const window = oneOf(topWindows, all(params, 't')[0]) ?? 'week';
  const languages = filter ? [] : [...new Set(all(params, 'lang').flatMap(value => value.split(','))
    .flatMap(value => {
      const tag = languageTag(value);
      return tag ? [tag] : [];
    }))].slice(0, CONTENT_LANGUAGE_LIMIT);
  const realms = filter ? [] : [...new Set(all(params, 'realm').filter(value => realmId.test(value)))].slice(0, MAX_REALMS);
  return { tab, filter, sort, window, languages, realms };
}

/** The home URL for a state: only what differs from the defaults, in a stable order. */
export function feedSearch(state: FeedState, defaults: FeedDefaults): string {
  const params = new URLSearchParams();
  if (state.tab === 'pinned' && state.filter) params.set('tab', state.filter);
  else if (state.tab !== defaults.tab) params.set('tab', state.tab);
  if (state.sort !== defaults.sort) params.set('sort', state.sort);
  if (state.sort === 'top' && state.window !== 'week') params.set('t', state.window);
  if (state.languages.length) params.set('lang', state.languages.join(','));
  for (const realm of state.realms) params.append('realm', realm);
  const text = params.toString();
  return text ? `?${text}` : '';
}

/**
 * The next state after a simple choice. Switching tab or sort keeps every
 * filter, so an advanced selection survives ordinary edits; a sort that the
 * new tab lacks falls back to Best. Leaving a pinned tab leaves its filter.
 */
export function withChange(state: FeedState, change: Partial<FeedState>): FeedState {
  const next = { ...state, ...change };
  if (next.tab !== 'pinned') next.filter = null;
  if (next.tab === 'following' && next.sort === 'top') next.sort = 'best';
  return next;
}

/** The state showing a pinned filter's tab, with the current sort. */
export function pinnedTab(state: FeedState, filter: string): FeedState {
  return { ...state, tab: 'pinned', filter, languages: [], realms: [] };
}

/** Filters beyond tab and sort, for the Filters button's count. */
export function activeFilterCount(state: FeedState): number {
  return state.languages.length + state.realms.length;
}

/**
 * Main's feed query for a state. An empty filter sends nothing: no hidden
 * language or Realm defaults narrow what the reader asked for. A pinned tab
 * reads All through its Saved Filter, which Main compiles.
 */
export function feedQuery(state: FeedState, input: { actingSubject?: string; language: string;
  cursor?: string | null }): FeedQuery {
  const pinned = state.tab === 'pinned' && state.filter;
  return {
    scope: pinned ? 'all' : state.tab === 'following' ? 'following' : 'all', sort: state.sort,
    ...(state.sort === 'top' ? { window: state.window } : {}),
    ...(pinned ? { savedFilter: state.filter! } : {}),
    ...(!pinned && state.languages.length ? { contentLanguages: state.languages } : {}),
    ...(!pinned && state.realms.length ? { realms: state.realms } : {}),
    ...(input.actingSubject ? { actingSubject: input.actingSubject } : {}),
    ...(input.cursor ? { cursor: input.cursor } : {}),
  };
}
