import { createFileRoute } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { createIsomorphicFn } from '@tanstack/react-start';
import { env } from 'cloudflare:workers';
import { Empty, EmptyHeader, EmptyTitle } from '@rezics/ui/shadcn/empty';
import { SearchPage } from '../search/search.tsx';
import { searchQueryOptions } from '../search/search-queries';
import { useSearchQuery } from '../search/use-search-query';
import { isRealmDiscoverySearch, realmDiscoveryQueryOptions } from '../search/realm-discovery-loader';
import { correctSearchInput, removeSearchInput, searchLoaderDeps, searchParams } from '../search/search-params';
import { SearchInputRecovery } from '../search/search-input-recovery';
import { PageHeading } from '../shell/page-heading';
import { pageHead } from '../shell/head';
import { validatePublicOrigin } from '../shell/origin';
import { m } from '../paraglide/messages.js';
import { getLocale, locales } from '../paraglide/runtime.js';

function messageOptions(locale: string) {
  return { locale: locales.find((value) => value === locale) ?? 'en' };
}

const publicOrigin = createIsomorphicFn()
  .server(() => validatePublicOrigin((env as { PUBLIC_ORIGIN?: string }).PUBLIC_ORIGIN))
  .client(() =>
    validatePublicOrigin(new URL(document.querySelector<HTMLLinkElement>('link[rel="canonical"]')!.href).origin),
  );

export const Route = createFileRoute('/search')({
  staticData: { publicCache: true },
  validateSearch: searchParams,
  loaderDeps: ({ search }) => searchLoaderDeps(search),
  loader: ({ deps, context }) => {
    const params = deps;
    if (params.invalidInput) return { query: params.query, invalidInput: params.invalidInput };
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
  const deps = searchLoaderDeps(search);
  const navigate = Route.useNavigate();
  const locale = getLocale();
  if (deps.invalidInput) {
    const invalidInput = deps.invalidInput;
    return (
      <SearchInputRecovery
        key={`${invalidInput.key}:${invalidInput.value}`}
        parameter={invalidInput.key}
        value={invalidInput.value}
        locale={locale}
        onApply={(value) => {
          void navigate({
            search: (previous) => correctSearchInput(previous, invalidInput.key, value),
          });
        }}
        onRemove={() => {
          void navigate({ search: (previous) => removeSearchInput(previous, invalidInput.key) });
        }}
      />
    );
  }
  return <SearchResults deps={deps} locale={locale} />;
}

function SearchResults({ deps, locale }: { deps: ReturnType<typeof searchLoaderDeps>; locale: string }) {
  const { data, retry } = useSearchQuery(locale, deps);
  const realms = useQuery({ ...realmDiscoveryQueryOptions(locale), enabled: isRealmDiscoverySearch(deps) });
  return (
    <SearchPage
      query={deps.query}
      data={data}
      locale={locale}
      onRetry={retry}
      {...(realms.data ? { realmDiscovery: realms.data } : {})}
    />
  );
}
