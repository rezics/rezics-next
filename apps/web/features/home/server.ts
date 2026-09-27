import { cache } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import { type ReaderSeed, readReaderSeed } from '../catalogue/reader-store.ts';
import { type FeedDefaults, type FeedState, feedQuery, parseFeedState } from '../feed/state.ts';
import { type ContinueItem, type FeedPage, type FeedQuery, type InterestsResult, type Loaded, settle,
  type SuggestedFollow, type TrendingItem } from '../feed/types.ts';
import { readFollowed, readModerated, readOfficialZones, shellReader } from '../shell/communities-read.ts';
import type { Community, Moderated } from '../shell/communities.ts';

// Server reads for home. Each returns its own outcome, so one region's
// failure never takes down another; the rail streams in after the feed.

/** The reader's default view as Main keeps it; a person who follows nothing starts on All. */
async function readDefaults(hasFollows: boolean): Promise<FeedDefaults> {
  const reader = await shellReader();
  const fallback: FeedDefaults = { tab: hasFollows ? 'following' : 'all', sort: 'best' };
  if (!reader.actingSubject || !hasFollows) return fallback;
  const read = await settle(() => reader.main.v1.me['feed-preferences'].get({ query: {
    actingSubject: reader.actingSubject! } }));
  // Before a first choice Main answers its defaults with no revision; those fit a follower too.
  return read.ok ? { tab: read.data.preferences.tab, sort: read.data.preferences.sort } : fallback;
}

/** Whether the reader follows anything at all: a new person gets the interest picker instead of an empty feed. */
const followsAnything = cache(async (): Promise<boolean | null> => {
  const reader = await shellReader();
  if (!reader.actingSubject) return null;
  const page = await settle(() => reader.main.v1.me.follows.get({ query: { actingSubject: reader.actingSubject!,
    limit: 1 } }));
  return page.ok ? page.data.items.length > 0 : null;
});

/** The first page of a feed view. Main answers 409 when its projection moved mid-read; a first page reads again once. */
async function readFeedPage(query: FeedQuery): Promise<Loaded<FeedPage>> {
  const reader = await shellReader();
  const client = query.actingSubject ? reader.main : reader.anonymous;
  const first = await settle(() => client.v1.feed.get({ query }));
  return !first.ok && first.failure === 'moved' ? settle(() => client.v1.feed.get({ query })) : first;
}

interface HomeFeed {
  signedIn: boolean;
  /** The Agent the reader acts as; null signed out, or signed in before an Agent is chosen. */
  actingSubject: string | null;
  avatarQuery: string;
  state: FeedState;
  defaults: FeedDefaults;
  query: FeedQuery;
  page: Loaded<FeedPage>;
  /** Null signed out; true for a person who follows nothing yet. */
  newPerson: boolean | null;
  followed: { realms: Community[]; zones: Community[]; complete: boolean } | null;
  readerSeed: ReaderSeed | null;
  /** Main could not serve the personal read, so the page shows the public All feed instead and says so. */
  personalRefused: boolean;
}

export async function readHomeFeed(params: Record<string, string | string[] | undefined>,
  locale: UiLocale): Promise<HomeFeed> {
  const reader = await shellReader();
  const actingSubject = reader.actingSubject ?? null;
  const [realms, zones, any] = await Promise.all([readFollowed('realm'), readFollowed('zone'), followsAnything()]);
  const defaults = await readDefaults(any === true);
  // Without an Agent to act as, Main can only show the public feed.
  const state = parseFeedState(params, Boolean(actingSubject), defaults);
  const query = feedQuery(state, { language: locale, ...(actingSubject ? { actingSubject } : {}) });
  let page = await readFeedPage(query);
  let shown = query;
  // A personal view Main cannot serve still leaves the reader something to read: the public feed, with a note.
  const personalRefused = Boolean(actingSubject) && !page.ok;
  if (personalRefused) {
    shown = feedQuery({ ...state, tab: 'all' }, { language: locale });
    page = await readFeedPage(shown);
  }
  const works = page.ok ? page.data.items.flatMap(item => item.primaryAction.kind === 'want-to-read'
    ? [item.primaryAction.work] : []) : [];
  const readerSeed = actingSubject && works.length ? await readReaderSeed(reader.main, actingSubject, works) : null;
  return { signedIn: reader.signedIn, actingSubject, avatarQuery: reader.avatarQuery, state, defaults, query: shown, page,
    personalRefused,
    newPerson: any === null ? null : !any,
    followed: realms && zones ? { realms: realms.items, zones: zones.items, complete: realms.complete && zones.complete }
      : null,
    readerSeed };
}

/** Works in progress and followed Works with unread chapters, newest first; null when there are none. */
export async function readContinue(): Promise<ContinueItem[] | null> {
  const reader = await shellReader();
  if (!reader.actingSubject) return null;
  const read = await settle(() => reader.main.v1.me.continue.get({ query: { actingSubject: reader.actingSubject!,
    limit: 6 } }));
  return read.ok && read.data.items.length ? read.data.items : null;
}

export interface TrendingWork { item: TrendingItem; realm: Community | null }

/**
 * What is being read this week: in the reader's followed Realms (Main keeps
 * at most two per Realm and honours mutes), or across REZICS signed out.
 */
export async function readTrending(): Promise<{ scope: 'followed' | 'global'; items: TrendingWork[] }> {
  const reader = await shellReader();
  const scope = reader.actingSubject ? 'followed' as const : 'global' as const;
  const [read, realms] = await Promise.all([settle(() => (reader.actingSubject ? reader.main : reader.anonymous)
    .v1.trending.get({ query: { scope, window: 'week', ...(reader.actingSubject
      ? { actingSubject: reader.actingSubject } : {}) } })), readFollowed('realm')]);
  return { scope, items: read.ok ? read.data.items.map(item => ({ item,
    realm: realms?.items.find(realm => realm.id === item.realm) ?? null })) : [] };
}

/** What the interest picker offers: the kinds Main has content for, and languages from the locale. */
export async function readInterests(locale: UiLocale): Promise<Pick<InterestsResult, 'kinds' | 'languages'>> {
  const reader = await shellReader();
  const read = await settle(() => reader.anonymous.v1.onboarding.interests.get({ query: { locale } }));
  return read.ok ? read.data : { kinds: [], languages: [locale] };
}

/** Realms and Zones to follow, each with Main's reason; the signed-out rail uses the same suggestions. */
export async function readSuggestions(locale: UiLocale): Promise<SuggestedFollow[]> {
  const reader = await shellReader();
  const read = await settle(() => (reader.actingSubject ? reader.main : reader.anonymous)
    .v1.onboarding['suggested-follows'].get({ query: { locale,
      ...(reader.actingSubject ? { actingSubject: reader.actingSubject } : {}) } }));
  return read.ok ? read.data.items : [];
}

export { readModerated, readOfficialZones };
export type { Moderated };
