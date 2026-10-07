import { cache } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import { type ReaderSeed, readReaderSeed } from '../catalogue/reader-store.ts';
import { type FeedDefaults, type FeedState, feedQuery, parseFeedState } from '../feed/state.ts';
import { type ContinueItem, type FeedPage, type FeedQuery, type Loaded, settle, type SuggestedFollow,
  type TrendingItem } from '../feed/types.ts';
import { readFollowed, readModerated, readOfficialZones, shellReader } from '../shell/communities-read.ts';
import type { Community, Moderated } from '../shell/communities.ts';
import {
  addressConceptTab, collectConceptTabs, type ConceptAddress, type ConceptFeedPage, type FollowedConceptTab,
  readConceptFeed, tabFromFollowState, withOpenedConcept,
} from './followed-concept-feed.ts';

// Server reads for home. Each returns its own outcome, so one region's
// failure never takes down another; the rail streams in after the feed.

/** The reader's saved default view and suggestion choice, read alongside their follows rather than after them. */
async function readSavedDefaults(): Promise<{ defaults: FeedDefaults; recommendations: boolean;
  contentLanguages: string[] } | null> {
  const reader = await shellReader();
  if (!reader.actingSubject) return null;
  const read = await settle(() => reader.main.v1.me['feed-preferences'].get({ query: {
    actingSubject: reader.actingSubject! } }));
  // Before a first choice Main answers its defaults with no revision; those fit a follower too.
  return read.ok ? { defaults: { tab: read.data.preferences.tab, sort: read.data.preferences.sort },
    recommendations: read.data.preferences.recommendations,
    contentLanguages: read.data.preferences.contentLanguages } : null;
}

/** The reader's default view as Main keeps it; a person who follows nothing starts on All. */
function feedDefaults(hasFollows: boolean, saved: FeedDefaults | null): FeedDefaults {
  return hasFollows && saved ? saved : { tab: hasFollows ? 'following' : 'all', sort: 'best' };
}

/** Whether the reader follows anything at all: a new person is invited to choose topics and communities. */
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

/** Who is reading and which view they asked for: quick reads the page frame and its controls need. */
export interface HomeView {
  signedIn: boolean;
  /** The Agent the reader acts as; null signed out, or signed in before an Agent is chosen. */
  actingSubject: string | null;
  avatarQuery: string;
  state: FeedState;
  defaults: FeedDefaults;
  query: FeedQuery;
  /** Null signed out; true for a person who follows nothing yet. */
  newPerson: boolean | null;
  /** Whether Following fills a quiet page with suggestions; null signed out or unread. */
  recommendations: boolean | null;
  /** Main's reading languages, in the reader's order. Null signed out or when Home could not be read. */
  readingLanguages: readonly string[] | null;
  followed: { realms: Community[]; zones: Community[]; complete: boolean } | null;
}

/** The first page of posts: Main's slowest read on Home, so the route streams it in behind the frame. */
export interface HomePosts {
  /** The query that produced `page`: the public All feed when the personal one was refused. */
  query: FeedQuery;
  page: Loaded<FeedPage>;
  readerSeed: ReaderSeed | null;
  /** Main could not serve the personal read, so the page shows the public All feed instead and says so. */
  personalRefused: boolean;
}

export async function readHomeView(params: Record<string, string | string[] | undefined>,
  locale: UiLocale): Promise<HomeView> {
  const reader = await shellReader();
  const actingSubject = reader.actingSubject ?? null;
  const [realms, zones, any, saved] = await Promise.all([readFollowed('realm'), readFollowed('zone'), followsAnything(),
    readSavedDefaults()]);
  const defaults = feedDefaults(any === true, saved?.defaults ?? null);
  // Without an Agent to act as, Main can only show the public feed.
  const state = parseFeedState(params, Boolean(actingSubject), defaults);
  const query = feedQuery(state, { language: locale, ...(actingSubject ? { actingSubject } : {}) });
  return { signedIn: reader.signedIn, actingSubject, avatarQuery: reader.avatarQuery, state, defaults, query,
    newPerson: any === null ? null : !any, recommendations: saved?.recommendations ?? null,
    readingLanguages: saved?.contentLanguages ?? null,
    followed: realms && zones ? { realms: realms.items, zones: zones.items, complete: realms.complete && zones.complete }
      : null };
}

/**
 * The topics the reader follows, as Home tabs. Null when Home could not read
 * the follows list. Saved Filters are not consulted: a topic tab needs no platform grant.
 */
export async function readFollowedConceptTabs(): Promise<{ tabs: FollowedConceptTab[]; complete: boolean } | null> {
  const reader = await shellReader();
  if (!reader.actingSubject) return null;
  const actingSubject = reader.actingSubject;
  return collectConceptTabs(async cursor => {
    const read = await settle(() => reader.main.v1.me.follows.get({ query: {
      actingSubject, kind: 'concept', limit: 20, ...(cursor ? { cursor } : {}) } }));
    if (!read.ok) return read;
    return { ok: true, data: { items: read.data.items, nextCursor: read.data.nextCursor, complete: read.data.complete } };
  });
}

/**
 * The topic `?tab=` names. A complete follows list answers on its own. An
 * unfinished or unread list asks follow state for that one Concept, so a
 * bookmarked topic still opens and a saved-filter address does not become one.
 */
export async function resolveConceptTab(tabUuid: string | null,
  listed: { tabs: readonly FollowedConceptTab[]; complete: boolean } | null): Promise<
  { kind: 'selected'; tab: FollowedConceptTab; tabs: FollowedConceptTab[] }
  | { kind: 'absent'; tabs: FollowedConceptTab[] }
  | { kind: 'unread'; tabs: FollowedConceptTab[] }> {
  const tabs = [...(listed?.tabs ?? [])];
  if (!tabUuid) return { kind: 'absent', tabs };
  const addressed: ConceptAddress = addressConceptTab(listed, tabUuid);
  if (addressed.kind === 'selected') return { kind: 'selected', tab: addressed.tab, tabs };
  if (addressed.kind === 'absent') return { kind: 'absent', tabs };
  const reader = await shellReader();
  if (!reader.actingSubject) return { kind: 'absent', tabs };
  const read = await settle(() => reader.main.v1.follows({ id: tabUuid }).get({ query: {
    kind: 'concept', actingSubject: reader.actingSubject! } }));
  if (!read.ok) return read.failure === 'missing' || read.failure === 'invalid'
    ? { kind: 'absent', tabs } : { kind: 'unread', tabs };
  const tab = tabFromFollowState(read.data, tabUuid);
  return tab ? { kind: 'selected', tab, tabs: withOpenedConcept(tabs, tab) } : { kind: 'absent', tabs };
}

/** One seek page of a followed topic's public works, newest first. */
export async function readConceptTopicFeed(conceptId: string, locale: UiLocale, cursor?: string):
  Promise<Loaded<ConceptFeedPage>> {
  const reader = await shellReader();
  return readConceptFeed(reader.actingSubject ? reader.main : reader.anonymous, conceptId, locale, cursor);
}

export type { ConceptFeedPage, FollowedConceptTab };

export async function readHomePosts(view: HomeView, locale: UiLocale): Promise<HomePosts> {
  const reader = await shellReader();
  let page = await readFeedPage(view.query);
  let shown = view.query;
  // A personal view Main cannot serve still leaves the reader something to read: the public feed, with a note.
  // A pinned tab's failure is its own and shows as such.
  const personalRefused = Boolean(view.actingSubject) && !page.ok && view.state.tab !== 'pinned';
  if (personalRefused) {
    shown = feedQuery({ ...view.state, tab: 'all', filter: null }, { language: locale });
    page = await readFeedPage(shown);
  }
  const works = page.ok ? page.data.items.flatMap(item => item.primaryAction.kind === 'want-to-read'
    ? [item.primaryAction.work] : []) : [];
  const readerSeed = view.actingSubject && works.length
    ? await readReaderSeed(reader.main, view.actingSubject, works) : null;
  return { query: shown, page, personalRefused, readerSeed };
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
