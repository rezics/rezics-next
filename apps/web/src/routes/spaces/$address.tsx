import { createFileRoute } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useSyncExternalStore } from 'react';
import { useRouter } from '@tanstack/react-router';
import { personalRead } from '../../kernel/query';
import { useSession } from '../../session/query';
import { spaceQuery } from '../../community/space-queries';
import { getLocale } from '../../paraglide/runtime.js';
import { SpacePage } from '../../community/space-page';
import {
  bindHydratedSpacePage,
  captureSpacePageAdmission,
  getSpacePageAdmission,
  isObsoleteSpacePageRead,
  ObsoleteSpacePageReadError,
  spacePageAdmissionFor,
  spacePageSessionSource,
  SpacePageLifetimeHost,
} from '../../community/space-page-lifetime';
import type { SpacePageAdmission, SpacePageTarget } from '../../community/space-page-lifetime';
import type { SpacePageData } from '../../community/space';
import { ClosedErrorPage } from '../../shell/closed';
import { spacePageHead } from '../../community/space-head';

type SpaceLoaderData = { page: SpacePageData; admission: SpacePageAdmission };

export const Route = createFileRoute('/spaces/$address')({
  staticData: { publicCache: true },
  loader: async ({ params, context }): Promise<SpaceLoaderData> => {
    const locale = getLocale();
    const target: SpacePageTarget = { kind: 'space', address: params.address };
    let original = captureSpacePageAdmission(context.queryClient, {
      target,
      locale,
      credentialMode: 'anonymous',
    });
    for (let attempt = 0; attempt < 2; attempt++) {
      const query = spaceQuery(params.address, locale, 'anonymous', original);
      try {
        let page = await context.queryClient.ensureQueryData(query);
        let admission = getSpacePageAdmission(page);
        if (admission?.readId !== original.readId) {
          page = await context.queryClient.fetchQuery({ ...query, staleTime: 0 });
          admission = getSpacePageAdmission(page);
        }
        if (admission?.readId === original.readId) return { page, admission };
        throw new ObsoleteSpacePageReadError();
      } catch (error) {
        if (!isObsoleteSpacePageRead(error) || attempt > 0) throw error;
        original = captureSpacePageAdmission(context.queryClient, {
          target,
          locale,
          credentialMode: 'anonymous',
        });
      }
    }
    throw new ObsoleteSpacePageReadError();
  },
  head: ({ loaderData, params }) =>
    spacePageHead(loaderData.page, getLocale(), `/spaces/${encodeURIComponent(params.address)}`),
  errorComponent: ClosedErrorPage,
  component: SpaceRoute,
});

function SpaceRoute() {
  const { address } = Route.useParams();
  const locale = getLocale();
  const router = useRouter();
  const client = useQueryClient();
  const { state: session } = useSession();
  const { page: publicPage, admission: publicAdmission } = Route.useLoaderData();
  const source = spacePageSessionSource(client);
  const sessionRevision = useSyncExternalStore(source.subscribe, source.revision, source.revision);
  const publicRequest = { target: { kind: 'space' as const, address }, locale, credentialMode: 'anonymous' as const };
  const publicCurrent = bindHydratedSpacePage(publicPage, publicAdmission, client, publicRequest);
  const sessionPage = useQuery({
    ...spaceQuery(address, locale, 'session'),
    enabled: personalRead.enabled && session === 'signed-in' && publicPage.realm === null,
    retry: false,
  });
  // A personal response belongs only to the current signed-in reader. Required read failures
  // still reach the route boundary, and cached protected content cannot survive sign-out or refresh.
  const personal = session === 'signed-in' && publicPage.realm === null;
  const sessionRequest = { target: { kind: 'space' as const, address }, locale, credentialMode: 'session' as const };
  const currentSessionAdmission = sessionPage.data
    ? spacePageAdmissionFor(sessionPage.data, client, sessionRequest)
    : null;
  if (personal && sessionPage.isError && !isObsoleteSpacePageRead(sessionPage.error)) throw sessionPage.error;
  const usePersonal = personal && sessionPage.isSuccess && !sessionPage.isFetching && !!currentSessionAdmission;
  const page = usePersonal ? sessionPage.data! : publicPage;
  const admission = usePersonal ? currentSessionAdmission! : publicAdmission;
  const request = usePersonal ? sessionRequest : publicRequest;

  useEffect(() => {
    if (personal) {
      if (!sessionPage.isFetching && (!currentSessionAdmission || isObsoleteSpacePageRead(sessionPage.error)))
        void sessionPage.refetch();
      return;
    }
    if (!publicCurrent) void router.invalidate();
  }, [
    address,
    currentSessionAdmission,
    personal,
    publicCurrent,
    router,
    sessionPage.error,
    sessionPage.isFetching,
    sessionPage.refetch,
    sessionRevision,
  ]);

  return (
    <SpacePageLifetimeHost
      page={page}
      admission={admission}
      target={request.target}
      locale={locale}
      credentialMode={request.credentialMode}
    >
      <SpacePage page={page} />
    </SpacePageLifetimeHost>
  );
}
