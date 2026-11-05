import { reviewRequest } from '../../accounts/resource-access/request';
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
  loader: ({ params, abortController }) =>
    routedId(params.resourceId)
      ? reviewRequest(
          (signal) => readResourceAccess({ data: { resourceId: params.resourceId }, signal }),
          abortController.signal,
        )
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
        read: (cursor, signal) =>
          readResourceAccess({ data: { resourceId, ...(cursor ? { cursor } : {}) }, ...(signal ? { signal } : {}) }),
        transfer: (data, signal) =>
          transferResourceOwner({ data, headers: csrfHeaders(), ...(signal ? { signal } : {}) }),
        save: (data, signal) => saveResourceAccess({ data, headers: csrfHeaders(), ...(signal ? { signal } : {}) }),
        lookup: (handle, signal) => findAccessIdentity({ data: { resourceId, handle }, ...(signal ? { signal } : {}) }),
      }}
    />
  );
}
