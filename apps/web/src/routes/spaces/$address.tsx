import { realmReadingSearch } from '../../community/realm-reading-return';
import { createFileRoute } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { useRouter } from '@tanstack/react-router';
import { personalRead } from '../../kernel/query';
import { useSession } from '../../session/query';
import { spaceQuery } from '../../community/space-queries';
import { getLocale } from '../../paraglide/runtime.js';
import { SpacePage } from '../../community/space-page';
import {
  bindHydratedSpacePage,
  awaitSpacePageRead,
  captureSpacePageAdmission,
  isObsoleteSpacePageRead,
  ObsoleteSpacePageReadError,
  releaseSpacePageRead,
  spacePageAdmissionFor,
  spacePageQueryResultIsCurrent,
  spacePageReadWasCancelled,
  spacePageReadResultWasReplaced,
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
  validateSearch: realmReadingSearch,
  loaderDeps: ({ search }) => realmReadingSearch(search),
  loader: async ({ params, context, abortController }): Promise<SpaceLoaderData> => {
    const locale = getLocale();
    const target: SpacePageTarget = { kind: 'space', address: params.address };
    const signal = abortController.signal;
    let original = captureSpacePageAdmission(context.queryClient, {
      target,
      locale,
      credentialMode: 'anonymous',
      signal,
    });
    for (let attempt = 0; attempt < 2; attempt++) {
      if (signal.aborted || getLocale() !== locale) {
        releaseSpacePageRead(original);
        throw new ObsoleteSpacePageReadError();
      }
      const query = spaceQuery(params.address, locale, 'anonymous', original);
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
          credentialMode: 'anonymous',
          signal,
        });
      }
    }
    throw new ObsoleteSpacePageReadError();
  },
  head: ({ loaderData, params }) =>
    spacePageHead(loaderData!.page, getLocale(), `/spaces/${encodeURIComponent(params.address)}`),
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
  const publicRequest = useMemo(
    () => ({ target: { kind: 'space' as const, address }, locale, credentialMode: 'anonymous' as const }),
    [address, locale],
  );
  const publicCurrent = bindHydratedSpacePage(publicPage, publicAdmission, client, publicRequest);
  const sessionPage = useQuery({
    ...spaceQuery(address, locale, 'session'),
    enabled: personalRead.enabled && session === 'signed-in' && publicPage.realm === null,
    retry: false,
  });
  // A personal response belongs only to the current signed-in reader. Required read failures
  // still reach the route boundary, and cached protected content cannot survive sign-out or refresh.
  const personal = session === 'signed-in' && publicPage.realm === null;
  const sessionRequest = useMemo(
    () => ({ target: { kind: 'space' as const, address }, locale, credentialMode: 'session' as const }),
    [address, locale],
  );
  const currentSessionAdmission = sessionPage.data
    ? spacePageAdmissionFor(sessionPage.data.page, client, sessionRequest, sessionPage.data.admission)
    : null;
  if (personal && sessionPage.isError && !isObsoleteSpacePageRead(sessionPage.error)) throw sessionPage.error;
  const usePersonal = personal && sessionPage.isSuccess && !sessionPage.isFetching && !!currentSessionAdmission;
  const page = usePersonal ? sessionPage.data!.page : publicPage;
  const admission = usePersonal ? currentSessionAdmission! : publicAdmission;
  const request = usePersonal ? sessionRequest : publicRequest;
  const effectIdentity = JSON.stringify([
    address,
    locale,
    sessionRevision,
    publicAdmission.readId,
    sessionPage.data?.admission.readId ?? null,
    personal,
  ]);
  const latestEffect = useRef({ identity: effectIdentity, client });
  latestEffect.current = { identity: effectIdentity, client };
  const recoveryKey = JSON.stringify([
    address,
    locale,
    sessionRevision,
    personal,
    personal ? null : publicAdmission.readId,
  ]);
  const recovery = useRef({ key: recoveryKey, client, attempted: false });
  if (recovery.current.key !== recoveryKey || recovery.current.client !== client)
    recovery.current = { key: recoveryKey, client, attempted: false };

  useEffect(() => {
    if (latestEffect.current.identity !== effectIdentity || latestEffect.current.client !== client) return;
    if (personal) {
      if (
        !recovery.current.attempted &&
        !sessionPage.isFetching &&
        (!currentSessionAdmission || isObsoleteSpacePageRead(sessionPage.error))
      ) {
        recovery.current.attempted = true;
        void sessionPage.refetch();
      }
      return;
    }
    if (
      !recovery.current.attempted &&
      !publicCurrent &&
      !bindHydratedSpacePage(publicPage, publicAdmission, client, publicRequest)
    ) {
      recovery.current.attempted = true;
      void router.invalidate();
    }
  }, [
    address,
    client,
    currentSessionAdmission,
    effectIdentity,
    personal,
    publicAdmission,
    publicCurrent,
    publicPage,
    publicRequest,
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
