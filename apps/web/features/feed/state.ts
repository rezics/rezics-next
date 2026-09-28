import type { FeedModelKind, FeedQuery } from './types.ts';

// The feed a reader is looking at, kept in the URL so every view has an
// address, survives reload and works without JavaScript. Only choices that
// differ from the defaults appear in it.

const feedTabs = ['following', 'all'] as const;
export type FeedTab = (typeof feedTabs)[number];
const feedSorts = ['best', 'new', 'top'] as const;
export type FeedSort = (typeof feedSorts)[number];
export const topWindows = ['week', 'month', 'all'] as const;
type TopWindow = (typeof topWindows)[number];

/** The six kinds people choose from, in onboarding and as feed chips (never the model's types). */
export const interestKinds = ['books', 'software', 'ai', 'recipes', 'media', 'discussions'] as const;
export type InterestKind = (typeof interestKinds)[number];

/** What each kind asks Main for. */
export const interestFilter: Record<InterestKind, { kinds?: FeedModelKind[]; interests?: string } | null> = {
  books: { interests: 'books' }, software: { interests: 'software' }, ai: { interests: 'ai' },
  recipes: { interests: 'recipes' }, media: { interests: 'media' },
  discussions: { kinds: ['discussion', 'reply'] },
};

/** Content languages a reader can filter by: the interface locales' writing systems. */
export const contentLanguages = ['en', 'zh-Hans', 'zh-Hant', 'ja', 'ko', 'de', 'fr', 'es'] as const;

export interface FeedState {
  tab: FeedTab;
  sort: FeedSort;
  /** Top's window; ignored by Best and New. */
  window: TopWindow;
  kind: InterestKind | null;
  languages: string[];
  realms: string[];
}

export interface FeedDefaults { tab: FeedTab; sort: FeedSort }

/** Posts as cards, or one line each: the reader's choice, kept in a cookie so the server renders it at once. */
export type PostView = 'card' | 'compact';
export const VIEW_COOKIE = 'rezics_post_view';

export function parsePostView(value: string | undefined): PostView {
  return value === 'compact' ? 'compact' : 'card';
}

const realmId = /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/;
const MAX_LANGUAGES = 8, MAX_REALMS = 8;

type Params = URLSearchParams | Record<string, string | string[] | undefined>;

function all(params: Params, name: string): string[] {
  if (params instanceof URLSearchParams) return params.getAll(name);
  const value = params[name];
  return value === undefined ? [] : Array.isArray(value) ? value : [value];
}

const oneOf = <T extends string>(values: readonly T[], value: string | undefined): T | undefined =>
  values.find(item => item === value);

/**
 * The feed a URL asks for. Signed out there is only All. Following has no Top
 * (Main ranks Top only across REZICS), so it falls back to Best. Unknown
 * values are dropped rather than failing the page.
 */
export function parseFeedState(params: Params, signedIn: boolean,
  defaults: FeedDefaults = { tab: signedIn ? 'following' : 'all', sort: 'best' }): FeedState {
  const tab = signedIn ? oneOf(feedTabs, all(params, 'tab')[0]) ?? defaults.tab : 'all';
  let sort = oneOf(feedSorts, all(params, 'sort')[0]) ?? defaults.sort;
  if (tab === 'following' && sort === 'top') sort = 'best';
  const window = oneOf(topWindows, all(params, 't')[0]) ?? 'week';
  const kind = oneOf(interestKinds, all(params, 'kind')[0]) ?? null;
  const languages = [...new Set(all(params, 'lang').flatMap(value => value.split(','))
    .filter(value => (contentLanguages as readonly string[]).includes(value)))].slice(0, MAX_LANGUAGES);
  const realms = [...new Set(all(params, 'realm').filter(value => realmId.test(value)))].slice(0, MAX_REALMS);
  return { tab, sort, window, kind, languages, realms };
}

/** The home URL for a state: only what differs from the defaults, in a stable order. */
export function feedSearch(state: FeedState, defaults: FeedDefaults): string {
  const params = new URLSearchParams();
  if (state.tab !== defaults.tab) params.set('tab', state.tab);
  if (state.sort !== defaults.sort) params.set('sort', state.sort);
  if (state.sort === 'top' && state.window !== 'week') params.set('t', state.window);
  if (state.kind) params.set('kind', state.kind);
  if (state.languages.length) params.set('lang', state.languages.join(','));
  for (const realm of state.realms) params.append('realm', realm);
  const text = params.toString();
  return text ? `?${text}` : '';
}

/**
 * The next state after a simple choice. Switching tab or sort keeps every
 * filter, so an advanced selection survives ordinary edits; a sort that the
 * new tab lacks falls back to Best.
 */
export function withChange(state: FeedState, change: Partial<FeedState>): FeedState {
  const next = { ...state, ...change };
  if (next.tab === 'following' && next.sort === 'top') next.sort = 'best';
  return next;
}

/** Whether Main can show this kind. */
export function kindAvailable(kind: InterestKind): boolean {
  return interestFilter[kind] !== null;
}

/** Filters beyond tab and sort, for the Filters button's count. */
export function activeFilterCount(state: FeedState): number {
  return state.languages.length + state.realms.length;
}

/**
 * Main's feed query for a state. An empty filter sends nothing: no hidden
 * language, kind or Realm defaults narrow what the reader asked for.
 */
export function feedQuery(state: FeedState, input: { actingSubject?: string; language: string;
  cursor?: string | null }): FeedQuery {
  const filter = state.kind ? interestFilter[state.kind] : null;
  return {
    scope: state.tab, sort: state.sort, language: input.language,
    ...(state.sort === 'top' ? { window: state.window } : {}),
    ...(filter?.kinds ? { kinds: filter.kinds } : {}),
    ...(filter?.interests ? { interests: filter.interests } : {}),
    ...(state.languages.length ? { contentLanguages: state.languages } : {}),
    ...(state.realms.length ? { realms: state.realms } : {}),
    ...(input.actingSubject ? { actingSubject: input.actingSubject } : {}),
    ...(input.cursor ? { cursor: input.cursor } : {}),
  };
}
