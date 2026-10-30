import { createFileRoute } from '@tanstack/react-router';
import { requireSignedIn } from '../../session/guard';
import { useSession } from '../../session/query';
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
    const { state: session } = useSession();
    // Hydration must not remount the operation and replenish its refresh budget.
    const sessionKey = session === 'unknown' ? 'signed-in' : session;
    return (
      <AuthorErasureOperationPage
        key={`${id}:${sessionKey}`}
        initial={
          session === 'signed-out'
            ? { kind: 'signed-out' }
            : session === 'unavailable'
              ? { kind: 'unavailable' }
              : initial
        }
        read={() => readThreadAuthorErasure({ data: { id } })}
      />
    );
  },
});
