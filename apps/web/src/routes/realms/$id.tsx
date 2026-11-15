import { CommunityRouteNotFound, readCommunityRoute } from '../../community/protected-route';
import { realmReadingSearch } from '../../community/realm-reading-return';
import { realmCataloguePageSearch } from '../../community/realm-catalogue-entry';
import { createFileRoute, redirect } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { useSession } from '../../session/query';
import { personalRead } from '../../session/reading-policy';
import { CommunityReaderStatus, useCurrentCommunityRoutePage } from '../../community/current-route-page';
import { realmPageQuery } from '../../community';
import { SpacePage } from '../../session/community-application';
import { getLocale } from '../../paraglide/runtime.js';
import { ClosedErrorPage } from '../../shell/closed';
import { spacePageHead } from '../../community';
import type { SpacePageData } from '../../community';
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

type RealmLoaderData = { page: SpacePageData; admission: SpacePageAdmission };

export const Route = createFileRoute('/realms/$id')({
  staticData: { publicCache: true },
  validateSearch: realmCataloguePageSearch,
  loaderDeps: ({ search }) => realmReadingSearch(search),
  loader: ({ params, context, abortController, location }) =>
    readCommunityRoute(context.queryClient, context.credentialMode, async (credentialMode) => {
      const locale = getLocale();
      const target: SpacePageTarget = { kind: 'realm', id: params.id };
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
        const query = realmPageQuery(params.id, locale, credentialMode, original);
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
            result.admission.readId !== original.readId ||
            !spacePageQueryResultIsCurrent(original, context.queryClient, query.queryKey, result)
          )
            throw new ObsoleteSpacePageReadError();
          const { located, admission } = result;
          if (located.kind === 'redirect') {
            if (!spacePageQueryResultIsCurrent(original, context.queryClient, query.queryKey, result))
              throw new ObsoleteSpacePageReadError();
            releaseSpacePageRead(original);
            throw redirect({
              href: `/${locale}/spaces/${encodeURIComponent(located.address)}${location.searchStr}${location.hash ? `#${location.hash}` : ''}`,
              statusCode: 307,
              ...(credentialMode === 'session' ? { headers: { 'Cache-Control': 'private, no-store' } } : {}),
            });
          }
          const data = { page: located.page, admission } satisfies RealmLoaderData;
          if (!spacePageQueryResultIsCurrent(original, context.queryClient, query.queryKey, result))
            throw new ObsoleteSpacePageReadError();
          releaseSpacePageRead(original, true);
          return data;
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
      `/realms/${encodeURIComponent(params.id)}`,
    ),
  errorComponent: ClosedErrorPage,
  notFoundComponent: CommunityRouteNotFound,
  component: RealmRoute,
});

function RealmRoute() {
  const { id } = Route.useParams();
  const locale = getLocale();
  const { state } = useSession();
  const initial = Route.useLoaderData();
  const { credentialMode } = initial.admission;
  const request = useMemo(
    () => ({ target: { kind: 'realm' as const, id }, locale, credentialMode }),
    [id, locale, credentialMode],
  );
  const personal = personalRead.enabled && state === 'signed-in' && credentialMode === 'anonymous';
  const sessionPage = useQuery({ ...realmPageQuery(id, locale, 'session'), enabled: personal, retry: false });
  const located = sessionPage.isSuccess ? sessionPage.data.located : undefined;
  const current = useCurrentCommunityRoutePage({
    initial,
    request,
    personal,
    result: located?.kind === 'page' ? { page: located.page, admission: sessionPage.data!.admission } : undefined,
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
