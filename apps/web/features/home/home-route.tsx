import { Skeleton } from '@rezics/ui/skeleton';
import { cookies } from 'next/headers';
import { Suspense } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import { localizedPath } from '../../i18n/locale.ts';
import { getMessages } from '../../i18n/server.ts';
import { readPlatformAccess } from '../api/main.ts';
import { operationOpen } from '../api/platform-access.ts';
import { signInPath } from '../auth/paths.ts';
import { feedSearch, withChange } from '../feed/state.ts';
import { readSavedFilters } from '../saved-filter/server.ts';
import { followedRealmIds, segmentsOf } from '../shell/communities.ts';
import { FeedSkeleton } from '../feed/feed-list.tsx';
import { HomePage, HomePosts, type HomePostsProps, MissingTab } from './home-page.tsx';
import { PICKER_COOKIE, WELCOME_COOKIE } from './cookies.ts';
import { ConceptTopicFeed } from './tabs.tsx';
import type { HomeMessages } from './messages.ts';
import { Rail } from './rail.tsx';
import { type FollowedConceptTab, type HomePosts as Posts, readConceptTopicFeed, readContinue, readFollowedConceptTabs,
  readHomePosts, readHomeView, readModerated, readOfficialZones, readSuggestions, readTrending, resolveConceptTab }
  from './server.ts';

async function HomeRail({ locale, messages, followed, posts, signedIn, avatarQuery }: {
  locale: UiLocale; messages: HomeMessages;
  /** The Realms and Zones the reader follows, by their own IDs and their Realms'. */
  followed: ReadonlySet<string>;
  /** The posts' read, for the ranking it explains; null when there are no posts to read. */
  posts: Promise<Posts> | null; signedIn: boolean; avatarQuery: string;
}) {
  const [trending, suggestions, moderated, official, shown] = await Promise.all([readTrending(),
    readSuggestions(locale), readModerated(locale), readOfficialZones(locale), posts]);
  const ranking = shown?.page.ok ? shown.page.data.ranking : null;
  return <Rail locale={locale} messages={messages} signedIn={signedIn} avatarQuery={avatarQuery}
    data={{ trending, ranking, moderated, realmSegments: segmentsOf(official),
      suggestions: suggestions.filter(item => !followed.has(item.id) && !followed.has(item.realm)) }} />;
}

function RailSkeleton() {
  return <div aria-hidden="true" className="grid gap-4">
    <Skeleton className="h-64 rounded-2xl" />
    <Skeleton className="h-48 rounded-2xl" />
  </div>;
}

/** The first page of posts, once Main answers; the page and its controls are already showing. */
async function StreamedPosts({ posts, ...props }: Omit<HomePostsProps, 'query' | 'page' | 'readerSeed' | 'personalRefused'>
  & { posts: Promise<Posts> }) {
  return <HomePosts {...props} {...await posts} />;
}

/** A followed topic's works, once the public template answers. */
async function StreamedConcept({ topic, locale, messages }: { topic: FollowedConceptTab; locale: UiLocale;
  messages: { home: HomeMessages; feed: HomePostsProps['messages']['feed'] } }) {
  return <ConceptTopicFeed key={topic.id} topic={topic} locale={locale} messages={messages}
    initial={await readConceptTopicFeed(topic.id, locale)} />;
}

/**
 * The home route. The frame, the sort and everything read quickly render at
 * once; the posts, Main's slowest read here, and the rail stream in after.
 */
export async function HomeRoute({ locale, searchParams }: { locale: UiLocale;
  searchParams: Record<string, string | string[] | undefined> }) {
  // Every read that does not depend on another starts at once, so the page waits for the slowest, not their sum.
  const [home, feedMessages, view, jar, continueItems, official, savedFilters, access, followedConcepts] = await Promise.all([
    getMessages('home', locale), getMessages('feed', locale), readHomeView(searchParams, locale), cookies(),
    readContinue(), readOfficialZones(locale), readSavedFilters(locale), readPlatformAccess(), readFollowedConceptTabs()]);
  const messages = { home, feed: feedMessages };
  // Sign-in returns to this view, with its filters.
  const here = localizedPath(`/${feedSearch(view.state, view.defaults)}`, locale);
  const signInHref = signInPath(here);
  const followed = new Set(view.followed ? [...followedRealmIds(view.followed),
    ...[...view.followed.realms, ...view.followed.zones].map(item => item.id)] : []);
  const topic = view.state.tab === 'pinned'
    ? await resolveConceptTab(view.state.filter, followedConcepts) : { kind: 'absent' as const, tabs: followedConcepts?.tabs ?? [] };
  const conceptTab = topic.kind === 'selected' ? topic.tab : null;
  const pinned = !conceptTab && view.state.tab === 'pinned' && savedFilters ? [...savedFilters.pinned, ...savedFilters.unpinned]
    .find(filter => filter.id === view.state.filter) ?? null : null;
  // Pinned tabs exist only where Saved Filters are open for the reader: an address kept from before is a gone tab.
  // A followed topic is not that address. An unread confirmation is a failed read, not a tab that was removed.
  const savedFiltersOpen = operationOpen('getV1MeSaved-filters', access);
  const missing = topic.kind !== 'unread' && !conceptTab && view.state.tab === 'pinned'
    && (savedFilters !== null || !savedFiltersOpen) && !pinned;
  const posts = missing || conceptTab || topic.kind === 'unread' ? null : readHomePosts(view, locale);
  const allHref = localizedPath(`/${feedSearch(withChange(view.state, { tab: 'all' }), view.defaults)}`, locale);
  return <HomePage locale={locale} messages={messages} now={Date.now()}
    signedIn={view.signedIn} actingSubject={view.actingSubject} avatarQuery={view.avatarQuery} state={view.state}
    defaults={view.defaults} readingLanguages={view.readingLanguages} newPerson={view.newPerson === true}
    followed={view.followed} concepts={topic.tabs}
    continueItems={continueItems} official={official} savedFilters={savedFilters}
    setupHref={`${localizedPath('/welcome', locale)}?next=${encodeURIComponent(here)}`}
    setupLater={jar.get(PICKER_COOKIE)?.value === 'skipped'}
    welcomeDismissed={jar.get(WELCOME_COOKIE)?.value === 'dismissed'}
    signInHref={signInHref} signUpHref={`${signInHref}&create=1`}
    posts={conceptTab ? <Suspense fallback={<div aria-busy="true"><FeedSkeleton /></div>}>
      <StreamedConcept topic={conceptTab} locale={locale} messages={messages} />
    </Suspense> : topic.kind === 'unread' ? <ConceptTopicFeed topic={null} locale={locale} messages={messages}
      initial={{ ok: false, failure: 'unavailable' }} />
      : posts ? <Suspense fallback={<div aria-busy="true"><FeedSkeleton /></div>}>
        <StreamedPosts posts={posts} locale={locale} messages={messages} signedIn={view.signedIn}
          actingSubject={view.actingSubject} signInHref={signInHref} state={view.state} defaults={view.defaults}
          pinned={pinned} recommendations={view.recommendations} />
      </Suspense> : <MissingTab locale={locale} messages={messages} allHref={allHref} />}
    rail={<Suspense fallback={<RailSkeleton />}>
      <HomeRail locale={locale} messages={home} followed={followed} signedIn={view.signedIn}
        avatarQuery={view.avatarQuery} posts={posts} />
    </Suspense>} />;
}
