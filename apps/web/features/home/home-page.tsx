import { buttonVariants } from '@rezics/ui/button';
import { CompassIcon, FilterXIcon, InboxIcon, SearchIcon, TriangleAlertIcon } from 'lucide-react';
import { materializeData } from 'native-i18n';
import Link from 'next/link';
import type { ReactNode } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import { localizedPath } from '../../i18n/locale.ts';
import { type ReaderActions, ReaderActionsProvider } from '../catalogue/reader-actions.tsx';
import type { ReaderSeed } from '../catalogue/reader-store.ts';
import type { FeedApi } from '../feed/api.ts';
import { FeedControls } from '../feed/controls.tsx';
import { FeedProvider } from '../feed/feed-context.tsx';
import { FeedList } from '../feed/feed-list.tsx';
import type { FeedMessages } from '../feed/messages.ts';
import type { ContinueItem, InterestsResult } from '../feed/types.ts';
import { type FeedDefaults, feedSearch, type FeedState, interestKinds, withChange } from '../feed/state.ts';
import type { FeedPage, FeedQuery, Loaded } from '../feed/types.ts';
import { type Community, followedRealmIds } from '../shell/communities.ts';
import { EmptyState } from '../shell/empty-state.tsx';
import { ContinueStrip } from './continue-strip.tsx';
import { InterestPicker } from './interest-picker.tsx';
import type { HomeMessages } from './messages.ts';
import { OfficialZoneTiles, WelcomeCard } from './welcome.tsx';

export interface HomePageProps {
  locale: UiLocale;
  messages: { home: HomeMessages; feed: FeedMessages };
  /** The server render's clock, for relative times. */
  now: number;
  signedIn: boolean;
  actingSubject: string | null;
  avatarQuery: string;
  state: FeedState;
  defaults: FeedDefaults;
  query: FeedQuery;
  page: Loaded<FeedPage>;
  /** True for a signed-in person who follows nothing yet. */
  newPerson: boolean;
  followed: { realms: Community[]; zones: Community[]; complete: boolean } | null;
  continueItems: readonly ContinueItem[] | null;
  official: readonly Community[];
  interests: Pick<InterestsResult, 'kinds' | 'languages'>;
  pickerSkipped: boolean;
  welcomeDismissed: boolean;
  signInHref: string;
  signUpHref: string;
  readerSeed?: ReaderSeed | null;
  /** Main refused the reader's personal feed; the public one shows with a note. */
  personalRefused?: boolean;
  /** The right rail, streamed in by the route (or drawn directly in stories). */
  rail?: ReactNode;
  /** Stories: an in-memory Main and reader shelf. */
  api?: FeedApi;
  readerActions?: ReaderActions;
}

/** What an empty view says, naming its cause and offering the fixes that fit (never switching views silently). */
function EmptyFeed({ state, defaults, locale, messages }: { state: FeedState; defaults: FeedDefaults;
  locale: UiLocale; messages: FeedMessages }) {
  const t = materializeData(messages, { locale });
  const href = (change: Partial<FeedState>) => localizedPath(`/${feedSearch(withChange(state, change), defaults)}`, locale);
  const fix = buttonVariants({ variant: 'outline', size: 'sm' });
  if (state.languages.length || state.realms.length || state.kind) {
    const languages = new Intl.ListFormat(locale, { type: 'disjunction' }).format(state.languages
      .map(language => new Intl.DisplayNames([locale], { type: 'language' }).of(language) ?? language));
    const cause = state.languages.length ? t.emptyFilteredLanguages({ languages })
      : state.realms.length ? t.emptyFilteredRealms : t.emptyFilteredKind({ kind: t[state.kind!] });
    return <EmptyState icon={FilterXIcon} title={t.emptyFiltered} description={cause} className="m-3 sm:m-4">
      {state.languages.length ? <Link href={href({ languages: [] })} className={fix}>{t.includeAllLanguages}</Link> : null}
      {state.realms.length ? <Link href={href({ realms: [] })} className={fix}>{t.includeAllRealms}</Link> : null}
      {state.kind ? <Link href={href({ kind: null })} className={fix}>{t.showEverything}</Link> : null}
      <Link href={localizedPath('/search', locale)} className={buttonVariants({ variant: 'ghost', size: 'sm' })}>
        <SearchIcon aria-hidden="true" />{t.searchAll}</Link>
    </EmptyState>;
  }
  if (state.tab === 'following') {
    return <EmptyState icon={InboxIcon} title={t.emptyFollowing} description={t.emptyFollowingBody} className="m-3 sm:m-4">
      <Link href={href({ tab: 'all' })} className={buttonVariants({ size: 'sm' })}>{t.browseAll}</Link>
    </EmptyState>;
  }
  return <EmptyState icon={CompassIcon} title={t.emptyAll} description={t.emptyAllBody} className="m-3 sm:m-4">
    <Link href={localizedPath('/discover', locale)} className={buttonVariants({ size: 'sm' })}>{t.exploreDiscover}</Link>
  </EmptyState>;
}

/**
 * Home, in Reddit's frame: the Continue strip first (it is what brings people
 * back), then Following or All with the sort always in view, the posts, and a
 * rail at wide sizes. Signed out it is All · Best under the official Zones; a
 * new person first picks interests and follows communities in one step.
 */
export function HomePage(props: HomePageProps) {
  const { locale, messages, state, defaults, signedIn, actingSubject } = props;
  const t = materializeData(messages.home, { locale });
  const feed = materializeData(messages.feed, { locale });
  const kindNames = Object.fromEntries(interestKinds.map(kind => [kind, feed[kind]])) as Record<
    (typeof interestKinds)[number], string>;
  const realms = props.followed?.realms.map(realm => ({ id: realm.id, name: realm.name, language: realm.language })) ?? [];
  const allHref = localizedPath(`/${feedSearch(withChange(state, { tab: 'all' }), defaults)}`, locale);
  return <FeedProvider locale={locale} messages={messages.feed} now={props.now} signedIn={signedIn}
    actingSubject={actingSubject} signInHref={props.signInHref} avatarQuery={props.avatarQuery} tab={props.personalRefused ? 'all' : state.tab}
    followedRealms={props.followed?.complete ? followedRealmIds(props.followed) : null} api={props.api}>
    <ReaderActionsProvider signedIn={signedIn} signInHref={props.signInHref} actingSubject={actingSubject}
      seed={props.readerSeed ?? undefined} actions={props.readerActions}>
      <div className="mx-auto grid w-full max-w-[72rem] items-start gap-6 py-4 sm:px-6 sm:py-6 lg:px-8
        xl:grid-cols-[minmax(0,46rem)_20rem] xl:justify-center">
        <div className="grid min-w-0 gap-5">
          <h1 className="sr-only">{t.title}</h1>
          {!signedIn ? <>
            <OfficialZoneTiles zones={props.official} locale={locale} messages={messages.home} />
            <WelcomeCard locale={locale} messages={messages.home} signInHref={props.signInHref}
              signUpHref={props.signUpHref} dismissed={props.welcomeDismissed} />
          </> : null}
          {props.newPerson && actingSubject ? <InterestPicker locale={locale} messages={messages.home}
            kindNames={kindNames} initial={props.interests} collapsed={props.pickerSkipped} /> : null}
          {props.continueItems?.length ? <ContinueStrip items={props.continueItems} locale={locale}
            messages={messages.home} /> : null}
          <section aria-labelledby="home-posts" className="min-w-0 border-border/60 border-y bg-card sm:rounded-2xl
            sm:border sm:shadow-(--aura-shadow-card)">
            <h2 id="home-posts" className="sr-only">{feed.posts}</h2>
            <FeedControls state={state} defaults={defaults} signedIn={Boolean(actingSubject)} locale={locale}
              messages={messages.feed} realms={realms} />
            {props.personalRefused ? <p role="status" className="flex items-start gap-2 border-border/60 border-b
              bg-warning/10 px-4 py-2.5 text-sm text-warning-foreground">
              <TriangleAlertIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />{feed.personalRefused}</p> : null}
            <FeedList initial={props.page} query={props.query} allHref={allHref}
              empty={<EmptyFeed state={state} defaults={defaults} locale={locale} messages={messages.feed} />} />
          </section>
        </div>
        {props.rail ? <aside aria-label={t.sidebar} className="sticky top-20 hidden xl:block">{props.rail}</aside> : null}
      </div>
    </ReaderActionsProvider>
  </FeedProvider>;
}
