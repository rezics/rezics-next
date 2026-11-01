import { createFileRoute, useLocation } from '@tanstack/react-router';
import { useCallback } from 'react';
import { requireSignedIn } from '../../session/guard';
import { pageHead } from '../../shell/head';
import { pageHeadContext } from '../../shell/head-context';
import { m } from '../../paraglide/messages.js';
import { AuthorErasureOperationPage } from '../../threads/author-erasure-operation';
import { readThreadAuthorErasure } from '../../threads/author-erasure-server';

export const Route = createFileRoute('/operations/$id')({
  beforeLoad: requireSignedIn,
  loader: ({ params }) => readThreadAuthorErasure({ data: { id: params.id } }),
  staleTime: 0,
  head: ({ match }) =>
    pageHead(
      { title: m.author_erasure_operation_title(), robots: 'noindex, nofollow' },
      pageHeadContext(match.pathname),
    ),
  component: function OperationRoute() {
    const { id } = Route.useParams();
    const initial = Route.useLoaderData();
    const location = useLocation();
    const read = useCallback(() => readThreadAuthorErasure({ data: { id } }), [id]);
    return <AuthorErasureOperationPage initial={initial} operationId={id} navigationKey={location.href} read={read} />;
  },
});
