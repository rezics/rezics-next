import { buttonVariants } from '@rezics/ui/button';
import { cn } from '@rezics/ui/utils';
import { CircleSlashIcon, LinkIcon, ListOrderedIcon, XIcon } from 'lucide-react';
import { type ContractOf, materializeData } from 'native-i18n';
import Link from 'next/link';
import type { UiLocale } from '../../i18n/define.ts';
import { PageContainer, PageHeader } from '../shell/page.tsx';
import type { DiscoverMessages } from './messages.ts';
import { Notice } from './notice.tsx';
import type { DiscoveryLoader } from './query.ts';
import type { BrowseScope } from './scope.ts';
import { ScopeBar, type ScopeRealm, scopeName } from './scope-bar.tsx';
import { Shelf } from './shelf.tsx';
import { type DiscoverState, discoverHref, type ShelfSpec, type WorkTypeKey, workTypes } from './state.ts';
import type { DiscoveryPage, DiscoveryQuery, Loaded } from './types.ts';

/** A shelf with Main's query for it and its server-rendered first page. */
export interface LoadedShelf { spec: ShelfSpec; query: DiscoveryQuery; initial: Loaded<DiscoveryPage> }

export interface DiscoverPageProps {
  /** Null when the URL is malformed; the page says so instead of widening the view. */
  state: DiscoverState | null;
  realm: ScopeRealm | null;
  /** The Realm in the URL is not public or does not exist. */
  realmMissing?: boolean;
  /** The chosen rating Context's question, when Main could read it. */
  question: { question: string; max: number } | null;
  shelves: readonly LoadedShelf[];
  signInHref: string;
  avatarQuery?: string;
  load?: DiscoveryLoader;
  locale: UiLocale;
  messages: DiscoverMessages;
}

const topRatedOf: Record<WorkTypeKey, 'topRatedBook' | 'topRatedDocument' | 'topRatedRecipe'> = {
  book: 'topRatedBook', document: 'topRatedDocument', recipe: 'topRatedRecipe' };

function shelfTitle(spec: ShelfSpec, t: ContractOf<DiscoverMessages>): string {
  if (spec.sort === 'top-rated') return spec.type ? t[topRatedOf[spec.type]] : t.topRated;
  if (spec.type) return t[spec.type];
  return spec.term ? t.termShelf : t.recent;
}

/** Moving between scopes: a Realm's rating Context means nothing elsewhere, and Mine has no terms. */
function hrefIn(state: DiscoverState, scope: BrowseScope): string {
  const context = state.scope.kind === 'realm' || scope.kind === 'realm' ? null : state.context;
  return discoverHref({ ...state, scope, context, term: scope.kind === 'mine' ? null : state.term });
}

function Pill({ href, current, children }: { href: string; current: boolean; children: string }) {
  return <Link href={href} aria-current={current ? 'page' : undefined} className={cn(
    'inline-flex h-8 items-center rounded-full border border-border px-3.5 font-medium text-sm outline-none',
    'transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring',
    'aria-[current=page]:border-primary/40 aria-[current=page]:bg-primary/10 aria-[current=page]:text-primary')}>
    {children}</Link>;
}

function Chip({ href, label, remove }: { href: string; label: string; remove: string }) {
  return <li className="inline-flex h-8 items-center gap-1 rounded-full bg-secondary ps-3.5 pe-1 text-sm">
    <span className="max-w-72 truncate">{label}</span>
    <Link href={href} aria-label={remove} title={remove} className="grid size-6 place-items-center rounded-full
      outline-none hover:bg-background/70 focus-visible:ring-2 focus-visible:ring-ring">
      <XIcon aria-hidden="true" className="size-3.5" /></Link>
  </li>;
}

/**
 * `/discover`: browse without a phrase. Each shelf is scoped and labelled with
 * its scope; filters live in the URL, and every failure is shown per shelf.
 */
export function DiscoverPage({ state, realm, realmMissing, question, shelves, signInHref, avatarQuery, load,
  locale, messages }: DiscoverPageProps) {
  const t = materializeData(messages, { locale });
  const header = <PageHeader title={t.title} description={t.description} />;
  if (!state) {
    return <PageContainer className="grid gap-8">{header}
      <Notice icon={LinkIcon} headingLevel={2} title={t.badLinkTitle} description={t.badLinkHelp}>
        <Link href="/discover" className={buttonVariants({ size: 'sm' })}>{t.startFromGlobal}</Link>
      </Notice>
    </PageContainer>;
  }
  const scopeLabel = scopeName(state.scope, realm, t);
  const line = state.scope.kind === 'global' ? t.scopeLineGlobal : state.scope.kind === 'mine' ? t.scopeLineMine
    : t.scopeLineRealm({ realm: scopeLabel });
  const neighbour = state.scope.kind === 'global' ? undefined
    : { href: hrefIn(state, { kind: 'global' }), label: t.seeGlobal };
  const filters = [
    ...(state.context ? [{ label: question ? t.contextFilter({ question: question.question }) : t.contextFilterUnknown,
      href: discoverHref({ ...state, context: null }) }] : []),
    ...(state.term ? [{ label: t.termFilter, href: discoverHref({ ...state, term: null }) }] : []),
  ];
  return <PageContainer className="grid gap-8">
    {header}
    <div className="grid gap-4">
      <ScopeBar scope={state.scope} realm={realm} hrefFor={scope => hrefIn(state, scope)} line={line} t={t} />
      <nav aria-label={t.typeFilter} className="flex flex-wrap gap-2">
        <Pill href={discoverHref({ ...state, type: null })} current={state.type === null}>{t.allTypes}</Pill>
        {workTypes.map(type => <Pill key={type.key} href={discoverHref({ ...state, type: type.key })}
          current={state.type === type.key}>{t[type.key]}</Pill>)}
      </nav>
      {filters.length ? <ul aria-label={t.activeFilters} className="flex flex-wrap gap-2">
        {filters.map(filter => <Chip key={filter.label} href={filter.href} label={filter.label}
          remove={t.removeFilter({ filter: filter.label })} />)}
      </ul> : null}
    </div>
    {realmMissing ? <Notice icon={CircleSlashIcon} headingLevel={2} title={t.realmMissingTitle}>
      <Link href={hrefIn(state, { kind: 'global' })} className={buttonVariants({ size: 'sm' })}>
        {t.startFromGlobal}</Link>
    </Notice> : !shelves.length ? <Notice icon={ListOrderedIcon} headingLevel={2} title={t.mineNeedsQuestion}
      description={t.mineNeedsQuestionHelp} /> : <div className="grid gap-12">
      {shelves.map(({ spec, query, initial }) => <Shelf key={spec.key} title={shelfTitle(spec, t)}
        scopeLabel={scopeLabel} scope={state.scope} query={query} initial={initial} load={load}
        subtitle={spec.sort === 'top-rated' ? question ? t.rankedBy({ question: question.question,
          max: String(question.max) }) : t.rankedByUnknown : spec.term ? t.termLine : undefined}
        browseAll={spec.type && !state.type ? { href: discoverHref({ ...state, type: spec.type }),
          label: t.browseAll({ shelf: t[spec.type] }) } : undefined}
        neighbour={neighbour} signInHref={signInHref} avatarQuery={avatarQuery} locale={locale}
        messages={messages} />)}
    </div>}
  </PageContainer>;
}
