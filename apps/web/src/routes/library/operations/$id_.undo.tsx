import { createFileRoute, useLocation } from '@tanstack/react-router';
import { requireSignedIn } from '../../../session/guard';
import { BulkOperationUndoPage } from '../../../library/bulk-operation-undo-page';
import { pageHead } from '../../../shell/head';
import { pageHeadContext } from '../../../shell/head-context';
import { m } from '../../../paraglide/messages.js';

export const Route = createFileRoute('/library/operations/$id_/undo')({
  beforeLoad: requireSignedIn,
  head: ({ match }) =>
    pageHead({ title: m.library_bulk_undo_title(), robots: 'noindex, nofollow' }, pageHeadContext(match.pathname)),
  component: function UndoRoute() {
    const { id } = Route.useParams();
    const location = useLocation();
    let requestedId: string | undefined;
    try {
      requestedId = decodeURIComponent(location.pathname.match(/\/library\/operations\/([^/]+)\/undo\/?$/)?.[1] ?? '');
    } catch {
      /* Invalid pending address. */
    }
    if (requestedId !== id) return <p role="status">{m.bulk_operation_loading()}</p>;
    return <BulkOperationUndoPage id={id} href={location.publicHref} />;
  },
});
