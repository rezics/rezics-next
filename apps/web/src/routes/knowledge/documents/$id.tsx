import { createFileRoute, notFound } from '@tanstack/react-router';
import { m } from '../../../paraglide/messages.js';
import { getLocale } from '../../../paraglide/runtime.js';
import { pageHead } from '../../../shell/head';
import { pageHeadContext } from '../../../shell/head-context';
import {
  KnowledgeDocumentPending,
  KnowledgeDocumentRoute,
  knowledgeDocumentRequest,
  knowledgeDocumentSearch,
  loadKnowledgeDocumentVisit,
} from '../../../knowledge/route';

export const Route = createFileRoute('/knowledge/documents/$id')({
  staleTime: 0,
  gcTime: 0,
  shouldReload: true,
  pendingMs: 0,
  validateSearch: knowledgeDocumentSearch,
  loader: async ({ params, context, location }) => {
    const request = knowledgeDocumentRequest(
      params.id,
      (location.search as { revisionId?: string }).revisionId,
      getLocale(),
    );
    if (!request) throw notFound();
    return loadKnowledgeDocumentVisit(context.queryClient, request);
  },
  head: ({ match }) =>
    pageHead({ title: m.knowledge_heading(), robots: 'noindex, nofollow' }, pageHeadContext(match.pathname)),
  pendingComponent: KnowledgeDocumentPending,
  component: KnowledgeDocumentRoute,
});
