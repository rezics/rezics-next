import { PublicAccountState, PublicRealmsPage } from '../accounts/public-profile/view';
import { useEffect } from 'react';
import { useQueryClient, useSuspenseQuery } from '@tanstack/react-query';
import { createFileRoute, notFound, redirect, useLocation, useRouter } from '@tanstack/react-router';
import { createIsomorphicFn } from '@tanstack/react-start';
import { env } from 'cloudflare:workers';
import { agentPageHead, agentPagePaths, agentPathView, agentViewAvailable } from '../features/pages/agent-page';
import { canonicalRedirect, keepSearch } from '../subject/subject-href';
import { agentPath } from '../features/pages/agent';
import { agentViewQuery } from '../features/pages/agent-queries';
import { useProfileReading } from '../accounts/public-profile/reader-presentation/adapter';
import { SubjectLink, subjectPageMessages, viewTabLabels } from '../features/pages/route-support';
import { CollectionWindowsContext, useCollectionWindows } from '../accounts/public-profile/collection-windows/host';
import { PublicProfilePage } from '../accounts/public-profile/page';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import { validatePublicOrigin } from '../shell/origin';
import { projectShareCardPage } from '../media/share-card-page';

const publicOrigin = createIsomorphicFn()
  .server(() => validatePublicOrigin((env as { PUBLIC_ORIGIN?: string }).PUBLIC_ORIGIN))
  .client(() =>
    validatePublicOrigin(new URL(document.querySelector<HTMLLinkElement>('link[rel="canonical"]')!.href).origin),
  );

const viewLabel = {
  realms: () => m.public_account_realms(),
  overview: () => m.subject_overview(),
  editions: () => m.subject_editions(),
  contents: () => m.subject_contents(),
  characters: () => m.subject_characters(),
  appearances: () => m.subject_appearances(),
  credits: () => m.subject_credits(),
  works: () => m.subject_works(),
  relations: () => m.subject_relations(),
  posts: () => m.subject_posts(),
  reviews: () => m.subject_reviews(),
  discussion: () => m.subject_discussion(),
  lists: () => m.subject_lists(),
  collections: () => m.subject_collections(),
  details: () => m.subject_details(),
};

export const Route = createFileRoute('/@{$handle}_/$view')({
  staticData: { publicCache: true },
  // Cursor replacements retain the local visit; account/view/locale changes retire it in the receiver.
  remountDeps: () => null,
  gcTime: 0,
  validateSearch: (search: Record<string, unknown>): { cursor?: string } => ({
    ...(typeof search.cursor === 'string' && search.cursor.length <= 4096 ? { cursor: search.cursor } : {}),
  }),
  loaderDeps: ({ search }) => ({ cursor: search.cursor }),
  // readAgentPage(...) is called by the public view query factory; this loader only seeds its query cache.
  loader: async ({ params, deps, location, context }) => {
    const view = agentPathView(params.view);
    if (!view) throw notFound();
    const locale = getLocale();
    const query = agentViewQuery(params.handle, locale, view, deps.cursor, location.searchStr);
    const page = await context.queryClient.fetchQuery({ ...query, staleTime: 0 }).catch((error: unknown) => {
      context.queryClient.removeQueries({ queryKey: query.queryKey });
      throw error;
    });
    if (page.kind === 'redirect') {
      throw redirect({
        href: keepSearch(page.redirectTo, '', location.hash),
        statusCode: 302,
        headers: { 'Cache-Control': 'private, no-store' },
      });
    }
    if (page.kind === 'state') return page;
    if (view !== 'realms' && !agentViewAvailable(page.tabs, view) && !page.overview.views?.includes(view))
      throw redirect(canonicalRedirect(agentPath(locale, page.handle), location.searchStr, location.hash, 302));
    const canonicalHandle = page.page.account?.handle;
    if (!canonicalHandle) throw notFound();
    if (canonicalHandle !== params.handle) {
      throw redirect(
        canonicalRedirect(agentPath(locale, canonicalHandle, view), location.searchStr, location.hash, 308),
      );
    }
    return {
      ...page,
      shareCard: page.overview.subject
        ? projectShareCardPage({ kind: 'page', page: page.overview }, { id: page.overview.subject, locale })
        : undefined,
      paths: agentPagePaths(canonicalHandle, view),
    };
  },
  head: ({ loaderData }) =>
    loaderData?.kind === 'page'
      ? agentPageHead(
          loaderData.overview,
          getLocale(),
          publicOrigin(),
          loaderData.paths,
          loaderData.view,
          loaderData.cursor,
          loaderData.shareCard,
        )
      : { meta: [{ title: m.public_account_heading() }, { name: 'robots', content: 'noindex, nofollow' }] },
  component: AgentViewRoute,
});

function AgentViewRoute() {
  const { handle, view: rawView } = Route.useParams();
  const view = agentPathView(rawView);
  if (!view || view === 'overview') throw notFound();
  const { cursor } = Route.useSearch();
  const locale = getLocale();
  const router = useRouter();
  const { searchStr, hash } = useLocation();
  const queryClient = useQueryClient();
  const query = agentViewQuery(handle, locale, view, cursor, searchStr);
  const { data, dataUpdatedAt } = useSuspenseQuery(query);
  const queryIdentity = JSON.stringify(query.queryKey);
  useEffect(() => {
    if (view !== 'collections') return;
    // Cursor coordinates survive; predecessor response bodies do not become a second page cache.
    return () => { queryClient.removeQueries({ queryKey: JSON.parse(queryIdentity), exact: true }); };
  }, [queryClient, queryIdentity, view]);
  const reading = useProfileReading({
    handle,
    locale,
    path: { kind: 'view', view: rawView },
    enabled: data.kind === 'page' && view !== 'realms',
    owner: data,
  });
  const windows = useCollectionWindows({
    ...(data.kind === 'page' ? { page: data.page } : {}),
    failure: data.kind === 'state' ? data.state : undefined,
    owner: handle, revision: dataUpdatedAt, view, locale, cursor: cursor ?? null, search: searchStr, hash,
    navigate: (href) => { void router.navigate({ href }); },
    retry: () => { void router.invalidate(); },
  });
  if (data.kind === 'redirect') {
    throw redirect({ href: data.redirectTo, statusCode: 302, headers: { 'Cache-Control': 'private, no-store' } });
  }
  if (data.kind === 'state')
    return <PublicAccountState page state={data.state} retry={() => void router.invalidate()} />;
  if (view === 'realms')
    return (
      <PublicRealmsPage
        handle={data.page.account!.handle}
        title={data.title}
        locale={locale}
        result={data.realms ?? { state: 'unavailable' }}
        search={searchStr}
        retry={() => void router.invalidate()}
      />
    );
  return (
    <CollectionWindowsContext.Provider value={windows}>
    <PublicProfilePage key={cursor ?? 'first'}
      page={data.page}
      cursor={data.cursor ?? null}
      locale={locale}
      messages={subjectPageMessages()}
      reading={reading}
      relations={data.relations}
      {...(data.operator ? { operator: data.operator } : {})}
      link={SubjectLink}
      view={view}
      tabs={data.tabs}
      tabLabels={viewTabLabels()}
      base={`/${encodeURIComponent(locale)}/@${encodeURIComponent(handle)}`}
      heading={{
        title: data.title,
        label: viewLabel[view](),
        href: `/${encodeURIComponent(locale)}/@${encodeURIComponent(handle)}`,
      }}
      publicRealms={data.publicRealms}
      renderJsonLd={false}
    />
    </CollectionWindowsContext.Provider>
  );
}
