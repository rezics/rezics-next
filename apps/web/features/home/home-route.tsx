import { Skeleton } from '@rezics/ui/skeleton';
import { materializeData } from 'native-i18n';
import { cookies } from 'next/headers';
import { Suspense } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import { localizedPath } from '../../i18n/locale.ts';
import { getMessages } from '../../i18n/server.ts';
import { signInPath } from '../auth/paths.ts';
import { feedSearch, interestKinds } from '../feed/state.ts';
import { HomePage } from './home-page.tsx';
import { PICKER_COOKIE, WELCOME_COOKIE } from './cookies.ts';
import type { HomeMessages } from './messages.ts';
import { Rail } from './rail.tsx';
import { readContinue, readHomeFeed, readInterests, readModerated, readOfficialZones, readSuggestions,
  readTrending } from './server.ts';

async function HomeRail({ locale, messages, kinds, followedRealms, ranking, signedIn, avatarQuery }: {
  locale: UiLocale; messages: HomeMessages; kinds: Record<string, string>;
  followedRealms: readonly { id: string; name: string }[];
  ranking: Parameters<typeof Rail>[0]['data']['ranking']; signedIn: boolean; avatarQuery: string;
}) {
  const [trending, suggestions, moderated] = await Promise.all([readTrending(), readSuggestions(locale),
    readModerated(followedRealms.map(realm => realm.id).join(','))]);
  const followed = new Set(followedRealms.map(realm => realm.id));
  return <Rail locale={locale} messages={messages} kinds={kinds} signedIn={signedIn} avatarQuery={avatarQuery}
    data={{ trending, ranking, moderated: moderated.map(item => ({ ...item,
      name: followedRealms.find(realm => realm.id === item.realm)?.name ?? '' })),
      suggestions: suggestions.filter(item => !followed.has(item.id) && !followed.has(item.realm)) }} />;
}

function RailSkeleton() {
  return <div aria-hidden="true" className="grid gap-4">
    <Skeleton className="h-64 rounded-2xl" />
    <Skeleton className="h-48 rounded-2xl" />
  </div>;
}

/** The home route: the feed renders with the page; the rail streams in beside it. */
export async function HomeRoute({ locale, searchParams }: { locale: UiLocale;
  searchParams: Record<string, string | string[] | undefined> }) {
  const [home, feedMessages, feed, jar] = await Promise.all([getMessages('home', locale),
    getMessages('feed', locale), readHomeFeed(searchParams, locale), cookies()]);
  const [continueItems, official, interests] = await Promise.all([
    feed.actingSubject ? readContinue() : null, feed.signedIn ? [] : readOfficialZones(locale),
    feed.newPerson ? readInterests(locale) : { kinds: [], languages: [locale] }]);
  // Sign-in returns to this view, with its filters.
  const signInHref = signInPath(localizedPath(`/${feedSearch(feed.state, feed.defaults)}`, locale));
  const followedRealms = feed.followed?.realms.map(realm => ({ id: realm.id, name: realm.name })) ?? [];
  const feedText = materializeData(feedMessages, { locale });
  const kinds = Object.fromEntries(interestKinds.map(kind => [kind, feedText[kind]]));
  return <HomePage locale={locale} messages={{ home, feed: feedMessages }} now={Date.now()}
    signedIn={feed.signedIn} actingSubject={feed.actingSubject} avatarQuery={feed.avatarQuery} state={feed.state}
    defaults={feed.defaults} query={feed.query} page={feed.page} newPerson={feed.newPerson === true}
    followed={feed.followed} continueItems={continueItems} official={official} interests={interests}
    pickerSkipped={jar.get(PICKER_COOKIE)?.value === 'skipped'}
    welcomeDismissed={jar.get(WELCOME_COOKIE)?.value === 'dismissed'}
    signInHref={signInHref} signUpHref={`${signInHref}&create=1`} readerSeed={feed.readerSeed}
    personalRefused={feed.personalRefused}
    rail={<Suspense fallback={<RailSkeleton />}>
      <HomeRail locale={locale} messages={home} kinds={kinds} followedRealms={followedRealms} signedIn={feed.signedIn}
        avatarQuery={feed.avatarQuery} ranking={feed.page.ok ? feed.page.data.ranking : null} />
    </Suspense>} />;
}
