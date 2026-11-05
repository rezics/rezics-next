import { readAgentPage } from '../features/pages/agent-actions';
import { PublicRealmsRoute } from '../accounts/public-profile/realm-windows/route';
import { PublicAccountState } from '../accounts/public-profile/view';
import { useSuspenseQuery } from '@tanstack/react-query';
import { createFileRoute, notFound, redirect, useLocation, useRouter } from '@tanstack/react-router';
import { createIsomorphicFn } from '@tanstack/react-start';
import { env } from 'cloudflare:workers';
import { agentPageHead, agentPagePaths, agentPathView, agentViewAvailable } from '../features/pages/agent-page';
import { canonicalRedirect, keepSearch } from '../subject/subject-href';
import { agentPath } from '../features/pages/agent';
import { agentViewQuery } from '../features/pages/agent-queries';
import { useProfileReading } from '../accounts/public-profile/reader-presentation/adapter';
import { SubjectLink, subjectPageMessages, viewTabLabels } from '../features/pages/route-support';
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
  gcTime: 0,
  remountDeps: ({ params, search }) => (params.view === 'realms' ? search.cursor : undefined),
  shouldReload: ({ params }) => (params.view === 'realms' ? true : undefined),
  validateSearch: (search: Record<string, unknown>): { cursor?: string } => ({
    ...(typeof search.cursor === 'string' && search.cursor.length <= 4096 ? { cursor: search.cursor } : {}),
  }),
  loaderDeps: ({ search }) => ({ cursor: search.cursor }),
  // Realms replaces its native loader page; other named views keep their existing query cache.
  loader: async ({ params, deps, location, context }) => {
    const view = agentPathView(params.view);
    if (!view) throw notFound();
    const locale = getLocale();
    const address = new URL(location.publicHref, 'https://route.local');
    const search = view === 'realms' ? address.search : location.searchStr;
    const hash = view === 'realms' ? address.hash : location.hash;
    const query = agentViewQuery(params.handle, locale, view, deps.cursor, search);
    const page =
      view === 'realms'
        ? await readAgentPage({ data: { handle: params.handle, locale, view, cursor: deps.cursor, search } })
        : await context.queryClient.fetchQuery({ ...query, staleTime: 0 }).catch((error: unknown) => {
            context.queryClient.removeQueries({ queryKey: query.queryKey });
            throw error;
          });
    if (page.kind === 'redirect') {
      throw redirect({
        href: keepSearch(page.redirectTo, '', hash),
        statusCode: 302,
        headers: { 'Cache-Control': 'private, no-store' },
      });
    }
    if (page.kind === 'state') return page;
    if (view !== 'realms' && !agentViewAvailable(page.tabs, view) && !page.overview.views?.includes(view))
      throw redirect(canonicalRedirect(agentPath(locale, page.handle), search, hash, 302));
    const canonicalHandle = page.page.account?.handle;
    if (!canonicalHandle) throw notFound();
    if (canonicalHandle !== params.handle) {
      throw redirect(canonicalRedirect(agentPath(locale, canonicalHandle, view), search, hash, 308));
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
          { ...loaderData.overview, account: loaderData.page.account! },
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
  const data = Route.useLoaderData();
  const { view: rawView } = Route.useParams();
  const view = agentPathView(rawView);
  if (!view || view === 'overview') throw notFound();
  const { cursor } = Route.useSearch();
  if (view === 'realms') return <PublicRealmsRoute source={data} locale={getLocale()} cursor={cursor} />;
  return <NamedAccountViewRoute view={view} />;
}

function NamedAccountViewRoute({
  view,
}: {
  view: Exclude<ReturnType<typeof agentPathView>, undefined | 'realms' | 'overview'>;
}) {
  const { handle, view: rawView } = Route.useParams();
  const { cursor } = Route.useSearch();
  const locale = getLocale();
  const router = useRouter();
  const { searchStr } = useLocation();
  const { data } = useSuspenseQuery(agentViewQuery(handle, locale, view, cursor, searchStr));
  const reading = useProfileReading({
    handle,
    locale,
    path: { kind: 'view', view: rawView },
    enabled: data.kind === 'page',
    owner: data,
  });
  if (data.kind === 'redirect') {
    throw redirect({ href: data.redirectTo, statusCode: 302, headers: { 'Cache-Control': 'private, no-store' } });
  }
  if (data.kind === 'state')
    return <PublicAccountState page state={data.state} retry={() => void router.invalidate()} />;
  return (
    <PublicProfilePage
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
  );
}
