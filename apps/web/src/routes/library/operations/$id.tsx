import { createFileRoute, useLocation } from '@tanstack/react-router';
import { requireSignedIn } from '../../../session/guard';
import { BulkOperationPage } from '../../../library/bulk-operation-recovery-page';
import { pageHead } from '../../../shell/head';
import { pageHeadContext } from '../../../shell/head-context';
import { m } from '../../../paraglide/messages.js';

export const Route = createFileRoute('/library/operations/$id')({
  beforeLoad: requireSignedIn,
  head: ({ match }) =>
    pageHead({ title: m.bulk_operation_title(), robots: 'noindex, nofollow' }, pageHeadContext(match.pathname)),
  component: function OperationRoute() {
    const { id } = Route.useParams();
    const location = useLocation();
    let requestedId: string | undefined;
    try {
      requestedId = decodeURIComponent(location.pathname.match(/\/library\/operations\/([^/]+)\/?$/)?.[1] ?? '');
    } catch {
      /* Invalid pending address. */
    }
    if (requestedId !== id) return <p role="status">{m.bulk_operation_loading()}</p>;
    return <BulkOperationPage id={id} href={location.publicHref} />;
  },
});
