import { Skeleton } from '@rezics/ui/skeleton';
import { materializeData } from 'native-i18n';
import { cookies } from 'next/headers';
import { Suspense } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import { localizedPath } from '../../i18n/locale.ts';
import { getMessages } from '../../i18n/server.ts';
import { signInPath } from '../auth/paths.ts';
import { feedSearch, interestKinds } from '../feed/state.ts';
import { followedRealmIds, segmentsOf } from '../shell/communities.ts';
import { FeedSkeleton } from '../feed/feed-list.tsx';
import { HomePage, HomePosts, type HomePostsProps } from './home-page.tsx';
import { PICKER_COOKIE, WELCOME_COOKIE } from './cookies.ts';
import type { HomeMessages } from './messages.ts';
import { Rail } from './rail.tsx';
import { type HomePosts as Posts, readContinue, readHomePosts, readHomeView, readInterests, readModerated,
  readOfficialZones, readSuggestions, readTrending } from './server.ts';

async function HomeRail({ locale, messages, kinds, followed, posts, signedIn, avatarQuery }: {
  locale: UiLocale; messages: HomeMessages; kinds: Record<string, string>;
  /** The Realms and Zones the reader follows, by their own IDs and their Realms'. */
  followed: ReadonlySet<string>;
  /** The posts' read, for the ranking it explains. */
  posts: Promise<Posts>; signedIn: boolean; avatarQuery: string;
}) {
  const [trending, suggestions, moderated, official, { page }] = await Promise.all([readTrending(),
    readSuggestions(locale), readModerated(locale), readOfficialZones(locale), posts]);
  const ranking = page.ok ? page.data.ranking : null;
  return <Rail locale={locale} messages={messages} kinds={kinds} signedIn={signedIn} avatarQuery={avatarQuery}
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

/**
 * The home route. The frame, the sort and everything read quickly render at
 * once; the posts, Main's slowest read here, and the rail stream in after.
 */
export async function HomeRoute({ locale, searchParams }: { locale: UiLocale;
  searchParams: Record<string, string | string[] | undefined> }) {
  // Every read that does not depend on another starts at once, so the page waits for the slowest, not their sum.
  const [home, feedMessages, view, jar, continueItems, official, picker] = await Promise.all([getMessages('home', locale),
    getMessages('feed', locale), readHomeView(searchParams, locale), cookies(), readContinue(),
    readOfficialZones(locale), readInterests(locale)]);
  const posts = readHomePosts(view, locale);
  const interests = picker ?? { kinds: [], languages: [locale] };
  // Sign-in returns to this view, with its filters.
  const signInHref = signInPath(localizedPath(`/${feedSearch(view.state, view.defaults)}`, locale));
  const followed = new Set(view.followed ? [...followedRealmIds(view.followed),
    ...[...view.followed.realms, ...view.followed.zones].map(item => item.id)] : []);
  const feedText = materializeData(feedMessages, { locale });
  const kinds = Object.fromEntries(interestKinds.map(kind => [kind, feedText[kind]]));
  return <HomePage locale={locale} messages={{ home, feed: feedMessages }} now={Date.now()}
    signedIn={view.signedIn} actingSubject={view.actingSubject} avatarQuery={view.avatarQuery} state={view.state}
    defaults={view.defaults} newPerson={view.newPerson === true} followed={view.followed}
    continueItems={continueItems} official={official} interests={interests}
    pickerSkipped={jar.get(PICKER_COOKIE)?.value === 'skipped'}
    welcomeDismissed={jar.get(WELCOME_COOKIE)?.value === 'dismissed'}
    signInHref={signInHref} signUpHref={`${signInHref}&create=1`}
    posts={<Suspense fallback={<div aria-busy="true"><FeedSkeleton /></div>}>
      <StreamedPosts posts={posts} locale={locale} messages={feedMessages} signedIn={view.signedIn}
        actingSubject={view.actingSubject} signInHref={signInHref} state={view.state} defaults={view.defaults} />
    </Suspense>}
    rail={<Suspense fallback={<RailSkeleton />}>
      <HomeRail locale={locale} messages={home} kinds={kinds} followed={followed} signedIn={view.signedIn}
        avatarQuery={view.avatarQuery} posts={posts} />
    </Suspense>} />;
}
