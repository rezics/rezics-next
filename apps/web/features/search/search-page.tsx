import { buttonVariants } from '@rezics/ui/button';
import { cn } from '@rezics/ui/utils';
import { ChevronDownIcon, LinkIcon, SlidersHorizontalIcon, UserRoundIcon, XIcon } from 'lucide-react';
import { type ContractOf, materializeData } from 'native-i18n';
import Link from '../shell/localized-link.tsx';
import type { UiLocale } from '../../i18n/define.ts';
import { localizedPath } from '../../i18n/locale.ts';
import { signInPath } from '../auth/paths.ts';
import { type ReaderActions, ReaderActionsProvider } from '../catalogue/reader-actions.tsx';
import type { DiscoverMessages } from '../discover/messages.ts';
import { Notice } from '../discover/notice.tsx';
import { workTypes } from '../discover/state.ts';
import { PageContainer } from '../shell/page.tsx';
import type { SearchMessages } from './messages.ts';
import type { SearchLoader } from './query.ts';
import { type RealmOption, SearchForm } from './search-form.tsx';
import { SearchResults } from './search-results.tsx';
import { type ParsedSearch, phraseStatus, type SearchState, searchHref, searchLanguages } from './state.ts';
import type { SearchLoaded, SearchResultPage } from './types.ts';

type Text = ContractOf<SearchMessages>;

export interface SearchPageProps {
  parsed: ParsedSearch;
  /** The Realm in the URL, offered beside Global in the scope selector. */
  realm: RealmOption | null;
  initial: SearchLoaded | null;
  signedIn: boolean;
  actingSubject?: string;
  avatarQuery?: string;
  load?: SearchLoader;
  /** Stories supply reader actions; pages derive them from the session. */
  readerActions?: ReaderActions;
  locale: UiLocale;
  messages: SearchMessages;
  /** Still passed by the route; the result cards read catalogue strings now. */
  discoverMessages?: DiscoverMessages;
}

function languageName(tag: string, locale: UiLocale): string {
  try { return new Intl.DisplayNames([locale], { type: 'language' }).of(tag) ?? tag; } catch { return tag; }
}

/** The complete relation supplies Work-grain counts for its current filter basis. */
function Filters({ state, facets, idPrefix, locale, t }: { state: SearchState;
  facets?: SearchResultPage['facets']; idPrefix: string; locale: UiLocale; t: Text }) {
  const offered = [...new Set([...searchLanguages, ...(facets?.languages.values.map(item => item.value) ?? [])])];
  const languages = [null, ...offered, ...(state.language && !offered.includes(state.language)
    ? [state.language] : [])];
  return <div className="grid gap-5">
    <nav aria-labelledby={`${idPrefix}-language`} className="grid gap-1">
      <h2 id={`${idPrefix}-language`} className="mb-1 font-semibold text-sm">{t.language}</h2>
      <ul className="grid gap-0.5">
        {languages.map(language => <li key={language ?? 'any'}>
          <Link href={searchHref({ ...state, language })}
            aria-current={state.language === language ? 'true' : undefined}
            className="group/lang flex items-center gap-2.5 rounded-xl px-2 py-1.5 text-sm outline-none transition-colors
              hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring aria-[current=true]:bg-primary/10
              aria-[current=true]:font-medium aria-[current=true]:text-primary">
            <span aria-hidden="true" className="grid size-4 shrink-0 place-items-center rounded-full border border-border
              group-aria-[current=true]/lang:border-primary">
              <span className="hidden size-2 rounded-full bg-primary group-aria-[current=true]/lang:block" /></span>
            <span lang={language ?? undefined} className="min-w-0 flex-1">{language
              ? languageName(language, locale) : t.anyLanguage}</span>
            {language && facets ? <span className="text-muted-foreground tabular-nums">
              {facets.languages.values.find(item => item.value === language)?.count ?? 0}</span> : null}
          </Link>
        </li>)}
      </ul>
      <p className="mt-1 px-2 text-muted-foreground text-xs">{t.languageHelp}</p>
    </nav>
    <section aria-labelledby={`${idPrefix}-type`} className="grid gap-2">
      <h2 id={`${idPrefix}-type`} className="font-semibold text-sm">{t.workType}</h2>
      <ul className="grid gap-2">
        {workTypes.map(type => {
          const included = state.includeTypes?.includes(type.key) ?? false;
          const excluded = state.excludeTypes?.includes(type.key) ?? false;
          const label = t[`${type.key}Type`];
          const count = facets?.types.values.find(item => item.value === type.iri)?.count;
          return <li key={type.key} className="grid gap-1 rounded-xl border border-border/60 p-2 text-sm">
            <span>{label}{count !== undefined ? <span className="ms-2 text-muted-foreground tabular-nums">
              {count}</span> : null}</span>
            <div className="flex gap-2">
              <Link aria-current={included ? 'true' : undefined}
                href={searchHref({ ...state,
                  includeTypes: included ? state.includeTypes?.filter(key => key !== type.key)
                    : [...(state.includeTypes ?? []), type.key],
                  excludeTypes: state.excludeTypes?.filter(key => key !== type.key) })}
                className="rounded-md px-2 py-1 text-muted-foreground outline-none hover:bg-accent
                  focus-visible:ring-2 focus-visible:ring-ring aria-[current=true]:bg-primary/10
                  aria-[current=true]:text-primary" aria-label={t.includeType({ type: label })}>{t.include}</Link>
              <Link aria-current={excluded ? 'true' : undefined}
                href={searchHref({ ...state,
                  includeTypes: state.includeTypes?.filter(key => key !== type.key),
                  excludeTypes: excluded ? state.excludeTypes?.filter(key => key !== type.key)
                    : [...(state.excludeTypes ?? []), type.key] })}
                className="rounded-md px-2 py-1 text-muted-foreground outline-none hover:bg-accent
                  focus-visible:ring-2 focus-visible:ring-ring aria-[current=true]:bg-primary/10
                  aria-[current=true]:text-primary" aria-label={t.excludeType({ type: label })}>{t.exclude}</Link>
            </div>
          </li>;
        })}
      </ul>
      <p className="px-2 text-muted-foreground text-xs">{t.typeHelp}</p>
    </section>
    <section aria-labelledby={`${idPrefix}-term`} className="grid gap-2">
      <h2 id={`${idPrefix}-term`} className="font-semibold text-sm">{t.classification}</h2>
      {state.term ? <p className="inline-flex h-8 w-fit items-center gap-1 rounded-full bg-secondary ps-3.5 pe-1
        text-sm">
        {t.classificationActive}{facets?.terms.values[0]
          ? <span className="tabular-nums">{t.atLeast({ count: String(facets.terms.values[0].count) })}</span> : null}
        <Link href={searchHref({ ...state, term: null })} aria-label={t.removeFilter({ filter: t.classificationActive })}
          className="grid size-6 place-items-center rounded-full outline-none hover:bg-background/70
            focus-visible:ring-2 focus-visible:ring-ring"><XIcon aria-hidden="true" className="size-3.5" /></Link>
      </p> : <p className="px-2 text-muted-foreground text-xs">{t.classificationHelp}</p>}
    </section>
  </div>;
}

/**
 * `/search`: the phrase, its scope and include filters are URL state; the
 * server renders page one and the browser continues with "Show more".
 */
export function SearchPage({ parsed, realm, initial, signedIn, actingSubject, avatarQuery, load, readerActions, locale,
  messages }: SearchPageProps) {
  const t = materializeData(messages, { locale });
  const state: SearchState = parsed.ok ? parsed.state
    : { phrase: parsed.phrase, scope: { kind: 'global' }, language: null, term: null };
  const scopeLabel = state.scope.kind === 'realm' && realm ? realm.label : t.global;
  const searching = parsed.ok && phraseStatus(state.phrase) === 'ok';
  // Result cards read the reader's shelf state in the browser, one batch per page of results.
  return <ReaderActionsProvider signedIn={signedIn} signInHref={signInPath(localizedPath(searchHref(state), locale))}
    actingSubject={actingSubject} actions={readerActions}><PageContainer className="grid gap-6">
    <header className="grid gap-4">
      <h1 className="font-semibold text-3xl tracking-tight sm:text-4xl">{t.title}</h1>
      <SearchForm state={state} realm={realm} locale={locale} messages={messages} />
      {searching ? <p className="text-pretty break-words text-lg">{state.scope.kind === 'realm'
        ? t.resultsForIn({ phrase: state.phrase, scope: scopeLabel }) : t.resultsFor({ phrase: state.phrase })}</p> : null}
    </header>
    {!parsed.ok ? parsed.reason === 'mine'
      ? <Notice icon={UserRoundIcon} headingLevel={2} title={t.mineTitle} description={t.mineHelp}>
        <Link href="/discover?scope=mine" className={buttonVariants({ size: 'sm', variant: 'outline' })}>
          {t.browseMine}</Link>
        <Link href={searchHref(state)} className={buttonVariants({ size: 'sm' })}>{t.seeGlobal}</Link>
      </Notice>
      : <Notice icon={LinkIcon} headingLevel={2} title={t.badLinkTitle} description={t.badLinkHelp}>
        <Link href={searchHref(state)} className={buttonVariants({ size: 'sm' })}>{t.seeGlobal}</Link>
      </Notice>
      : <div className="grid gap-6 lg:grid-cols-[15rem_minmax(0,1fr)] lg:items-start">
        <aside aria-label={t.filters}>
          <div className="hidden lg:sticky lg:top-6 lg:block">
            <Filters state={state} facets={initial?.ok ? initial.page.facets : undefined}
              idPrefix="filters-wide" locale={locale} t={t} />
          </div>
          <details className="group rounded-2xl border border-border/70 lg:hidden">
            <summary className={cn('flex cursor-pointer list-none items-center gap-2 rounded-2xl px-4 py-3 font-medium',
              'text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden')}>
              <SlidersHorizontalIcon aria-hidden="true" className="size-4 text-muted-foreground" />
              <span className="flex-1">{t.filterResults}</span>
              <ChevronDownIcon aria-hidden="true" className="size-4 text-muted-foreground transition-transform
                group-open:rotate-180" />
            </summary>
            <div className="border-border/60 border-t px-4 py-4">
              <Filters state={state} facets={initial?.ok ? initial.page.facets : undefined}
                idPrefix="filters-narrow" locale={locale} t={t} />
            </div>
          </details>
        </aside>
        <SearchResults state={state} initial={initial} scopeLabel={scopeLabel} signedIn={signedIn}
          actingSubject={actingSubject} avatarQuery={avatarQuery} load={load} locale={locale} messages={messages} />
      </div>}
  </PageContainer></ReaderActionsProvider>;
}
