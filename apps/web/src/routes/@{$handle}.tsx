import { createFileRoute, useRouter } from '@tanstack/react-router';
import { readAgentPage } from '../features/pages/agent-actions';
import { agentPath } from '../features/pages/agent';
import { SubjectLink, subjectPageMessages, viewTabLabels } from '../features/pages/route-support';
import { SubjectPage } from '../features/pages/subject';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';

// An agent's page is its own address: never inside a Realm or a Zone, whatever venue the agent speaks in.
export const Route = createFileRoute('/@{$handle}')({
  loader: ({ params }) => readAgentPage({ data: { handle: params.handle, locale: getLocale() } }),
  head: ({ loaderData }) => ({ meta: [{ title: loaderData?.title || m.not_found_heading() }] }),
  component: AgentRoute,
});

function AgentRoute() {
  const { page, reader, relations, tabs, handle } = Route.useLoaderData();
  const nonce = useRouter().options.ssr?.nonce;
  const locale = getLocale();
  return (
    <SubjectPage
      page={page}
      locale={locale}
      messages={subjectPageMessages()}
      reader={reader}
      relations={relations}
      link={SubjectLink}
      tabs={tabs}
      tabLabels={viewTabLabels()}
      base={agentPath(locale, handle)}
      {...(nonce !== undefined ? { nonce } : {})}
      renderJsonLd={false}
    />
  );
}
