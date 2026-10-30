import { useQuery, useSuspenseQuery } from '@tanstack/react-query';
import { createFileRoute, notFound, redirect, useLocation } from '@tanstack/react-router';
import { createIsomorphicFn } from '@tanstack/react-start';
import { env } from 'cloudflare:workers';
import { agentPageHead, agentPagePaths, agentPathView, agentViewAvailable } from '../features/pages/agent-page';
import { canonicalRedirect, keepSearch } from '../subject/subject-href';
import { agentPath } from '../features/pages/agent';
import { agentReaderQuery, agentViewQuery } from '../features/pages/agent-queries';
import { SubjectLink, subjectPageMessages, viewTabLabels } from '../features/pages/route-support';
import { SubjectPage } from '../features/pages/subject';
import { personalRead } from '../kernel/query';
import { useSession } from '../session/query';
import { defaultReader } from '../subject/reader';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import { validatePublicOrigin } from '../shell/origin';

const publicOrigin = createIsomorphicFn()
  .server(() => validatePublicOrigin((env as { PUBLIC_ORIGIN?: string }).PUBLIC_ORIGIN))
  .client(() =>
    validatePublicOrigin(new URL(document.querySelector<HTMLLinkElement>('link[rel="canonical"]')!.href).origin),
  );

const viewLabel = {
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
  validateSearch: (search: Record<string, unknown>): { cursor?: string } => ({
    ...(typeof search.cursor === 'string' && search.cursor.length <= 2048 ? { cursor: search.cursor } : {}),
  }),
  loaderDeps: ({ search }) => ({ cursor: search.cursor }),
  // readAgentPage(...) is called by the public view query factory; this loader only seeds its query cache.
  loader: async ({ params, deps, location, context }) => {
    const view = agentPathView(params.view);
    if (!view) throw notFound();
    const locale = getLocale();
    const query = agentViewQuery(params.handle, locale, view, deps.cursor, location.searchStr);
    const page = await context.queryClient.ensureQueryData(query).catch((error: unknown) => {
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
    if (!agentViewAvailable(page.tabs, view) && !page.overview.views?.includes(view))
      throw redirect(canonicalRedirect(agentPath(locale, page.handle), location.searchStr, location.hash, 302));
    const canonicalHandle = page.page.account?.handle;
    if (!canonicalHandle) throw notFound();
    if (canonicalHandle !== params.handle) {
      throw redirect(
        canonicalRedirect(agentPath(locale, canonicalHandle, view), location.searchStr, location.hash, 308),
      );
    }
    return { ...page, paths: agentPagePaths(canonicalHandle, view) };
  },
  head: ({ loaderData }) =>
    loaderData
      ? agentPageHead(
          loaderData.overview,
          getLocale(),
          publicOrigin(),
          loaderData.paths,
          loaderData.view,
          loaderData.cursor,
        )
      : { meta: [{ title: m.not_found_heading() }] },
  component: AgentViewRoute,
});

function AgentViewRoute() {
  const { handle, view: rawView } = Route.useParams();
  const view = agentPathView(rawView);
  if (!view || view === 'overview') throw notFound();
  const { cursor } = Route.useSearch();
  const locale = getLocale();
  const { searchStr } = useLocation();
  const { data } = useSuspenseQuery(agentViewQuery(handle, locale, view, cursor, searchStr));
  const { state: session } = useSession();
  const { data: reader } = useQuery({
    ...agentReaderQuery(handle, locale),
    enabled: data.kind === 'page' && personalRead.enabled && session === 'signed-in',
  });
  if (data.kind === 'redirect') {
    throw redirect({ href: data.redirectTo, statusCode: 302, headers: { 'Cache-Control': 'private, no-store' } });
  }
  return (
    <SubjectPage
      page={data.page}
      locale={locale}
      messages={subjectPageMessages()}
      reader={reader ?? defaultReader}
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
      renderJsonLd={false}
    />
  );
}
