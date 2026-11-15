import { CommunityRouteNotFound, readCommunityRoute } from '../../community/protected-route';
import { realmReadingSearch } from '../../community/realm-reading-return';
import { realmCataloguePageSearch } from '../../community/realm-catalogue-entry';
import { createFileRoute } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { CommunityReaderStatus, useCurrentCommunityRoutePage } from '../../community/current-route-page';
import { personalRead } from '../../session/reading-policy';
import { useSession } from '../../session/index';
import { spaceQuery } from '../../community';
import { getLocale } from '../../paraglide/runtime.js';
import { SpacePage } from '../../session/community-application';
import {
  awaitSpacePageRead,
  captureSpacePageAdmission,
  isObsoleteSpacePageRead,
  ObsoleteSpacePageReadError,
  releaseSpacePageRead,
  spacePageQueryResultIsCurrent,
  spacePageReadWasCancelled,
  spacePageReadResultWasReplaced,
  SpacePageLifetimeHost,
} from '../../community';
import type { SpacePageAdmission, SpacePageTarget } from '../../community';
import type { SpacePageData } from '../../community';
import { ClosedErrorPage } from '../../shell/closed';
import { spacePageHead } from '../../community';

type SpaceLoaderData = { page: SpacePageData; admission: SpacePageAdmission };

export const Route = createFileRoute('/spaces/$address')({
  staticData: { publicCache: true },
  validateSearch: realmCataloguePageSearch,
  loaderDeps: ({ search }) => realmReadingSearch(search),
  loader: ({ params, context, abortController }): Promise<SpaceLoaderData> =>
    readCommunityRoute(context.queryClient, 'anonymous', async (credentialMode) => {
      const locale = getLocale();
      const target: SpacePageTarget = { kind: 'space', address: params.address };
      const signal = abortController.signal;
      let original = captureSpacePageAdmission(context.queryClient, {
        target,
        locale,
        credentialMode,
        signal,
      });
      for (let attempt = 0; attempt < 2; attempt++) {
        if (signal.aborted || getLocale() !== locale) {
          releaseSpacePageRead(original);
          throw new ObsoleteSpacePageReadError();
        }
        const query = spaceQuery(params.address, locale, credentialMode, original);
        try {
          let result = await awaitSpacePageRead(original, context.queryClient.ensureQueryData(query));
          if (signal.aborted || getLocale() !== locale) throw new ObsoleteSpacePageReadError();
          if (
            result.admission.readId !== original.readId ||
            !spacePageQueryResultIsCurrent(original, context.queryClient, query.queryKey, result)
          )
            result = await awaitSpacePageRead(original, context.queryClient.fetchQuery({ ...query, staleTime: 0 }));
          if (signal.aborted || getLocale() !== locale) throw new ObsoleteSpacePageReadError();
          if (
            result.admission.readId === original.readId &&
            spacePageQueryResultIsCurrent(original, context.queryClient, query.queryKey, result)
          ) {
            const data = { page: result.page, admission: result.admission } satisfies SpaceLoaderData;
            if (!spacePageQueryResultIsCurrent(original, context.queryClient, query.queryKey, result))
              throw new ObsoleteSpacePageReadError();
            releaseSpacePageRead(original, true);
            return data;
          }
          throw new ObsoleteSpacePageReadError();
        } catch (error) {
          const cancelled = spacePageReadWasCancelled(original, context.queryClient);
          const replaced = spacePageReadResultWasReplaced(original, context.queryClient);
          releaseSpacePageRead(original);
          if (!isObsoleteSpacePageRead(error) && !cancelled) throw error;
          if (attempt > 0 || signal.aborted || getLocale() !== locale || replaced) {
            if (cancelled && !signal.aborted) throw new ObsoleteSpacePageReadError();
            throw error;
          }
          original = captureSpacePageAdmission(context.queryClient, {
            target,
            locale,
            credentialMode,
            signal,
          });
        }
      }
      throw new ObsoleteSpacePageReadError();
    }),
  head: ({ loaderData, params }) =>
    spacePageHead(
      loaderData?.admission.credentialMode === 'anonymous' ? loaderData.page : undefined,
      getLocale(),
      `/spaces/${encodeURIComponent(params.address)}`,
    ),
  errorComponent: ClosedErrorPage,
  notFoundComponent: CommunityRouteNotFound,
  component: SpaceRoute,
});

function SpaceRoute() {
  const { address } = Route.useParams();
  const locale = getLocale();
  const { state } = useSession();
  const initial = Route.useLoaderData();
  const { credentialMode } = initial.admission;
  const request = useMemo(
    () => ({ target: { kind: 'space' as const, address }, locale, credentialMode }),
    [address, locale, credentialMode],
  );
  // Carried Realms need the same viewer-specific native home as standalone Spaces.
  const personal = personalRead.enabled && state === 'signed-in' && credentialMode === 'anonymous';
  const sessionPage = useQuery({ ...spaceQuery(address, locale, 'session'), enabled: personal, retry: false });
  const current = useCurrentCommunityRoutePage({
    initial,
    request,
    personal,
    result: sessionPage.isSuccess ? sessionPage.data : undefined,
    fetching: sessionPage.isPending || sessionPage.isFetching,
    refetch: sessionPage.refetch,
  });

  return (
    <>
      <CommunityReaderStatus status={current.status} refetch={sessionPage.refetch} />
      <SpacePageLifetimeHost
        page={current.page}
        admission={current.admission}
        target={current.request.target}
        locale={locale}
        credentialMode={current.request.credentialMode}
      >
        <SpacePage page={current.page} />
      </SpacePageLifetimeHost>
    </>
  );
}
