import { buttonVariants } from '@rezics/ui/button';
import { CompassIcon, FilterXIcon, InboxIcon, PinOffIcon, SearchIcon, TagIcon, TriangleAlertIcon } from 'lucide-react';
import { materializeData } from 'native-i18n';
import Link from 'next/link';
import type { ReactNode } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import { localizedPath } from '../../i18n/locale.ts';
import { type ReaderActions, ReaderActionsProvider } from '../catalogue/reader-actions.tsx';
import type { ReaderSeed } from '../catalogue/reader-store.ts';
import { conceptPath } from '../concept/state.ts';
import type { FeedApi } from '../feed/api.ts';
import { FeedControls } from '../feed/controls.tsx';
import { FeedProvider, FeedView } from '../feed/feed-context.tsx';
import { FeedList } from '../feed/feed-list.tsx';
import type { FeedMessages } from '../feed/messages.ts';
import type { ContinueItem } from '../feed/types.ts';
import { type FeedDefaults, feedSearch, type FeedState, withChange } from '../feed/state.ts';
import type { FeedPage, FeedQuery, Loaded } from '../feed/types.ts';
import type { SavedFilterApi } from '../saved-filter/api.ts';
import { currentFiltersDocument, filterTitle } from '../saved-filter/tabs.ts';
import type { SavedFilter, SavedFilters } from '../saved-filter/types.ts';
import { type Community, followedRealmIds, segmentsOf } from '../shell/communities.ts';
import { EmptyState } from '../shell/empty-state.tsx';
import { ContinueStrip } from './continue-strip.tsx';
import { SetupInvite } from './invite.tsx';
import type { HomeMessages } from './messages.ts';
import { PinPicker } from './pin-picker.tsx';
import { SuggestionsNote } from './suggestions-note.tsx';
import { HomeTabs } from './tabs.tsx';
import { WelcomeCard } from './welcome.tsx';

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
  /** True for a signed-in person who follows nothing yet. */
  newPerson: boolean;
  followed: { realms: Community[]; zones: Community[]; complete: boolean } | null;
  continueItems: readonly ContinueItem[] | null;
  /** Official Zones: the addresses Realm links use, `/r/fiction` rather than a UUID. */
  official: readonly Community[];
  /** The reader's Saved Filters: pinned tabs and the rest. Null signed out or when Main could not read them. */
  savedFilters: SavedFilters | null;
  /** The first-minute setup, returning here. */
  setupHref: string;
  /** The new person put the setup invitation off before. */
  setupLater: boolean;
  welcomeDismissed: boolean;
  signInHref: string;
  signUpHref: string;
  /** The posts under the sort, normally <HomePosts>; the route streams them in behind the rest of the page. */
  posts: ReactNode;
  /** The right rail, streamed in by the route (or drawn directly in stories). */
  rail?: ReactNode;
  /** Stories: an in-memory Main. */
  api?: FeedApi;
  filtersApi?: SavedFilterApi;
}

export interface HomePostsProps {
  locale: UiLocale;
  messages: { home: HomeMessages; feed: FeedMessages };
  signedIn: boolean;
  actingSubject: string | null;
  signInHref: string;
  state: FeedState;
  defaults: FeedDefaults;
  /** The query that produced `page`, without a cursor. */
  query: FeedQuery;
  page: Loaded<FeedPage>;
  /** The pinned tab's filter, when the page shows one. */
  pinned?: SavedFilter | null;
  /** Whether Following fills a quiet page with suggestions; null when unknown or not signed in. */
  recommendations?: boolean | null;
  readerSeed?: ReaderSeed | null;
  /** Main refused the reader's personal feed; the public one shows with a note. */
  personalRefused?: boolean;
  /** Stories: an in-memory reader shelf and preference write. */
  readerActions?: ReaderActions;
  saveRecommendations?: (actingSubject: string, on: boolean) => Promise<boolean>;
}

/** The first page of posts and what follows it, with the shelf state for their Works. */
export function HomePosts({ locale, messages, signedIn, actingSubject, signInHref, state, defaults, query, page,
  pinned = null, recommendations = null, readerSeed, personalRefused = false, readerActions,
  saveRecommendations }: HomePostsProps) {
  const feed = materializeData(messages.feed, { locale });
  const allHref = localizedPath(`/${feedSearch(withChange(state, { tab: 'all' }), defaults)}`, locale);
  const tab = personalRefused ? 'all' : state.tab;
  // Say so where suggestions fill Following, or where the reader turned them off.
  const suggested = page.ok && page.data.items.some(item => item.reason.kind === 'recommended');
  const note = tab === 'following' && actingSubject && recommendations !== null && (suggested || !recommendations)
    ? <SuggestionsNote locale={locale} messages={messages.home} on={recommendations} actingSubject={actingSubject}
      save={saveRecommendations} /> : null;
  return <FeedView tab={tab}>
    <ReaderActionsProvider signedIn={signedIn} signInHref={signInHref} actingSubject={actingSubject}
      seed={readerSeed ?? undefined} actions={readerActions}>
      {personalRefused ? <p role="status" className="flex items-start gap-2 border-border/60 border-b
        bg-warning/10 px-4 py-2.5 text-sm text-warning-foreground">
        <TriangleAlertIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />{feed.personalRefused}</p> : null}
      {note}
      <FeedList initial={page} query={query} allHref={allHref}
        empty={<EmptyFeed state={state} defaults={defaults} locale={locale} messages={messages} pinned={pinned} />} />
    </ReaderActionsProvider>
  </FeedView>;
}

/** What an empty view says, naming its cause and offering the fixes that fit (never switching views silently). */
function EmptyFeed({ state, defaults, locale, messages, pinned }: { state: FeedState; defaults: FeedDefaults;
  locale: UiLocale; messages: { home: HomeMessages; feed: FeedMessages }; pinned: SavedFilter | null }) {
  const t = materializeData(messages.feed, { locale });
  const home = materializeData(messages.home, { locale });
  const href = (change: Partial<FeedState>) => localizedPath(`/${feedSearch(withChange(state, change), defaults)}`, locale);
  const fix = buttonVariants({ variant: 'outline', size: 'sm' });
  if (state.tab === 'pinned') {
    const topic = pinned ? filterTitle(pinned)?.value : null;
    return <EmptyState icon={TagIcon} title={topic && pinned?.concept ? home.emptyPinned({ topic })
      : home.emptyPinnedFilter} description={home.emptyPinnedBody} className="m-3 sm:m-4">
      {pinned?.concept && topic ? <Link href={localizedPath(conceptPath(pinned.concept.id), locale)}
        className={buttonVariants({ size: 'sm' })}>{home.openTopic({ topic })}</Link> : null}
      <Link href={href({ tab: 'all' })} className={fix}>{t.browseAll}</Link>
    </EmptyState>;
  }
  if (state.languages.length || state.realms.length) {
    const languages = new Intl.ListFormat(locale, { type: 'disjunction' }).format(state.languages
      .map(language => new Intl.DisplayNames([locale], { type: 'language' }).of(language) ?? language));
    const cause = state.languages.length ? t.emptyFilteredLanguages({ languages }) : t.emptyFilteredRealms;
    return <EmptyState icon={FilterXIcon} title={t.emptyFiltered} description={cause} className="m-3 sm:m-4">
      {state.languages.length ? <Link href={href({ languages: [] })} className={fix}>{t.includeAllLanguages}</Link> : null}
      {state.realms.length ? <Link href={href({ realms: [] })} className={fix}>{t.includeAllRealms}</Link> : null}
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

/** A pinned tab's address whose filter is gone: say so and offer All, which always exists. */
export function MissingTab({ locale, messages, allHref }: { locale: UiLocale;
  messages: { home: HomeMessages; feed: FeedMessages }; allHref: string }) {
  const t = materializeData(messages.home, { locale });
  return <EmptyState icon={PinOffIcon} title={t.tabMissing} description={t.tabMissingBody} className="m-3 sm:m-4">
    <Link href={allHref} className={buttonVariants({ size: 'sm' })}>
      {materializeData(messages.feed, { locale }).browseAll}</Link>
  </EmptyState>;
}

/**
 * Home, in Reddit's frame with X's treatment: the Continue strip first (it is
 * what brings people back), then the tabs (Following, All, the reader's pinned
 * topics and filters, `+`) and one compact control line, the posts as divided
 * rows with no frame around them, and a rail at wide sizes. Signed out it is
 * All · Best; the official Zones are in the navigation. A new person is
 * invited to the first-minute setup, and All · Best is never empty meanwhile.
 */
export function HomePage(props: HomePageProps) {
  const { locale, messages, state, defaults, signedIn, actingSubject } = props;
  const t = materializeData(messages.home, { locale });
  const feed = materializeData(messages.feed, { locale });
  const realms = props.followed?.realms.map(realm => ({ id: realm.id, name: realm.name, language: realm.language })) ?? [];
  const names = new Intl.DisplayNames([locale], { type: 'language' });
  const document = currentFiltersDocument(state);
  const current = document ? { document, labels: [...state.languages.map(language => names.of(language) ?? language),
    ...state.realms.map(realm => realms.find(item => item.id === realm)?.name ?? feed.realms)] } : null;
  const tabs = actingSubject ? <HomeTabs state={state} defaults={defaults} locale={locale} messages={messages}
    actingSubject={actingSubject} filters={props.savedFilters} api={props.filtersApi}
    picker={props.savedFilters ? <PinPicker state={state} defaults={defaults} locale={locale} messages={messages.home}
      actingSubject={actingSubject} filters={props.savedFilters} current={current} api={props.filtersApi} /> : null} />
    : undefined;
  return <FeedProvider locale={locale} messages={messages.feed} now={props.now} signedIn={signedIn}
    actingSubject={actingSubject} signInHref={props.signInHref} avatarQuery={props.avatarQuery} tab={state.tab}
    followedRealms={props.followed?.complete ? followedRealmIds(props.followed) : null} api={props.api}
    realmSegments={segmentsOf(props.official)}>
    <div className="mx-auto grid w-full max-w-[72rem] items-start gap-6 py-4 sm:px-6 sm:py-6 lg:px-8
      xl:grid-cols-[minmax(0,46rem)_20rem] xl:justify-center">
      <div className="grid min-w-0 gap-5">
        <h1 className="sr-only">{t.title}</h1>
        {!signedIn ? <WelcomeCard locale={locale} messages={messages.home} signInHref={props.signInHref}
          signUpHref={props.signUpHref} dismissed={props.welcomeDismissed} /> : null}
        {props.newPerson && actingSubject ? <SetupInvite locale={locale} messages={messages.home}
          href={props.setupHref} later={props.setupLater} /> : null}
        {props.continueItems?.length ? <ContinueStrip items={props.continueItems} locale={locale}
          messages={messages.home} /> : null}
        <section aria-labelledby="home-posts" className="min-w-0">
          <h2 id="home-posts" className="sr-only">{feed.posts}</h2>
          <FeedControls state={state} defaults={defaults} signedIn={Boolean(actingSubject)} locale={locale}
            messages={messages.feed} realms={realms} tabs={tabs} />
          {props.posts}
        </section>
      </div>
      {props.rail ? <aside aria-label={t.sidebar} className="sticky top-20 hidden xl:block">{props.rail}</aside> : null}
    </div>
  </FeedProvider>;
}
