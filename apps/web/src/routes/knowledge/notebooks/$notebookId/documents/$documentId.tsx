import { createFileRoute, notFound, useLoaderData } from '@tanstack/react-router';
import { KnowledgePrivatePage, parseKnowledgePrivateAddress } from '../../../../../knowledge/route';
import { m } from '../../../../../paraglide/messages.js';
import { pageHead } from '../../../../../shell/head';
import { pageHeadContext } from '../../../../../shell/head-context';

export const Route = createFileRoute('/knowledge/notebooks/$notebookId/documents/$documentId')({
  staleTime: 0,
  gcTime: 0,
  shouldReload: true,
  loader: ({ params }) => {
    const address = parseKnowledgePrivateAddress(params);
    if (!address) throw notFound();
    return address;
  },
  head: ({ match }) =>
    pageHead({ title: m.knowledge_private_heading(), robots: 'noindex, nofollow' }, pageHeadContext(match.pathname)),
  component: KnowledgePrivateDocumentRoute,
});

function KnowledgePrivateDocumentRoute() {
  const address = useLoaderData({ from: '/knowledge/notebooks/$notebookId/documents/$documentId' });
  return <KnowledgePrivatePage address={{ kind: 'resume', ...address }} />;
}
