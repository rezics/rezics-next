import { createFileRoute, notFound, useParams } from '@tanstack/react-router';
import { KnowledgeNavigationRoute } from '../../../../knowledge/route';
import { isKnowledgeId } from '../../../../knowledge/private-knowledge';
import { m } from '../../../../paraglide/messages.js';
import { pageHead } from '../../../../shell/head';
import { pageHeadContext } from '../../../../shell/head-context';

export const Route = createFileRoute('/knowledge/notebooks/$notebookId/')({
  staleTime: 0,
  gcTime: 0,
  shouldReload: true,
  loader: ({ params }) => {
    if (!isKnowledgeId(params.notebookId)) throw notFound();
  },
  head: ({ match }) =>
    pageHead({ title: m.knowledge_navigation_outline(), robots: 'noindex, nofollow' }, pageHeadContext(match.pathname)),
  component: NotebookOutlineRoute,
});
function NotebookOutlineRoute() {
  const { notebookId } = useParams({ from: '/knowledge/notebooks/$notebookId/' });
  return <KnowledgeNavigationRoute notebookId={notebookId} />;
}
