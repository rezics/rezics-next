import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from '@tanstack/react-router';
import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { Button } from '@rezics/ui/shadcn/button';
import type { ReadCredentialMode } from '../kernel/credential';
import { m } from '../paraglide/messages.js';
import type { SpacePageData } from './space';
import {
  bindHydratedSpacePage,
  spacePageAdmissionFor,
  spacePageSessionSource,
  type SpacePageAdmission,
  type SpacePageTarget,
} from './space-page-lifetime';

export type CommunityRoutePage = { page: SpacePageData; admission: SpacePageAdmission };
type ReaderRequest = { target: SpacePageTarget; locale: string; credentialMode: ReadCredentialMode };

export function useCurrentCommunityRoutePage({
  initial,
  request,
  personal,
  result,
  fetching,
  refetch,
}: {
  initial: CommunityRoutePage;
  request: ReaderRequest;
  personal: boolean;
  result: CommunityRoutePage | undefined;
  fetching: boolean;
  refetch: () => Promise<unknown>;
}) {
  const client = useQueryClient();
  const router = useRouter();
  const source = spacePageSessionSource(client);
  const revision = useSyncExternalStore(source.subscribe, source.revision, source.revision);
  const personalRequest = useMemo(() => ({ ...request, credentialMode: 'session' as const }), [request]);
  const current =
    personal && result ? spacePageAdmissionFor(result.page, client, personalRequest, result.admission) : null;
  const publicCurrent = bindHydratedSpacePage(initial.page, initial.admission, client, request);

  const previous = useRef({ readId: initial.admission.readId, revision, personal });
  const attempted = useRef<string | null>(null);
  useEffect(() => {
    const before = previous.current;
    previous.current = { readId: initial.admission.readId, revision, personal };
    if (source.revision() !== revision) return;

    if (personal) {
      const publicReadReplaced = before.personal && before.readId !== initial.admission.readId;
      const readerReplaced = before.personal && before.revision !== revision;
      // Membership and publication acknowledge first, then invalidate the route.
      // Refresh their supplying private page on that same route readback.
      if (publicReadReplaced || readerReplaced) void refetch();
      return;
    }

    const key = JSON.stringify([request.target, request.locale, request.credentialMode, revision]);
    if (
      !publicCurrent &&
      attempted.current !== key &&
      !bindHydratedSpacePage(initial.page, initial.admission, client, request)
    ) {
      attempted.current = key;
      void router.invalidate();
    }
  }, [client, initial, personal, publicCurrent, refetch, request, revision, router, source]);

  if (current && result) return { page: result.page, admission: current, request: personalRequest, status: null };
  return {
    ...initial,
    request,
    status: personal ? (fetching ? ('loading' as const) : ('unavailable' as const)) : null,
  };
}

export function CommunityReaderStatus({
  status,
  refetch,
}: {
  status: 'loading' | 'unavailable' | null;
  refetch: () => Promise<unknown>;
}) {
  if (!status) return null;
  return (
    <div className="mb-4 flex flex-wrap items-baseline gap-2 text-sm">
      <p role="status">{status === 'loading' ? m.realm_membership_loading() : m.realm_membership_unavailable()}</p>
      {status === 'unavailable' ? (
        <Button type="button" variant="outline" size="sm" onClick={() => void refetch()}>
          {m.realm_membership_retry()}
        </Button>
      ) : null}
    </div>
  );
}
