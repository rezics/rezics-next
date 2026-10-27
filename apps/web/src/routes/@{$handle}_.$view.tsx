import { isView } from '@rezics/composition';
import { createFileRoute, notFound, useRouter } from '@tanstack/react-router';
import { readAgentPage } from '../features/pages/agent-actions';
import { agentPath } from '../features/pages/agent';
import { SubjectLink, subjectPageMessages, viewTabLabels } from '../features/pages/route-support';
import { SubjectPage } from '../features/pages/subject';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';

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
  validateSearch: (search: Record<string, unknown>): { cursor?: string } => ({
    ...(typeof search.cursor === 'string' && search.cursor.length <= 2048 ? { cursor: search.cursor } : {}),
  }),
  loaderDeps: ({ search }) => ({ cursor: search.cursor }),
  loader: ({ params, deps }) => {
    // The overview is the agent's own address, not a view address.
    if (!isView(params.view) || params.view === 'overview') throw notFound();
    return readAgentPage({
      data: { handle: params.handle, locale: getLocale(), view: params.view, cursor: deps.cursor },
    });
  },
  head: ({ loaderData }) => ({
    meta: [
      {
        title: loaderData
          ? [loaderData.title, viewLabel[loaderData.view]()].filter(Boolean).join(' · ')
          : m.not_found_heading(),
      },
    ],
  }),
  component: AgentViewRoute,
});

function AgentViewRoute() {
  const { page, reader, relations, tabs, title, view, handle } = Route.useLoaderData();
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
      view={view}
      tabs={tabs}
      tabLabels={viewTabLabels()}
      base={agentPath(locale, handle)}
      heading={{ title, label: viewLabel[view](), href: agentPath(locale, handle) }}
      {...(nonce !== undefined ? { nonce } : {})}
      renderJsonLd={false}
    />
  );
}
