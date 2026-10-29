import { useQuery, useSuspenseQuery } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { createIsomorphicFn } from '@tanstack/react-start';
import { env } from 'cloudflare:workers';
import { agentPageHead, agentPagePaths } from '../features/pages/agent-page';
import { agentPageQuery, agentReaderQuery } from '../features/pages/agent-queries';
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

// An agent's page is its own address: never inside a Realm or a Zone, whatever venue the agent speaks in.
// readAgentPage(...) is called by the shared public query factory so SSR and hydration use the same cache entry.
export const Route = createFileRoute('/@{$handle}')({
  loader: async ({ params, context }) => {
    const locale = getLocale();
    const page = await context.queryClient.ensureQueryData(agentPageQuery(params.handle, locale));
    return { ...page, paths: agentPagePaths(params.handle) };
  },
  head: ({ loaderData }) =>
    loaderData
      ? agentPageHead(loaderData.overview, getLocale(), publicOrigin(), loaderData.paths, loaderData.view)
      : { meta: [{ title: m.not_found_heading() }] },
  component: AgentRoute,
});

function AgentRoute() {
  const { handle } = Route.useParams();
  const locale = getLocale();
  const { data } = useSuspenseQuery(agentPageQuery(handle, locale));
  const { state: session } = useSession();
  const { data: reader } = useQuery({
    ...agentReaderQuery(handle, locale),
    enabled: personalRead.enabled && session === 'signed-in',
  });
  return (
    <SubjectPage
      page={data.page}
      locale={locale}
      messages={subjectPageMessages()}
      reader={reader ?? defaultReader}
      relations={data.relations}
      link={SubjectLink}
      tabs={data.tabs}
      tabLabels={viewTabLabels()}
      base={`/${encodeURIComponent(locale)}/@${encodeURIComponent(handle)}`}
      renderJsonLd={false}
    />
  );
}
