import { buttonVariants } from '@rezics/ui/button';
import { cn } from '@rezics/ui/utils';
import { ChevronLeftIcon, ChevronRightIcon, LockIcon, RefreshCwIcon, RotateCwIcon, StarIcon, TriangleAlertIcon,
  UserRoundIcon } from 'lucide-react';
import { materializeData } from 'native-i18n';
import type { ReactNode } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import { localizedPath } from '../../i18n/locale.ts';
import { signInPath } from '../auth/paths.ts';
import { messages as authMessages } from '../auth/messages.ts';
import { type ReaderActions, ReaderActionsProvider } from '../catalogue/reader-actions.tsx';
import type { ReaderSeed } from '../catalogue/reader-store.ts';
import { formatMean } from '../catalogue/work.ts';
import { WorkRow } from '../catalogue/work-row.tsx';
import { WorkGrid, WorkShelf } from '../catalogue/work-shelf.tsx';
import { Notice } from '../discover/notice.tsx';
import { EmptyState } from '../shell/empty-state.tsx';
import Link from '../shell/localized-link.tsx';
import { ReportAction } from '../safety/report-action.tsx';
import { PageContainer } from '../shell/page.tsx';
import { Expandable } from '../work-page/expandable.tsx';
import { creditedCard, shelfCard, worksSummary } from './cards.ts';
import { type FollowActions, FollowControl } from './follow-button.tsx';
import { followerLabel } from './followers.ts';
import type { ProfileMessages } from './messages.ts';
import { ProfileAvatar } from './profile-avatar.tsx';
import { ProfileContributions } from './contributions.tsx';
import type { ContributionPage } from './contributions.tsx';
import { profileHref, type ProfileView } from './route.ts';
import type { AgentProfile, AgentWorksPage, FollowState, LibraryView, Loaded, ReadFailure, ShelfCard,
  ShelfStatus } from './types.ts';

type Text = ReturnType<typeof materializeData<ProfileMessages>>;

/** Who is looking: signed in or not, the Agent they act as, and their shelf state for the Works shown. */
export interface ProfileReader {
  signedIn: boolean;
  actingSubject?: string | null;
  /** Cover and avatar bytes go through the BFF, which then needs the reader's Agent. */
  avatarQuery?: string;
  /** Null when Main denies this Agent a reader library; shelf buttons are then not drawn. */
  seed?: ReaderSeed | null;
}

/** Whether the reader is looking at their own profile, as the Agent they act as. */
export const ownProfile = (reader: ProfileReader, profile: Pick<AgentProfile, 'id'>) =>
  Boolean(reader.actingSubject) && reader.actingSubject === profile.id;

export function shelfLabel(status: ShelfStatus, t: Text): string {
  return status === 'reading' ? t.shelfReading : status === 'read' ? t.shelfRead : t.shelfWantToRead;
}

/** Whom the profile introduces, above the name, as Goodreads marks a "Goodreads Author". */
export function kindLabel(profile: Pick<AgentProfile, 'kind'>, credited: boolean, t: Text): string {
  if (profile.kind === 'organization') return t.organization;
  if (profile.kind === 'service') return t.service;
  return credited ? t.author : t.reader;
}

// CJK prose reads at a taller line height (frontend principles); the page spaces the scripts apart.
const proseClass = (language: string | undefined) => /^(?:zh|ja|ko)(?:-|$)/.test(language ?? '')
  ? 'leading-[1.8]' : 'leading-relaxed';

/** A region that could not load, said quietly with a way to try again. */
function Failure({ failure, title, retryHref, t }: { failure: ReadFailure; title: string; retryHref: string; t: Text }) {
  const moved = failure === 'moved';
  return <Notice icon={moved ? RefreshCwIcon : TriangleAlertIcon} tone={moved ? 'default' : 'destructive'}
    headingLevel={2} title={moved ? t.movedTitle : title} description={moved ? t.movedBody : undefined}>
    <Link href={retryHref} className={buttonVariants({ size: 'sm', variant: 'outline' })}>
      {moved ? t.firstPage : <><RotateCwIcon aria-hidden="true" />{t.retry}</>}</Link>
  </Notice>;
}

function ProfileHeader({ profile, credited, follow, reader, followActions, locale, messages }: {
  profile: AgentProfile; credited: boolean; follow: Loaded<FollowState>; reader: ProfileReader;
  followActions?: FollowActions; locale: UiLocale; messages: ProfileMessages;
}) {
  const t = materializeData(messages, { locale });
  const own = ownProfile(reader, profile);
  const followers = follow.ok ? follow.data.followers : null;
  return <header className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-5 gap-y-6 sm:items-start
    sm:gap-x-10">
    <ProfileAvatar name={profile.displayName} kind={profile.kind} avatarUrl={profile.avatarUrl}
      avatarQuery={reader.avatarQuery} className="sm:row-span-2" />
    <div className="min-w-0 space-y-1.5 sm:pt-3">
      <p className="font-medium text-muted-foreground text-sm">{kindLabel(profile, credited, t)}</p>
      <h1 className="text-balance font-semibold font-work-title text-3xl/tight tracking-tight [overflow-wrap:anywhere]
        sm:text-5xl/tight">{profile.displayName}</h1>
      {profile.handle ? <p className="text-muted-foreground [overflow-wrap:anywhere]">@{profile.handle}</p> : null}
    </div>
    <div className="col-span-2 grid content-start gap-5 sm:col-span-1 sm:col-start-2">
      {own ? <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <Link href={localizedPath('/settings', locale)} className={cn(buttonVariants({ variant: 'outline', pill: true }),
          'min-w-32')}><UserRoundIcon aria-hidden="true" />{t.editProfile}</Link>
        {profile.handle ? null : <Link href={localizedPath('/settings#handle', locale)}
          className="rounded-sm text-primary underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:ring-ring">
          {authMessages[locale].chooseHandle}</Link>}
        {followers ? <span className="text-muted-foreground text-sm tabular-nums">
          {followerLabel(followers, locale, messages)}</span> : null}
      </div>
        : <FollowControl target={profile.id} name={profile.displayName}
          following={follow.ok ? follow.data.following : null} revision={follow.ok ? follow.data.revision : null}
          followers={followers} signedIn={reader.signedIn} actingSubject={reader.actingSubject}
          signInHref={signInPath(localizedPath(profileHref(profile), locale))} actions={followActions}
          locale={locale} messages={messages} />}
      {profile.bio ? <Expandable more={t.showMore} less={t.showLess} className="max-w-prose">
        <p lang={profile.bio.language} className={cn('whitespace-pre-line text-pretty text-[1.0625rem]',
          proseClass(profile.bio.language))}>{profile.bio.text}</p>
      </Expandable> : null}
      {own ? null : <div><ReportAction target={profile.id} kind="profile" /></div>}
    </div>
  </header>;
}

const completionText = (completion: AgentWorksPage['items'][number]['completionStatus'], t: Text) =>
  completion === 'ongoing' ? t.serialOngoing : completion === 'hiatus' ? t.serialHiatus
    : completion === 'completed' ? t.serialCompleted : null;

/**
 * Works as Goodreads lists an author's books: cover rows with the rating,
 * pitch and a quiet shelf button, which the author does not get on their own.
 */
function WorkRows({ page, profile, own, headingLevel, avatarQuery, locale, messages }: {
  page: AgentWorksPage; profile: AgentProfile; own: boolean; headingLevel: 2 | 3; avatarQuery?: string;
  locale: UiLocale; messages: ProfileMessages;
}) {
  const t = materializeData(messages, { locale });
  return <ol className="grid divide-y divide-border/70">
    {page.items.map(item => {
      const serial = completionText(item.completionStatus, t);
      return <li key={item.id} className="py-6 first:pt-2">
        <WorkRow work={creditedCard(item, profile.displayName, profile, locale, messages)} headingLevel={headingLevel}
          avatarQuery={avatarQuery} locale={locale} shelf={own ? 'none' : 'secondary'}>{serial}</WorkRow>
      </li>;
    })}
  </ol>;
}

/** "5 works · ★ 4.21 average rating · 1,204 ratings", given only for what the whole list supports. */
function WorksSummaryLine({ page, locale, messages }: { page: AgentWorksPage; locale: UiLocale;
  messages: ProfileMessages }) {
  const t = materializeData(messages, { locale });
  const summary = worksSummary(page);
  return <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-muted-foreground text-sm">
    <span>{summary.complete ? t.workCount(summary.works)
      : t.workCountAtLeast({ count: new Intl.NumberFormat(locale).format(summary.works) })}</span>
    {summary.rating ? <>
      <span aria-hidden="true">·</span>
      <span className="inline-flex items-center gap-1">
        <StarIcon aria-hidden="true" className="size-3.5 fill-current text-rating" />
        <span className="font-semibold text-foreground tabular-nums">{formatMean(summary.rating.mean, locale)}
          {summary.rating.max === 5 ? null : `/${summary.rating.max}`}</span>
        <span className="sr-only">{t.averageRating({ mean: formatMean(summary.rating.mean, locale) })}</span>
      </span>
      <span aria-hidden="true">·</span>
      <span className="tabular-nums">{t.ratingCount(summary.rating.count)}</span>
    </> : null}
  </p>;
}

function WorksSection({ profile, works, own, avatarQuery, locale, messages }: {
  profile: AgentProfile; works: Loaded<AgentWorksPage>; own: boolean; avatarQuery?: string; locale: UiLocale;
  messages: ProfileMessages;
}) {
  const t = materializeData(messages, { locale });
  if (!works.ok) {
    return <Failure failure={works.failure} title={t.worksUnavailable} retryHref={profileHref(profile)} t={t} />;
  }
  return <section aria-labelledby="profile-works" className="grid gap-4">
    <header className="grid gap-1.5 border-border/70 border-b pb-4">
      <div className="flex items-end justify-between gap-4">
        <h2 id="profile-works" className="text-balance font-semibold text-2xl tracking-tight">
          {t.worksHeading({ name: profile.displayName })}</h2>
        {works.data.nextCursor ? <Link href={profileHref(profile, { kind: 'works' })}
          className="inline-flex shrink-0 items-center gap-0.5 rounded-sm font-medium text-primary text-sm outline-none
            underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:ring-ring">{t.allWorks}
          <ChevronRightIcon aria-hidden="true" className="size-4 rtl:rotate-180" /></Link> : null}
      </div>
      <WorksSummaryLine page={works.data} locale={locale} messages={messages} />
    </header>
    <WorkRows page={works.data} profile={profile} own={own} headingLevel={3} avatarQuery={avatarQuery} locale={locale}
      messages={messages} />
  </section>;
}

const pillClass = cn('inline-flex h-9 items-center gap-2 rounded-full border border-border/80 px-4 text-sm',
  'outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring');

/**
 * A person's reading shelves, as on a Goodreads profile: every shelf with its
 * count, then the Works on each. When Main does not show them to this reader,
 * the profile says so without counting anything.
 */
function LibrarySection({ profile, library, avatarQuery, locale, messages }: {
  profile: AgentProfile; library: LibraryView; avatarQuery?: string; locale: UiLocale; messages: ProfileMessages;
}) {
  const t = materializeData(messages, { locale });
  const heading = <h2 id="profile-shelves" className="text-balance font-semibold text-2xl tracking-tight">
    {t.shelvesHeading({ name: profile.displayName })}</h2>;
  if (library.kind === 'failed') {
    return <Failure failure={library.failure} title={t.shelvesUnavailable} retryHref={profileHref(profile)}
      t={t} />;
  }
  if (library.kind === 'private') {
    return <section aria-labelledby="profile-shelves" className="grid gap-3">
      {heading}
      <p className="flex items-center gap-2 text-muted-foreground">
        <LockIcon aria-hidden="true" className="size-4 shrink-0" />
        {library.visibility === 'followers' ? t.followersShelves({ name: profile.displayName })
          : t.privateShelves({ name: profile.displayName })}</p>
    </section>;
  }
  return <>
    <section aria-labelledby="profile-shelves" className="grid gap-4 border-border/70 border-b pb-5">
      {heading}
      <nav aria-label={t.shelfSummary}>
        <ul className="flex flex-wrap gap-2">
          {library.shelves.map(shelf => <li key={shelf.status}>
            <Link href={profileHref(profile, { kind: 'shelf', status: shelf.status })} className={pillClass}>
              {shelfLabel(shelf.status, t)}
              <span className="text-muted-foreground tabular-nums">{new Intl.NumberFormat(locale).format(shelf.count)}{shelf.countKind === 'lower-bound' ? '+' : ''}</span>
            </Link>
          </li>)}
        </ul>
      </nav>
      {library.own ? <p className="flex items-center gap-2 text-muted-foreground text-sm">
        <LockIcon aria-hidden="true" className="size-4 shrink-0" />{t.ownShelves}</p> : null}
    </section>
    {library.shelves.filter(shelf => shelf.count > 0 || shelf.countKind === 'lower-bound').map(shelf => {
      const title = <>{shelfLabel(shelf.status, t)} <span className="font-normal text-muted-foreground tabular-nums">
        {new Intl.NumberFormat(locale).format(shelf.count)}{shelf.countKind === 'lower-bound' ? '+' : ''}</span></>;
      return shelf.works.ok
        ? <WorkShelf key={shelf.status} heading={{ title,
          seeAll: { href: profileHref(profile, { kind: 'shelf', status: shelf.status }) } }}
          works={shelf.works.data.map(shelfCard)} avatarQuery={avatarQuery} locale={locale} />
        : <Failure key={shelf.status} failure={shelf.works.failure} title={t.shelfUnavailable}
          retryHref={profileHref(profile)} t={t} />;
    })}
  </>;
}

export interface ProfilePageProps {
  profile: AgentProfile;
  works: Loaded<AgentWorksPage>;
  follow: Loaded<FollowState>;
  /** Null for organizations and services, which keep no reading shelves. */
  library: LibraryView | null;
  reader: ProfileReader;
  /** Stories supply these; pages derive them from the session. */
  readerActions?: ReaderActions;
  followActions?: FollowActions;
  locale: UiLocale;
  messages: ProfileMessages;
  /** Stories can supply a small public activity page without a running Main. */
  contributionsRead?: (kind: 'posts' | 'comments', cursor?: string) => Promise<ContributionPage>;
}

/**
 * `/@{handle}`: one template for every Agent. An author leads with their
 * works, a reader with their shelves; an author who reads shows both, and an
 * organization shows the works it is credited on.
 */
export function ProfilePage({ profile, works, follow, library, reader, readerActions, followActions, locale,
  messages, contributionsRead }: ProfilePageProps) {
  const t = materializeData(messages, { locale });
  const credited = works.ok && works.data.items.length > 0;
  const hasShelves = library?.kind === 'shelves' && library.shelves.some(shelf => shelf.count > 0 || shelf.countKind === 'lower-bound');
  const worksRegion = !works.ok || credited
    ? <WorksSection profile={profile} works={works} own={ownProfile(reader, profile)} avatarQuery={reader.avatarQuery}
      locale={locale} messages={messages} /> : null;
  const libraryRegion = library && (library.kind !== 'shelves' || hasShelves || library.own)
    ? <LibrarySection profile={profile} library={library} avatarQuery={reader.avatarQuery} locale={locale}
      messages={messages} /> : null;
  return <ReaderActionsProvider signedIn={reader.signedIn} actions={readerActions}
    signInHref={signInPath(localizedPath(profileHref(profile), locale))}
    actingSubject={reader.seed === null ? null : reader.actingSubject} seed={reader.seed ?? undefined}>
    {/* Names and headings mix Latin and CJK ("Moonlit Scribe的书架"); space them apart. */}
    <PageContainer className="grid gap-12 [text-autospace:normal]">
      <ProfileHeader profile={profile} credited={credited} follow={follow} reader={reader}
        followActions={followActions} locale={locale} messages={messages} />
      {profile.kind === 'person' ? <ProfileContributions agent={profile.id}
        actingSubject={reader.actingSubject ?? null} locale={locale} messages={messages}
        load={contributionsRead}>
        {worksRegion || libraryRegion ? <div className="grid gap-12">{worksRegion}{libraryRegion}</div>
          : <EmptyState icon={UserRoundIcon} title={t.nothingYetTitle({ name: profile.displayName })}
            description={t.nothingYetBody} />}
      </ProfileContributions>
        : worksRegion || libraryRegion ? <div className="grid gap-12">{worksRegion}{libraryRegion}</div>
          : <EmptyState icon={UserRoundIcon} title={t.nothingYetTitle({ name: profile.displayName })}
            description={t.nothingYetWorksBody} />}
    </PageContainer>
  </ReaderActionsProvider>;
}

/** Main could not answer for the profile: say so and offer a retry, rather than pretend it does not exist. */
export function ProfileUnavailable({ handle, locale, messages }: { handle: string; locale: UiLocale;
  messages: ProfileMessages }) {
  const t = materializeData(messages, { locale });
  return <PageContainer>
    <EmptyState icon={TriangleAlertIcon} tone="destructive" role="alert" headingLevel={1} title={t.unavailableTitle}
      description={t.unavailableBody}>
      <Link href={profileHref(handle)} className={buttonVariants()}><RotateCwIcon aria-hidden="true" />{t.retry}</Link>
    </EmptyState>
  </PageContainer>;
}

/** A full list under a profile (all works, one shelf): the person it belongs to, its title and pages. */
function ListFrame({ profile, title, count, view, cursor, nextCursor, reader, readerActions, locale, messages,
  children }: {
  profile: AgentProfile; title: string; count?: ReactNode; view: ProfileView; cursor?: string;
  nextCursor: string | null; reader: ProfileReader; readerActions?: ReaderActions; locale: UiLocale;
  messages: ProfileMessages; children: ReactNode;
}) {
  const t = materializeData(messages, { locale });
  return <ReaderActionsProvider signedIn={reader.signedIn} actions={readerActions}
    signInHref={signInPath(localizedPath(profileHref(profile, view, cursor), locale))}
    actingSubject={reader.seed === null ? null : reader.actingSubject} seed={reader.seed ?? undefined}>
    <PageContainer className="grid gap-8 [text-autospace:normal]">
      <header className="grid gap-4">
        <Link href={profileHref(profile)} className="flex w-fit items-center gap-3 rounded-full pe-3
          outline-none hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring">
          <ProfileAvatar name={profile.displayName} kind={profile.kind} avatarUrl={profile.avatarUrl}
            avatarQuery={reader.avatarQuery} size="sm" />
          <span className="grid min-w-0">
            <span className="truncate font-medium">{profile.displayName}</span>
            {profile.handle ? <span className="truncate text-muted-foreground text-sm">@{profile.handle}</span> : null}
          </span>
          <span className="sr-only">{t.backTo({ name: profile.displayName })}</span>
        </Link>
        <h1 className="flex flex-wrap items-baseline gap-x-3 text-balance font-semibold text-3xl tracking-tight
          sm:text-4xl">{title}{count}</h1>
      </header>
      {children}
      {cursor || nextCursor ? <nav aria-label={title} className="flex flex-wrap justify-between gap-3">
        {cursor ? <Link href={profileHref(profile, view)} className={buttonVariants({ variant: 'outline' })}>
          <ChevronLeftIcon aria-hidden="true" className="rtl:rotate-180" />{t.firstPage}</Link> : <span />}
        {nextCursor ? <Link href={profileHref(profile, view, nextCursor)} rel="next"
          className={buttonVariants({ variant: 'outline' })}>{t.nextPage}
          <ChevronRightIcon aria-hidden="true" className="rtl:rotate-180" /></Link> : null}
      </nav> : null}
    </PageContainer>
  </ReaderActionsProvider>;
}

/** `/@{handle}/works`: every Work the Agent is credited on, twenty to a page. */
export function ProfileWorksPage({ profile, works, cursor, reader, readerActions, locale, messages }: {
  profile: AgentProfile; works: Loaded<AgentWorksPage>; cursor?: string; reader: ProfileReader;
  readerActions?: ReaderActions; locale: UiLocale; messages: ProfileMessages;
}) {
  const t = materializeData(messages, { locale });
  const view = { kind: 'works' } as const;
  return <ListFrame profile={profile} title={t.worksHeading({ name: profile.displayName })} view={view} cursor={cursor}
    nextCursor={works.ok ? works.data.nextCursor : null} reader={reader} readerActions={readerActions} locale={locale}
    messages={messages}>
    {!works.ok ? <Failure failure={works.failure} title={t.worksUnavailable} retryHref={profileHref(profile, view)}
      t={t} />
      : works.data.items.length ? <WorkRows page={works.data} profile={profile} own={ownProfile(reader, profile)}
        headingLevel={2}
        avatarQuery={reader.avatarQuery} locale={locale} messages={messages} />
        : <p className="text-muted-foreground">{t.noWorks}</p>}
  </ListFrame>;
}

/** `/@{handle}/shelves/{status}`: one shelf in full, as a grid of covers. */
export function ProfileShelfPage({ profile, status, shelf, cursor, reader, readerActions, locale, messages }: {
  profile: AgentProfile; status: ShelfStatus;
  shelf: Loaded<{ count: number; countKind: 'exact' | 'lower-bound'; cards: ShelfCard[]; nextCursor: string | null }>; cursor?: string;
  reader: ProfileReader; readerActions?: ReaderActions; locale: UiLocale; messages: ProfileMessages;
}) {
  const t = materializeData(messages, { locale });
  const view = { kind: 'shelf', status } as const;
  const count = shelf.ok ? <span className="font-normal text-muted-foreground text-2xl tabular-nums">
    {new Intl.NumberFormat(locale).format(shelf.data.count)}{shelf.data.countKind === 'lower-bound' ? '+' : ''}</span> : null;
  return <ListFrame profile={profile} title={shelfLabel(status, t)} count={count} view={view} cursor={cursor}
    nextCursor={shelf.ok ? shelf.data.nextCursor : null} reader={reader} readerActions={readerActions} locale={locale}
    messages={messages}>
    {!shelf.ok ? <Failure failure={shelf.failure} title={t.shelfUnavailable} retryHref={profileHref(profile, view)}
      t={t} />
      : shelf.data.cards.length ? <WorkGrid works={shelf.data.cards.map(shelfCard)} headingLevel={2}
        avatarQuery={reader.avatarQuery} locale={locale} />
        : shelf.data.count === 0 && shelf.data.countKind === 'exact'
          ? <p className="text-muted-foreground">{t.shelfEmpty}</p> : null}
  </ListFrame>;
}
