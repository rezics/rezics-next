import { createFileRoute, useLocation, useRouter } from '@tanstack/react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createIsomorphicFn } from '@tanstack/react-start';
import { getRequest } from '@tanstack/react-start/server';
import { env } from 'cloudflare:workers';
import { Empty, EmptyHeader, EmptyTitle } from '@rezics/ui/shadcn/empty';
import {
  correctSearchInput,
  SearchInputRecovery,
  SearchPage,
  searchInputDependency,
  searchInputFingerprint,
  searchParams,
  searchUrlIntake,
  removeSearchInput,
} from '../search/search.tsx';
import { searchQueryOptions } from '../search/search-queries';
import { searchSessionOwner } from '../search/search-session-owner';
import { searchRequiresCurrentReader, searchSessionLifetime } from '../search/scoped-search-lifetime';
import { searchUnavailablePage } from '../search/search-recovery';
import { useSearchQuery } from '../search/use-search-query';
import { isRealmDiscoverySearch, realmDiscoveryQueryOptions } from '../search/realm-discovery-loader';
import { PageHeading } from '../shell/page-heading';
import { pageHead } from '../shell/head';
import { validatePublicOrigin } from '../shell/origin';
import { sessionQuery, useSession } from '../session/query';
import { m } from '../paraglide/messages.js';
import { getLocale, locales } from '../paraglide/runtime.js';

function messageOptions(locale: string) {
  return { locale: locales.find((value) => value === locale) ?? 'en' };
}

const publicOrigin = createIsomorphicFn()
  .server(() => validatePublicOrigin((env as { PUBLIC_ORIGIN?: string }).PUBLIC_ORIGIN, getRequest().url))
  .client(() =>
    validatePublicOrigin(new URL(document.querySelector<HTMLLinkElement>('link[rel="canonical"]')!.href).origin),
  );

export const Route = createFileRoute('/search')({
  staticData: { publicCache: true },
  validateSearch: searchParams,
  loaderDeps: ({ search }) => searchInputDependency(search),
  loader: ({ context, location }) => {
    const intake = searchUrlIntake(location.search, location.searchStr, location.publicHref);
    if (intake.kind !== 'ready') return { query: '' };
    const params = intake.request;
    // Scoped reads start in the session-bound client query so private results never enter the public route cache.
    if (searchRequiresCurrentReader(params)) return { query: params.query };
    const locale = getLocale();
    return Promise.all([
      context.queryClient.fetchQuery(searchQueryOptions(locale, params)),
      isRealmDiscoverySearch(params) ? context.queryClient.fetchQuery(realmDiscoveryQueryOptions(locale)) : undefined,
    ]).then(() => ({ query: params.query }));
  },
  head: ({ loaderData }) => {
    const locale = getLocale();
    const options = messageOptions(locale);
    return pageHead(
      {
        title: loaderData?.query
          ? `${loaderData.query} – ${m.search_heading({}, options)}`
          : m.search_heading({}, options),
        robots: 'noindex, follow',
      },
      { origin: publicOrigin(), locale, path: '/search' },
    );
  },
  component: SearchRoute,
  errorComponent: SearchFailed,
});

/** A search the kernel could not answer says so in a sentence, in the page's own frame. */
function SearchFailed() {
  const options = messageOptions(getLocale());
  return (
    <section className="mx-auto max-w-5xl space-y-6">
      <PageHeading>{m.search_heading({}, options)}</PageHeading>
      <Empty className="border" role="alert">
        <EmptyHeader>
          <EmptyTitle className="text-base font-normal">{m.search_failed({}, options)}</EmptyTitle>
        </EmptyHeader>
      </Empty>
    </section>
  );
}

function SearchRoute() {
  const search = Route.useSearch();
  const location = useLocation();
  const router = useRouter();
  const navigate = Route.useNavigate();
  const locale = getLocale();
  const intake = searchUrlIntake(search, location.searchStr, location.publicHref);
  const fingerprint = searchInputFingerprint(search);
  const queryClient = useQueryClient();
  const cachedSession = queryClient.getQueryData(sessionQuery.queryKey);
  const readerIntent = cachedSession ? searchSessionOwner(cachedSession) : undefined;
  const visitLocation = router.state.location;
  const focusAfterNavigation = (
    nextSearch: Record<string, unknown>,
    startNavigation: () => Promise<unknown>,
  ) => {
    if (router.state.location !== visitLocation || typeof document === 'undefined') return;
    const expectedFingerprint = searchInputFingerprint(nextSearch);
    const source = document.activeElement;
    void startNavigation().then(() => {
      const targetLocation = router.state.location;
      if (searchInputFingerprint(targetLocation.search as Record<string, unknown>) !== expectedFingerprint) return;
      const focus = () => {
        if (router.state.location !== targetLocation || getLocale() !== locale) return;
        const currentSession = queryClient.getQueryData(sessionQuery.queryKey);
        const currentReader = currentSession ? searchSessionOwner(currentSession) : undefined;
        if (currentReader !== readerIntent) return;
        const active = document.activeElement;
        const shellFocus = document.getElementById('main-content');
        if (
          active !== source &&
          !(active === document.body && source && !source.isConnected) &&
          active !== shellFocus
        )
          return;
        const firstIssue = document.querySelector<HTMLElement>(
          '[data-search-input-first] textarea, [data-search-input-first] input, [data-search-input-first] button',
        );
        const results = document.querySelector<HTMLElement>('[data-search-results]');
        if (results && currentReader !== undefined && results.dataset.searchReader !== (currentReader ?? '')) return;
        (firstIssue ?? results)?.focus({ preventScroll: true });
      };
      document.defaultView!.requestAnimationFrame(focus);
    });
  };

  if (intake.kind === 'over-budget') {
    return (
      <SearchInputRecovery
        key="over-budget"
        overBudget
        locale={locale}
        onRestart={() => {
          focusAfterNavigation({}, () => navigate({ search: () => ({}) }));
        }}
      />
    );
  }

  if (intake.kind === 'invalid') {
    const baseFingerprint = fingerprint;
    return (
      <SearchInputRecovery
        key={intake.fingerprint}
        issues={intake.issues}
        locale={locale}
        onApply={(issue, value) => {
          const next = correctSearchInput(search, issue.key, value, issue.occurrence);
          focusAfterNavigation(next, () =>
            navigate({
              search: (previous) =>
                searchInputFingerprint(previous) === baseFingerprint
                  ? correctSearchInput(previous, issue.key, value, issue.occurrence)
                  : previous,
            }),
          );
        }}
        onRemove={(issue) => {
          const next = removeSearchInput(search, issue.key, issue.occurrence);
          focusAfterNavigation(next, () =>
            navigate({
              search: (previous) =>
                searchInputFingerprint(previous) === baseFingerprint
                  ? removeSearchInput(previous, issue.key, issue.occurrence)
                  : previous,
            }),
          );
        }}
      />
    );
  }
  return <SearchResults deps={intake.request} locale={locale} searchHref={location.publicHref} />;
}

function SearchResults({
  deps,
  locale,
  searchHref,
}: {
  deps: ReturnType<typeof searchLoaderDeps>;
  locale: string;
  searchHref: string;
}) {
  const sessionState = useSession();
  const reader = searchSessionOwner(sessionState);
  const page = searchRequiresCurrentReader(deps) && (sessionState.state !== 'signed-in' || reader === null)
    ? (
      <SearchPage
        query={deps.query}
        data={{ ...searchUnavailablePage(deps), recovery: { status: 'session' } }}
        locale={locale}
        session={null}
        searchHref={searchHref}
      />
    )
    : (
      <LoadedSearchResults
        deps={deps}
        locale={locale}
        searchHref={searchHref}
        key={searchSessionLifetime(locale, { ...deps, cursor: undefined }, reader ?? undefined)}
        {...(searchRequiresCurrentReader(deps) && reader ? { reader } : {})}
        session={reader}
      />
    );
  return (
    <div data-search-results data-search-reader={reader ?? ''} tabIndex={-1}>
      {page}
    </div>
  );
}

function LoadedSearchResults({
  deps,
  locale,
  searchHref,
  reader,
  session,
}: {
  deps: ReturnType<typeof searchLoaderDeps>;
  locale: string;
  searchHref: string;
  reader?: string;
  session: string | null;
}) {
  const { data, retry } = useSearchQuery(locale, deps, reader);
  const realms = useQuery({ ...realmDiscoveryQueryOptions(locale), enabled: isRealmDiscoverySearch(deps) });
  return (
    <SearchPage
      query={deps.query}
      data={data}
      locale={locale}
      searchHref={searchHref}
      onRetry={retry}
      session={session}
      {...(realms.data ? { realmDiscovery: realms.data } : {})}
    />
  );
}
