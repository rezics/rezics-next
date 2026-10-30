import { createFileRoute } from '@tanstack/react-router';
import {
  readResourceAccess,
  findAccessIdentity,
  saveResourceAccess,
  transferResourceOwner,
} from '../../accounts/resource-access/actions';
import { ResourceAccessPage } from '../../accounts/resource-access/page';
import { routedId } from '../../accounts/resource-access/data';
import { m } from '../../paraglide/messages.js';
import { requireSignedIn } from '../../session/guard';
import { pageHead } from '../../shell/head';
import { pageHeadContext } from '../../shell/head-context';
import { csrfHeaders } from '../../threads/composer';

export const Route = createFileRoute('/access/$resourceId')({
  beforeLoad: requireSignedIn,
  loader: ({ params }) =>
    routedId(params.resourceId)
      ? readResourceAccess({ data: { resourceId: params.resourceId } })
      : { status: 'denied' as const },
  head: ({ match }) =>
    pageHead({ title: m.access_heading(), robots: 'noindex, nofollow' }, pageHeadContext(match.pathname)),
  component: AccessRoute,
});

function AccessRoute() {
  const initial = Route.useLoaderData();
  const { resourceId } = Route.useParams();
  return (
    <ResourceAccessPage
      key={resourceId}
      initial={initial}
      io={{
        read: (cursor) => readResourceAccess({ data: { resourceId, ...(cursor ? { cursor } : {}) } }),
        transfer: (data) => transferResourceOwner({ data, headers: csrfHeaders() }),
        save: (data) => saveResourceAccess({ data, headers: csrfHeaders() }),
        lookup: (handle) => findAccessIdentity({ data: { resourceId, handle } }),
      }}
    />
  );
}
