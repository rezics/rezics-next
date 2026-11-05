import { reviewRequest } from '../../accounts/resource-access/request';
import { createFileRoute } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import { useLayoutEffect, useMemo, useSyncExternalStore } from 'react';
import {
  readResourceAccess,
  findAccessIdentity,
  saveResourceAccess,
  transferResourceOwner,
} from '../../accounts/resource-access/actions';
import { ResourceAccessPage } from '../../accounts/resource-access/page';
import { routedId } from '../../accounts/resource-access/data';
import type { AccessIO, AccessState } from '../../accounts/resource-access/data';
import { accessRecoveryVisits } from '../../accounts/resource-access/visits';
import { m } from '../../paraglide/messages.js';
import { requireSignedIn } from '../../session/guard';
import { pageHead } from '../../shell/head';
import { pageHeadContext } from '../../shell/head-context';
import { postCommandSessionSource } from '../../threads/post-command-lifetime';

export const Route = createFileRoute('/access/$resourceId')({
  beforeLoad: requireSignedIn,
  loader: async ({ params, abortController, context }) => {
    const revision = postCommandSessionSource(context.queryClient).snapshot();
    const initial = routedId(params.resourceId)
      ? await reviewRequest(
          (signal) => readResourceAccess({ data: { resourceId: params.resourceId }, signal }),
          abortController.signal,
        )
      : { status: 'denied' as const };
    return { initial, revision };
  },
  head: ({ match }) =>
    pageHead({ title: m.access_heading(), robots: 'noindex, nofollow' }, pageHeadContext(match.pathname)),
  component: AccessRoute,
});

function AccessRoute() {
  const loaded = Route.useLoaderData();
  const { resourceId } = Route.useParams();
  const client = useQueryClient();
  const source = postCommandSessionSource(client);
  const revision = useSyncExternalStore(source.subscribe, source.snapshot, source.serverSnapshot);
  const initial: AccessState = loaded.revision === revision ? loaded.initial : { status: 'loading' };
  const visits = accessRecoveryVisits(client);
  const binding = JSON.stringify([resourceId, revision]);
  const io = useMemo<AccessIO>(() => {
    const session = source.read();
    const headers = { 'X-CSRF-Token': session?.csrfToken ?? '' };
    const current = () => source.snapshot() === revision && source.read()?.state === 'signed-in';
    return {
      read: (cursor, signal) =>
        current()
          ? readResourceAccess({ data: { resourceId, ...(cursor ? { cursor } : {}) }, ...(signal ? { signal } : {}) })
          : Promise.resolve({ status: 'denied' }),
      transfer: (data, signal) =>
        current()
          ? transferResourceOwner({ data, headers, ...(signal ? { signal } : {}) })
          : Promise.resolve({ status: 'denied', current: { status: 'denied' } }),
      save: (data, signal) =>
        current()
          ? saveResourceAccess({ data, headers, ...(signal ? { signal } : {}) })
          : Promise.resolve({ status: 'denied' }),
      lookup: (handle, signal) => {
        if (!current()) throw new Error('Resource access caller retired');
        return findAccessIdentity({ data: { resourceId, handle }, ...(signal ? { signal } : {}) });
      },
    };
  }, [resourceId, revision, source]);
  const recovery = useMemo(() => visits.resume(binding, initial, io), [visits, binding, io, loaded]);
  useLayoutEffect(() => () => visits.release(binding, recovery), [visits, binding, recovery]);
  useLayoutEffect(() => {
    if (loaded.revision !== revision || recovery.snapshot().pending) void recovery.reload();
  }, [loaded, revision, recovery]);
  return <ResourceAccessPage key={binding} initial={initial} io={io} recovery={recovery} />;
}
