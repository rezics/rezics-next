import { createFileRoute, notFound, useLoaderData } from '@tanstack/react-router';
import { parseKnowledgePrivateSubjectSearch } from '../../knowledge/private-knowledge';
import { KnowledgePrivatePage } from '../../knowledge/private-page';
import { m } from '../../paraglide/messages.js';
import { pageHead } from '../../shell/head';
import { pageHeadContext } from '../../shell/head-context';

export const Route = createFileRoute('/knowledge/new')({
  staleTime: 0,
  gcTime: 0,
  shouldReload: true,
  validateSearch(search: Record<string, unknown>) {
    const parsed = parseKnowledgePrivateSubjectSearch(search);
    if (!parsed) throw notFound();
    return parsed;
  },
  loader: ({ location }) => {
    const parsed = parseKnowledgePrivateSubjectSearch(location.search);
    if (!parsed) throw notFound();
    return parsed;
  },
  head: ({ match }) =>
    pageHead({ title: m.knowledge_private_heading(), robots: 'noindex, nofollow' }, pageHeadContext(match.pathname)),
  component: KnowledgePrivateNewRoute,
});

function KnowledgePrivateNewRoute() {
  const { subjectId } = useLoaderData({ from: '/knowledge/new' });
  return <KnowledgePrivatePage address={{ kind: 'create', subjectId }} />;
}
