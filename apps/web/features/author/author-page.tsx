import { initials } from '@rezics/ui/avatar-initials';
import { buttonVariants } from '@rezics/ui/button';
import { cn } from '@rezics/ui/utils';
import { ChevronLeftIcon, ChevronRightIcon, RefreshCwIcon, RotateCwIcon, StarIcon, TriangleAlertIcon } from 'lucide-react';
import { materializeData } from 'native-i18n';
import type { ReactNode } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import { localizedPath } from '../../i18n/locale.ts';
import { signInPath } from '../auth/paths.ts';
import { type ReaderActions, ReaderActionsProvider } from '../catalogue/reader-actions.tsx';
import type { ReaderSeed } from '../catalogue/reader-store.ts';
import { type CatalogueWork, coverKindOf, formatCompact, formatMean } from '../catalogue/work.ts';
import { WorkRow } from '../catalogue/work-row.tsx';
import { Notice } from '../discover/notice.tsx';
import { EmptyState } from '../shell/empty-state.tsx';
import Link from '../shell/localized-link.tsx';
import { PageContainer } from '../shell/page.tsx';
import { workHref } from '../work-page/route.ts';
import { authorName, formatAuthorDate, lifespan, retrievedOn } from './facts.ts';
import type { AuthorMessages } from './messages.ts';
import { type AuthorView, openLibraryAuthorHref } from './route.ts';
import type { AuthorIdentifier, AuthorTotals, AuthorWork, AuthorWorksPage, ExternalAuthor, Loaded,
  ReadFailure } from './types.ts';

type Text = ReturnType<typeof materializeData<AuthorMessages>>;

/** Who is looking: signed in or not, the Agent they act as, and their shelf state for the Works shown. */
export interface AuthorReader {
  signedIn: boolean;
  actingSubject?: string | null;
  /** Cover bytes go through the BFF, which then needs the reader's Agent. */
  avatarQuery?: string;
  /** Null when Main denies this Agent a reader library; shelf buttons are then not drawn. */
  seed?: ReaderSeed | null;
}

/** A credited Work as a catalogue row: cover, title, every credited author, Global rating, pitch. */
export function authorCard(item: AuthorWork): CatalogueWork {
  return { id: item.id, href: workHref(item.id.slice(-36)), title: item.title, cover: item.cover,
    kind: coverKindOf(item.types),
    authors: item.authors.flatMap(credit => credit.displayName ? [credit.displayName]
      : credit.kind === 'external' ? [credit.key.replace(/^\/authors\//, '')] : []),
    rating: item.rating ? { mean: item.rating.mean, count: item.rating.count, max: item.rating.scale.max } : null,
    tagline: item.tagline, completion: item.completionStatus };
}

/**
 * A portrait without a photograph: Open Library's author photos are images,
 * not facts, so the page draws the name's initials in the Work-title face,
 * as a REZICS profile without a photo does.
 */
function Portrait({ name, size = 'lg', className }: { name: string; size?: 'sm' | 'lg'; className?: string }) {
  return <span aria-hidden="true" className={cn('relative grid shrink-0 place-items-center overflow-hidden rounded-full',
    'bg-accent text-accent-foreground after:absolute after:inset-0 after:rounded-[inherit] after:border',
    'after:border-foreground/8', size === 'lg' ? 'size-20 text-3xl sm:size-40 sm:text-6xl' : 'size-10 text-base',
    className)}>
    <span className="font-semibold font-work-title leading-none">{initials(name)}</span>
  </span>;
}

const count = (value: { value: number; kind: 'exact' | 'lower-bound' }, locale: UiLocale) =>
  `${value.value >= 10_000 ? formatCompact(value.value, locale) : new Intl.NumberFormat(locale).format(value.value)}${
    value.kind === 'lower-bound' ? '+' : ''}`;

/**
 * What the author's Works add up to on REZICS, as Goodreads sums up an author
 * above their books: works, the mean over every rating, ratings and readers.
 * Numbers lead; each label follows in the reading order of a definition list.
 */
function Totals({ totals, locale, messages }: { totals: AuthorTotals; locale: UiLocale; messages: AuthorMessages }) {
  const t = materializeData(messages, { locale });
  const item = (label: string, value: ReactNode) => <div className="flex flex-col-reverse gap-0.5">
    <dt className="text-muted-foreground text-sm">{label}</dt>
    <dd className="font-semibold text-2xl tabular-nums tracking-tight">{value}</dd>
  </div>;
  return <dl aria-label={t.totals} className="flex flex-wrap gap-x-10 gap-y-4">
    {item(t.worksLabel(totals.works.value), count(totals.works, locale))}
    {totals.ratings ? item(t.averageLabel, <span className="inline-flex items-center gap-1.5">
      <StarIcon aria-hidden="true" className="size-5 fill-current text-rating" />
      {formatMean(totals.ratings.mean, locale)}
      {totals.ratings.scale.max === 5 ? null
        : <span className="font-normal text-base text-muted-foreground">/{totals.ratings.scale.max}</span>}
    </span>) : null}
    {item(t.ratingsLabel(totals.ratings?.count.value ?? 0),
      totals.ratings ? count(totals.ratings.count, locale) : 0)}
    {totals.readers ? item(t.readersLabel(totals.readers.value), count(totals.readers, locale)) : null}
  </dl>;
}

function AuthorHeader({ author, locale, messages }: { author: ExternalAuthor; locale: UiLocale;
  messages: AuthorMessages }) {
  const t = materializeData(messages, { locale });
  const name = authorName(author, t);
  const years = lifespan(author.facts, locale, messages);
  return <header className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-5 gap-y-6 sm:items-start
    sm:gap-x-10">
    <Portrait name={name} className="sm:row-span-2" />
    <div className="min-w-0 space-y-1.5 sm:pt-3">
      <p className="font-medium text-muted-foreground text-sm">{t.author}</p>
      <h1 className="text-balance font-semibold font-work-title text-3xl/tight tracking-tight [overflow-wrap:anywhere]
        sm:text-5xl/tight">{name}</h1>
      {years ? <p className="text-lg text-muted-foreground tabular-nums">{years}</p> : null}
    </div>
    <div className="col-span-2 sm:col-span-1 sm:col-start-2">
      <Totals totals={author.totals} locale={locale} messages={messages} />
    </div>
  </header>;
}

const completionText = (completion: AuthorWork['completionStatus'], t: Text) =>
  completion === 'ongoing' ? t.serialOngoing : completion === 'hiatus' ? t.serialHiatus : null;

/** Works as Goodreads lists an author's books: cover rows, most rated first, with the rating, pitch and shelf button. */
function WorkRows({ items, headingLevel, avatarQuery, locale, messages }: {
  items: readonly AuthorWork[]; headingLevel: 2 | 3; avatarQuery?: string; locale: UiLocale; messages: AuthorMessages;
}) {
  const t = materializeData(messages, { locale });
  return <ol className="grid divide-y divide-border/70">
    {items.map(item => <li key={item.id} className="py-6 first:pt-2">
      <WorkRow work={authorCard(item)} headingLevel={headingLevel} avatarQuery={avatarQuery} locale={locale}>
        {completionText(item.completionStatus, t)}</WorkRow>
    </li>)}
  </ol>;
}

/** A region that could not load, said quietly with a way to try again. */
function Failure({ failure, title, retryHref, t }: { failure: ReadFailure; title: string; retryHref: string; t: Text }) {
  const moved = failure === 'moved';
  return <Notice icon={moved ? RefreshCwIcon : TriangleAlertIcon} tone={moved ? 'default' : 'destructive'}
    headingLevel={2} title={moved ? t.movedTitle : title} description={moved ? t.movedBody : undefined}>
    <Link href={retryHref} className={buttonVariants({ size: 'sm', variant: 'outline' })}>
      {moved ? t.firstPage : <><RotateCwIcon aria-hidden="true" />{t.retry}</>}</Link>
  </Notice>;
}

const linkClass = cn('group flex items-baseline gap-3 rounded-sm py-1.5 outline-none',
  'focus-visible:ring-2 focus-visible:ring-ring');
const readingSchemes = ['project_gutenberg', 'librivox'] as const;

/** One onward link: where it goes, what it holds or the identifier there, and the outward arrow the Work page uses. */
function Onward({ href, label, note, mono }: { href: string; label: string; note: string; mono?: boolean }) {
  return <li><a href={href} rel="noreferrer" className={linkClass}>
    <span className="font-medium underline-offset-4 group-hover:underline">{label}</span>
    <span className={cn('ms-auto truncate text-muted-foreground text-sm', mono && 'font-mono text-xs')}>{note}</span>
    <span aria-hidden="true" className="text-muted-foreground text-xs">↗</span>
  </a></li>;
}

/**
 * The record behind the page, as Open Library lists it: the full dates, a
 * fuller name, free editions to read or hear, the catalogues that identify
 * the author, and where and when REZICS took these facts. No biography: Open
 * Library's is prose, not a fact REZICS may repeat.
 */
function AuthorRecord({ author, locale, messages }: { author: ExternalAuthor; locale: UiLocale;
  messages: AuthorMessages }) {
  const t = materializeData(messages, { locale });
  const facts = author.facts;
  const details = [
    ...facts?.birthDate ? [[t.born, formatAuthorDate(facts.birthDate, locale, messages)] as const] : [],
    ...facts?.deathDate ? [[t.died, formatAuthorDate(facts.deathDate, locale, messages)] as const] : [],
    ...facts?.fullerName ? [[t.fullName, facts.fullerName.value] as const] : [],
  ];
  const identifiers = facts?.identifiers ?? [];
  const reading = identifiers.filter(item => (readingSchemes as readonly string[]).includes(item.scheme));
  const records = identifiers.filter(item => !(readingSchemes as readonly string[]).includes(item.scheme));
  const label = (item: AuthorIdentifier) => t[item.scheme];
  const retrieved = author.name ? retrievedOn(author.name.nameSource.fetchedAt, locale) : null;
  const id = author.key.replace(/^\/authors\//, '');
  const heading = 'font-semibold text-muted-foreground text-xs uppercase tracking-wider';
  return <aside className="grid content-start gap-8 text-[0.9375rem]">
    {details.length ? <section aria-labelledby="author-details" className="grid gap-3">
      <h2 id="author-details" className={heading}>{t.details}</h2>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-6 gap-y-2">
        {details.map(([term, value]) => <div key={term} className="contents">
          <dt className="text-muted-foreground">{term}</dt><dd className="[overflow-wrap:anywhere]">{value}</dd>
        </div>)}
      </dl>
    </section> : null}
    {reading.length ? <section aria-labelledby="author-read-free" className="grid gap-2">
      <h2 id="author-read-free" className={heading}>{t.readFree}</h2>
      <ul className="grid divide-y divide-border/60">
        {reading.map(item => <Onward key={item.scheme} href={item.url} label={label(item)}
          note={item.scheme === 'librivox' ? t.librivoxNote : t.project_gutenbergNote} />)}
      </ul>
    </section> : null}
    <section aria-labelledby="author-records" className="grid gap-2">
      <h2 id="author-records" className={heading}>{t.records}</h2>
      <ul className="grid divide-y divide-border/60">
        <Onward href={`https://openlibrary.org${author.key}`} label={t.openLibrary} note={id} mono />
        {records.map(item => <Onward key={item.scheme} href={item.url} label={label(item)} note={item.value} mono />)}
      </ul>
    </section>
    <p className="text-pretty text-muted-foreground text-xs leading-relaxed">
      {retrieved ? t.sourceNote({ date: retrieved }) : t.sourceNoteUndated}{' '}
      <a href={author.record} rel="noreferrer"
        className="whitespace-nowrap rounded-sm font-medium text-foreground underline underline-offset-4 outline-none
          focus-visible:ring-2 focus-visible:ring-ring">{t.viewRecord}</a>
    </p>
  </aside>;
}

export interface AuthorPageProps {
  author: ExternalAuthor;
  reader: AuthorReader;
  /**
   * "More from this author's readers": the slot for a row of Works the
   * author's readers also enjoyed, once Main serves that read (G-381).
   */
  alsoEnjoyed?: ReactNode;
  /** Stories supply these; pages derive them from the session. */
  readerActions?: ReaderActions;
  locale: UiLocale;
  messages: AuthorMessages;
}

/**
 * `/authors/open-library/{id}`: an author Open Library lists, as REZICS knows
 * them. The header leads with the name, their years and what their Works add
 * up to here; the Works follow, most rated first, beside the record's facts
 * and the places to read them free or look them up.
 */
export function AuthorPage({ author, reader, alsoEnjoyed, readerActions, locale, messages }: AuthorPageProps) {
  const t = materializeData(messages, { locale });
  const name = authorName(author, t);
  const href = openLibraryAuthorHref(author.key);
  return <ReaderActionsProvider signedIn={reader.signedIn} actions={readerActions}
    signInHref={signInPath(localizedPath(href, locale))}
    actingSubject={reader.seed === null ? null : reader.actingSubject} seed={reader.seed ?? undefined}>
    {/* Names and headings mix Latin and CJK; space them apart. */}
    <PageContainer className="grid gap-12 [text-autospace:normal]">
      <AuthorHeader author={author} locale={locale} messages={messages} />
      <div className="grid gap-12 lg:grid-cols-[minmax(0,1fr)_17rem] lg:gap-16">
        <div className="grid min-w-0 content-start gap-12">
          <section aria-labelledby="author-works" className="grid gap-4">
            <header className="flex items-end justify-between gap-4 border-border/70 border-b pb-4">
              <h2 id="author-works" className="text-balance font-semibold text-2xl tracking-tight">
                {t.worksHeading({ name })}</h2>
              {author.works.nextCursor ? <Link href={openLibraryAuthorHref(author.key, { kind: 'works' })}
                className="inline-flex shrink-0 items-center gap-0.5 rounded-sm font-medium text-primary text-sm
                  outline-none underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:ring-ring">
                {t.allWorks}<ChevronRightIcon aria-hidden="true" className="size-4 rtl:rotate-180" /></Link> : null}
            </header>
            {author.works.items.length ? <WorkRows items={author.works.items} headingLevel={3}
              avatarQuery={reader.avatarQuery} locale={locale} messages={messages} />
              : <p className="text-muted-foreground">{t.noWorks}</p>}
          </section>
          {alsoEnjoyed}
        </div>
        <AuthorRecord author={author} locale={locale} messages={messages} />
      </div>
    </PageContainer>
  </ReaderActionsProvider>;
}

/** Main could not answer for the author: say so and offer a retry, rather than pretend they do not exist. */
export function AuthorUnavailable({ authorKey, locale, messages }: { authorKey: string; locale: UiLocale;
  messages: AuthorMessages }) {
  const t = materializeData(messages, { locale });
  return <PageContainer>
    <EmptyState icon={TriangleAlertIcon} tone="destructive" role="alert" headingLevel={1} title={t.unavailableTitle}
      description={t.unavailableBody}>
      <Link href={openLibraryAuthorHref(authorKey)} className={buttonVariants()}>
        <RotateCwIcon aria-hidden="true" />{t.retry}</Link>
    </EmptyState>
  </PageContainer>;
}

/** `/authors/open-library/{id}/works`: every Work crediting the author, twenty to a page, in the page's order. */
export function AuthorWorksListPage({ author, works, cursor, reader, readerActions, locale, messages }: {
  author: ExternalAuthor; works: Loaded<AuthorWorksPage>; cursor?: string; reader: AuthorReader;
  readerActions?: ReaderActions; locale: UiLocale; messages: AuthorMessages;
}) {
  const t = materializeData(messages, { locale });
  const name = authorName(author, t);
  const view: AuthorView = { kind: 'works' };
  const title = t.worksHeading({ name });
  const nextCursor = works.ok ? works.data.nextCursor : null;
  const page = (target: AuthorView, at?: string) => openLibraryAuthorHref(author.key, target, at);
  return <ReaderActionsProvider signedIn={reader.signedIn} actions={readerActions}
    signInHref={signInPath(localizedPath(openLibraryAuthorHref(author.key, view, cursor), locale))}
    actingSubject={reader.seed === null ? null : reader.actingSubject} seed={reader.seed ?? undefined}>
    <PageContainer className="grid gap-8 [text-autospace:normal]">
      <header className="grid gap-4">
        <Link href={page({ kind: 'overview' })} className="flex w-fit items-center gap-3 rounded-full pe-3
          outline-none hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring">
          <Portrait name={name} size="sm" />
          <span className="truncate font-medium">{name}</span>
          <span className="sr-only">{t.backTo({ name })}</span>
        </Link>
        <h1 className="text-balance font-semibold text-3xl tracking-tight sm:text-4xl">{title}</h1>
      </header>
      {!works.ok ? <Failure failure={works.failure} title={t.worksUnavailable}
        retryHref={page(view)} t={t} />
        : works.data.items.length ? <WorkRows items={works.data.items} headingLevel={2}
          avatarQuery={reader.avatarQuery} locale={locale} messages={messages} />
          : <p className="text-muted-foreground">{t.noWorks}</p>}
      {cursor || nextCursor ? <nav aria-label={title} className="flex flex-wrap justify-between gap-3">
        {cursor ? <Link href={page(view)} className={buttonVariants({ variant: 'outline' })}>
          <ChevronLeftIcon aria-hidden="true" className="rtl:rotate-180" />{t.firstPage}</Link> : <span />}
        {nextCursor ? <Link href={page(view, nextCursor)} rel="next"
          className={buttonVariants({ variant: 'outline' })}>{t.nextPage}
          <ChevronRightIcon aria-hidden="true" className="rtl:rotate-180" /></Link> : null}
      </nav> : null}
    </PageContainer>
  </ReaderActionsProvider>;
}
