import { buttonVariants } from '@rezics/ui/button';
import { cn } from '@rezics/ui/utils';
import { CircleSlashIcon, LibraryBigIcon, LinkIcon, StarIcon, XIcon } from 'lucide-react';
import { type ContractOf, materializeData } from 'native-i18n';
import type { UiLocale } from '../../i18n/define.ts';
import { type ReaderActions, ReaderActionsProvider } from '../catalogue/reader-actions.tsx';
import type { ReaderSeed } from '../catalogue/reader-store.ts';
import Link from '../shell/localized-link.tsx';
import { PageContainer } from '../shell/page.tsx';
import type { DiscoverMessages } from './messages.ts';
import { Notice } from './notice.tsx';
import type { DiscoveryLoader } from './query.ts';
import { type BrowseScope, sameScope, shortId } from './scope.ts';
import { DiscoverShelf } from './shelf.tsx';
import { type DiscoverState, discoverHref, type ShelfSpec, type WorkTypeKey, workTypes } from './state.ts';
import type { DiscoveryPage, DiscoveryQuery, Loaded, WorkName } from './types.ts';

/** A shelf with Main's query for it, its server-rendered first page and, for a genre, the genre's name. */
export interface LoadedShelf { spec: ShelfSpec; query: DiscoveryQuery; initial: Loaded<DiscoveryPage>; genre?: WorkName }

/** A Realm a page can name: its public name when Main gave one. */
export interface ScopeRealm { id: string; name: WorkName | null }

export interface DiscoverPageProps {
  /** Null when the URL is malformed; the page says so instead of widening the view. */
  state: DiscoverState | null;
  realm: ScopeRealm | null;
  /** The Realm in the URL is not public or does not exist. */
  realmMissing?: boolean;
  shelves: readonly LoadedShelf[];
  signedIn: boolean;
  signInHref: string;
  avatarQuery?: string;
  load?: DiscoveryLoader;
  /** The Agent a signed-in reader acts as, and their state for the Works on the page. */
  actingSubject?: string;
  readerSeed?: ReaderSeed;
  /** Stories supply reader actions; pages derive them from the session. */
  readerActions?: ReaderActions;
  locale: UiLocale;
  messages: DiscoverMessages;
}

type Text = ContractOf<DiscoverMessages>;

const byType = <K extends string>(prefix: K, type: WorkTypeKey | null) =>
  `${prefix}${type ? `${type[0]!.toUpperCase()}${type.slice(1)}` : 'All'}` as
    `${K}${'All' | 'Book' | 'Document' | 'Recipe'}`;

/** A shelf's title in readers' words ("Readers’ favorites", "Popular in Adventure"). */
export function shelfTitle(shelf: Pick<LoadedShelf, 'spec' | 'genre'>, t: Text): string {
  const { topic } = shelf.spec;
  const genre = shelf.genre?.value ?? t.thisGenre;
  switch (topic.kind) {
    case 'favorites': return t[byType('favorites', topic.type)];
    case 'recent': return t[byType('recent', topic.type)];
    case 'popular-in': return t.popularIn({ genre });
    case 'new-in': return t.newIn({ genre });
    case 'mine': return t.mineShelf;
  }
}

/** A community's name, or "Community 1a2b3c4d" while Main cannot name it. */
export const realmName = (realm: ScopeRealm, t: Text) => realm.name?.value ?? t.realmFallback({ id: shortId(realm.id) });

/** Moving between scopes: a pinned rating question belongs to its scope, and Mine has no genres. */
function hrefIn(state: DiscoverState, scope: BrowseScope): string {
  return discoverHref({ ...state, scope, context: null, term: scope.kind === 'mine' ? null : state.term });
}

const pill = cn('inline-flex h-9 items-center rounded-full px-4 font-medium text-sm outline-none transition-colors',
  'text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring',
  'aria-[current=page]:bg-foreground aria-[current=page]:text-background');

/** Whose picks the page shows, small beside the title: scope matters here, but is not the headline. */
function CommunitySwitch({ state, realm, t }: { state: DiscoverState; realm: ScopeRealm | null; t: Text }) {
  const choices: { scope: BrowseScope; label: string; lang?: string }[] = [
    { scope: { kind: 'global' }, label: t.everyone },
    ...(state.scope.kind === 'realm' && realm ? [{ scope: state.scope, label: realmName(realm, t),
      lang: realm.name?.language }] : []),
    { scope: { kind: 'mine' }, label: t.mine },
  ];
  return <nav aria-label={t.community} className="flex max-w-full gap-1 overflow-x-auto rounded-full border
    border-border/70 p-1 scrollbar-none">
    {choices.map(choice => <Link key={choice.label} href={hrefIn(state, choice.scope)} lang={choice.lang}
      aria-current={sameScope(choice.scope, state.scope) ? 'page' : undefined}
      className={cn(pill, 'h-8 max-w-56 shrink-0 truncate px-3.5')}>{choice.label}</Link>)}
  </nav>;
}

/**
 * `/discover`: shelves by meaning — readers' favorites, genres, recently
 * added books, guides and recipes — rather than by storage type. The overview
 * shows sideways rows; choosing a kind or genre shows its full lists. Scope
 * appears only once the reader picks a community or their own ratings.
 */
export function DiscoverView({ state, realm, realmMissing, shelves, signedIn, signInHref, avatarQuery, load,
  actingSubject, readerSeed, readerActions, locale, messages }: DiscoverPageProps) {
  const t = materializeData(messages, { locale });
  if (!state) {
    return <PageContainer className="grid gap-8">
      <h1 className="font-semibold text-3xl tracking-tight sm:text-4xl">{t.title}</h1>
      <Notice icon={LinkIcon} headingLevel={2} title={t.badLinkTitle} description={t.badLinkHelp}>
        <Link href="/discover" className={buttonVariants({ size: 'sm' })}>{t.browseEverything}</Link>
      </Notice>
    </PageContainer>;
  }
  const { scope } = state;
  const heading = scope.kind === 'realm' && realm
    ? { title: t.titleRealm({ realm: realmName(realm, t) }), description: t.descriptionRealm, lang: realm.name?.language }
    : scope.kind === 'mine' ? { title: t.titleMine, description: t.descriptionMine } : { title: t.title, description: t.description };
  const overview = scope.kind !== 'mine' && !state.type && !state.term;
  const neighbour = scope.kind === 'global' ? undefined : { href: hrefIn(state, { kind: 'global' }), label: t.seeEverything };
  const genre = shelves.find(shelf => shelf.genre)?.genre
    ?? shelves.flatMap(shelf => shelf.initial.ok && shelf.initial.data.matchedTerm ? [shelf.initial.data.matchedTerm.name] : [])[0];
  const genreLabel = genre ? t.genreFilter({ genre: genre.value }) : t.genreUnknown;
  const seeAll = (shelf: LoadedShelf) => {
    const { topic } = shelf.spec;
    if (!overview || topic.kind === 'mine') return undefined;
    return { href: discoverHref('term' in topic ? { ...state, term: topic.term } : { ...state, type: topic.type }) };
  };
  return <ReaderActionsProvider signedIn={signedIn} signInHref={signInHref} actingSubject={actingSubject}
    seed={readerSeed} actions={readerActions}>
    <PageContainer className="grid gap-10 sm:gap-12">
      <header className="grid gap-5">
        <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-4">
          <div className="min-w-0 space-y-1.5">
            <h1 lang={heading.lang} className="text-balance font-semibold text-3xl tracking-tight sm:text-4xl">
              {heading.title}</h1>
            <p className="text-pretty text-muted-foreground">{heading.description}</p>
          </div>
          <CommunitySwitch state={state} realm={realm} t={t} />
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
          <nav aria-label={t.typeFilter} className="-mx-1 flex gap-1 overflow-x-auto px-1 scrollbar-none">
            <Link href={discoverHref({ ...state, type: null })} aria-current={state.type === null ? 'page' : undefined}
              className={pill}>{t.allTypes}</Link>
            {workTypes.map(type => <Link key={type.key} href={discoverHref({ ...state, type: type.key })}
              aria-current={state.type === type.key ? 'page' : undefined} className={pill}>{t[type.key]}</Link>)}
          </nav>
          {state.term ? <p className="inline-flex h-9 items-center gap-1 rounded-full bg-secondary ps-4 pe-1 text-sm">
            <span lang={genre?.language} className="max-w-[min(24rem,60vw)] truncate">{genreLabel}</span>
            <Link href={discoverHref({ ...state, term: null })} aria-label={t.removeFilter({ filter: genreLabel })}
              className="grid size-7 place-items-center rounded-full outline-none hover:bg-background/70
                focus-visible:ring-2 focus-visible:ring-ring"><XIcon aria-hidden="true" className="size-3.5" /></Link>
          </p> : null}
        </div>
      </header>
      {realmMissing ? <Notice icon={CircleSlashIcon} headingLevel={2} title={t.realmMissingTitle}>
        <Link href={hrefIn(state, { kind: 'global' })} className={buttonVariants({ size: 'sm' })}>{t.browseEverything}</Link>
      </Notice> : !shelves.length ? <Notice icon={StarIcon} headingLevel={2} title={t.noRatingsYet}
        description={t.noRatingsHelp} /> : overview && shelves.every(shelf => shelf.initial.ok
          && !shelf.initial.data.items.length)
        // Empty rows hide themselves; when all are empty, say so rather than show a bare page.
        ? <Notice icon={LibraryBigIcon} headingLevel={2} title={t.empty} description={t.emptyHelp}>
          {neighbour ? <Link href={neighbour.href} className={buttonVariants({ size: 'sm', variant: 'outline' })}>
            {neighbour.label}</Link> : null}
        </Notice> : shelves.map(shelf => <DiscoverShelf key={shelf.spec.key}
        heading={{ title: shelfTitle(shelf, t), seeAll: seeAll(shelf) }}
        mode={overview ? 'row' : 'grid'} scope={scope} query={shelf.query} initial={shelf.initial} load={load}
        neighbour={neighbour} signInHref={signInHref} avatarQuery={avatarQuery} locale={locale} messages={messages} />)}
    </PageContainer>
  </ReaderActionsProvider>;
}

