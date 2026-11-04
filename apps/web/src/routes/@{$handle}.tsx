import { PublicAccountState } from '../accounts/public-profile/view';
import { useSuspenseQuery } from '@tanstack/react-query';
import { createFileRoute, notFound, redirect, useLocation, useRouter } from '@tanstack/react-router';
import { createIsomorphicFn } from '@tanstack/react-start';
import { env } from 'cloudflare:workers';
import { agentPageHead, agentPagePaths } from '../features/pages/agent-page';
import { canonicalRedirect, keepSearch } from '../subject/subject-href';
import { agentPath } from '../features/pages/agent';
import { agentPageQuery } from '../features/pages/agent-queries';
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

// An agent's page is its own address: never inside a Realm or a Zone, whatever venue the agent speaks in.
// readAgentPage(...) is called by the shared public query factory so SSR and hydration use the same cache entry.
export const Route = createFileRoute('/@{$handle}')({
  staticData: { publicCache: true },
  loader: async ({ params, location, context }) => {
    const locale = getLocale();
    const query = agentPageQuery(params.handle, locale, location.searchStr);
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
    const canonicalHandle = page.page.account?.handle;
    if (!canonicalHandle) throw notFound();
    if (canonicalHandle !== params.handle) {
      throw redirect(canonicalRedirect(agentPath(locale, canonicalHandle), location.searchStr, location.hash, 308));
    }
    return {
      ...page,
      shareCard: page.overview.subject
        ? projectShareCardPage({ kind: 'page', page: page.overview }, { id: page.overview.subject, locale })
        : undefined,
      paths: agentPagePaths(canonicalHandle),
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
          undefined,
          loaderData.shareCard,
        )
      : { meta: [{ title: m.public_account_heading() }, { name: 'robots', content: 'noindex, nofollow' }] },
  component: AgentRoute,
});

function AgentRoute() {
  const { handle } = Route.useParams();
  const locale = getLocale();
  const router = useRouter();
  const { searchStr } = useLocation();
  const { data } = useSuspenseQuery(agentPageQuery(handle, locale, searchStr));
  const reading = useProfileReading({
    handle,
    locale,
    path: { kind: 'overview' },
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
      locale={locale}
      messages={subjectPageMessages()}
      reading={reading}
      relations={data.relations}
      {...(data.operator ? { operator: data.operator } : {})}
      link={SubjectLink}
      tabs={data.tabs}
      tabLabels={viewTabLabels()}
      base={`/${encodeURIComponent(locale)}/@${encodeURIComponent(handle)}`}
      publicRealms={data.publicRealms}
      renderJsonLd={false}
    />
  );
}
