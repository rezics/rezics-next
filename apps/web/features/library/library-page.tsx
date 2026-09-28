import { buttonVariants } from '@rezics/ui/button';
import { cn } from '@rezics/ui/utils';
import { BookMarkedIcon, BookOpenCheckIcon, BookOpenIcon, ChevronLeftIcon, ChevronRightIcon, CompassIcon, HouseIcon,
  LayoutGridIcon, LibraryBigIcon, ListIcon, LockIcon, RefreshCwIcon, RotateCwIcon, SearchXIcon, TriangleAlertIcon,
  UserRoundCogIcon } from 'lucide-react';
import { materializeData } from 'native-i18n';
import type { ReactNode } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import { localizedPath } from '../../i18n/locale.ts';
import type { ReaderActions } from '../catalogue/reader-actions.tsx';
import { CoverLink, workTitle } from '../catalogue/work-tile.tsx';
import { Notice } from '../discover/notice.tsx';
import { EmptyState } from '../shell/empty-state.tsx';
import Link from '../shell/localized-link.tsx';
import { PageContainer } from '../shell/page.tsx';
import type { LibraryApi } from './api.ts';
import { NewShelf, SortControl, VisibilityControl } from './controls.tsx';
import { LibraryProvider } from './library-context.tsx';
import { statusLabel } from './labels.ts';
import { LibraryList } from './library-list.tsx';
import type { LibraryMessages } from './messages.ts';
import type { ShelfView } from './read.ts';
import { ReadingProgress } from './row-parts.tsx';
import { type LibraryShelf, type LibraryState, libraryHref, shelfKey, statusShelves } from './state.ts';
import type { CustomShelf, LibraryOverview, LibraryRow, Loaded, ShelfStatus } from './types.ts';

type T = ReturnType<typeof materializeData<LibraryMessages>>;

const count = (value: number, locale: UiLocale) => new Intl.NumberFormat(locale).format(value);

const navItem = cn('flex min-h-10 items-center gap-2 whitespace-nowrap rounded-full border border-border/70 px-3.5',
  'text-sm outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring',
  'aria-[current=page]:border-transparent aria-[current=page]:bg-foreground aria-[current=page]:text-background',
  'lg:rounded-xl lg:border-transparent lg:px-3');

/**
 * The shelves, as Goodreads' "Bookshelves" column: All and the three status
 * shelves with their counts, then the reader's own. A row of chips that
 * scrolls on a phone, a column beside the list on a wide screen.
 */
function ShelfNav({ state, overview, locale, messages }: {
  state: LibraryState; overview: LibraryOverview; locale: UiLocale; messages: LibraryMessages;
}) {
  const t = materializeData(messages, { locale });
  const current = shelfKey(state.shelf);
  const href = (shelf: LibraryShelf) => libraryHref(state, { shelf, layout: state.layout });
  const total = statusShelves.reduce((sum, status) => sum + overview.counts[status], 0);
  const entries: { key: string; shelf: LibraryShelf; label: string; count: number }[] = [
    { key: 'all', shelf: { kind: 'all' }, label: t.all, count: total },
    ...statusShelves.map(status => ({ key: status, shelf: { kind: 'status', status } as const,
      label: statusLabel(status, t), count: overview.counts[status] })),
  ];
  return <nav aria-label={t.shelves} className="-mx-4 min-w-0 px-4 lg:mx-0 lg:px-0">
    <div className="flex gap-2 overflow-x-auto pb-1 [scrollbar-width:none] lg:grid lg:gap-6 lg:overflow-visible">
      <ul className="flex gap-2 lg:grid lg:gap-0.5">
        {entries.map(entry => <li key={entry.key}>
          <Link href={href(entry.shelf)} aria-current={current === entry.key ? 'page' : undefined} className={navItem}>
            <span className="lg:flex-1">{entry.label}</span>
            <span className="tabular-nums opacity-70">{count(entry.count, locale)}</span>
          </Link>
        </li>)}
      </ul>
      <div className="flex items-center gap-2 lg:grid lg:gap-1">
        <h2 className="hidden px-3 font-semibold text-muted-foreground text-xs uppercase tracking-wide lg:block">
          {t.yourShelves}</h2>
        {overview.customShelves.length ? <ul className="flex gap-2 lg:grid lg:gap-0.5">
          {overview.customShelves.map(shelf => {
            const id = shelf.id.slice(-36);
            return <li key={shelf.id}>
              <Link href={href({ kind: 'custom', id })} aria-current={current === id ? 'page' : undefined}
                className={navItem}>
                <span className="max-w-48 truncate lg:flex-1">{shelf.name}</span>
                {shelf.disclosure === 'private' ? <LockIcon role="img" aria-label={t.privateShelf}
                  className="size-3.5 shrink-0 opacity-70" /> : null}
              </Link>
            </li>;
          })}
        </ul> : null}
        <NewShelf locale={locale} messages={messages} className="shrink-0 rounded-full lg:w-fit lg:rounded-xl" />
      </div>
    </div>
  </nav>;
}

/** Currently reading, first on All as on StoryGraph: the latest few, each with how far and Continue. */
function CurrentlyReading({ rows, total, state, avatarQuery, locale, messages }: {
  rows: readonly LibraryRow[]; total: number; state: LibraryState; avatarQuery?: string; locale: UiLocale;
  messages: LibraryMessages;
}) {
  const t = materializeData(messages, { locale });
  return <section aria-labelledby="library-reading" className="grid gap-4">
    <header className="flex items-end justify-between gap-4">
      <h2 id="library-reading" className="font-semibold text-xl tracking-tight">{t.currentlyReading}</h2>
      {total > rows.length ? <Link href={libraryHref(state, { shelf: { kind: 'status', status: 'reading' } })}
        className="inline-flex items-center gap-0.5 rounded-sm font-medium text-primary text-sm outline-none
          underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:ring-ring">
        {t.all} {count(total, locale)}<ChevronRightIcon aria-hidden="true" className="size-4 rtl:rotate-180" /></Link>
        : null}
    </header>
    {/* A row that scrolls on a phone, so the shelf below stays in reach; a grid on wider screens. */}
    <ul className="-mx-4 flex snap-x snap-mandatory scroll-px-4 gap-3 overflow-x-auto px-4 pb-1 [scrollbar-width:none]
      sm:mx-0 sm:grid sm:grid-cols-2 sm:gap-4 sm:overflow-visible sm:px-0 xl:grid-cols-3">
      {rows.map(row => <li key={row.work.id} className="group/tile flex w-[85%] shrink-0 snap-start gap-4 rounded-2xl
        bg-muted/50 p-4 sm:w-auto">
        <CoverLink work={row.work} avatarQuery={avatarQuery} className="w-20 shrink-0 self-start" />
        <div className="grid min-w-0 flex-1 content-start gap-3">
          <h3 lang={row.work.title?.language} className="line-clamp-2 font-medium font-work-title text-base/snug">
            <Link href={row.work.href} className="rounded-sm outline-none hover:underline focus-visible:ring-2
              focus-visible:ring-ring">{workTitle(row.work, locale)}</Link></h3>
          <ReadingProgress row={row} locale={locale} messages={messages} />
        </div>
      </li>)}
    </ul>
  </section>;
}

/** List or grid, each its own address. */
function LayoutToggle({ state, locale, messages }: { state: LibraryState; locale: UiLocale; messages: LibraryMessages }) {
  const t = materializeData(messages, { locale });
  const item = cn('grid size-8 place-items-center rounded-full text-muted-foreground outline-none transition-colors',
    'hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring',
    'aria-[current=page]:bg-foreground aria-[current=page]:text-background');
  return <nav aria-label={t.layout} className="flex rounded-full bg-muted/70 p-0.5">
    <Link href={libraryHref(state, { layout: 'list' })} aria-current={state.layout === 'list' ? 'page' : undefined}
      aria-label={t.list} title={t.list} className={item}><ListIcon aria-hidden="true" className="size-4" /></Link>
    <Link href={libraryHref(state, { layout: 'grid' })} aria-current={state.layout === 'grid' ? 'page' : undefined}
      aria-label={t.grid} title={t.grid} className={item}><LayoutGridIcon aria-hidden="true" className="size-4" /></Link>
  </nav>;
}

function Pagination({ state, page, pages, locale, messages }: { state: LibraryState; page: number; pages: number;
  locale: UiLocale; messages: LibraryMessages }) {
  const t = materializeData(messages, { locale });
  if (pages < 2) return null;
  return <nav aria-label={t.pages} className="flex flex-wrap items-center justify-between gap-3">
    {page > 1 ? <Link href={libraryHref(state, { page: page - 1 })} rel="prev" className={buttonVariants({
      variant: 'outline' })}><ChevronLeftIcon aria-hidden="true" className="rtl:rotate-180" />{t.previousPage}</Link>
      : <span />}
    <p className="text-muted-foreground text-sm tabular-nums">{t.pageOf({ page: count(page, locale),
      pages: count(pages, locale) })}</p>
    {page < pages ? <Link href={libraryHref(state, { page: page + 1 })} rel="next" className={buttonVariants({
      variant: 'outline' })}>{t.nextPage}<ChevronRightIcon aria-hidden="true" className="rtl:rotate-180" /></Link>
      : <span />}
  </nav>;
}

const emptyText = (status: ShelfStatus, t: T) => status === 'reading' ? [t.emptyReading, t.emptyReadingBody]
  : status === 'read' ? [t.emptyRead, t.emptyReadBody] : [t.emptyWantToRead, t.emptyWantToReadBody];

/** A shelf with nothing on it says what belongs there and where to find some. */
function EmptyShelf({ shelf, locale, messages }: { shelf: LibraryShelf; locale: UiLocale; messages: LibraryMessages }) {
  const t = materializeData(messages, { locale });
  const [title, body] = shelf.kind === 'status' ? emptyText(shelf.status, t)
    : shelf.kind === 'custom' ? [t.emptyCustom, t.emptyCustomBody] : [t.firstUseTitle, t.firstUseBody];
  return <EmptyState icon={shelf.kind === 'status' && shelf.status === 'read' ? BookOpenCheckIcon : BookMarkedIcon}
    title={title} description={body}>
    {shelf.kind === 'custom' ? null : <Link href="/discover" className={buttonVariants({ size: 'sm' })}>
      <CompassIcon aria-hidden="true" />{t.discover}</Link>}
  </EmptyState>;
}

/**
 * A reader with nothing shelved yet: what the three shelves are for, and
 * the two places to find something, Discover and the home feed.
 */
function FirstUse({ locale, messages }: { locale: UiLocale; messages: LibraryMessages }) {
  const t = materializeData(messages, { locale });
  const shelves = [
    { icon: BookMarkedIcon, title: t.wantToRead, body: t.firstUseWant },
    { icon: BookOpenIcon, title: t.reading, body: t.firstUseReading },
    { icon: BookOpenCheckIcon, title: t.read, body: t.firstUseRead },
  ];
  return <section aria-labelledby="library-first-use" className="grid justify-items-center gap-8 rounded-3xl border
    border-border/80 border-dashed bg-card/60 px-6 py-12 text-center sm:py-16">
    <span className="grid size-14 place-items-center rounded-2xl bg-primary/10 text-primary">
      <LibraryBigIcon aria-hidden="true" className="size-7" /></span>
    <div className="grid max-w-xl gap-2">
      <h2 id="library-first-use" className="text-balance font-semibold text-2xl tracking-tight">{t.firstUseTitle}</h2>
      <p className="text-pretty text-muted-foreground">{t.firstUseBody}</p>
    </div>
    <ul className="grid w-full max-w-3xl gap-3 text-start sm:grid-cols-3">
      {shelves.map(shelf => <li key={shelf.title} className="grid gap-1.5 rounded-2xl bg-background p-4">
        <shelf.icon aria-hidden="true" className="size-5 text-primary" />
        <h3 className="font-medium">{shelf.title}</h3>
        <p className="text-pretty text-muted-foreground text-sm">{shelf.body}</p>
      </li>)}
    </ul>
    <div className="flex flex-wrap justify-center gap-2">
      <Link href="/discover" className={buttonVariants({ pill: true })}><CompassIcon aria-hidden="true" />{t.discover}</Link>
      <Link href="/" className={buttonVariants({ variant: 'outline', pill: true })}>
        <HouseIcon aria-hidden="true" />{t.homeFeed}</Link>
    </div>
  </section>;
}

function shelfTitle(shelf: LibraryShelf, custom: CustomShelf | null, t: T): string {
  return shelf.kind === 'all' ? t.all : shelf.kind === 'status' ? statusLabel(shelf.status, t) : custom?.name ?? '';
}

/** The chosen shelf: its name and count, sort and layout, the Works and the pages. */
function ShelfSection({ state, view, overview, now, avatarQuery, locale, messages }: {
  state: LibraryState; view: Loaded<ShelfView>; overview: LibraryOverview; now: number; avatarQuery?: string;
  locale: UiLocale; messages: LibraryMessages;
}) {
  const t = materializeData(messages, { locale });
  if (!view.ok) {
    if (view.failure === 'missing') {
      return <EmptyState icon={SearchXIcon} title={t.missingShelfTitle} description={t.missingShelfBody}>
        <Link href={libraryHref(state, { shelf: { kind: 'all' } })} className={buttonVariants({ size: 'sm',
          variant: 'outline' })}>{t.backToAll}</Link>
      </EmptyState>;
    }
    const moved = view.failure === 'moved';
    return <Notice icon={moved ? RefreshCwIcon : TriangleAlertIcon} tone={moved ? 'default' : 'destructive'}
      headingLevel={2} title={moved ? t.movedTitle : t.shelfUnavailable} description={moved ? t.movedBody : undefined}>
      <Link href={libraryHref(state)} className={buttonVariants({ size: 'sm', variant: 'outline' })}>
        <RotateCwIcon aria-hidden="true" />{moved ? t.reload : t.retry}</Link>
    </Notice>;
  }
  const { data } = view;
  const title = shelfTitle(data.shelf, data.custom, t);
  return <section aria-labelledby="library-shelf" className="grid gap-5">
    <header className="grid gap-1 border-border/70 border-b pb-4">
      <h2 id="library-shelf"
        className="flex flex-wrap items-baseline gap-x-3 text-balance font-semibold text-2xl tracking-tight">
        {title}<span className="font-normal text-muted-foreground text-lg tabular-nums">
          {count(data.total, locale)}{data.truncated ? '+' : ''}</span>
        {data.custom?.disclosure === 'private' ? <LockIcon role="img" aria-label={t.privateShelf}
          className="size-4 self-center text-muted-foreground" /> : null}
      </h2>
      {data.truncated ? <p className="text-muted-foreground text-sm">{t.truncated({ count: count(data.total, locale) })}</p>
        : null}
    </header>
    {data.rows.length
      ? <LibraryList rows={data.rows} shelf={data.shelf} custom={data.custom} customShelves={overview.customShelves}
        layout={state.layout} now={now} avatarQuery={avatarQuery} locale={locale} messages={messages}
        controls={<><SortControl state={state} locale={locale} messages={messages} />
          <LayoutToggle state={state} locale={locale} messages={messages} /></>} />
      : <EmptyShelf shelf={data.shelf} locale={locale} messages={messages} />}
    <Pagination state={state} page={data.page} pages={data.pages} locale={locale} messages={messages} />
  </section>;
}

export interface LibraryPageProps {
  state: LibraryState;
  overview: Loaded<LibraryOverview>;
  view: Loaded<ShelfView>;
  /** Currently reading for the top of All; empty elsewhere. */
  reading: readonly LibraryRow[];
  /** The server's clock, so relative times print the same on both sides. */
  now: number;
  avatarQuery?: string;
  /** Stories supply these; pages write to Main. */
  api?: LibraryApi;
  readerActions?: Extract<ReaderActions, { kind: 'ready' }>;
  locale: UiLocale;
  messages: LibraryMessages;
}

/**
 * `/library`: the reader's own books, Goodreads' "My Books" with StoryGraph's
 * progress. Shelves beside the list, Currently reading first, and every
 * shelf sortable, as a list or a grid, with several Works moved at once.
 */
export function LibraryPage({ state, overview, view, reading, now, avatarQuery, api, readerActions, locale,
  messages }: LibraryPageProps) {
  const t = materializeData(messages, { locale });
  if (!overview.ok) return <LibraryUnavailable failure={overview.failure} locale={locale} messages={messages} />;
  const { data } = overview;
  const total = statusShelves.reduce((sum, status) => sum + data.counts[status], 0);
  const firstUse = total === 0 && data.customShelves.length === 0;
  const titles = Object.fromEntries([...reading, ...view.ok ? view.data.rows : []]
    .map(row => [row.work.id, workTitle(row.work, locale)]));
  return <LibraryProvider actingSubject={data.agent} seed={view.ok ? view.data.seed : {}}
    ratingContext={data.ratingContext} titles={titles} api={api} readerActions={readerActions} locale={locale}
    messages={messages}>
    {/* Titles mix Latin and CJK; space them apart. */}
    <PageContainer className="grid gap-8 [text-autospace:normal]">
      <header className="flex flex-col gap-5 sm:flex-row sm:items-start sm:justify-between">
        <div className="grid gap-2">
          <h1 className="text-balance font-semibold text-3xl tracking-tight sm:text-4xl">{t.title}</h1>
          <p className="text-muted-foreground">{t.workCount(total)}</p>
        </div>
        <VisibilityControl initial={data.visibility} locale={locale} messages={messages} />
      </header>
      {firstUse ? <FirstUse locale={locale} messages={messages} />
        : <div className="grid gap-6 lg:grid-cols-[13rem_minmax(0,1fr)] lg:gap-12">
          <ShelfNav state={state} overview={data} locale={locale} messages={messages} />
          <div className="grid min-w-0 content-start gap-10">
            {state.shelf.kind === 'all' && reading.length && state.page === 1
              ? <CurrentlyReading rows={reading.slice(0, 3)} total={data.counts.reading} state={state}
                avatarQuery={avatarQuery} locale={locale} messages={messages} /> : null}
            <ShelfSection state={state} view={view} overview={data} now={now} avatarQuery={avatarQuery}
              locale={locale} messages={messages} />
          </div>
        </div>}
    </PageContainer>
  </LibraryProvider>;
}

/** Library could not be read: Main refused this identity a library, or could not answer. */
export function LibraryUnavailable({ failure, locale, messages }: { failure: string; locale: UiLocale;
  messages: LibraryMessages }) {
  const t = materializeData(messages, { locale });
  const denied = failure === 'sign-in';
  const action: ReactNode = denied
    ? <Link href={`/identity?next=${encodeURIComponent(localizedPath('/library', locale))}`} className={buttonVariants()}>
      <UserRoundCogIcon aria-hidden="true" />{t.switchIdentity}</Link>
    : <Link href="/library" className={buttonVariants()}><RotateCwIcon aria-hidden="true" />{t.retry}</Link>;
  return <PageContainer className="grid gap-8">
    <h1 className="font-semibold text-3xl tracking-tight sm:text-4xl">{t.title}</h1>
    <EmptyState icon={denied ? LockIcon : TriangleAlertIcon} tone={denied ? 'default' : 'destructive'}
      role={denied ? undefined : 'alert'} title={denied ? t.deniedTitle : t.unavailableTitle}
      description={denied ? t.deniedBody : t.unavailableBody}>{action}</EmptyState>
  </PageContainer>;
}
